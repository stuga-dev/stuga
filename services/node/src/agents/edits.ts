/**
 * Agent edit proposals, the one write path an agent has into a document. Every
 * content write goes to the actor's `/runs/propose` with the review mode this
 * node resolved from the document's `agent_mode`: `review` parks pending hunks
 * for a person, `auto` applies at once, attributed and revertible. Shared by
 * the REST propose route and /mcp, so both run the same gates.
 */
import { getDoc, type DocRow } from "@stuga/db";
import { markdownByteLength, MAX_IMPORT_MARKDOWN_BYTES } from "@stuga/protocol/text/markdown-import";
import type { AgentRunSource, AgentRunSummary, AiCitation, AiStrEdit } from "@stuga/protocol/wire/doc-socket";
import type { ReviewMode } from "@stuga/protocol/domain/events";
import type { ProposeBody } from "@stuga/agent-surface/backend";
import { CITATIONS_MAX, CITED_EDITS_MAX } from "@stuga/agent-surface/catalog";
import { hostExternalImages, ingestNote, type HostedImage } from "../media/media-ingest.js";
import { recordAudit } from "../audit/record.js";
import type { Ctx } from "../auth/context.js";
import { canReadDoc, canWriteDoc, READ_ONLY_MESSAGE } from "../authz/authz.js";
import { resolveReviewMode } from "../authz/review-mode.js";

export interface ProposeInput {
  docId: string;
  action: "write" | "str_replace" | "append" | "cited_edits";
  /** write: the whole new document body. append: the text to add. */
  text?: string;
  /** append: add under this heading's section instead of at the end. */
  heading?: string | null;
  /** str_replace: the text to find, unique unless replaceAll. */
  find?: string;
  replace?: string;
  replaceAll?: boolean;
  /** cited_edits: surgical edits plus the citations the actor materializes as footnotes at commit time. */
  edits?: AiStrEdit[];
  citations?: AiCitation[];
  source: AgentRunSource;
}

export type ProposeOutcome =
  // `mediaNote` reports images hosted on the way in, and any that could not be:
  // a failed download is a note on a completed edit, never a failure of it.
  // `doc` is the row the write was authorized against, so an answer can name what applies to it without a re-read.
  | { kind: "proposed"; run: AgentRunSummary; pending: number; mediaNote?: string; review: ReviewMode; reason: string; doc: DocRow }
  | { kind: "auto_applied"; run: AgentRunSummary; seq: number; mediaNote?: string; review: ReviewMode; reason: string; doc: DocRow }
  | { kind: "noop" }
  | { kind: "error"; message: string; retryable?: boolean; status?: number };

/** Shown when the requested state already matches the document. */
export const NOOP_MESSAGE = "no changes: the document already matches the requested state.";

/** Shown when the doc moved under the proposal and none of its hunks still match. */
export const STALE_MESSAGE =
  "no changes applied: the document changed while writing. Re-read the document and retry your edit.";

const CITED_OLD_STRING_MAX = 1_000_000;
const CITATION_TITLE_MAX = 200;
const CITATION_HEADING_MAX = 500;
const CITATION_CONTENT_MAX = 1000;

/**
 * Validate a REST caller's cited_edits. The actor trusts the node, so this is
 * the gate: every edit anchors on a non-empty `old_string`, and citation text is
 * capped because it becomes footnotes.
 */
export function parseCitedEdits(
  edits: unknown,
  citations: unknown,
): { edits: AiStrEdit[]; citations: AiCitation[] } | { error: string } {
  if (!Array.isArray(edits) || edits.length === 0) return { error: "cited_edits requires a non-empty `edits` array" };
  if (edits.length > CITED_EDITS_MAX) return { error: `cited_edits accepts at most ${CITED_EDITS_MAX} edits` };
  const cleanEdits: AiStrEdit[] = [];
  for (const e of edits) {
    if (!e || typeof e !== "object") return { error: "each edit must be an object with `old_string` and `new_string`" };
    const { old_string, new_string } = e as Record<string, unknown>;
    if (typeof old_string !== "string" || old_string === "" || typeof new_string !== "string") {
      return { error: "each edit needs a non-empty `old_string` and a string `new_string`" };
    }
    if (old_string.length > CITED_OLD_STRING_MAX) return { error: "an edit's `old_string` is too long" };
    cleanEdits.push({ old_string, new_string });
  }
  const cleanCitations: AiCitation[] = [];
  if (citations !== undefined && citations !== null) {
    if (!Array.isArray(citations)) return { error: "`citations` must be an array" };
    if (citations.length > CITATIONS_MAX) return { error: `cited_edits accepts at most ${CITATIONS_MAX} citations` };
    for (const c of citations) {
      if (!c || typeof c !== "object") return { error: "each citation must be an object" };
      const { n, doc_id, title, heading_path, content } = c as Record<string, unknown>;
      if (!Number.isInteger(n) || (n as number) < 1) return { error: "each citation needs a positive integer `n`" };
      if (typeof doc_id !== "string" || !doc_id) return { error: "each citation needs a `doc_id`" };
      if (typeof title !== "string") return { error: "each citation needs a string `title`" };
      if (heading_path != null && typeof heading_path !== "string") return { error: "`heading_path` must be a string" };
      if (content !== undefined && typeof content !== "string") return { error: "`content` must be a string" };
      cleanCitations.push({
        n: n as number,
        doc_id,
        title: title.slice(0, CITATION_TITLE_MAX),
        heading_path: typeof heading_path === "string" ? heading_path.slice(0, CITATION_HEADING_MAX) : null,
        content: typeof content === "string" ? content.slice(0, CITATION_CONTENT_MAX) : "",
      });
    }
  }
  return { edits: cleanEdits, citations: cleanCitations };
}

/** Shown when the run's stored contents can't be read, so nothing was changed. */
export const LEDGER_UNAVAILABLE_MESSAGE =
  "no changes applied: this document's edit ledger is temporarily unavailable. Try again shortly.";

/** The actor's propose response. */
interface ProposeResponse {
  mode?: "proposed" | "auto_applied" | "noop";
  run?: AgentRunSummary;
  pending?: number;
  seq?: number;
  /** The actor parked an `auto` proposal because the run holds undecided work. */
  parked_behind_pending?: boolean;
  error?: string;
  count?: number;
  message?: string;
}

/** Why an `auto` document parked this one anyway. */
const HELD_REASON =
  "this document applies agent changes at once, but your earlier changes in this run are still waiting for the user";

function docActor(ctx: Ctx, docId: string) {
  return ctx.env.docs.get(docId);
}

/** The refusal for a Markdown call aimed at a database, naming the tools that work on one. */
export const databaseDocMessage = (docId: string): string =>
  `${docId} is a structured database, not a prose document — use the \`databases\` tool ` +
  `(schema/rows) and the \`query\` tool (read-only SQL) to work with it`;

const tooLarge = (): ProposeOutcome => ({
  kind: "error",
  message: `document too large (max ${Math.floor(MAX_IMPORT_MARKDOWN_BYTES / 1024)} KB)`,
  status: 413,
});

/**
 * Host every external image an edit carries, across a `write` body, a
 * `str_replace` replacement and each cited edit, with one cache. Sequential, so
 * the per-edit fetch cap counts in order.
 */
async function hostAgentImages(
  ctx: Ctx,
  workspaceId: string,
  docId: string,
  input: ProposeInput,
): Promise<{ text?: string; replace?: string; edits?: AiStrEdit[]; mediaNote?: string }> {
  const cache = new Map<string, string | { error: string }>();
  const hosted: HostedImage[] = [];
  const failures: Array<{ url: string; reason: string }> = [];
  let truncated = false;

  const run = async (md: string): Promise<string> => {
    if (!md.includes("![")) return md;
    const r = await hostExternalImages(ctx.env, workspaceId, docId, md, cache);
    hosted.push(...r.hosted);
    failures.push(...r.failures);
    truncated ||= r.truncated;
    return r.markdown;
  };

  const text = input.text == null ? input.text : await run(input.text);
  const replace = input.replace == null ? input.replace : await run(input.replace);
  let edits = input.edits;
  if (edits?.length) {
    const next: AiStrEdit[] = [];
    for (const e of edits) next.push({ ...e, new_string: await run(e.new_string) });
    edits = next;
  }

  const note = ingestNote(hosted, failures, truncated);
  return { text, replace, edits, mediaNote: note || undefined };
}

/**
 * Propose one edit: exists, not trashed, readable, writable, unlocked, within
 * the size cap; then hand the action, not a computed result, to the actor that
 * holds the live document.
 */
export async function proposeDocEdit(ctx: Ctx, input: ProposeInput): Promise<ProposeOutcome> {
  const { docId } = input;
  const doc = await getDoc(ctx.sql, docId);
  if (!doc || doc.trashed || doc.workspace_id !== ctx.workspaceId) {
    return { kind: "error", message: `document ${docId} not found`, status: 404 };
  }
  if (doc.doc_type !== "prose") {
    return { kind: "error", message: databaseDocMessage(docId), status: 400 };
  }
  if (!canReadDoc(ctx, doc)) return { kind: "error", message: `document ${docId} not found`, status: 404 };
  if (ctx.scope?.readOnly) return { kind: "error", message: READ_ONLY_MESSAGE, status: 403 };
  if (!canWriteDoc(ctx, doc)) {
    return { kind: "error", message: `no write access to ${docId}`, status: 403 };
  }
  if (doc.locked) {
    return { kind: "error", message: `document ${docId} is locked; unlock it to make changes`, status: 423 };
  }
  const review = resolveReviewMode(ctx, doc);

  // Before the size gate, since a `data:` image shrinks to a short path once
  // stored; after the ACL gates, so only a writer can make the node fetch a URL.
  const { text, replace, edits, mediaNote } = await hostAgentImages(ctx, doc.workspace_id, docId, input);

  if (input.action === "write" || input.action === "append") {
    if (text == null) return { kind: "error", message: `${input.action} requires \`text\``, status: 400 };
    if (markdownByteLength(text) > MAX_IMPORT_MARKDOWN_BYTES) return tooLarge();
  } else if (input.action === "cited_edits") {
    if (!edits?.length) return { kind: "error", message: "cited_edits requires `edits`", status: 400 };
    // The actor caps the result; this refuses an edit set that cannot fit.
    const added = edits.reduce((n, e) => n + markdownByteLength(e.new_string), 0);
    if (added > MAX_IMPORT_MARKDOWN_BYTES) return tooLarge();
  } else {
    if (!input.find) return { kind: "error", message: "str_replace requires a non-empty `find`", status: 400 };
    if (replace != null && markdownByteLength(replace) > MAX_IMPORT_MARKDOWN_BYTES) return tooLarge();
  }

  const res = await docActor(ctx, docId).fetch(`http://actor/runs/propose?docId=${encodeURIComponent(docId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: input.action,
      text,
      heading: input.heading ?? null,
      find: input.find,
      replace,
      replace_all: input.replaceAll,
      edits,
      citations: input.citations,
      source: input.source,
      review: review.mode,
      agent: ctx.displayName || ctx.alias,
      agent_alias: ctx.alias,
      client: ctx.client ?? null,
      model: ctx.model ?? null,
      // An agent's edits go to the human who issued its key; a person reviews their own.
      reviewer: ctx.isAgent ? ctx.onBehalfOf : ctx.alias,
      workspace_id: ctx.workspaceId,
      doc_title: doc.title ?? "",
    }),
  });
  const body = (await res.json().catch(() => null)) as ProposeResponse | null;

  if (res.ok) {
    if (body?.mode === "proposed" && body.run) {
      // A run holding undecided hunks parks even on an `auto` document.
      const held = body.parked_behind_pending === true;
      const mode: ReviewMode = held ? "review" : review.mode;
      const reason = held ? HELD_REASON : review.reason;
      recordAudit(ctx, {
        action: "doc.propose",
        targetKind: "doc",
        targetId: docId,
        targetLabel: doc.title,
        detail: { run_id: body.run.id, mode: "proposed", edit: input.action, pending: body.pending ?? 0, review: mode },
      });
      return { kind: "proposed", run: body.run, pending: body.pending ?? 0, mediaNote, review: mode, reason, doc };
    }
    if (body?.mode === "auto_applied" && body.run) {
      recordAudit(ctx, {
        action: "doc.propose",
        targetKind: "doc",
        targetId: docId,
        targetLabel: doc.title,
        detail: { run_id: body.run.id, mode: "auto_applied", edit: input.action, seq: body.seq ?? 0, review: review.mode },
      });
      return { kind: "auto_applied", run: body.run, seq: body.seq ?? 0, mediaNote, review: review.mode, reason: review.reason, doc };
    }
    if (body?.mode === "noop") return { kind: "noop" };
    return { kind: "error", message: "propose failed (unexpected response)", status: 502 };
  }

  if (res.status === 409) {
    if (body?.error === "not_found") {
      return input.action === "append"
        ? { kind: "error", message: "`heading` not found in the document", status: 409 }
        : { kind: "error", message: "`find` not found in the document", status: 409 };
    }
    if (body?.error === "ambiguous") {
      return input.action === "append"
        ? { kind: "error", message: `\`heading\` matches ${body.count ?? 0} headings — name a unique one`, status: 409 }
        : {
            kind: "error",
            message: `\`find\` matches ${body.count ?? 0} times — set replace_all:true or make it unique`,
            status: 409,
          };
    }
    // Stale: the document moved and no hunk still matches; the agent should re-read and retry.
    return { kind: "error", message: STALE_MESSAGE, retryable: true, status: 409 };
  }
  // The actor re-checks the lock at write time; one can land in between.
  if (res.status === 423) {
    return { kind: "error", message: `document ${docId} is locked; unlock it to make changes`, status: 423 };
  }
  if (res.status === 503) {
    return { kind: "error", message: LEDGER_UNAVAILABLE_MESSAGE, status: 503 };
  }
  if (res.status === 413) return tooLarge();
  return { kind: "error", message: `propose failed (${res.status})`, status: 502 };
}

/** A proposal that landed, as the wire body REST and /mcp answer with, its media note included. */
export function proposeBody(
  outcome: Exclude<ProposeOutcome, { kind: "error" }>,
  reviewUrl: string,
): ProposeBody & { review?: ReviewMode } {
  const note = outcome.kind !== "noop" && outcome.mediaNote ? { media_note: outcome.mediaNote } : {};
  switch (outcome.kind) {
    case "proposed":
      return { mode: "proposed", run: outcome.run, pending: outcome.pending, review: outcome.review, reason: outcome.reason, ...note };
    case "auto_applied":
      return {
        mode: "auto_applied",
        run: outcome.run,
        seq: outcome.seq,
        review: outcome.review,
        reason: outcome.reason,
        review_url: reviewUrl,
        ...note,
      };
    case "noop":
      return { mode: "noop", message: NOOP_MESSAGE };
  }
}

export interface ProjectedMarkdown {
  markdown: string;
  /** The row the read was authorized against, for callers that name or place what they read. */
  doc: DocRow;
  /** Present when the caller is an agent with an open run carrying pending hunks. */
  runId?: string;
  pending?: number;
}

/**
 * A document's live Markdown. An agent gets the projection with its own pending
 * hunks laid over, so it does not "fix" what it just proposed. Null when missing
 * or unreadable; "database" for a database.
 */
export async function readDocMarkdownWithProjection(
  ctx: Ctx,
  docId: string,
): Promise<ProjectedMarkdown | "database" | null> {
  const doc = await getDoc(ctx.sql, docId);
  if (!doc || doc.trashed) return null;
  if (!canReadDoc(ctx, doc)) return null;
  if (doc.doc_type !== "prose") return "database";
  let url = `http://actor/markdown?docId=${encodeURIComponent(docId)}`;
  if (ctx.isAgent) url += `&agent=${encodeURIComponent(ctx.alias)}`;
  const res = await docActor(ctx, docId).fetch(url);
  if (!res.ok) return null;
  const data = (await res.json().catch(() => null)) as {
    markdown?: string;
    run_id?: string;
    pending?: number;
  } | null;
  if (!data) return null;
  const out: ProjectedMarkdown = { markdown: data.markdown ?? "", doc };
  if (data.run_id) out.runId = data.run_id;
  if (data.pending) out.pending = data.pending;
  return out;
}

/** A document's run ledger. Null when missing or unreadable; "database" for a database, whose ledger is its own actor's. */
export async function readDocRuns(ctx: Ctx, docId: string): Promise<AgentRunSummary[] | "database" | null> {
  const doc = await getDoc(ctx.sql, docId);
  if (!doc || doc.trashed) return null;
  if (!canReadDoc(ctx, doc)) return null;
  if (doc.doc_type !== "prose") return "database";
  const res = await docActor(ctx, docId).fetch(`http://actor/runs?docId=${encodeURIComponent(docId)}`);
  if (!res.ok) return null;
  const data = (await res.json().catch(() => null)) as { runs?: AgentRunSummary[] } | null;
  return data?.runs ?? [];
}

/** One passage of the document that an agent put there, as the reader should know it. */
export interface ProvenancePassage {
  run_id: string;
  agent: string;
  agent_alias: string;
  /** How the passage landed: reviewed by a human, or applied without one. */
  landed: "accepted" | "auto_applied";
  /** True once a human has accepted it or dismissed the run's catch-up card. */
  reviewed: boolean;
  /** The passage, cut to a readable size. */
  excerpt: string;
}

/** Characters of each provenance excerpt. */
const PROVENANCE_EXCERPT_CHARS = 240;

/**
 * The agent-written passages still present in a document, with who wrote them
 * and whether a person has looked: every landed hunk whose text still occurs in
 * the live Markdown, newest run first. It lets an agent tell another agent's
 * unreviewed sentence from a person's.
 */
export async function readDocProvenance(
  ctx: Ctx,
  docId: string,
): Promise<{ passages: ProvenancePassage[]; pending_runs: number } | "database" | null> {
  const md = await readDocMarkdownWithProjection(ctx, docId);
  if (md === null || md === "database") return md;
  const runs = await readDocRuns(ctx, docId);
  if (runs === null || runs === "database") return runs;
  // The live text: an agent's own pending overlay is not in the document.
  const live = ctx.isAgent ? await liveMarkdown(ctx, docId) : md.markdown;
  const passages: ProvenancePassage[] = [];
  let pendingRuns = 0;
  for (const run of runs) {
    if (run.reverted) continue;
    if (run.status === "open" && run.hunks.some((h) => h.status === "pending")) pendingRuns++;
    for (const hunk of run.hunks) {
      if (hunk.status !== "accepted" && hunk.status !== "auto_applied") continue;
      const text = hunk.new_string;
      if (!text || !live.includes(text)) continue;
      passages.push({
        run_id: run.id,
        agent: run.agent,
        agent_alias: run.agent_alias,
        landed: hunk.status,
        reviewed: hunk.status === "accepted" || run.acknowledged,
        excerpt: text.length > PROVENANCE_EXCERPT_CHARS ? `${text.slice(0, PROVENANCE_EXCERPT_CHARS)}…` : text,
      });
    }
  }
  return { passages, pending_runs: pendingRuns };
}

/** The document as it is, with nobody's pending hunks laid over it. */
async function liveMarkdown(ctx: Ctx, docId: string): Promise<string> {
  const res = await docActor(ctx, docId).fetch(`http://actor/markdown?docId=${encodeURIComponent(docId)}`);
  if (!res.ok) return "";
  const data = (await res.json().catch(() => null)) as { markdown?: string } | null;
  return data?.markdown ?? "";
}
