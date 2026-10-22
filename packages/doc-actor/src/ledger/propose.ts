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
  type CitationInput,
} from "@stuga/crdt-ops";
import { appendMarkdown, type AppendPlacement } from "../append.js";
import { layOver, PENDING_RUN_MAX, pendingOf, runBlobKey, type RunBody, type RunLedger, type StoredRun } from "./run-store.js";

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
  /** The document's level as the node resolved it. */
  review: ReviewMode;
  /** At `colleague`, the approver group the document's folders name; stamped on the run. */
  approverGroup?: string | null;
  /**
   * Whether to tell the reviewer. Only the co-author's turn on this document opts
   * out — its reviewer is watching it land; its cross-document proposals arrive
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
  /**
   * The change this proposal belongs to, or null. A run belongs to one change: a proposal for another
   * than the agent's open run here starts a run of its own, queued behind that one while it waits.
   */
  changeId?: string | null;
}

export type ProposeRunResult =
  | { mode: "noop" }
  | {
      mode: "proposed";
      run: AgentRunSummary;
      pending: number;
      hunkIds: string[];
      parkedBehindPending?: boolean;
      /** The run it waits behind: an earlier change of this agent's here, still undecided. */
      queuedBehind?: { runId: string; changeId: string | null };
      placed?: AppendPlacement;
    }
  | { mode: "auto_applied"; run: AgentRunSummary; seq: number; applied: number; hunkIds: string[]; placed?: AppendPlacement }
  /** `headings`: an append's heading was not there; these are, as the agent's view has them. `empty`: that view is empty. */
  | { mode: "error"; status: number; error: string; message?: string; count?: number; headings?: string[]; empty?: boolean };

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
  // The node refuses a trashed document first; this holds for a co-author turn that outlived the trashing.
  if (store.trashed) return { mode: "error", status: 409, error: "trashed", message: "this document is in the trash" };

  // Every storage read happens before `current` is read, so nothing awaits between reading and committing.
  let open = await ledger.openRunFor(agentAlias, { closeIdle: true });
  if (open && ledger.bodyLost(open.stored, open.body)) {
    return { mode: "error", status: 503, error: "unavailable", message: "run ledger unavailable" };
  }
  const changeId = input.changeId ?? null;
  // A run belongs to one change. The agent's open run here, from another change, is finished when
  // nothing in it waits (it closes, as an idle one would); otherwise this proposal starts a run queued behind it.
  if (open && (open.stored.change_id ?? null) !== changeId) {
    if (pendingOf(open.body).length === 0) {
      await ledger.close(open.stored, open.body);
      ledger.sendUpdated(open.stored, open.body);
    }
    open = null;
  }
  // Every open run of the agent here, oldest first: what this proposal is made on top of.
  const chain = await ledger.chainFor(agentAlias);
  const waiting = chain.filter((r) => pendingOf(r.body).length > 0);
  // The run a new one would wait behind: the newest of the agent's runs here that still holds undecided hunks.
  const ahead: StoredRun | null = open ? null : (waiting.at(-1)?.stored ?? null);
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
  const existingPending = waiting.flatMap((r) => pendingOf(r.body));
  // What the agent believes the document says: the live text plus its own pending hunks, run after run.
  const working = existingPending.length > 0 ? layOver(current, waiting) : current;

  let next: string;
  let renumber = new Map<number, number>();
  let placed: AppendPlacement | undefined;
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
      return { mode: "error", status: 409, error: "not_found", headings: out.headings, empty: out.empty };
    }
    next = out.markdown;
    placed = out.placed;
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
  const commit = shouldCommit(input.review, parkedBehindPending);
  // Kept under their document numbers, so a later turn's [^1] cannot overwrite an earlier one.
  const citations =
    op.action === "cited_edits" && op.citations.length > 0 ? mergeCitations(open?.body.citations, op.citations, renumber) : undefined;
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
  // A cited edit staged only the body, so its definitions are written here, as on accept.
  if (commit) {
    // The agent's principal, which version history names by the person it acts for; its label is only a label.
    await store.commitMarkdown(ledger.commitTarget(plan!.markdown, { citations }), current, { alias: agentAlias, agent: agentName }, "run-large");
    await store.flushIfVersionDue("run");
  }

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
      ...(changeId ? { change_id: changeId } : {}),
      // Its hunks quote the text of the runs it is proposed on top of, so it is accepted only after them.
      ...(ahead ? { queued_behind: ahead.id, stacked_on: waiting.map((r) => r.stored.id) } : {}),
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
  // The group it was first proposed under stays; a decision also asks for the document's group now.
  if (input.review === "colleague" && input.approverGroup && !stored.approver_group) stored.approver_group = input.approverGroup;
  if (citations) runBody.citations = citations;

  if (!commit) {
    const behind = stored.queued_behind ? chain.find((r) => r.stored.id === stored!.queued_behind)?.stored : undefined;
    const queuedBehind = behind ? { runId: behind.id, changeId: behind.change_id ?? null } : undefined;
    await ledger.save(stored, runBody);
    const pending = pendingOf(runBody).length;
    // The reviewer is usually not looking when an agent writes; a parked proposal nobody hears about is a silent queue.
    if (input.notifyReviewer !== false) {
      await ledger.notify(stored, { eventType: "AGENT_EDITS_PROPOSED", count: pending });
    }
    // Whoever may approve at `colleague` is not the one watching, the co-author's turn included.
    await ledger.notifyApprovers(stored, pending, input.notifyReviewer !== false);
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
      hunkIds: added.map((h) => h.id),
      // Said only when it contradicts the `auto` the agent read.
      parkedBehindPending: parkedBehindPending && input.review === "auto",
      ...(queuedBehind ? { queuedBehind } : {}),
      ...(placed ? { placed } : {}),
    };
  }

  for (let i = 0; i < added.length; i++) {
    added[i]!.status = plan!.applied.has(i) ? "auto_applied" : "conflict";
  }
  stored.auto_applied = true;
  // The run stays open, so a whole `auto` session groups into one catch-up card.
  await ledger.save(stored, runBody);
  if (input.notifyReviewer !== false) {
    await ledger.notify(stored, { eventType: "AGENT_EDITS_APPLIED" });
  }
  // An open page shows the catch-up card now, not on its next load.
  ledger.sendUpdated(stored, runBody);
  const applied = plan!.applied.size;
  ledger.emitEvent("run.applied", stored, agentActorOf(agentAlias), "agent", {
    review: input.review,
    decided_by: "policy:auto",
    applied,
    conflicts: added.length - applied,
  });
  return { mode: "auto_applied", run: ledger.summaryOf(stored, runBody), seq: store.seq, applied, hunkIds: added.map((h) => h.id), ...(placed ? { placed } : {}) };
}

/** A run's citations with a proposal's added under the numbers its markers landed as. */
function mergeCitations(
  existing: CitationInput[] | undefined,
  proposed: AiCitation[],
  renumber: Map<number, number>,
): CitationInput[] {
  const merged = new Map((existing ?? []).map((c) => [c.n, c]));
  for (const c of proposed) {
    const to = renumber.get(c.n);
    if (to !== undefined) merged.set(to, { ...c, n: to });
  }
  return [...merged.values()].sort((a, b) => a.n - b.n);
}
