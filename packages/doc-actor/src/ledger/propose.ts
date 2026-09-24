/**
 * Proposing one edit into a document's run ledger: the single place the
 * park-or-commit decision is made, shared by the node's propose route and the
 * in-app co-author.
 */
import type { AgentRunHunk, AgentRunSource, AgentRunSummary, AiCitation, AiStrEdit } from "@stuga/protocol/wire/doc-socket";
import { stricterReviewMode, type ReviewMode } from "@stuga/protocol/domain/events";
import { agentActorOf, newRunId, shouldCommit } from "@stuga/protocol/domain/runs";
import { markdownByteLength, MAX_IMPORT_MARKDOWN_BYTES } from "@stuga/protocol/text/markdown-import";
import {
  applyRenumberedStrEdits,
  applyStrEditsStrict,
  computeStrEdits,
  docToMarkdown,
  getStugaSchema,
  markdownToDoc,
} from "@stuga/crdt-ops";
import { appendMarkdown } from "../append.js";
import { PENDING_RUN_MAX, pendingOf, runBlobKey, type RunBody, type RunLedger } from "./run-store.js";

/**
 * What a caller asks for. `write`, `str_replace` and `append` are the MCP/REST
 * actions; `cited_edits` is the co-author's surgical edits plus citations,
 * applied to the ledger's own working copy and staging only the body.
 */
export type ProposeAction =
  | { action: "write"; text: string }
  | { action: "str_replace"; find: string; replace: string; replaceAll: boolean }
  | { action: "append"; text: string; heading: string | null }
  | { action: "cited_edits"; edits: AiStrEdit[]; citations: AiCitation[] };

export interface ProposeRunInput {
  op: ProposeAction;
  source: AgentRunSource;
  /** The document's `agent_mode` as the node resolved it. */
  review: ReviewMode;
  /**
   * Whether to tell the reviewer. Only the co-author's turn on this document opts
   * out — its reviewer is watching it stage; its cross-document proposals arrive
   * over the route and notify like any other.
   */
  notifyReviewer?: boolean;
  /** Display name on the run bar. */
  agent: string;
  /** Run identity: one open run per alias. */
  agentAlias: string;
  /** The human who decides this run. */
  reviewer: string;
  workspaceId: string;
  docTitle: string;
  /** Labels recorded on the run; the latest proposal's wins. */
  client?: string | null;
  model?: string | null;
}

export type ProposeRunResult =
  | { mode: "noop" }
  | { mode: "proposed"; run: AgentRunSummary; pending: number; parkedBehindPending?: boolean }
  | { mode: "auto_applied"; run: AgentRunSummary; seq: number }
  | { mode: "error"; status: number; error: string; message?: string; count?: number };

function appendHunks(body: RunBody, hunks: Array<{ old_string: string; new_string: string }>, review: ReviewMode): AgentRunHunk[] {
  const added: AgentRunHunk[] = hunks.map((h, i) => ({
    id: `h${body.hunks.length + i + 1}`,
    old_string: h.old_string,
    new_string: h.new_string,
    status: "pending" as const,
    review,
  }));
  body.hunks.push(...added);
  return added;
}

export async function proposeRunEdit(ledger: RunLedger, input: ProposeRunInput): Promise<ProposeRunResult> {
  const store = ledger.store;
  await store.ensureLoaded();
  const { agentAlias, reviewer } = input;
  // The route checks the lock too; this copy holds if one lands between the two.
  if (store.locked) return { mode: "error", status: 423, error: "locked", message: "this document is locked" };

  // Every storage read happens before `current` is read, so nothing awaits between reading and committing.
  const open = await ledger.openRunFor(agentAlias, { closeIdle: true });
  if (open && ledger.bodyLost(open.stored, open.body)) {
    return { mode: "error", status: 503, error: "unavailable", message: "run ledger unavailable" };
  }
  // Backpressure instead of deletion: only a proposal that would open a new run is refused.
  if (!open) {
    const pending = await ledger.pendingRunCount();
    if (pending >= PENDING_RUN_MAX) {
      return {
        mode: "error",
        status: 429,
        error: "review_backlog",
        message: `this document already has ${pending} proposals waiting for review — ask the reviewer to decide some before proposing more`,
        count: pending,
      };
    }
  }
  const current = store.markdown();
  const existingPending = open ? pendingOf(open.body) : [];
  // What the agent believes the document says: the live text plus its own pending hunks.
  const working = existingPending.length > 0 ? applyStrEditsStrict(current, existingPending).markdown : current;

  let next: string;
  let renumber = new Map<number, number>();
  if (input.op.action === "write") {
    next = input.op.text;
  } else if (input.op.action === "append") {
    const out = appendMarkdown(working, input.op.text, input.op.heading);
    if ("error" in out) {
      if (out.error === "heading_ambiguous") return { mode: "error", status: 409, error: "ambiguous", count: out.count };
      if (out.error === "unbalanced_fence") {
        return {
          mode: "error",
          status: 400,
          error: "unbalanced_fence",
          message: "this text opens a code fence it never closes, which would pull the rest of the document into it — close the fence and send it again",
        };
      }
      return { mode: "error", status: 409, error: "not_found" };
    }
    next = out.markdown;
  } else if (input.op.action === "cited_edits") {
    // Body only: markers renumbered past the document's footnotes; definitions are reconciled at commit.
    const out = applyRenumberedStrEdits(working, input.op.edits, input.op.citations);
    next = out.markdown;
    renumber = out.renumber;
  } else {
    const { find, replace } = input.op;
    const occurrences = working.split(find).length - 1;
    if (occurrences === 0) return { mode: "error", status: 409, error: "not_found" };
    if (occurrences > 1 && !input.op.replaceAll) {
      return { mode: "error", status: 409, error: "ambiguous", count: occurrences };
    }
    // split/join, not String.replace, which would expand `$&` and halve `$$` in the replacement.
    next = working.split(find).join(replace);
  }
  if (next === working) return { mode: "noop" };
  // The co-author has no route in front of it, so the size cap lives here too.
  if (markdownByteLength(next) > MAX_IMPORT_MARKDOWN_BYTES) {
    return { mode: "error", status: 413, error: "too_large", message: "document too large" };
  }

  // Canonicalize first: computeStrEdits verifies hunks byte-for-byte, so a
  // non-canonical spelling would collapse the edit into one document-sized hunk.
  let canonical: string;
  try {
    canonical = docToMarkdown(markdownToDoc(next, getStugaSchema()));
  } catch {
    canonical = next;
  }
  if (canonical === working) return { mode: "noop" };
  // An agent's own phrasing is kept verbatim only for a unique single-line
  // str_replace whose result is already canonical; anything else (a deleted
  // line splits its block, a multi-line find can tear a neighbour) is diffed.
  const op = input.op;
  const verbatimSafe =
    op.action === "str_replace" &&
    !op.replaceAll &&
    !op.find.includes("\n") &&
    !op.replace.includes("\n") &&
    working.split(op.find).length - 1 === 1 &&
    canonical === next;
  const computed: { old_string: string; new_string: string }[] =
    verbatimSafe && op.action === "str_replace"
      ? [{ old_string: op.find, new_string: op.replace }]
      : computeStrEdits(working, canonical);
  if (computed.length === 0) return { mode: "noop" };

  // `computed` was diffed against `working`, which includes the pending hunks, so
  // it cannot commit ahead of them.
  const parkedBehindPending = existingPending.length > 0;
  const commit = shouldCommit(input.review, input.source, parkedBehindPending);
  // Verify the hunks land before minting any ledger state, so a stale agent leaves nothing behind.
  let plan: { markdown: string; applied: Set<number> } | null = null;
  if (commit) {
    const result = applyStrEditsStrict(current, computed.map((h) => ({ ...h })));
    const applied = new Set(result.applied);
    if (applied.size === 0) {
      return { mode: "error", status: 409, error: "stale", message: "document changed; re-read and retry" };
    }
    plan = { markdown: result.markdown, applied };
  }

  const agentName = input.agent || agentAlias;
  // Before any further storage await, so the fragment cannot shift after `current` was read.
  if (commit) await store.commitMarkdown(plan!.markdown, current, { agent: agentName }, "run-large");

  const now = Date.now();
  let stored = open?.stored;
  let runBody = open?.body;
  if (!stored || !runBody) {
    const id = newRunId();
    stored = {
      id,
      doc_id: store.docId,
      source: input.source,
      agent: agentName,
      agent_alias: agentAlias,
      ...(input.client ? { client: input.client } : {}),
      ...(input.model ? { model: input.model } : {}),
      reviewer,
      status: "open",
      acknowledged: false,
      auto_applied: false,
      review_mode: input.review,
      created_at: now,
      updated_at: now,
      workspace_id: input.workspaceId,
      doc_title: input.docTitle,
      blob_key: runBlobKey(store.docId, id),
      hunk_meta: [],
    };
    runBody = { baseline_markdown: current, hunks: [] };
    await ledger.track(id);
    await ledger.setActive(agentAlias, id);
  }
  const added = appendHunks(runBody, computed, input.review);
  stored.updated_at = now;
  if (input.client) stored.client = input.client;
  if (input.model) stored.model = input.model;
  stored.review_mode = stricterReviewMode(stored.review_mode, input.review);
  // Citations are kept under their document numbers, so a later turn's [^1] cannot overwrite an earlier one.
  if (op.action === "cited_edits" && op.citations.length > 0) {
    const merged = new Map((runBody.citations ?? []).map((c) => [c.n, c]));
    for (const c of op.citations) {
      const to = renumber.get(c.n);
      if (to !== undefined) merged.set(to, { ...c, n: to });
    }
    runBody.citations = [...merged.values()].sort((a, b) => a.n - b.n);
  }

  if (!commit) {
    await ledger.save(stored, runBody);
    const pending = pendingOf(runBody).length;
    // The reviewer is usually not looking when an agent writes; a parked proposal nobody hears about is a silent queue.
    if (input.notifyReviewer !== false) {
      await ledger.notify(
        stored,
        "AGENT_EDITS_PROPOSED",
        `${stored.agent} proposed ${pending === 1 ? "1 change" : `${pending} changes`} — waiting for your review`,
      );
    }
    ledger.sendUpdated(stored, runBody);
    ledger.emitEvent("run.proposed", stored, agentActorOf(agentAlias), "agent", {
      review: input.review,
      added: added.length,
      pending,
    });
    return {
      mode: "proposed",
      run: ledger.summaryOf(stored, runBody),
      pending,
      // Said only when it contradicts the `auto` the agent read.
      parkedBehindPending: parkedBehindPending && input.review === "auto",
    };
  }

  for (let i = 0; i < added.length; i++) {
    added[i]!.status = plan!.applied.has(i) ? "auto_applied" : "conflict";
  }
  stored.auto_applied = true;
  // The run stays open, so a whole `auto` session groups into one catch-up card.
  await ledger.save(stored, runBody);
  await ledger.notify(stored, "AGENT_EDITS_APPLIED", `${stored.agent} edited this document — applied at once by policy`);
  ledger.emitEvent("run.applied", stored, agentActorOf(agentAlias), "agent", {
    review: input.review,
    decided_by: "policy:auto",
    applied: added.filter((h) => h.status === "auto_applied").length,
    conflicts: added.filter((h) => h.status === "conflict").length,
  });
  return { mode: "auto_applied", run: ledger.summaryOf(stored, runBody), seq: store.seq };
}
