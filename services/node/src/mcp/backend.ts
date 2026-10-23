/** The agent tools' data access for one call, in-process over its resolved Ctx. */
import type {
  AgentBackend,
  Answer,
  AskedBy,
  Authorship,
  DatabaseMutation,
  DatabaseProposeBody,
  ImportOutcome,
  MarkdownBody,
  PendingChange,
  ProposedChange,
  ViewShape,
  ProposeInstructionLabels,
  RetrieveBody,
  WaitingChanges,
} from "@stuga/agent-surface/backend";
import { MAX_INLINE_IMAGE_BYTES } from "@stuga/agent-surface/catalog";
import {
  type DocRow,
  docAuthorship,
  getDoc,
  getWorkspace,
  latestWorkspaceEventId,
  listComments,
  listDocs,
  listFolders,
  listWorkspaceEvents,
  type WaitingRun,
  waitingRuns,
} from "@stuga/db";
import { stricterReviewMode, type ReviewMode } from "@stuga/protocol/domain/events";
import { DATABASE_IMPORT_INLINE_MAX_CHARS } from "@stuga/protocol/databases/limits";
import { RUN_FEEDBACK_LOOKBACK_DAYS } from "@stuga/protocol/domain/limits";
import type { DatabaseRunSummary, DatabaseSchema } from "@stuga/protocol/databases/types";
import {
  databaseDocMessage,
  type ProjectedMarkdown,
  proposeBody,
  proposeDocEdit,
  readDocMarkdownWithProjection,
  readDocProvenance,
  readDocRuns,
} from "../agents/edits.js";
import {
  type CollectionRefusal,
  changePersonCollectionItems,
  createPersonCollection,
  deletePersonCollection,
  isCollectionRefusal,
  listPersonCollections,
  openCollection,
  renamePersonCollection,
} from "../api/collections.js";
import { recallRows } from "../agents/recall-rows.js";
import { planRemember } from "../agents/remember.js";
import { collectionScope } from "../retrieval/scope.js";
import { retrievePassages, searchDocuments } from "../api/search.js";
import { folderSummary } from "../api/summaries.js";
import { eventActorOf } from "../audit/record.js";
import type { Ctx } from "../auth/context.js";
import { canCommentDoc, canReadDoc, canWriteDoc, personOf, scopeFolderIds } from "../authz/authz.js";
import { effectiveReviewLevel, resolveReviewMode } from "../authz/review-mode.js";
import { commentInput, isCommentRefusal, postComment } from "../comments/post.js";
import { markYours } from "../comments/read.js";
import { authorizedDatabase, callDatabaseActor } from "../databases/gate.js";
import {
  commitDatabaseImport,
  createDatabaseImport,
  importPageUrl,
  parseCommitOptions,
  stageInlineImport,
} from "../databases/imports/staging.js";
import {
  databaseProposeBody,
  parseColumnSpecs,
  proposeDatabaseOp,
  proposeTableWithColumns,
  type DatabaseProposeOutcome,
} from "../databases/propose.js";
import { findRowPage, openRowPage } from "../databases/row-pages.js";
import { createDocument } from "../documents/create.js";
import { changeAnswer, changeArgsOf } from "../changes/resolve.js";
import { docAgentInstructions, docAgentInstructionsOrNone, docInstructionLabelsOrNone } from "../documents/instructions.js";
import {
  MediaValidationError,
  decodeBase64Image,
  fetchRemoteFile,
  imageUploadLimits,
  mediaUrl,
  sniffImageMime,
  storeFile,
  storeImage,
} from "../media/media.js";
import { createMediaUpload, takeMediaUpload } from "../media/uploads.js";
import { landsIn, netChanges, relevance, waitsFor, type NetChange, type NetOfRun, type PassageOf } from "./waiting.js";
import { docWikiLinks, wikiIndex, wikiLint, wikiLog } from "../wiki/wiki.js";
import { WIKI_LOG_PAGE_MAX } from "@stuga/agent-surface/catalog";

/** Max page before the caller's own runs are picked out: a busy database's newest runs may all be someone else's. */
const RUNS_PAGE = 50;
/** Pages an agent's index or check lists, and pages linking to a document its metadata names. */
const AGENT_INDEX_PAGES = 300;
const AGENT_LINT_PAGES = 100;
const AGENT_LINKED_FROM = 50;

const NOT_FOUND = { error: "not found or no access" };

/** The tools' data access in the one workspace `ctx` resolved to. */
export function nodeBackend(ctx: Ctx): AgentBackend {
  /** A database the caller may change, or the refusal. */
  const writableDatabase = async (databaseId: string): Promise<DocRow | { error: string }> => {
    const doc = await authorizedDatabase(ctx, databaseId);
    if (!doc) return NOT_FOUND;
    if (!canWriteDoc(ctx, doc)) return { error: "no write access to this database" };
    if (doc.locked) return { error: "this database is locked; the user must unlock it first" };
    return doc;
  };

  /** A document or database the caller may add a file to, or the refusal: an upload is a write, gated as an edit is. */
  const uploadTarget = async (docId: string): Promise<DocRow | { error: string }> => {
    const doc = await getDoc(ctx.sql, docId);
    if (!doc || doc.trashed || !canReadDoc(ctx, doc)) return { error: `document ${docId} not found` };
    if (!canWriteDoc(ctx, doc)) return { error: `no write access to ${docId}` };
    if (doc.locked) return { error: `${doc.doc_type === "database" ? "database" : "document"} ${docId} is locked; unlock it to add files` };
    return doc;
  };

  const actorJson = async <T>(res: Response, fallback: string): Answer<T> => {
    const body = (await res.json().catch(() => null)) as (T & { message?: string }) | null;
    if (!res.ok || body === null) return { error: body?.message ?? fallback };
    return body;
  };

  return {
    origin: ctx.servedOrigin,

    wikiIndex: (parentId) => wikiIndex(ctx, { folderId: parentId, limit: AGENT_INDEX_PAGES }),
    wikiLog: (before, limit) => wikiLog(ctx, { before, limit: Math.min(Math.max(limit, 1), WIKI_LOG_PAGE_MAX) }),
    wikiLint: (parentId) => wikiLint(ctx, { folderId: parentId, limit: AGENT_LINT_PAGES }),

    async workspaceInstructions() {
      const ws = await getWorkspace(ctx.sql, ctx.workspaceId);
      return { workspace_id: ctx.workspaceId, name: ws?.name ?? "", instructions: ws?.agent_instructions ?? "" };
    },

    async listDocs(parentId) {
      const docs = await listDocs(ctx.sql, ctx.principals, ctx.workspaceId, {
        scopeFolderIds: scopeFolderIds(ctx),
        ...(parentId !== undefined ? { parentId } : {}),
      });
      return docs.map((d) => ({ doc_id: d.doc_id, title: d.title, doc_type: d.doc_type, parent_id: d.parent_id, updated_at: d.updated_at }));
    },

    async searchDocs(query) {
      // An agent's search falls back to the pages holding some of its words, said to be partial.
      const answer = orCollectionNotFound(await searchDocuments(ctx, query, { anyWordFallback: true }));
      if ("error" in answer) return answer;
      const [results, rows] = await Promise.all([withAuthorship(ctx, answer.results, query.q, null), rowsOf(ctx, query)]);
      return { ...answer, results, ...rows };
    },

    async docMetadata(docId) {
      const doc = await getDoc(ctx.sql, docId);
      if (!doc || !canReadDoc(ctx, doc)) return { error: "not found" };
      const review = resolveReviewMode(ctx, doc);
      const links = await docWikiLinks(ctx, doc, { limit: AGENT_LINKED_FROM, paths: false });
      return {
        doc_id: doc.doc_id,
        title: doc.title,
        doc_type: doc.doc_type,
        updated_at: doc.updated_at,
        locked: doc.locked,
        search_hidden: doc.search_hidden,
        review: { mode: review.mode, reason: review.reason },
        // Only pages the caller can read; the others are neither named nor counted.
        linked_from: links.linked_from.map((p) => ({ doc_id: p.doc_id, title: p.title, kinds: p.kinds })),
        ...(links.linked_from_truncated ? { linked_from_truncated: true } : {}),
        needs_checking: links.needs_checking,
        ...(await docAgentInstructions(ctx, doc)),
      };
    },

    async createDoc(input) {
      const out = await createDocument(ctx, {
        title: input.title,
        docType: input.doc_type,
        parentId: input.parent_id,
        table: input.table,
        columns: input.columns,
        change: changeArgsOf(input),
      });
      if (!out.ok) return { error: out.message };
      // The document exists now: a failed lookup must not read as a failed create, or the agent makes another.
      return {
        doc_id: out.doc.doc_id,
        title: out.doc.title,
        ...changeAnswer(out.change ?? null),
        ...(out.held ? { held: true } : {}),
        ...(await docAgentInstructionsOrNone(ctx, out.doc)),
      };
    },

    async readMarkdown(docId) {
      const md = await readDocMarkdownWithProjection(ctx, docId);
      if (!md) return NOT_FOUND;
      if (md === "database") return { error: databaseDocMessage(docId) };
      return {
        markdown: md.markdown,
        run_id: md.runId ?? null,
        pending: md.pending ?? 0,
        ...(await waitingInRead(ctx, md)),
        ...(md.feedback ? { feedback: md.feedback } : {}),
        ...(await docAgentInstructions(ctx, md.doc)),
      };
    },

    async docRuns(docId) {
      const runs = await readDocRuns(ctx, docId);
      if (runs === "database") return { error: databaseDocMessage(docId) };
      if (!runs) return NOT_FOUND;
      return runs.filter((r) => r.agent_alias === ctx.alias);
    },

    async provenance(docId) {
      const out = await readDocProvenance(ctx, docId);
      if (out === null) return NOT_FOUND;
      if (out === "database") return { error: databaseDocMessage(docId) };
      return out;
    },

    async propose(docId, input) {
      const outcome = await proposeDocEdit(ctx, {
        docId,
        action: input.action,
        text: input.text,
        heading: input.heading ?? null,
        find: input.find,
        replace: input.replace,
        replaceAll: input.replace_all,
        edits: input.edits,
        citations: input.citations,
        revises: input.revises,
        source: "connector",
        change: changeArgsOf(input),
      });
      if (outcome.kind === "error") return { error: outcome.message };
      const answer = proposeBody(outcome, `${ctx.servedOrigin}/doc/${docId}`);
      if (outcome.kind === "noop") return answer;
      return { ...answer, ...(await docInstructionLabelsOrNone(ctx, outcome.doc)) };
    },

    async uploadMedia(docId, source) {
      const doc = await uploadTarget(docId);
      if ("error" in doc) return doc;
      const database = doc.doc_type === "database";
      try {
        let bytes: Uint8Array;
        let name: string | undefined;
        if (source.kind === "upload_id") {
          const taken = await takeMediaUpload(ctx, doc, source.upload_id);
          if ("error" in taken) return taken;
          ({ bytes, name } = taken);
        } else if (source.kind === "data") {
          bytes = decodeBase64Image(source.data, "file");
          if (bytes.byteLength > MAX_INLINE_IMAGE_BYTES) {
            return { error: `too large to send inline (max ${Math.floor(MAX_INLINE_IMAGE_BYTES / (1024 * 1024))} MB): use action:start_upload or upload_from_url` };
          }
          name = source.name;
        } else {
          const fetched = await fetchRemoteFile(source.url, imageUploadLimits(ctx.env.settings.current().maxBodyBytes).bytes);
          bytes = fetched.bytes;
          name = source.name ?? fetched.name;
        }
        // The bytes name their own type; a model-declared mime is wrong too often to ask for one. A
        // document shows an image; anything else, and whatever a database holds, is a file by its name.
        const image = sniffImageMime(bytes);
        if (image && !database) {
          const stored = await storeImage(ctx.env.media, doc.workspace_id, bytes, image);
          return { url: mediaUrl(docId, stored.hash), hash: stored.hash, size: stored.size, mime: stored.mime };
        }
        if (!name?.trim()) return { error: "name the file: pass `name`, such as report.pdf" };
        const stored = await storeFile(ctx.env.media, doc.workspace_id, bytes, name, database ? docId : undefined);
        return { url: mediaUrl(docId, stored.hash, stored.name), hash: stored.hash, size: stored.size, mime: stored.mime, name: stored.name, ...(database ? { database: true as const } : {}) };
      } catch (e) {
        if (e instanceof MediaValidationError) return { error: e.message };
        return { error: `upload failed: ${e instanceof Error ? e.message : String(e)}` };
      }
    },

    async startUpload(docId, name) {
      const doc = await uploadTarget(docId);
      if ("error" in doc) return doc;
      return createMediaUpload(ctx, doc, name);
    },

    async listComments(docId) {
      const doc = await getDoc(ctx.sql, docId);
      if (!doc || !canReadDoc(ctx, doc)) return { error: "not found" };
      return { comments: markYours(ctx, await listComments(ctx.sql, docId)) };
    },

    async addComment(docId, { body, parent_num, quote }) {
      const doc = await getDoc(ctx.sql, docId);
      if (!doc || !canReadDoc(ctx, doc)) return { error: "not found" };
      if (!canCommentDoc(ctx, doc)) return { error: "no comment access" };
      const input = commentInput({ body, parent_num, quote });
      if (typeof input === "string") return { error: input };
      const out = await postComment(ctx, doc, input);
      if (isCommentRefusal(out)) return { error: out.error };
      return { ...out.comment, ...(out.suppressed > 0 ? { notifications_held: out.suppressed } : {}) };
    },

    async listFolders() {
      // Summaries, as REST lists them: no grants, and no instructions (those come with the items beneath).
      const folders = await listFolders(ctx.sql, ctx.principals, ctx.workspaceId, undefined, { scopeFolderIds: scopeFolderIds(ctx) });
      return { folders: folders.map(folderSummary) };
    },

    async pollEvents({ after, types, limit, mine }) {
      const latest = await latestWorkspaceEventId(ctx.sql, ctx.workspaceId);
      // No cursor means "from now": the whole retained history does not belong in the agent's context. An agent
      // asking after its own decisions gets the recent ones, or it misses what was decided while it was away.
      const lookback = mine && after === undefined;
      const start = after ?? (lookback ? 0 : latest);
      const events = await listWorkspaceEvents(ctx.sql, {
        workspaceId: ctx.workspaceId,
        principals: ctx.principals,
        after: start,
        // An agent's own: decisions on its runs, and replies in comment threads it started.
        types: mine && !types?.length ? ["run.decided", "run.reverted", "run.reopened", "comment.added"] : types,
        scopeFolderIds: scopeFolderIds(ctx),
        // Its own replies are left out by the actor its events carry, which for a person is `user:<alias>`.
        ...(mine ? { agentAlias: ctx.alias, selfActor: eventActorOf(ctx) } : {}),
        ...(lookback ? { since: new Date(Date.now() - RUN_FEEDBACK_LOOKBACK_DAYS * 86_400_000) } : {}),
        limit: limit ?? 50,
      });
      return {
        events: events.map((e) => ({ id: Number(e.id), at: e.at, type: e.type, doc_id: e.doc_id, actor: e.actor, actor_kind: e.actor_kind, payload: e.payload })),
        cursor: events.length > 0 ? Number(events[events.length - 1]!.id) : lookback ? latest : start,
        latest,
      };
    },

    listCollections: () => listPersonCollections(ctx),
    openCollection: async (collectionId) => refusalText(await openCollection(ctx, collectionId)),
    createCollection: async (name) => refusalText(await createPersonCollection(ctx, name)),
    renameCollection: async (collectionId, name) => refusalText(await renamePersonCollection(ctx, collectionId, name)),
    deleteCollection: async (collectionId) => refusalText(await deletePersonCollection(ctx, collectionId)),
    changeCollectionItems: async (collectionId, change, items) =>
      refusalText(await changePersonCollectionItems(ctx, collectionId, change, { docIds: items.doc_ids, folderIds: items.folder_ids })),

    async retrieve(query) {
      // With embeddings off, an agent still gets passages, found by their words.
      const answer = orCollectionNotFound(await retrievePassages(ctx, query, { keywordWhenOff: true }));
      if ("error" in answer) return answer;
      const [chunks, rows] = await Promise.all([withAuthorship(ctx, answer.chunks, query.q, (c) => c), rowsOf(ctx, query)]);
      return { ...answer, chunks, ...rows };
    },

    async databaseSchema(databaseId, opts) {
      const doc = await authorizedDatabase(ctx, databaseId);
      if (!doc) return NOT_FOUND;
      const [res, instructions] = await Promise.all([
        callDatabaseActor(ctx, databaseId, `schema?agent=${encodeURIComponent(ctx.alias)}`, null, "GET"),
        opts?.instructions === false ? {} : docAgentInstructions(ctx, doc),
      ]);
      const schema = await actorJson<DatabaseSchema>(res, "could not load the database schema");
      return "error" in schema ? schema : { ...schema, ...instructions };
    },

    async databaseRuns(databaseId) {
      if (!(await authorizedDatabase(ctx, databaseId))) return NOT_FOUND;
      const res = await callDatabaseActor(ctx, databaseId, `runs?limit=${RUNS_PAGE}`, null, "GET");
      const body = await actorJson<{ runs: DatabaseRunSummary[] }>(res, "could not load run status");
      if ("error" in body) return body;
      return body.runs.filter((r) => r.agent_alias === ctx.alias);
    },

    async mutateDatabase(databaseId, mutation) {
      const doc = await writableDatabase(databaseId);
      if ("error" in doc) return doc;
      // A write needs no schema read, so the answer names what governs this database; the schema carries the text.
      const labels = () => docInstructionLabelsOrNone(ctx, doc);
      const change = changeArgsOf(mutation);
      if (mutation.action === "create_table" && mutation.columns?.length) {
        const specs = parseColumnSpecs(mutation.columns);
        if (!specs.ok) return { error: specs.message };
        return proposeAnswer(await proposeTableWithColumns(ctx, doc, mutation.display, specs.columns, "connector", { revises: mutation.revises, change }), await labels());
      }
      return proposeAnswer(await proposeDatabaseOp(ctx, doc, databaseOp(mutation), "connector", { revises: mutation.revises, change }), await labels());
    },

    async openRowPage(databaseId, tableId, rowId) {
      const doc = await authorizedDatabase(ctx, databaseId);
      if (!doc) return NOT_FOUND;
      const out = await openRowPage(ctx, doc, tableId, rowId);
      if (out.kind === "error") return { error: out.message };
      return { doc_id: out.doc_id, created: out.created, restored: out.restored };
    },

    async findRowPage(databaseId, tableId, rowId) {
      const doc = await authorizedDatabase(ctx, databaseId);
      if (!doc) return NOT_FOUND;
      const out = await findRowPage(ctx, doc, tableId, rowId);
      return out.kind === "error" ? { error: out.message } : { doc_id: out.doc_id };
    },

    async startImport(databaseId, tableId, format) {
      const doc = await writableDatabase(databaseId);
      if ("error" in doc) return doc;
      const staged = await createDatabaseImport(ctx, doc, tableId, format);
      if ("error" in staged) return { error: staged.error };
      const { import_id, upload_url, upload_path, max_bytes, expires_at, import_page_url } = staged.ticket;
      return { import_id, upload_url, upload_path, max_bytes, expires_at, import_page_url };
    },

    async importRows(databaseId, tableId, source, options): Answer<ImportOutcome> {
      const doc = await writableDatabase(databaseId);
      if ("error" in doc) return doc;
      const opts = parseCommitOptions({ ...options });
      if ("error" in opts) return opts;
      if (source.kind === "import_id") return commitDatabaseImport(ctx, doc, source.import_id, opts, "connector");
      const handOff = (why: string): ImportOutcome => ({ hand_off: { page_url: importPageUrl(ctx.servedOrigin, databaseId, tableId!), why } });
      if (source.content.length > DATABASE_IMPORT_INLINE_MAX_CHARS) {
        return handOff(`That is ${source.content.length} characters, past the ${DATABASE_IMPORT_INLINE_MAX_CHARS} a tool call may carry.`);
      }
      const staged = await createDatabaseImport(ctx, doc, tableId, source.format ?? "csv");
      if ("error" in staged) return { error: staged.error };
      const body = await stageInlineImport(ctx, doc, staged.ticket.import_id, source.content);
      if (body.status >= 400) return handOff(String(body.body.error));
      return commitDatabaseImport(ctx, doc, staged.ticket.import_id, opts, "connector");
    },

    async query(databaseId, sql, params) {
      if (!(await authorizedDatabase(ctx, databaseId))) return NOT_FOUND;
      const res = await callDatabaseActor(ctx, databaseId, "query", { sql, params });
      return actorJson<Record<string, unknown>>(res, "query failed");
    },

    planRemember: (points) => planRemember(ctx, points),
  };
}

/**
 * The rows of tables a recall's words reach, beside its documents or passages: an agent's alone, so a person's
 * answers stay as they are. Within the collection the call names. Best-effort: without them the answer stands.
 */
async function rowsOf(ctx: Ctx, query: { q: string; collection_id?: string }): Promise<Pick<RetrieveBody, "rows" | "rows_more" | "tables_waiting" | "tables">> {
  try {
    const scope = await collectionScope(ctx, query.collection_id);
    if (scope === "not-found") return {};
    const { rows, rows_more, tables_waiting, tables } = await recallRows(ctx, query.q, { scopeDocIds: scope });
    return {
      ...(rows.length > 0 ? { rows, tables } : {}),
      ...(rows_more.length > 0 ? { rows_more } : {}),
      ...(tables_waiting.length > 0 ? { tables_waiting } : {}),
    };
  } catch (e) {
    console.warn("[node] the rows a recall found are unavailable", { err: e instanceof Error ? e.message : String(e) });
    return {};
  }
}

/** One of the user's own waiting changes, as it would land, in its run's order. */
interface OwnChange {
  net: NetChange;
  order: number;
}

/** Waiting changes at one level, asked for by one side; the user's own carry what they change, read from their runs. */
type Group = WaitingChanges & { own?: OwnChange[] };

/**
 * Waiting runs by who asked for them and the level they wait at now: the user's own first, the colleague's level
 * first within each. A run of the user's own that `read` holds counts its changes as they would land, a change to
 * another of its changes one with it; any other run counts its pending hunks. A group nothing would change is left out.
 */
function waitingByLevel(runs: readonly WaitingRun[], itemNow: ReviewMode, person: string, read: ReadonlyMap<string, NetOfRun> = new Map()): Group[] {
  const by = new Map<string, Group>();
  let order = 0;
  for (const run of runs) {
    const asked: AskedBy = run.reviewer === person ? "user" : "others";
    const net = asked === "user" ? read.get(run.run_id) : undefined;
    const count = net ? net.changes.length + net.unread : run.pending;
    const level = waitsFor(run.review_mode, itemNow);
    const key = `${asked}:${level}`;
    let kept = by.get(key);
    if (kept) {
      kept.changes += count;
      if (run.created_at < kept.since) kept.since = run.created_at;
    } else {
      kept = { asked_by: asked, waits_for: level, changes: count, since: run.created_at };
      by.set(key, kept);
    }
    if (net?.changes.length) kept.own = [...(kept.own ?? []), ...net.changes.map((c) => ({ net: c, order: order++ }))];
  }
  return (["user:colleague", "user:review", "others:colleague", "others:review"] as const).flatMap((key) => {
    const kept = by.get(key);
    return kept && kept.changes > 0 ? [kept] : [];
  });
}

/** Characters of each side of a pending change an agent's read quotes; past it, the text is cut with "…". */
const PENDING_TEXT_MAX = 1_000;
/** Characters of each side of one of the user's waiting changes a recall answer or a read's tally lists. */
const PROPOSED_TEXT_MAX = 200;
/** The user's own waiting changes listed per document, at most, those about the question first; the rest are counted. */
const OWN_CHANGES_MAX = 6;
/** Documents per recall answer whose waiting changes by the user's agents are read and listed; the rest are counted. */
const OWN_DOCS_MAX = 10;

const quoteCut = (text: string, max = PENDING_TEXT_MAX): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** One of the user's own waiting changes as an answer lists it. */
function proposedOf(net: NetChange, section?: string): ProposedChange {
  return {
    approved_now: quoteCut(net.approvedNow, PROPOSED_TEXT_MAX),
    after_approval: quoteCut(net.afterApproval, PROPOSED_TEXT_MAX),
    ...(section !== undefined ? { section } : {}),
  };
}

/**
 * A group as an answer carries it: what it lists, and, in a recall answer, a note when that is not all of them
 * (`where` "passage": listed by the passage they land in). A read's tally counts them itself.
 */
function shownGroup({ own: _own, ...group }: Group, proposed: ProposedChange[], where: "passage" | "document" | "read"): WaitingChanges {
  if (group.asked_by !== "user") return group;
  const listed = proposed.length > 0 ? { proposed } : {};
  if (proposed.length >= group.changes || where === "read") return { ...group, ...listed };
  return { ...group, ...listed, note: `${proposed.length} of ${group.changes} listed${where === "passage" ? " here" : ""}; read the page for the rest.` };
}

/** The document's text as everyone but an agent with pending hunks reads it, or null when it cannot be read. */
async function approvedText(ctx: Ctx, docId: string): Promise<string | null> {
  const res = await ctx.env.docs.get(docId).fetch(`http://actor/markdown?docId=${encodeURIComponent(docId)}`);
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as { markdown?: unknown } | null;
  return typeof body?.markdown === "string" ? body.markdown : null;
}

/**
 * The changes of the user's own waiting runs on a document, as each would land on `approved` (read from the
 * document's actor when not given), by run. Best-effort: a run whose changes cannot be read is counted without them.
 */
async function listOwnChanges(ctx: Ctx, docId: string, runs: readonly WaitingRun[], approved?: string): Promise<Map<string, NetOfRun>> {
  const out = new Map<string, NetOfRun>();
  if (runs.length === 0) return out;
  try {
    const base = approved ?? (await approvedText(ctx, docId));
    if (base === null) return out;
    await Promise.all(
      runs.map(async (run) => {
        const res = await ctx.env.docs
          .get(docId)
          .fetch(`http://actor/runs/detail?docId=${encodeURIComponent(docId)}&runId=${encodeURIComponent(run.run_id)}&full=1`);
        if (!res.ok) return;
        const body = (await res.json().catch(() => null)) as { hunks?: Array<{ old_string?: string; new_string?: string; status?: string }> } | null;
        const pending = (body?.hunks ?? []).flatMap((h) =>
          h.status === "pending" && typeof h.old_string === "string" && typeof h.new_string === "string" ? [{ old_string: h.old_string, new_string: h.new_string }] : [],
        );
        out.set(run.run_id, netChanges(base, pending));
      }),
    );
  } catch (e) {
    console.warn("[node] a waiting run's changes are unavailable", { docId, err: e instanceof Error ? e.message : String(e) });
  }
  return out;
}

/**
 * What waits in an agent's read: its own changes laid over the text, each as it would land on the approved text
 * (an edit to another of them one with it) and who approves it; then the other changes waiting, which are not in
 * the text at all: those the user asked for through another of their agents listed, others' counted. Best-effort:
 * a read stands without it.
 */
async function waitingInRead(ctx: Ctx, md: ProjectedMarkdown): Promise<Pick<MarkdownBody, "pending_changes" | "pending_since" | "others_waiting">> {
  const itemNow = effectiveReviewLevel(md.doc);
  const hunks = md.pendingHunks ?? [];
  let own: PendingChange[] = [];
  let approved: string | null = hunks.length > 0 ? (md.approvedMarkdown ?? null) : md.markdown;
  let others: WaitingChanges[] = [];
  try {
    if (approved === null) approved = await approvedText(ctx, md.doc.doc_id);
    if (hunks.length > 0) {
      const level = hunks
        .map((h) => (h.review === "auto" ? (md.runReviewMode ?? "review") : h.review))
        .reduce((a, b) => stricterReviewMode(a, b));
      const waits = waitsFor(level, itemNow);
      own =
        approved === null
          ? // Without the approved text, each hunk as it was proposed.
            hunks.map((h) => ({ approved_now: quoteCut(h.old_string), after_approval: quoteCut(h.new_string), waits_for: waits }))
          : netChanges(approved, hunks).changes.map((c) => ({
              approved_now: quoteCut(c.approvedNow),
              after_approval: quoteCut(c.afterApproval),
              ...(c.addsAfter !== undefined ? { adds_after: c.addsAfter } : {}),
              ...(c.addsBefore !== undefined ? { adds_before: c.addsBefore } : {}),
              waits_for: waits,
            }));
    }
    const person = personOf(ctx);
    const runs = ((await waitingRuns(ctx.sql, ctx.workspaceId, [md.doc.doc_id])).get(md.doc.doc_id) ?? []).filter((r) => r.agent_alias !== ctx.alias);
    const read = await listOwnChanges(ctx, md.doc.doc_id, runs.filter((r) => r.reviewer === person), approved ?? undefined);
    // In the order their runs have them: a read answers no question.
    others = waitingByLevel(runs, itemNow, person, read).map((g) =>
      shownGroup(g, (g.own ?? []).slice(0, OWN_CHANGES_MAX).map((c) => proposedOf(c.net)), "read"),
    );
  } catch (e) {
    console.warn("[node] the changes waiting in a document are unavailable", { err: e instanceof Error ? e.message : String(e) });
  }
  return {
    ...(own.length > 0 ? { pending_changes: own, ...(md.runCreatedAt ? { pending_since: md.runCreatedAt } : {}) } : {}),
    ...(others.length > 0 ? { others_waiting: others } : {}),
  };
}

/**
 * Search hits or passages with who last changed each document, and what AI changes to it wait for approval, which an
 * agent cites and a person's REST answer leaves out: the changes the user asked for (through this agent or another
 * of theirs) listed as they would land, the approved text each changes now beside what it reads after approval, so
 * one answer can say "the page says 14 days; a change to 30 days waits for a colleague"; others' counted. Those
 * holding the most words of `query` come first, at most OWN_CHANGES_MAX a document, and a note says when some are
 * left out. With `passageOf`, passages: each listed change goes on the passage it lands in; one that lands in no
 * passage found is listed on the document's first, naming its section, only when it holds a word of the query.
 * Best-effort: without it the answer still stands, as it would have before.
 */
async function withAuthorship<T extends { doc_id: string }>(
  ctx: Ctx,
  items: T[],
  query: string,
  passageOf: ((item: T) => PassageOf) | null,
): Promise<Array<T & Authorship>> {
  if (items.length === 0) return items;
  try {
    const known = await docAuthorship(ctx.sql, ctx.workspaceId, [...new Set(items.map((i) => i.doc_id))]);
    const person = personOf(ctx);
    // The user's own waiting runs are read from their documents' actors, the first few documents only.
    const ownDocs = [...known.values()].filter((a) => a.waiting.some((r) => r.reviewer === person)).slice(0, OWN_DOCS_MAX);
    const read = new Map<string, NetOfRun>();
    await Promise.all(
      ownDocs.map(async (a) => {
        for (const [runId, net] of await listOwnChanges(ctx, a.doc_id, a.waiting.filter((r) => r.reviewer === person))) read.set(runId, net);
      }),
    );
    /** Per item, per group of its document, the changes listed on it. */
    const listedOn = new Map<number, Map<Group, ProposedChange[]>>();
    const groups = new Map<string, Group[]>();
    for (const a of known.values()) {
      const docGroups = waitingByLevel(a.waiting, effectiveReviewLevel(a.level), person, read);
      groups.set(a.doc_id, docGroups);
      const at = items.flatMap((x, i) => (x.doc_id === a.doc_id ? [i] : []));
      const ranked = docGroups
        .flatMap((group) => (group.own ?? []).map((own) => ({ group, own, score: relevance(query, own.net) })))
        .sort((x, y) => y.score - x.score || x.own.order - y.own.order)
        .slice(0, OWN_CHANGES_MAX);
      const placed = ranked.flatMap(({ group, own, score }) => {
        if (!passageOf) return [{ group, index: at[0]!, change: proposedOf(own.net), here: true }];
        const lands = landsIn(own.net, at.map((i) => passageOf(items[i]!)));
        if (lands >= 0) return [{ group, index: at[lands]!, change: proposedOf(own.net), here: true }];
        return score > 0 ? [{ group, index: at[0]!, change: proposedOf(own.net, own.net.section), here: false }] : [];
      });
      // On each passage, the changes that land in it first.
      for (const { group, index, change } of [...placed.filter((p) => p.here), ...placed.filter((p) => !p.here)]) {
        const onItem = listedOn.get(index) ?? new Map<Group, ProposedChange[]>();
        onItem.set(group, [...(onItem.get(group) ?? []), change]);
        listedOn.set(index, onItem);
      }
    }
    return items.map((item, index) => {
      const a = known.get(item.doc_id);
      if (!a) return item;
      const ai_edits = a.ai_changes === 0 ? "none" : a.ai_unreviewed > 0 ? "unreviewed" : "reviewed";
      const waiting = (groups.get(item.doc_id) ?? []).map((g) => shownGroup(g, listedOn.get(index)?.get(g) ?? [], passageOf ? "passage" : "document"));
      return {
        ...item,
        updated_at: a.updated_at,
        last_edited_by: a.last_edited_by,
        ai_edits,
        ...(waiting.length > 0 ? { pending_changes: waiting } : {}),
      };
    });
  } catch (e) {
    console.warn("[node] who wrote the documents a recall found is unavailable", { err: e instanceof Error ? e.message : String(e) });
    return items;
  }
}

/** The actor op one mutation proposes. */
function databaseOp(m: DatabaseMutation): Record<string, unknown> {
  switch (m.action) {
    case "create_table":
      return { kind: "tables.create", display: m.display };
    case "add_column":
      return { kind: "columns.add", table: m.table_id, display: m.display, type: m.type, choices: m.choices, description: m.description };
    case "insert_rows":
      return { kind: "rows.insert", table: m.table_id, rows: m.rows };
    case "update_rows":
      return { kind: "rows.update", table: m.table_id, updates: m.updates };
    case "delete_rows":
      return { kind: "rows.delete", table: m.table_id, row_ids: m.row_ids };
    case "create_view":
      return { kind: "views.create", table: m.table_id, ...viewOpFields(m.view) };
    case "update_view":
      return { kind: "views.update", table: m.table_id, view: m.view_id, ...viewOpFields(m.changes) };
  }
}

function viewOpFields({ kind, ...rest }: ViewShape): Record<string, unknown> {
  return kind === undefined ? rest : { ...rest, view_kind: kind };
}

function proposeAnswer(
  outcome: DatabaseProposeOutcome,
  instructions: ProposeInstructionLabels = {},
): DatabaseProposeBody | { error: string } {
  return outcome.kind === "error" ? { error: outcome.message } : { ...databaseProposeBody(outcome), ...instructions };
}

function refusalText<T extends object>(out: T | CollectionRefusal): T | { error: string } {
  return isCollectionRefusal(out) ? { error: out.error } : (out as T);
}

function orCollectionNotFound<T>(answer: T | "not-found"): T | { error: string } {
  return answer === "not-found" ? { error: "collection not found" } : answer;
}
