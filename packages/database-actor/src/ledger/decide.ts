/**
 * What people do with a run and with the Activity ledger: accept or reject
 * proposals, revert a run or one op, dismiss a catch-up card. The node computes
 * `manager_override`; the actor checks the reviewer half, since it holds the run.
 */
import { DATABASE_RUN_KEEP, DATABASE_RUN_LIST_DEFAULT } from "@stuga/protocol/databases/limits";
import type { DatabaseActor as DatabaseActorIdentity, DatabaseRunOpPayload, DatabaseRunSummary } from "@stuga/protocol/databases/types";
import { clampRunLimit } from "@stuga/protocol/domain/runs";
import type { DatabaseRunDecidedPayload } from "@stuga/protocol/wire/db-socket";
import { encodeJson } from "@stuga/protocol/wire/frame";
import { Opcode } from "@stuga/protocol/wire/opcodes";
import type { Database } from "../database.js";
import { commitOp, opDef, proposableDef } from "../ops/registry.js";
import { OpError, parseActor, parseOpsKeep, readJson } from "../request.js";
import { newId } from "../schema-ops.js";
import { applyInverse, getOp, isRevertible, listOps, loadInverse, recordOp, type OpRow, type RevertOutcome } from "./ops-ledger.js";
import { runActor } from "./propose.js";
import {
  acknowledgeRun,
  closeRun,
  getRun,
  listRunOps,
  listRuns,
  loadOpPayload,
  markRunReverted,
  pendingCountOf,
  setOpStatus,
  touchRun,
  type RunOpRow,
  type RunRow,
} from "./runs.js";

/** A run exists and the caller is its reviewer, or the node vouches for them as a manager. Fails closed on a missing name. */
function reviewerOf(db: Database, body: Record<string, unknown>, field: string): { run: RunRow; by: string } {
  const run = getRun(db.sql, body.run_id);
  if (!run) throw new OpError(404, "run_not_found", `no run with id ${String(body.run_id)}`);
  const by = body[field];
  if (typeof by !== "string" || by === "" || (by !== run.reviewer && body.manager_override !== true)) {
    throw new OpError(403, "not_reviewer", "only this run's reviewer can decide it");
  }
  return { run, by };
}

function idsOf(minted: Record<string, string | string[]>): string[] {
  return Object.values(minted).flat();
}

export async function handleRunDecide(db: Database, req: Request): Promise<Response> {
  const body = await readJson(req);
  const keep = parseOpsKeep(body);
  const { run, by: decidedBy } = reviewerOf(db, body, "decided_by");
  db.requireUnlocked("this database is locked; unlock it to review changes");
  const decision = body.decision;
  if (decision !== "accept" && decision !== "reject") throw new OpError(400, "bad_request", "decision must be accept or reject");
  const requested = Array.isArray(body.op_ids) ? new Set(body.op_ids.filter((x): x is string => typeof x === "string")) : null;

  const ops = listRunOps(db.sql, run.run_id);
  const payloads = new Map<string, DatabaseRunOpPayload>();
  const mintedBy = new Map<string, RunOpRow>();
  for (const op of ops) {
    const payload = await loadOpPayload(db.bucket, op);
    payloads.set(op.op_id, payload);
    const def = proposableDef(payload.kind);
    for (const id of def ? idsOf(def.proposal.minted(payload)) : []) mintedBy.set(id, op);
  }
  const statusOf = new Map(ops.map((o) => [o.op_id, o.status]));

  let applied = 0;
  let rejected = 0;
  let conflicts = 0;
  let blocked = 0;
  let deferred = 0;
  const touched: string[] = [];
  for (const op of ops) {
    if (op.status !== "pending" || (requested !== null && !requested.has(op.op_id))) continue;
    touched.push(op.op_id);
    // Every transition is guarded on `pending`: a racing decider may have won during the payload loads.
    if (decision === "reject") {
      if (setOpStatus(db.sql, run.run_id, op.op_id, "rejected", { decidedBy })) {
        statusOf.set(op.op_id, "rejected");
        rejected++;
      }
      continue;
    }
    // An op naming what an earlier op creates waits while that op is pending, and conflicts once it was refused.
    const payload = payloads.get(op.op_id)!;
    let dep: "pending" | "dead" | null = null;
    for (const ref of proposableDef(payload.kind)?.proposal.references(payload) ?? []) {
      const minter = mintedBy.get(ref);
      if (!minter || minter.op_id === op.op_id) continue;
      const st = statusOf.get(minter.op_id);
      if (st === "pending") dep = "pending";
      else if (st === "rejected" || st === "conflict") {
        dep = "dead";
        break;
      }
    }
    if (dep === "pending") {
      blocked++;
      continue;
    }
    if (dep === "dead") {
      if (setOpStatus(db.sql, run.run_id, op.op_id, "conflict", { decidedBy, error: "depends on a change that was rejected" })) {
        statusOf.set(op.op_id, "conflict");
        conflicts++;
      }
      continue;
    }
    try {
      await commitOp(db, opDef(payload.kind), payload, {
        actor: runActor(run),
        keep,
        claim: { runId: run.run_id, opId: op.op_id, status: "accepted", decidedBy },
      });
      statusOf.set(op.op_id, "accepted");
      applied++;
    } catch (e) {
      if (!(e instanceof OpError)) throw e;
      if (e.slug === "already_decided") continue;
      // An unreadable spill says nothing about the proposal: it stays pending.
      if (e.status === 503) {
        deferred++;
        continue;
      }
      if (setOpStatus(db.sql, run.run_id, op.op_id, "conflict", { decidedBy, error: e.message })) {
        statusOf.set(op.op_id, "conflict");
        conflicts++;
      }
    }
  }

  const now = Date.now();
  const remaining = pendingCountOf(db.sql, run.run_id);
  if (remaining === 0 && run.status === "open") closeRun(db.sql, run.run_id, now);
  else touchRun(db.sql, run.run_id, now);
  const fresh = getRun(db.sql, run.run_id)!;
  const summary = await db.runSummary(fresh);
  db.sockets.sendToReviewer(
    fresh.reviewer,
    encodeJson(Opcode.DB_RUN_DECIDED, { run_id: fresh.run_id, decision, op_ids: touched, decided_by: decidedBy, run: summary } satisfies DatabaseRunDecidedPayload),
  );
  db.publishRun(fresh, {
    type: "run.decided",
    actor: `user:${decidedBy}`,
    actorKind: "human",
    payload: { decision, decided_by: decidedBy, ops: touched.length, applied, rejected, conflicts, pending: remaining },
  });
  return Response.json({ run: summary, applied, rejected, conflicts, blocked, deferred });
}

export async function handleRunAck(db: Database, req: Request): Promise<Response> {
  const { run } = reviewerOf(db, await readJson(req), "acked_by");
  acknowledgeRun(db.sql, run.run_id, Date.now());
  const fresh = getRun(db.sql, run.run_id)!;
  db.publishRun(fresh);
  return Response.json({ run: await db.runSummary(fresh) });
}

/**
 * Undo a run's applied ops and reject what is still pending. Ops unwind in
 * reverse ledger order, the order they hit the data: accepts can land out of
 * position order, and two ops on one cell must unwind newest first.
 */
export async function handleRunRevert(db: Database, req: Request): Promise<Response> {
  const body = await readJson(req);
  const keep = parseOpsKeep(body);
  const { run, by: requestedBy } = reviewerOf(db, body, "requested_by");
  db.requireUnlocked("this database is locked; unlock it to revert changes");
  if (run.reverted) throw new OpError(409, "already_reverted", "this run was already reverted");
  const actor: DatabaseActorIdentity = { alias: requestedBy, is_agent: false };

  const ops = listRunOps(db.sql, run.run_id);
  // Refused before anything changes, as a document's run is: pending ops stay decidable.
  if (!ops.some((o) => o.ledger_op_id !== null)) throw new OpError(409, "nothing_to_revert", "nothing in this run was applied");
  for (const op of ops) {
    if (op.status === "pending") setOpStatus(db.sql, run.run_id, op.op_id, "rejected", { decidedBy: requestedBy });
  }
  const ledgerOps = ops
    .flatMap((o) => (o.ledger_op_id === null ? [] : [getOp(db.sql, o.ledger_op_id)]))
    .filter((op): op is OpRow => op !== null)
    .sort((a, b) => b.seq - a.seq);
  let reverted = 0;
  let skipped = 0;
  let restored = 0;
  let missing = 0;
  for (const op of ledgerOps) {
    if (!isRevertible(op)) {
      skipped++;
      continue;
    }
    try {
      const outcome = await revertOp(db, op, actor, keep);
      restored += outcome.restored;
      missing += outcome.missing;
      reverted++;
    } catch (e) {
      if (!(e instanceof OpError)) throw e;
      skipped++;
    }
  }
  // A concurrent revert may have finished during the awaits above; only one reports it.
  if (getRun(db.sql, run.run_id)!.reverted) throw new OpError(409, "already_reverted", "this run was already reverted");
  markRunReverted(db.sql, run.run_id, Date.now());
  const fresh = getRun(db.sql, run.run_id)!;
  await db.sendRunUpdated(fresh);
  db.sockets.broadcastChanged(null, "revert");
  db.publishRun(fresh, {
    type: "run.reverted",
    actor: `user:${requestedBy}`,
    actorKind: "human",
    payload: { decided_by: requestedBy, reverted, skipped },
  });
  return Response.json({ run: await db.runSummary(fresh), reverted, skipped, restored, missing });
}

export async function handleRunDetail(db: Database, url: URL): Promise<Response> {
  const run = getRun(db.sql, url.searchParams.get("runId"));
  if (!run) throw new OpError(404, "run_not_found", "no such run");
  const sample = url.searchParams.get("sample");
  const full = url.searchParams.get("full") === "1";
  return Response.json({ run: await db.runSummary(run, { full, sample: sample !== null && /^\d{1,4}$/.test(sample) ? Number(sample) : undefined }) });
}

export async function handleRunList(db: Database, url: URL): Promise<Response> {
  const runs: DatabaseRunSummary[] = [];
  for (const run of listRuns(db.sql, clampRunLimit(url.searchParams.get("limit"), DATABASE_RUN_KEEP, DATABASE_RUN_LIST_DEFAULT))) {
    runs.push(await db.runSummary(run));
  }
  return Response.json({ runs });
}

const OPS_LIST_DEFAULT = 50;
const OPS_LIST_MAX = 200;

export function handleOpsList(db: Database, url: URL): Response {
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null ? OPS_LIST_DEFAULT : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1) throw new OpError(400, "validation", "limit must be a positive integer");
  const rawBefore = url.searchParams.get("before_seq");
  const beforeSeq = rawBefore === null ? null : Number(rawBefore);
  if (beforeSeq !== null && !Number.isInteger(beforeSeq)) throw new OpError(400, "validation", "before_seq must be an integer");
  return Response.json({ ops: listOps(db.sql, Math.min(limit, OPS_LIST_MAX), beforeSeq) });
}

export async function handleOpsRevert(db: Database, req: Request): Promise<Response> {
  const body = await readJson(req);
  const actor = parseActor(body);
  const keep = parseOpsKeep(body);
  db.throttle(actor, "mutation");
  const op = getOp(db.sql, body.op_id);
  if (!op) throw new OpError(404, "op_not_found", `no op with id ${String(body.op_id)}`);
  if (op.kind === "revert") throw new OpError(409, "not_revertible", "a revert cannot be reverted");
  if (op.reverted_by !== null) throw new OpError(409, "already_reverted", "this op was already reverted");
  if (!isRevertible(op)) throw new OpError(409, "not_revertible", "this op has no recorded inverse");
  const outcome = await revertOp(db, op, actor, keep);
  db.sockets.broadcastChanged(op.table_id, "revert");
  return Response.json({ reverted: true, ...outcome });
}

/** Apply an op's inverse and record the revert. The blob read is the only await, so the op is re-checked inside the transaction. */
async function revertOp(db: Database, op: OpRow, actor: DatabaseActorIdentity, keep: number): Promise<RevertOutcome> {
  const inverse = await loadInverse(db.bucket, op);
  const revertId = newId("op_");
  let pruned: string[] = [];
  const outcome = db.storage.transactionSync(() => {
    const fresh = getOp(db.sql, op.op_id);
    if (!fresh || fresh.reverted_by !== null) throw new OpError(409, "already_reverted", "this op was already reverted");
    const now = Date.now();
    const result = applyInverse(db.sql, inverse, now);
    pruned = recordOp(
      db.sql,
      { opId: revertId, actor, kind: "revert", tableId: op.table_id, summary: `Reverted: ${op.summary}`, inline: null, blobKey: null, reverts: op.op_id, keep },
      now,
    );
    db.sql.exec(`UPDATE _ops SET reverted_by = ? WHERE op_id = ?`, revertId, op.op_id);
    return result;
  });
  db.dropBlobs(pruned);
  return outcome;
}
