/** Indexing a document after its actor flushed. */
import { chunkEmbedInput, headingAwareChunk } from "@stuga/ai";
import { sha256Hex, principalId } from "@stuga/auth";
import { charChangeCounts, yXmlFragmentToMarkdown } from "@stuga/crdt-ops";
import type { ChunkInput } from "@stuga/db";
import { snapshotKey } from "@stuga/protocol/domain/limits";
import { MAX_MENTIONS, markdownMentionAliases, mentionHref } from "@stuga/protocol/domain/mentions";
import type { IndexMessage } from "@stuga/protocol/internal/jobs";
import * as Y from "yjs";
import type { JobsDb } from "./db.js";
import { type JobDeps, type JobsEnv, isTerminal } from "./deps.js";

export type IndexDocMessage = Extract<IndexMessage, { kind: "index_doc" }>;

/** Texts per embedding request. */
const EMBED_BATCH = 16;
/** New or changed chunks one job embeds; the rest are stored vector-less for the reconcile sweep. */
const EMBED_CHUNKS_PER_JOB = 200;

/**
 * A snapshot's body as Markdown, or null when the blob is missing. Null is not
 * "": a missing blob must not publish a version as having deleted the text.
 */
async function markdownFromSnapshot(env: JobsEnv, key: string): Promise<string | null> {
  const obj = await env.snapshots.get(key);
  if (!obj) return null;
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, new Uint8Array(await obj.arrayBuffer()));
    return yXmlFragmentToMarkdown(doc.getXmlFragment("default"));
  } finally {
    doc.destroy();
  }
}

/**
 * The "+312 −45" a version prints, against the previous recorded version (most
 * flushes record none). A document's first snapshot compares with "", an
 * unreadable baseline gives null.
 */
async function versionCharChange(
  env: JobsEnv,
  db: JobsDb,
  docId: string,
  seq: number,
  text: string,
): Promise<{ added: number; removed: number } | null> {
  if (seq <= 1) return charChangeCounts("", text);
  const prevSeq = await db.previousVersionSeq(docId, seq);
  if (prevSeq === null) return null;
  const previous = await markdownFromSnapshot(env, snapshotKey(docId, prevSeq));
  return previous === null ? null : charChangeCounts(previous, text);
}

/** The line a mention sits on, as a person reads it: mentions and links reduced to their text. */
function mentionExcerpt(markdown: string, alias: string): string {
  const line = markdown.split("\n").find((l) => l.includes(mentionHref(alias))) ?? "";
  return line
    .replace(/\[(@[^\]]*)\]\(mention:[^)\s]+\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s*(?:#+|[-*+]|\d+[.)]|>)\s+/, "")
    .trim()
    .slice(0, 140);
}

/**
 * Notify the people this snapshot mentions who were not mentioned in the last
 * one. Removing a mention and adding it back notifies again; the notify worker
 * collapses repeats within the hour.
 */
async function notifyNewMentions(
  env: JobsEnv,
  deps: JobDeps,
  doc: NonNullable<Awaited<ReturnType<JobDeps["db"]["getDoc"]>>>,
  editors: string[],
  markdown: string,
  title: string,
): Promise<void> {
  const added = await deps.db.syncDocMentions(doc.doc_id, markdownMentionAliases(markdown));
  if (added.length === 0 || doc.trashed) return;
  // The first person among the editors; an agent's edit names no one.
  const human = editors.map((a) => (a.startsWith("user:") ? a.slice("user:".length) : a)).find((a) => !a.includes(":"));
  const actorName = human ? ((await deps.db.displayNameOf(human)) ?? human) : null;
  const recipients = await deps.db.mentionReaders(doc, added.slice(0, MAX_MENTIONS), human ?? null);
  for (const recipient of recipients) {
    await env.jobs.send({
      kind: "notify",
      recipient,
      workspaceId: doc.workspace_id,
      eventType: "MENTIONED_IN_DOC",
      docId: doc.doc_id,
      title: actorName ? `${actorName} mentioned you in "${title}"` : `You were mentioned in "${title}"`,
      body: mentionExcerpt(markdown, recipient),
      actor: human ?? "",
    });
  }
}

export async function handleIndexDoc(env: JobsEnv, deps: JobDeps, msg: IndexDocMessage): Promise<void> {
  const { db, log } = deps;
  const doc = await db.getDoc(msg.docId);
  if (!doc) return;

  // A forced reindex with no seq of its own reads the row's snapshot; before the first flush there is none.
  const snapshotSeq = msg.snapshotSeq ?? doc.snapshot_seq;
  const snapshotMarkdown = snapshotSeq > 0 ? await markdownFromSnapshot(env, snapshotKey(msg.docId, snapshotSeq)) : null;
  const searchText = snapshotMarkdown ?? "";
  // The row write, the embed input and its hash must all use the title the row will hold.
  const title = doc.title_source === "user" ? doc.title : msg.title || doc.title;

  // Only when the actor asked: it owns the version ring and the snapshot bytes.
  if (msg.recordVersion && msg.snapshotSeq) {
    const change =
      snapshotMarkdown === null
        ? null
        : await versionCharChange(env, db, msg.docId, msg.snapshotSeq, snapshotMarkdown).catch(() => null);
    const version: Parameters<JobsDb["recordVersion"]>[0] = {
      docId: msg.docId,
      seq: msg.snapshotSeq,
      // Everyone since the previous version; `authors` covers only the last flush.
      authors: msg.versionAuthors ?? msg.authors ?? [],
      blobKey: snapshotKey(msg.docId, msg.snapshotSeq),
      versionFloor: msg.versionFloor,
    };
    if (snapshotMarkdown !== null) version.chars = snapshotMarkdown.length;
    if (change) {
      version.charsAdded = change.added;
      version.charsRemoved = change.removed;
    }
    await db.recordVersion(version);
  }

  // A seq already indexed (a head the actor promoted to a version, a redelivery, a late job) was
  // notified and embedded then: running again would re-count the embedding or roll mentions back.
  // A forced job (the backfill) reruns its own seq, never one the row has moved past.
  if (msg.snapshotSeq !== undefined && (doc.snapshot_seq > msg.snapshotSeq || (doc.snapshot_seq === msg.snapshotSeq && !msg.force))) return;

  // Who the mentions name as their writer and who the embedding is charged to. A promote job
  // carries no `authors` (its flush took them): when it overtakes that flush's job, the version's stand in.
  const editors = msg.authors?.length ? msg.authors : ((msg.recordVersion && msg.versionAuthors) || []);

  // Before the search-hidden and unchanged-text exits: neither says anything about who is mentioned.
  if (snapshotMarkdown !== null) {
    await notifyNewMentions(env, deps, doc, editors, snapshotMarkdown, title).catch((err: unknown) =>
      log.warn("mention notifications failed", { docId: msg.docId, err: String(err) }),
    );
  }

  // Both exits below skip indexDoc, yet the row's seq must keep up with the actor's head (the
  // version listing's head_seq, the delete guard, the retention window). Last, like indexDoc: a
  // retry must not find it indexed.
  if (doc.search_hidden) {
    await db.clearDocChunks(msg.docId);
    if (msg.snapshotSeq !== undefined) await db.advanceSnapshotSeq(msg.docId, msg.snapshotSeq);
    return;
  }

  // Byte-identical text skips the embed; `force` (the backfill) bypasses it.
  const embedSource = `${title}\n\n${searchText}`;
  const hash = sha256Hex(embedSource);
  if (!msg.force && hash === (await db.getEmbeddingHash(msg.docId))) {
    if (msg.snapshotSeq !== undefined) {
      // Every seq since the row's holds this text. A version among them becomes the row's seq, so the
      // listing still calls it current and a forced reindex reads a snapshot the ring keeps.
      const version = await db.previousVersionSeq(msg.docId, msg.snapshotSeq + 1);
      await db.advanceSnapshotSeq(msg.docId, version !== null && version >= doc.snapshot_seq ? version : msg.snapshotSeq);
    }
    return;
  }

  const chunks: ChunkInput[] = [];
  if (searchText.length > 0) {
    const pieces = headingAwareChunk(searchText);
    if (pieces.length === 0) pieces.push({ content: title, headingPath: "" });

    // The exact embed input per chunk, shared with the reconcile path, so the dedup hash covers what was embedded.
    const inputs = pieces.map((p, i) => chunkEmbedInput(title, p.headingPath, p.content, i === 0));
    const hashes = inputs.map(sha256Hex);

    const ai = env.aiSettings.current();
    if (!ai.embed.enabled) {
      // Keyword-only rows; the backfill fills vectors in once embeddings are on.
      for (let i = 0; i < pieces.length; i++) {
        chunks.push({ content: pieces[i]!.content, headingPath: pieces[i]!.headingPath, embedding: null, embedHash: hashes[i]! });
      }
    } else {
      // A chunk whose exact input already has a vector keeps it, so an edit re-embeds only what changed.
      const reuse = await db.getReusableChunkEmbeddings(msg.docId, env.embeddingDims);
      const results: ChunkInput[] = Array.from({ length: pieces.length });
      const toEmbed: number[] = [];
      for (let i = 0; i < pieces.length; i++) {
        const reused = reuse.get(hashes[i]!);
        if (reused) {
          results[i] = { content: pieces[i]!.content, headingPath: pieces[i]!.headingPath, embedding: reused, embedHash: hashes[i]! };
        } else {
          toEmbed.push(i);
        }
      }

      const embedNow = toEmbed.slice(0, EMBED_CHUNKS_PER_JOB);
      const deferred = toEmbed.slice(EMBED_CHUNKS_PER_JOB);
      for (const i of deferred) {
        results[i] = { content: pieces[i]!.content, headingPath: pieces[i]!.headingPath, embedding: null, embedHash: hashes[i]! };
      }

      let totalTokens = 0;
      for (let start = 0; start < embedNow.length; start += EMBED_BATCH) {
        const batch = embedNow.slice(start, start + EMBED_BATCH);
        let vectors: (number[] | null)[];
        try {
          const res = await deps.embed(ai, batch.map((i) => inputs[i]!));
          vectors = res.embeddings;
          totalTokens += res.inputTokens;
        } catch (err) {
          // Stored vector-less so keyword search still works; the reconcile sweep retries.
          if (isTerminal(err)) {
            log.error("embed terminal failure (will not succeed on reconcile)", { docId: msg.docId, chunks: batch, err: String(err) });
          } else {
            log.warn("embed transient failure, chunks stored vector-less (reconcile will retry)", { docId: msg.docId, chunks: batch, err: String(err) });
          }
          vectors = batch.map(() => null);
        }
        batch.forEach((i, k) => {
          results[i] = { content: pieces[i]!.content, headingPath: pieces[i]!.headingPath, embedding: vectors[k] ?? null, embedHash: hashes[i]! };
        });
      }
      chunks.push(...results);

      log.info("index_doc chunk dedup", {
        docId: msg.docId,
        totalChunks: pieces.length,
        reused: pieces.length - toEmbed.length,
        embeddedNow: embedNow.length,
        deferred: deferred.length,
        embeddedTokens: totalTokens,
      });

      // Attributed once for the document: its first editor, else its owner.
      if (totalTokens > 0) {
        const alias = editors[0] ?? principalId(doc.owner);
        await db
          .insertAiUsage({
            alias,
            workspaceId: doc.workspace_id,
            docId: msg.docId,
            kind: "embedding",
            model: ai.embed.model,
            inputTokens: totalTokens,
          })
          .catch(() => {});
      }
    }
  }

  await db.indexDoc({
    docId: msg.docId,
    snapshotSeq,
    title,
    searchText,
    embeddingHash: hash,
    chunks,
    embeddingDims: env.embeddingDims,
  });
}
