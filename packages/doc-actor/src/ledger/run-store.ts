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
import { closedStatus, runIsIdle } from "@stuga/protocol/domain/runs";
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

export function runBlobKey(docId: string, runId: string): string {
  return `${docId}/runs/${runId}.json`;
}

const te = new TextEncoder();

export function pendingOf(body: RunBody): AgentRunHunk[] {
  return body.hunks.filter((h) => h.status === "pending");
}

function syncHunkMeta(stored: StoredRun, body: RunBody): void {
  stored.hunk_meta = body.hunks.map((h) => ({
    id: h.id,
    status: h.status,
    bytes: te.encode(h.old_string).length + te.encode(h.new_string).length,
  }));
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
   * skipped, never evicted; the run just added is never a candidate.
   */
  async track(runId: string): Promise<void> {
    const order = [...(await this.order()), runId];
    for (let i = 0; order.length > RUN_ORDER_MAX && i < order.length - 1; ) {
      const candidate = order[i]!;
      const stored = await this.load(candidate);
      if (stored?.hunk_meta.some((h) => h.status === "pending")) {
        i++;
        continue;
      }
      if (stored) {
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
  async projectionFor(agentAlias: string): Promise<{ markdown: string; pending: AgentRunHunk[]; runId: string | null }> {
    const live = this.store.markdown();
    const open = await this.openRunFor(agentAlias);
    const pending = open ? pendingOf(open.body) : [];
    if (!open || pending.length === 0) return { markdown: live, pending: [], runId: open?.stored.id ?? null };
    return { markdown: applyStrEditsStrict(live, pending).markdown, pending, runId: open.stored.id };
  }

  /** Terminal state: freeze the result markdown and release the agent's slot. */
  async close(stored: StoredRun, body: RunBody): Promise<void> {
    stored.status = closedStatus(body.hunks);
    stored.updated_at = Date.now();
    stored.seq_at_commit = this.store.seq;
    body.final_markdown = this.store.markdown();
    await this.save(stored, body);
    await this.clearActive(stored.agent_alias);
  }

  /**
   * The markdown to commit after a decision: `markdown` with this run's footnote
   * definitions reconciled against the markers that survived. Idempotent, and a
   * no-op for runs without citations.
   */
  commitTarget(markdown: string, body: RunBody): string {
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

  /** Notify the reviewer. Best-effort: a queue hiccup must not fail an edit that committed or parked. */
  async notify(stored: StoredRun, eventType: string, body: string): Promise<void> {
    try {
      await this.env.jobs.send({
        kind: "notify",
        recipient: stored.reviewer,
        workspaceId: stored.workspace_id,
        eventType,
        docId: this.store.docId,
        title: stored.doc_title,
        body,
        actor: stored.agent,
      });
    } catch (err) {
      console.warn("agent-run notify enqueue failed", { docId: this.store.docId, runId: stored.id, err: String(err) });
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
