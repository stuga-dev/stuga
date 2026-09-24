/**
 * An agent's proposal. The database's `agent_mode`, resolved by the node and
 * sent as `review`, is the whole decision: `review` parks the op for a person,
 * `auto` commits it with the run as the receipt.
 */
import { DATABASE_RUN_OPS_MAX } from "@stuga/protocol/databases/limits";
import type { DatabaseActor as DatabaseActorIdentity, DatabaseRunSource } from "@stuga/protocol/databases/types";
import { stricterReviewMode } from "@stuga/protocol/domain/events";
import { agentActorOf, newRunId, parseReviewMode, runIsIdle, shouldCommit } from "@stuga/protocol/domain/runs";
import type { Database } from "../database.js";
import { commitOp, opDef, proposableDef } from "../ops/registry.js";
import { SchemaView } from "../ops/schema-view.js";
import { OpError, parseActor, parseOpsKeep, readJson, requireObject } from "../request.js";
import {
  closeRun,
  finalizeRunPayload,
  getRun,
  getRunOp,
  insertRun,
  insertRunOp,
  listPendingRunOps,
  loadOpPayload,
  markRunAutoApplied,
  openRunOf,
  pendingCountOf,
  pendingPayloads,
  pruneRuns,
  setOpStatus,
  setRunReviewMode,
  totalOpsOf,
  touchRun,
  type RunRow,
} from "./runs.js";

const RUN_SOURCES: ReadonlySet<string> = new Set(["connector", "stdio", "panel"]);

const optionalString = (v: unknown): string | null => (typeof v === "string" ? v : null);

function requiredString(v: unknown, field: string): string {
  if (typeof v !== "string" || v === "") throw new OpError(400, "bad_request", `${field} is required`);
  return v;
}

/** The identity a run's ops are ledgered under: the agent, on its reviewer's behalf. */
export function runActor(run: RunRow): DatabaseActorIdentity {
  return { alias: run.agent_alias, is_agent: true, on_behalf_of: run.reviewer };
}

export async function handleRunPropose(db: Database, req: Request): Promise<Response> {
  const body = await readJson(req);
  const actor = parseActor(body);
  const keep = parseOpsKeep(body);
  if (!actor.is_agent) throw new OpError(400, "bad_request", "only agent mutations are proposed");
  db.throttle(actor, "mutation");
  const lockedMessage = "this database is locked; the user must unlock it first";
  db.requireUnlocked(lockedMessage);
  const source = typeof body.source === "string" && RUN_SOURCES.has(body.source) ? (body.source as DatabaseRunSource) : null;
  if (!source) throw new OpError(400, "bad_request", "source must be connector, stdio, or panel");
  const agent = requiredString(body.agent, "agent");
  const reviewer = requiredString(body.reviewer, "reviewer");
  const workspaceId = requiredString(body.workspace_id, "workspace_id");
  const docTitle = requiredString(body.doc_title, "doc_title");
  const op = requireObject(body.op, "op must be an object", "bad_request");
  const review = parseReviewMode(body.review);
  const now = Date.now();

  let run = openRunOf(db.sql, actor.alias);
  // A run closes when it has gone quiet with nothing pending, or when a receipt
  // run reaches the op cap (`auto` must never block the agent). A run a person
  // still has to review refuses at the cap instead.
  if (run && pendingCountOf(db.sql, run.run_id) === 0 && (runIsIdle(run.updated_at, now) || totalOpsOf(db.sql, run.run_id) >= DATABASE_RUN_OPS_MAX)) {
    closeRun(db.sql, run.run_id, now);
    await db.sendRunUpdated(getRun(db.sql, run.run_id)!);
    run = null;
  }
  if (run && totalOpsOf(db.sql, run.run_id) >= DATABASE_RUN_OPS_MAX) {
    throw new OpError(409, "run_cap", `this run already has ${DATABASE_RUN_OPS_MAX} changes; wait for the user to review them`);
  }

  const def = proposableDef(op.kind);
  if (!def) throw new OpError(400, "bad_request", `unknown op kind: ${String(op.kind)}`);
  const view = SchemaView.projected(db.sql, run ? (await pendingPayloads(db.sql, db.bucket, run.run_id)).map((p) => p.payload) : []);
  const payload = def.parse(op, view);
  const summary = def.proposal.describe(payload, view);

  const mintRun = (): RunRow => {
    const runId = newRunId();
    insertRun(
      db.sql,
      {
        runId,
        source,
        agent,
        agentAlias: actor.alias,
        reviewer,
        workspaceId,
        docTitle,
        reviewMode: review,
        client: optionalString(body.client),
        model: optionalString(body.model),
      },
      now,
    );
    db.dropBlobs(pruneRuns(db.sql));
    return getRun(db.sql, runId)!;
  };
  if (!run) run = mintRun();

  // The op id and position are minted after the spill await, together with the
  // insert, so two concurrent proposals can never claim the same position.
  const fin = await finalizeRunPayload(db.bucket, db.dbId, run.run_id, payload);
  db.requireUnlocked(lockedMessage);
  const reloaded = getRun(db.sql, run.run_id);
  run = reloaded !== null && reloaded.status === "open" ? reloaded : mintRun();
  const opId = insertRunOp(db.sql, { runId: run.run_id, kind: payload.kind, tableId: payload.table_id, summary, ...fin, review });
  touchRun(db.sql, run.run_id, now);
  setRunReviewMode(db.sql, run.run_id, stricterReviewMode(run.review_mode, review));
  const minted = def.proposal.minted(payload);

  // An op parsed against undecided ops of its run may depend on them, so it cannot land ahead of them.
  const parkedBehindPending = listPendingRunOps(db.sql, run.run_id).some((o) => o.review !== "auto");
  if (shouldCommit(review, source, parkedBehindPending)) {
    const outcome = await autoApplyPending(db, getRun(db.sql, run.run_id)!, keep);
    const fresh = getRun(db.sql, run.run_id)!;
    db.publishRun(fresh, {
      type: "run.applied",
      actor: agentActorOf(actor.alias),
      actorKind: "agent",
      payload: { review, decided_by: "policy:auto", applied: outcome.applied, conflicts: outcome.conflicts },
    });
    const opRow = getRunOp(db.sql, run.run_id, opId);
    if (opRow?.status === "conflict") {
      return Response.json({ error: "conflict", message: opRow.error ?? "the proposal no longer applies" }, { status: 409 });
    }
    return Response.json({ mode: "applied", run: await db.runSummary(fresh), result: outcome.results.get(opId) ?? null, minted });
  }

  // Parked. The live frame reaches a tab that has the table open; the
  // notification reaches everyone else. The co-author panel's requester is
  // already looking at it.
  const fresh = getRun(db.sql, run.run_id)!;
  const pending = pendingCountOf(db.sql, fresh.run_id);
  await db.sendRunUpdated(fresh);
  if (source !== "panel") await db.notifyProposed(fresh, pending);
  db.publishRun(fresh, { type: "run.proposed", actor: agentActorOf(actor.alias), actorKind: "agent", payload: { review, pending } });
  return Response.json({
    mode: "proposed",
    run: await db.runSummary(fresh),
    pending,
    minted,
    // Said only when it contradicts the word the node sent, so an agent that just read `auto` is told why it waits.
    parked_behind_pending: parkedBehindPending && review === "auto",
  });
}

/**
 * Commit every pending op of the run proposed under `auto`, in position order.
 * The run stays open so a session groups into one receipt. A lock or an
 * unreadable spill leaves an op pending; anything else that refuses it is a conflict.
 */
async function autoApplyPending(db: Database, run: RunRow, keep: number): Promise<{ applied: number; conflicts: number; results: Map<string, Record<string, unknown>> }> {
  const decidedBy = "policy:auto";
  const results = new Map<string, Record<string, unknown>>();
  let applied = 0;
  let conflicts = 0;
  for (const opRow of listPendingRunOps(db.sql, run.run_id).filter((o) => o.review === "auto")) {
    try {
      const payload = await loadOpPayload(db.bucket, opRow);
      const result = await commitOp(db, opDef(payload.kind), payload, {
        actor: runActor(run),
        keep,
        claim: { runId: run.run_id, opId: opRow.op_id, status: "auto_applied", decidedBy },
      });
      results.set(opRow.op_id, result);
      applied++;
    } catch (e) {
      if (!(e instanceof OpError)) throw e;
      if (e.slug === "already_decided" || e.status === 503 || e.status === 423) continue;
      setOpStatus(db.sql, run.run_id, opRow.op_id, "conflict", { decidedBy, error: e.message });
      conflicts++;
    }
  }
  if (applied > 0) markRunAutoApplied(db.sql, run.run_id);
  else touchRun(db.sql, run.run_id, Date.now());
  return { applied, conflicts, results };
}
