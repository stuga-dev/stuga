/**
 * What every route works against: the actor's storage and blobs, the database
 * id the node named, its sockets, rate budgets and the job queue.
 */
import { DATABASE_MUTATIONS_PER_MINUTE, DATABASE_QUERIES_PER_MINUTE } from "@stuga/protocol/databases/limits";
import type { DatabaseActor as DatabaseActorIdentity } from "@stuga/protocol/databases/types";
import type { DatabaseRunUpdatedPayload } from "@stuga/protocol/wire/db-socket";
import { encodeJson } from "@stuga/protocol/wire/frame";
import { Opcode } from "@stuga/protocol/wire/opcodes";
import type { ActorState, ActorStorage, BlobStore } from "@stuga/runtime";
import type { DatabaseActorEnv } from "./env.js";
import { runIndexEntry, toRunSummary, type RunRow } from "./ledger/runs.js";
import { OpError } from "./request.js";
import { getMeta, type SqlHandle } from "./schema-ops.js";
import { Sockets, type SessionMeta } from "./sockets.js";

const RATE_WINDOW_MS = 60_000;
/** Alias×budget keys kept; the oldest goes first, so rotating aliases cannot grow the map. */
const RATE_KEYS_MAX = 200;

interface RunEvent {
  type: string;
  actor: string;
  actorKind: "human" | "agent";
  payload: Record<string, unknown>;
}

export class Database {
  /** Set from `?dbId=` on every request; one actor instance serves one database. */
  dbId = "";
  readonly sockets: Sockets;
  /** Request stamps per `<budget>\0<alias>`; insertion order doubles as LRU. */
  readonly rate = new Map<string, number[]>();

  constructor(
    readonly state: ActorState<SessionMeta>,
    readonly env: DatabaseActorEnv,
  ) {
    this.sockets = new Sockets(state);
  }

  get storage(): ActorStorage {
    return this.state.storage;
  }

  get sql(): SqlHandle {
    return this.state.storage.sql;
  }

  get bucket(): BlobStore {
    return this.env.snapshots;
  }

  /** A per-alias sliding window, one budget for mutations and one for queries: the node funnels many sessions into one actor. */
  throttle(actor: DatabaseActorIdentity, budget: "mutation" | "query"): void {
    const max = budget === "mutation" ? DATABASE_MUTATIONS_PER_MINUTE : DATABASE_QUERIES_PER_MINUTE;
    const key = `${budget}\x00${actor.alias}`;
    const now = Date.now();
    const stamps = (this.rate.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    const ok = stamps.length < max;
    if (ok) stamps.push(now);
    this.rate.delete(key);
    this.rate.set(key, stamps);
    while (this.rate.size > RATE_KEYS_MAX) this.rate.delete(this.rate.keys().next().value!);
    if (!ok) throw new OpError(429, "rate_limited", `too many ${budget === "mutation" ? "mutations" : "queries"} (max ${max}/min per actor)`);
  }

  /** docs.locked, mirrored in by the node so an agent's change cannot land in a frozen database. */
  locked(): boolean {
    return getMeta(this.sql, "locked") === "1";
  }

  requireUnlocked(message: string): void {
    if (this.locked()) throw new OpError(423, "locked", message);
  }

  /** Delete spilled blobs a committed write released; a leaked object is harmless. */
  dropBlobs(keys: string[]): void {
    for (const key of keys) void this.bucket.delete(key).catch(() => {});
  }

  runSummary(run: RunRow, opts: { full?: boolean; sample?: number } = {}) {
    return toRunSummary(this.sql, this.bucket, run, this.dbId, opts);
  }

  async sendRunUpdated(run: RunRow): Promise<void> {
    const frame = encodeJson(Opcode.DB_RUN_UPDATED, { run: await this.runSummary(run) } satisfies DatabaseRunUpdatedPayload);
    this.sockets.sendToReviewer(run.reviewer, frame);
  }

  /** Mirror a run into the workspace inbox, with an event feed entry beside it. Best-effort: the ledger here is the truth. */
  publishRun(run: RunRow, event?: RunEvent): void {
    void this.env.jobs.send({ kind: "run_index", run: runIndexEntry(this.sql, run, this.dbId) }).catch(() => {});
    if (!event) return;
    void this.env.jobs
      .send({
        kind: "event",
        workspaceId: run.workspace_id,
        type: event.type,
        docId: this.dbId,
        actor: event.actor,
        actorKind: event.actorKind,
        payload: {
          run_id: run.run_id,
          agent: run.agent,
          agent_alias: run.agent_alias,
          reviewer: run.reviewer,
          status: run.status,
          doc_title: run.doc_title,
          kind: "database",
          ...event.payload,
        },
      })
      .catch(() => {});
  }

  /**
   * Tell the reviewer an agent's changes are waiting: an agent usually proposes
   * while nobody has the table open. The notify job's hourly dedupe collapses a
   * chatty session into one notification.
   */
  async notifyProposed(run: RunRow, pending: number): Promise<void> {
    try {
      await this.env.jobs.send({
        kind: "notify",
        recipient: run.reviewer,
        workspaceId: run.workspace_id,
        eventType: "DATABASE_AGENT_PROPOSED",
        docId: this.dbId,
        title: run.doc_title,
        body: `${run.agent} proposed ${pending === 1 ? "1 change" : `${pending} changes`} to this table — waiting for your review in the table's Activity panel.`,
        actor: run.agent_alias,
      });
    } catch (err) {
      console.warn("database-run notify enqueue failed", { databaseId: this.dbId, runId: run.run_id, err: String(err) });
    }
  }
}
