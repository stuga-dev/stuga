/**
 * The agent-run ledger's storage and side channels.
 *
 * A run is one agent's editing session on one document: hunks (str_edit pairs)
 * that park for review or commit at once, per the document's `agent_mode`.
 * Actor storage holds the small metadata read on every list (`run:<id>`, the
 * per-agent open-run pointer, the capped `run-order` index) with a `hunk_meta`
 * mirror; the blob store holds the unbounded body (baseline, hunk text, final
 * markdown). This actor is the only writer of both.
 */
import type {
  AgentRunHunk,
  AgentRunSource,
  AgentRunStatus,
  AgentRunSummary,
  RunDecidedPayload,
  RunHunkStatus,
  RunUpdatedPayload,
} from "@stuga/protocol/wire/doc-socket";
import type { ReviewMode } from "@stuga/protocol/domain/events";
import type { IndexMessage, RunIndexEntry } from "@stuga/protocol/internal/jobs";
import { closedStatus, feedbackExcerpt, runIsIdle, type AgentFeedback } from "@stuga/protocol/domain/runs";
import { stricterReviewMode } from "@stuga/protocol/domain/events";
import { RUN_FEEDBACK_LOOKBACK_DAYS, RUN_FEEDBACK_MAX_CHANGES } from "@stuga/protocol/domain/limits";
import { encodeJson } from "@stuga/protocol/wire/frame";
import { Opcode } from "@stuga/protocol/wire/opcodes";
import { applyStrEditsStrict, reconcileFootnotes, type CitationInput } from "@stuga/crdt-ops";
import type { ActorStorage, BlobStore, JobQueue } from "@stuga/runtime";
import type { DocStore } from "../store/doc-store.js";
import { safeSend, type DocSocket, type Peers } from "../session.js";

export const RUN_ORDER_KEY = "run-order";
/** How many runs a document keeps; decided runs beyond it are evicted oldest first. */
export const RUN_ORDER_MAX = 50;
/**
 * How many runs may hold an undecided hunk. Equal to RUN_ORDER_MAX: a pending run
 * is never evicted, so the ceiling is enforced by refusing the next new run.
 */
export const PENDING_RUN_MAX = RUN_ORDER_MAX;
/** Runs a list returns when the caller does not say; each costs a blob read. */
export const RUN_LIST_DEFAULT_LIMIT = 20;
/** Above this a summary elides `hunks` and sets `hunks_truncated`. */
const RUN_HUNKS_MAX_BYTES = 256 * 1024;
/** How many recent runs the reconnect replay scans; outstanding work is by construction recent. */
const RUN_REPLAY_SCAN = 20;

interface StoredHunkMeta {
  id: string;
  status: RunHunkStatus;
  /** UTF-8 size of old_string + new_string. */
  bytes: number;
}

/** What `run:<runId>` holds: the wire summary minus hunks, plus actor-only fields. */
export interface StoredRun {
  id: string;
  doc_id: string;
  source: AgentRunSource;
  agent: string;
  agent_alias: string;
  client?: string;
  model?: string;
  reviewer: string;
  status: AgentRunStatus;
  acknowledged: boolean;
  auto_applied: boolean;
  reverted?: boolean;
  /** The strictest review mode any proposal in this run carried. */
  review_mode: ReviewMode;
  /** The approver group the first proposal at `colleague` that named one was made under. */
  approver_group?: string;
  /** Hunk id → who accepted it at `colleague`, never its reviewer; an undo takes the entry back out. */
  approvals?: Record<string, string>;
  /** The change it belongs to; a run belongs to one change, and a proposal for another starts a run of its own. */
  change_id?: string;
  /**
   * The agent's earlier open run here it waits behind: it was proposed on top of that run's undecided
   * hunks, so it is accepted only once that run is decided. Moves up as the runs ahead close.
   */
  queued_behind?: string;
  /** Every run whose undecided text it was proposed on top of, kept after they close: its hunks may quote them. */
  stacked_on?: string[];
  created_at: number;
  updated_at: number;
  seq_at_commit?: number;
  workspace_id: string;
  /** Document title at propose time, for the notification body. */
  doc_title: string;
  blob_key: string;
  hunk_meta: StoredHunkMeta[];
}

/** What the blob holds. */
export interface RunBody {
  baseline_markdown: string;
  hunks: AgentRunHunk[];
  /** The document as the run closed (again on revert). */
  final_markdown?: string;
  /**
   * Panel runs only: the citations the hunks reference, under their document
   * numbers. The co-author stages only the body of a cited edit; every commit
   * reconciles the definitions block against the markers that actually landed.
   */
  citations?: CitationInput[];
}

export function runStorageKey(runId: string): string {
  return `run:${runId}`;
}

function runActiveKey(agentAlias: string): string {
  return `run-active:${agentAlias}`;
}

/** The runs of one agent holding a rejection it has not been handed yet, so a read checks one key. */
function feedbackPendingKey(agentAlias: string): string {
  return `feedback-pending:${agentAlias}`;
}

export function runBlobKey(docId: string, runId: string): string {
  return `${docId}/runs/${runId}.json`;
}

const te = new TextEncoder();

export function pendingOf(body: RunBody): AgentRunHunk[] {
  return body.hunks.filter((h) => h.status === "pending");
}

/** `live` with each run's pending hunks laid over it in turn, as the agent proposed them on top of each other. */
export function layOver(live: string, chain: ReadonlyArray<{ body: RunBody }>): string {
  let text = live;
  for (const r of chain) {
    const pending = pendingOf(r.body);
    if (pending.length > 0) text = applyStrEditsStrict(text, pending).markdown;
  }
  return text;
}

function syncHunkMeta(stored: StoredRun, body: RunBody): void {
  stored.hunk_meta = body.hunks.map((h) => ({
    id: h.id,
    status: h.status,
    bytes: te.encode(h.old_string).length + te.encode(h.new_string).length,
  }));
}

/** Who approved the run's changes that stand accepted at `colleague`, in name order. */
function approvedBy(stored: StoredRun): string[] {
  const approvals = stored.approvals ?? {};
  const accepted = stored.hunk_meta.filter((m) => m.status === "accepted" && approvals[m.id]).map((m) => approvals[m.id]!);
  return [...new Set(accepted)].sort();
}

/** The run as the workspace inbox mirrors it, counted from the metadata mirror. */
function runIndexEntry(stored: StoredRun): RunIndexEntry {
  const count = (status: RunHunkStatus) => stored.hunk_meta.filter((m) => m.status === status).length;
  return {
    runId: stored.id,
    workspaceId: stored.workspace_id,
    docId: stored.doc_id,
    docKind: "prose",
    docTitle: stored.doc_title,
    source: stored.source,
    agent: stored.agent,
    agentAlias: stored.agent_alias,
    client: stored.client ?? null,
    model: stored.model ?? null,
    reviewer: stored.reviewer,
    status: stored.status,
    reviewMode: stored.review_mode,
    approverGroup: stored.approver_group ?? null,
    approvedBy: approvedBy(stored),
    changeId: stored.change_id ?? null,
    queuedBehind: stored.queued_behind ?? null,
    autoApplied: stored.auto_applied,
    reverted: stored.reverted === true,
    acknowledged: stored.acknowledged,
    pending: count("pending"),
    accepted: count("accepted"),
    rejected: count("rejected"),
    conflicts: count("conflict"),
    applied: count("auto_applied"),
    createdAt: stored.created_at,
    updatedAt: stored.updated_at,
  };
}

/**
 * The wire summary. Hunks are elided past RUN_HUNKS_MAX_BYTES, or when the body
 * did not load (`body === null`), so the client re-fetches instead of rendering
 * "nothing to review" over real work.
 */
function toSummary(stored: StoredRun, body: RunBody | null): AgentRunSummary {
  const total = stored.hunk_meta.reduce((n, m) => n + m.bytes, 0);
  const truncated = body === null || total > RUN_HUNKS_MAX_BYTES;
  const summary: AgentRunSummary = {
    id: stored.id,
    doc_id: stored.doc_id,
    source: stored.source,
    agent: stored.agent,
    agent_alias: stored.agent_alias,
    reviewer: stored.reviewer,
    status: stored.status,
    hunks: truncated ? [] : body.hunks,
    acknowledged: stored.acknowledged,
    auto_applied: stored.auto_applied,
    review_mode: stored.review_mode,
    created_at: stored.created_at,
    updated_at: stored.updated_at,
  };
  if (truncated) summary.hunks_truncated = true;
  if (stored.reverted) summary.reverted = true;
  if (stored.client) summary.client = stored.client;
  if (stored.model) summary.model = stored.model;
  if (stored.approver_group) summary.approver_group = stored.approver_group;
  if (stored.change_id) summary.change_id = stored.change_id;
  if (stored.queued_behind) summary.queued_behind = stored.queued_behind;
  if (stored.stacked_on?.length) summary.stacked_on = stored.stacked_on;
  if (stored.seq_at_commit !== undefined) summary.seq_at_commit = stored.seq_at_commit;
  return summary;
}

export interface LedgerEnv {
  snapshots: BlobStore;
  jobs: JobQueue<IndexMessage>;
}

export class RunLedger {
  /** Run bodies by id, mirroring the blob objects; saveRun writes both together. */
  private readonly bodies = new Map<string, RunBody>();
  /** The `run-order` index; null means not loaded yet, not empty. */
  private orderCache: string[] | null = null;

  constructor(
    private readonly storage: ActorStorage,
    private readonly env: LedgerEnv,
    readonly store: DocStore,
    private readonly peers: Peers,
  ) {}

  /** Forget cached state (after the actor's storage was wiped). */
  reset(): void {
    this.bodies.clear();
    this.orderCache = null;
  }

  /** The capped run index, oldest first. */
  async order(): Promise<string[]> {
    if (this.orderCache === null) this.orderCache = (await this.storage.get<string[]>(RUN_ORDER_KEY)) ?? [];
    return this.orderCache;
  }

  async load(runId: string): Promise<StoredRun | null> {
    return (await this.storage.get<StoredRun>(runStorageKey(runId))) ?? null;
  }

  /**
   * The run's body, from the mirror or the blob store. A missing or unreadable
   * object degrades to an empty body (a list can still render the run) and is
   * not cached, so a transient error is seen again; writers check `bodyLost`.
   */
  async loadBody(stored: StoredRun): Promise<RunBody> {
    const cached = this.bodies.get(stored.id);
    if (cached) return cached;
    try {
      const obj = await this.env.snapshots.get(stored.blob_key);
      if (obj) {
        const body = JSON.parse(new TextDecoder().decode(new Uint8Array(await obj.arrayBuffer()))) as RunBody;
        this.bodies.set(stored.id, body);
        return body;
      }
    } catch (err) {
      console.warn("run body read failed", { docId: this.store.docId, runId: stored.id, err: String(err) });
    }
    if (stored.hunk_meta.length > 0) {
      console.warn("run body unavailable", { docId: this.store.docId, runId: stored.id, hunks: stored.hunk_meta.length });
    }
    return { baseline_markdown: "", hunks: [] };
  }

  /**
   * Did the body fail to load? Hunks are only ever appended or re-statused, so a
   * body shorter than the mirror is the degraded empty body, and writing it back
   * would turn a read error into permanent loss.
   */
  bodyLost(stored: StoredRun, body: RunBody): boolean {
    return body.hunks.length < stored.hunk_meta.length;
  }

  /** Persist both halves plus the mirror, and keep the workspace inbox in step. */
  async save(stored: StoredRun, body: RunBody): Promise<void> {
    if (this.bodyLost(stored, body)) throw new Error(`run body unavailable: ${stored.id}`);
    syncHunkMeta(stored, body);
    this.bodies.set(stored.id, body);
    await this.env.snapshots.put(stored.blob_key, te.encode(JSON.stringify(body)));
    await this.storage.put(runStorageKey(stored.id), stored);
    if (stored.workspace_id) this.enqueue({ kind: "run_index", run: runIndexEntry(stored) });
  }

  summaryOf(stored: StoredRun, body: RunBody): AgentRunSummary {
    return toSummary(stored, this.bodyLost(stored, body) ? null : body);
  }

  /**
   * Register a new run, evicting the oldest decided runs beyond the cap (metadata,
   * body and any dangling open-run pointer together). A run with a pending hunk is
   * skipped, never evicted, and so is one holding feedback its agent has not been
   * handed yet while that feedback is still within RUN_FEEDBACK_LOOKBACK_DAYS: a
   * reviewer's note is kept for the agent as long as reads would show it. The run
   * just added is never a candidate.
   */
  async track(runId: string): Promise<void> {
    const order = [...(await this.order()), runId];
    const stale = Date.now() - RUN_FEEDBACK_LOOKBACK_DAYS * 86_400_000;
    // One read of each agent's feedback list per eviction pass.
    const feedbackListed = new Map<string, string[]>();
    const listedFor = async (agentAlias: string): Promise<string[]> => {
      let listed = feedbackListed.get(agentAlias);
      if (!listed) {
        listed = (await this.storage.get<string[]>(feedbackPendingKey(agentAlias))) ?? [];
        feedbackListed.set(agentAlias, listed);
      }
      return listed;
    };
    for (let i = 0; order.length > RUN_ORDER_MAX && i < order.length - 1; ) {
      const candidate = order[i]!;
      const stored = await this.load(candidate);
      if (stored?.hunk_meta.some((h) => h.status === "pending")) {
        i++;
        continue;
      }
      if (stored) {
        const listed = await listedFor(stored.agent_alias);
        // A decision stamps updated_at, so a listed run older than the lookback holds only stale feedback.
        if (listed.includes(candidate) && stored.updated_at >= stale) {
          i++;
          continue;
        }
        if (listed.includes(candidate)) {
          const left = listed.filter((id) => id !== candidate);
          feedbackListed.set(stored.agent_alias, left);
          await this.storage.put(feedbackPendingKey(stored.agent_alias), left);
        }
        const active = await this.storage.get<string>(runActiveKey(stored.agent_alias));
        if (active === candidate) await this.storage.delete(runActiveKey(stored.agent_alias));
        await this.env.snapshots.delete(stored.blob_key).catch(() => {});
      }
      await this.storage.delete(runStorageKey(candidate));
      this.bodies.delete(candidate);
      order.splice(i, 1);
    }
    this.orderCache = order;
    await this.storage.put(RUN_ORDER_KEY, order);
  }

  /** Runs still holding an undecided hunk; metadata only, and free while the ledger is under the ceiling. */
  async pendingRunCount(): Promise<number> {
    const order = await this.order();
    if (order.length < PENDING_RUN_MAX) return order.length;
    let pending = 0;
    for (const id of order) {
      const stored = await this.load(id);
      if (stored?.hunk_meta.some((h) => h.status === "pending")) pending++;
    }
    return pending;
  }

  async setActive(agentAlias: string, runId: string): Promise<void> {
    await this.storage.put(runActiveKey(agentAlias), runId);
  }

  async clearActive(agentAlias: string): Promise<void> {
    await this.storage.delete(runActiveKey(agentAlias));
  }

  /**
   * The agent's open run, or null; clears a stale pointer. `closeIdle` (proposes
   * only — a read must never mutate the ledger) rolls over a run that went quiet
   * with nothing left to decide, so a later session starts a fresh card. A run
   * with pending hunks never rolls over behind its reviewer.
   */
  async openRunFor(agentAlias: string, opts?: { closeIdle?: boolean }): Promise<{ stored: StoredRun; body: RunBody } | null> {
    const runId = await this.storage.get<string>(runActiveKey(agentAlias));
    if (!runId) return null;
    const stored = await this.load(runId);
    if (!stored || stored.status !== "open") {
      await this.clearActive(agentAlias);
      return null;
    }
    const body = await this.loadBody(stored);
    if (opts?.closeIdle && runIsIdle(stored.updated_at, Date.now()) && !this.bodyLost(stored, body) && pendingOf(body).length === 0) {
      await this.close(stored, body);
      this.sendUpdated(stored, body);
      return null;
    }
    return { stored, body };
  }

  /**
   * The document as `agentAlias`'s own pending hunks leave it. An agent reading
   * back a document it proposed to must see its own work, or it re-proposes it.
   */
  async projectionFor(agentAlias: string): Promise<{
    markdown: string;
    /** The live text the pending hunks are laid over: what everyone else reads. */
    approved: string;
    pending: AgentRunHunk[];
    runId: string | null;
    run: Pick<StoredRun, "created_at" | "review_mode"> | null;
  }> {
    const live = this.store.markdown();
    const open = await this.openRunFor(agentAlias);
    // Every open run of the agent, the queued ones included, in the order they were proposed on top of each other.
    const chain = open ? await this.chainFor(agentAlias) : [];
    const pending = chain.flatMap((r) => pendingOf(r.body));
    const run = open ? { created_at: (chain[0]?.stored ?? open.stored).created_at, review_mode: chain.reduce((m, r) => stricterReviewMode(m, r.stored.review_mode), open.stored.review_mode) } : null;
    if (!open || pending.length === 0) return { markdown: live, approved: live, pending: [], runId: open?.stored.id ?? null, run };
    return { markdown: layOver(live, chain), approved: live, pending, runId: open.stored.id, run };
  }

  /**
   * The agent's open runs here, oldest first: the run it is adding to and those it waits behind. A
   * proposal for another change than the newest's starts a run queued behind it, so a hub page never
   * refuses an agent's later work while its earlier changes wait. Bodies that did not load are left out.
   */
  async chainFor(agentAlias: string): Promise<Array<{ stored: StoredRun; body: RunBody }>> {
    const out: Array<{ stored: StoredRun; body: RunBody }> = [];
    for (const id of await this.order()) {
      const stored = await this.load(id);
      if (!stored || stored.agent_alias !== agentAlias || stored.status !== "open") continue;
      const body = await this.loadBody(stored);
      if (this.bodyLost(stored, body)) continue;
      out.push({ stored, body });
    }
    return out;
  }

  /**
   * After `stored` closed (decided, reverted, or rolled over): the agent's pointer goes back to the run
   * it waited behind, if that is still open, and the runs queued behind it move up behind that one, so
   * the next in line can be approved.
   */
  async unlink(stored: StoredRun): Promise<void> {
    const ahead = stored.queued_behind ? await this.load(stored.queued_behind) : null;
    const next = ahead && ahead.status === "open" ? ahead.id : null;
    const active = await this.storage.get<string>(runActiveKey(stored.agent_alias));
    if (active === stored.id) {
      if (next) await this.storage.put(runActiveKey(stored.agent_alias), next);
      else await this.storage.delete(runActiveKey(stored.agent_alias));
    }
    for (const id of await this.order()) {
      const behind = await this.load(id);
      if (!behind || behind.queued_behind !== stored.id) continue;
      const body = await this.loadBody(behind);
      if (this.bodyLost(behind, body)) continue;
      if (next) behind.queued_behind = next;
      else delete behind.queued_behind;
      behind.updated_at = Date.now();
      await this.save(behind, body);
      this.sendUpdated(behind, body);
    }
  }

  /** The run `stored` waits behind, while that one is still open: an accept of it is refused until then. */
  async aheadOf(stored: StoredRun): Promise<StoredRun | null> {
    if (!stored.queued_behind) return null;
    const ahead = await this.load(stored.queued_behind);
    return ahead && ahead.status === "open" ? ahead : null;
  }

  /**
   * Remember that `stored` holds feedback its agent has not answered yet. Called BEFORE the run is
   * saved with it: a listed run without open feedback is pruned on the next scan, while a saved note
   * on an unlisted run would never lead a read.
   */
  async noteFeedback(stored: StoredRun): Promise<void> {
    const key = feedbackPendingKey(stored.agent_alias);
    const runs = (await this.storage.get<string[]>(key)) ?? [];
    if (!runs.includes(stored.id)) await this.storage.put(key, [...runs, stored.id]);
  }

  /**
   * Mark the feedback `ids` of `agentAlias` answered: a proposal named them as the revision, or the
   * co-author's turn was shown them. Ids that are not open feedback on this agent's runs here are
   * ignored, so a feedback id grants nothing. Returns the ids it marked.
   */
  async answerFeedback(agentAlias: string, ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    return (await this.scanFeedback(agentAlias, new Set(ids))).answered;
  }

  /**
   * The reviewer withdraws what they requested on `stored` (Mark as reviewed): its open feedback is
   * marked answered on the hunks, which the caller saves; `unlistFeedback` then takes the run off its
   * agent's list. In that order a failed save leaves a listed run with open feedback, which reads
   * still show, never an unlisted run whose note nobody sees.
   */
  dismissFeedback(body: RunBody): number {
    const now = Date.now();
    let dismissed = 0;
    for (const h of body.hunks) {
      if (h.feedback && h.feedback.addressed_at === undefined) {
        h.feedback.addressed_at = now;
        dismissed++;
      }
    }
    return dismissed;
  }

  /** Take `stored` off its agent's feedback list, once nothing on it is open any more. */
  async unlistFeedback(stored: StoredRun): Promise<void> {
    const key = feedbackPendingKey(stored.agent_alias);
    const listed = (await this.storage.get<string[]>(key)) ?? [];
    if (listed.includes(stored.id)) await this.storage.put(key, listed.filter((id) => id !== stored.id));
  }

  /** The full text of the hunks one rejection of `agentAlias`'s run covered: a revise turn's scope. [] when gone. */
  async rejectedHunks(agentAlias: string, runId: string, feedbackId: string): Promise<Array<{ old_string: string; new_string: string }>> {
    const stored = await this.load(runId);
    if (!stored || stored.agent_alias !== agentAlias) return [];
    const body = await this.loadBody(stored);
    if (this.bodyLost(stored, body)) return [];
    return body.hunks.filter((h) => h.feedback?.id === feedbackId).map((h) => ({ old_string: h.old_string, new_string: h.new_string }));
  }

  /**
   * Rejections of `agentAlias`'s proposals here that it has not answered, newest first: what its reads
   * repeat and its proposals carry. They stay until a proposal names them in `revises`, the reviewer
   * marks the run reviewed, or they age past RUN_FEEDBACK_LOOKBACK_DAYS; from then on only `status`
   * shows them. Only the runs `noteFeedback` listed are read, and one with nothing left to show
   * leaves the list; a run whose body did not load is skipped, never written back.
   */
  async feedbackFor(agentAlias: string): Promise<AgentFeedback[]> {
    return (await this.scanFeedback(agentAlias)).open;
  }

  /** One pass over the agent's listed runs: what is open, and what `answer` marked answered on the way. */
  private async scanFeedback(agentAlias: string, answer?: ReadonlySet<string>): Promise<{ open: AgentFeedback[]; answered: string[] }> {
    const key = feedbackPendingKey(agentAlias);
    const listed = (await this.storage.get<string[]>(key)) ?? [];
    if (listed.length === 0) return { open: [], answered: [] };
    const now = Date.now();
    const stale = now - RUN_FEEDBACK_LOOKBACK_DAYS * 86_400_000;
    const open: AgentFeedback[] = [];
    const answered = new Set<string>();
    const keep: string[] = [];
    for (const runId of listed) {
      const stored = await this.load(runId);
      if (!stored || stored.agent_alias !== agentAlias) continue;
      const body = await this.loadBody(stored);
      if (this.bodyLost(stored, body)) {
        keep.push(runId);
        continue;
      }
      const byId = new Map<string, AgentFeedback>();
      let left = false;
      let changed = false;
      for (const h of body.hunks) {
        const fb = h.feedback;
        if (!fb || fb.addressed_at !== undefined || fb.decided_at < stale) continue;
        if (answer?.has(fb.id)) {
          fb.addressed_at = now;
          answered.add(fb.id);
          changed = true;
          continue;
        }
        left = true;
        let item = byId.get(fb.id);
        if (!item) {
          item = {
            id: fb.id,
            run_id: stored.id,
            ...(fb.reverted ? { reverted: true as const } : {}),
            ...(fb.note ? { note: fb.note } : {}),
            decided_at: fb.decided_at,
            changes: [],
          };
          byId.set(fb.id, item);
        }
        if (item.changes.length < RUN_FEEDBACK_MAX_CHANGES) {
          item.changes.push({ old_string: feedbackExcerpt(h.old_string), new_string: feedbackExcerpt(h.new_string) });
        } else {
          item.more = (item.more ?? 0) + 1;
        }
      }
      if (changed) await this.save(stored, body);
      if (left) keep.push(runId);
      open.push(...[...byId.values()].sort((a, b) => b.decided_at - a.decided_at));
    }
    if (keep.length !== listed.length) await this.storage.put(key, keep);
    return { open: open.sort((a, b) => b.decided_at - a.decided_at), answered: [...answered] };
  }

  /** Terminal state: freeze the result markdown and release the agent's slot. */
  async close(stored: StoredRun, body: RunBody): Promise<void> {
    stored.status = closedStatus(body.hunks);
    stored.updated_at = Date.now();
    stored.seq_at_commit = this.store.seq;
    body.final_markdown = this.store.markdown();
    await this.save(stored, body);
    await this.unlink(stored);
  }

  /**
   * The markdown to commit after a decision or an `auto` apply: `markdown` with this run's footnote
   * definitions reconciled against the markers that survived. Idempotent, and a
   * no-op for runs without citations.
   */
  commitTarget(markdown: string, body: Pick<RunBody, "citations">): string {
    const citations = body.citations;
    if (!citations?.length) return markdown;
    // Stored citations already carry their document numbers.
    return reconcileFootnotes(markdown, citations, new Map(citations.map((c) => [c.n, c.n])));
  }

  sendUpdated(stored: StoredRun, body: RunBody): void {
    this.peers.sendToReviewer(
      stored.reviewer,
      encodeJson(Opcode.RUN_UPDATED, { run: this.summaryOf(stored, body) } satisfies RunUpdatedPayload),
    );
  }

  sendDecided(stored: StoredRun, body: RunBody, decision: "accept" | "reject", hunkIds: string[], decidedBy: string): void {
    this.peers.sendToReviewer(
      stored.reviewer,
      encodeJson(Opcode.RUN_DECIDED, {
        run_id: stored.id,
        decision,
        hunk_ids: hunkIds,
        decided_by: decidedBy,
        run: this.summaryOf(stored, body),
      } satisfies RunDecidedPayload),
    );
  }

  /**
   * On a reviewer's handshake, replay the runs they still owe attention: open
   * ones, and auto-applied ones not yet acknowledged. The REST list is the
   * exhaustive path; this is the live nudge, bounded to the newest runs.
   */
  async sendOpenRunsTo(ws: DocSocket): Promise<void> {
    const order = await this.order();
    for (const runId of order.slice(-RUN_REPLAY_SCAN).reverse()) {
      const stored = await this.load(runId);
      if (!stored || stored.reviewer !== ws.meta.alias) continue;
      const outstanding = stored.status === "open" || (stored.auto_applied && !stored.acknowledged);
      if (!outstanding) continue;
      const body = await this.loadBody(stored);
      safeSend(ws, encodeJson(Opcode.RUN_UPDATED, { run: this.summaryOf(stored, body) } satisfies RunUpdatedPayload));
    }
  }

  /**
   * Notify the reviewer: of what was proposed, saying whether it waits for them or a colleague, or of
   * what applied at once. Best-effort: a queue hiccup must not fail an edit that committed or parked.
   */
  async notify(stored: StoredRun, n: { eventType: "AGENT_EDITS_PROPOSED"; count: number } | { eventType: "AGENT_EDITS_APPLIED" }): Promise<void> {
    const agent = stored.agent;
    const doc = stored.doc_title;
    const waits = stored.review_mode === "colleague" ? "colleague" : "you";
    try {
      await this.env.jobs.send({
        kind: "notify",
        recipient: stored.reviewer,
        workspaceId: stored.workspace_id,
        docId: this.store.docId,
        actor: stored.agent,
        ...(n.eventType === "AGENT_EDITS_PROPOSED"
          ? { eventType: n.eventType, params: { agent, doc, count: n.count, waits }, runId: stored.id }
          : { eventType: n.eventType, params: { agent, doc } }),
        ...(stored.change_id ? { changeId: stored.change_id } : {}),
      });
    } catch (err) {
      console.warn("agent-run notify enqueue failed", { docId: this.store.docId, runId: stored.id, err: String(err) });
    }
  }

  /**
   * At `colleague`, tell the people who may approve that the run waits for them; the node works out
   * who they are. Sent whether or not the reviewer is told (`askerTold`), since the reviewer cannot
   * approve it.
   */
  async notifyApprovers(stored: StoredRun, count: number, askerTold: boolean): Promise<void> {
    if (stored.review_mode !== "colleague" || !stored.workspace_id) return;
    try {
      await this.env.jobs.send({
        kind: "notify_approvers",
        workspaceId: stored.workspace_id,
        docId: this.store.docId,
        runId: stored.id,
        reviewer: stored.reviewer,
        approverGroup: stored.approver_group ?? null,
        actor: stored.agent_alias,
        agent: stored.agent,
        doc: stored.doc_title,
        count,
        askerTold,
        ...(stored.change_id ? { changeId: stored.change_id } : {}),
      });
    } catch (err) {
      console.warn("agent-run approvers notify enqueue failed", { docId: this.store.docId, runId: stored.id, err: String(err) });
    }
  }

  /** Tell the workspace feed. Best-effort: the feed describes the ledger, it does not gate it. */
  emitEvent(
    type: string,
    stored: StoredRun,
    actor: string,
    actorKind: "human" | "agent" | "internal",
    payload: Record<string, unknown>,
  ): void {
    if (!stored.workspace_id) return;
    this.enqueue({
      kind: "event",
      workspaceId: stored.workspace_id,
      type,
      docId: this.store.docId,
      actor,
      actorKind,
      payload: {
        run_id: stored.id,
        agent: stored.agent,
        agent_alias: stored.agent_alias,
        reviewer: stored.reviewer,
        status: stored.status,
        doc_title: stored.doc_title,
        ...(stored.change_id ? { change_id: stored.change_id } : {}),
        ...payload,
      },
    });
  }

  private enqueue(message: IndexMessage): void {
    try {
      void this.env.jobs.send(message).catch(() => {});
    } catch {
      /* best-effort */
    }
  }
}
