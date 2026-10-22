/** `/api/databases/:id/...`: every route passes databaseRoute's gate and forwards to the database's actor. */
import { touchDoc, type DocRow } from "@stuga/db";
import { csvFileName, rowsToCsv } from "@stuga/protocol/databases/csv";
import { selectOnlyViolation } from "@stuga/protocol/databases/sql-guard";
import { parseDecisionNote, type RunAct } from "@stuga/protocol/domain/runs";
import type { DatabaseOpSummary, DatabaseRunSummary } from "@stuga/protocol/databases/types";
import { agentNameMap } from "../agents/names.js";
import { recordAudit } from "../audit/record.js";
import { docInstructionLabelsOrNone } from "../documents/instructions.js";
import type { Ctx } from "../auth/context.js";
import { canWriteDoc } from "../authz/authz.js";
import { RunJudge, decisionRefusal, mayAct, narrowStacked, runDeciders, vouched, type RunVerdict } from "../authz/review-mode.js";
import { lockedError } from "../documents/access.js";
import { docAgentInstructions } from "../documents/instructions.js";
import { actorRefusalStatus, afterDatabaseMutation, authorizedDatabase, callDatabaseActor, databaseActor, projectedSchema, proxyActor } from "./gate.js";
import type { DecisionBlock } from "../api/runs.js";
import { settleHeldPage } from "../changes/held.js";
import { changeArgsOf, type ChangeArgs } from "../changes/resolve.js";
import { commitDatabaseImport, createDatabaseImport, parseCommitOptions } from "./imports/staging.js";
import {
  databaseProposeBody,
  parseColumnSpecs,
  proposeDatabaseOp,
  proposeTableWithColumns,
  type DatabaseProposeOutcome,
} from "./propose.js";
import { annotateRowPages, openRowPage, reconcileDocLinks } from "./row-pages.js";
import { error, json } from "../http/respond.js";
import type { WorkspaceCall } from "../http/router.js";

/** What a database route receives: the call, and the database it names, already through the read gate. */
export interface DatabaseCall extends WorkspaceCall {
  doc: DocRow;
  docId: string;
  canWrite: boolean;
  /** The write ACL, then the lock. */
  writeRefusal(): Response | null;
  body(): Promise<Record<string, unknown>>;
  /** An agent write's answer; mode "proposed" means queued for review. An agent's also names the instructions here. */
  proposeEnvelope(outcome: DatabaseProposeOutcome): Promise<Response>;
  /** Propose one op on the run ledger as a REST (stdio) agent, in the change its body names. */
  proposeOrError(op: Record<string, unknown>, change?: ChangeArgs): Promise<Response>;
  /** Renaming, retyping and deleting tables or columns has no reviewable form, so it stays a person's act. */
  agentSchemaRefusal(): Response | null;
}

/** The gate every database route passes first: tenant, ACL and scope, else "not found". */
export function databaseRoute(handler: (call: DatabaseCall) => Promise<Response>): (call: WorkspaceCall) => Promise<Response> {
  return async (call) => {
    const { ctx, req } = call;
    const docId = call.match[1]!;
    const doc = await authorizedDatabase(ctx, docId);
    if (!doc) return error(404, "not found");
    const canWrite = canWriteDoc(ctx, doc);
    const writeRefusal = (): Response | null => {
      if (!canWrite) return error(403, "view-only access");
      if (doc.locked) return error(423, "this document is locked; unlock it to make changes");
      return null;
    };
    const body = async (): Promise<Record<string, unknown>> =>
      ((await req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
    // A write needs no schema read, so an agent's answer names what governs this database; the schema carries the text.
    const proposeEnvelope = async (outcome: DatabaseProposeOutcome): Promise<Response> => {
      if (outcome.kind === "error") return error(outcome.status, outcome.message);
      const body = databaseProposeBody(outcome);
      return json(ctx.isAgent ? { ...body, ...(await docInstructionLabelsOrNone(ctx, doc)) } : body);
    };
    const proposeOrError = (op: Record<string, unknown>, change?: ChangeArgs): Promise<Response> =>
      proposeDatabaseOp(ctx, doc, op, "stdio", change ? { change } : {}).then(proposeEnvelope);
    const agentSchemaRefusal = (): Response | null =>
      ctx.isAgent
        ? error(
            403,
            "agents cannot rename, retype, or delete tables/columns — propose new columns/tables instead, or ask the user to make this change",
          )
        : null;
    return handler({ ...call, doc, docId, canWrite, writeRefusal, body, proposeEnvelope, proposeOrError, agentSchemaRefusal });
  };
}

/** Every path under a database this table does not name. */
export async function databaseNotFound(): Promise<Response> {
  return error(404, "not found");
}

/** The settable fields of a view, as sent; the actor validates them. */
const VIEW_FIELDS = ["name", "kind", "filter", "sorts", "group_by", "hidden_columns", "config", "position"] as const;

function viewFields(b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of VIEW_FIELDS) if (b[k] !== undefined) out[k] = b[k];
  return out;
}

/** The same fields on a propose op, where `kind` names the op and the view's kind travels as `view_kind`. */
function viewOpFields(b: Record<string, unknown>): Record<string, unknown> {
  const { kind, ...rest } = viewFields(b);
  return kind === undefined ? rest : { ...rest, view_kind: kind };
}

export async function getSchema({ ctx, doc, docId, canWrite }: DatabaseCall): Promise<Response> {
  // An agent reads its own pending proposals overlaid, so it does not propose them again.
  const path = ctx.isAgent ? `schema?agent=${encodeURIComponent(ctx.alias)}` : "schema";
  const res = await callDatabaseActor(ctx, docId, path, null, "GET");
  if (!res.ok) return proxyActor(res, "could not load the schema");
  const schema = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!schema) return error(502, "could not load the schema");
  // Only the node knows the ACL, so the grid learns from here whether to offer edits.
  const answer = { ...schema, can_write: canWrite && !doc.locked };
  if (!ctx.isAgent) return json(answer);
  // An agent reads the database's instructions with the schema it is about to write against.
  return json({ ...answer, ...(await docAgentInstructions(ctx, doc)) });
}

export async function createTable({ ctx, doc, docId, writeRefusal, body, proposeOrError, proposeEnvelope }: DatabaseCall): Promise<Response> {
  const r = writeRefusal();
  if (r) return r;
  const b = await body();
  // `columns` land with the table: one transaction for a person, one run for an agent.
  const specs = b.columns === undefined ? { ok: true as const, columns: [] } : parseColumnSpecs(b.columns);
  if (!specs.ok) return error(400, specs.message);
  if (ctx.isAgent) {
    if (specs.columns.length === 0) return proposeOrError({ kind: "tables.create", display: b.display }, changeArgsOf(b));
    if (typeof b.display !== "string" || b.display.trim() === "") return error(400, "display must not be empty");
    return proposeEnvelope(await proposeTableWithColumns(ctx, doc, b.display, specs.columns, "stdio", { change: changeArgsOf(b) }));
  }
  const res = await callDatabaseActor(ctx, docId, "tables/create", { display: b.display, columns: specs.columns });
  if (res.ok) await afterDatabaseMutation(ctx, doc, { kind: "table_created" });
  return proxyActor(res, "could not create the table");
}

export async function renameTable({ ctx, match, doc, docId, writeRefusal, body, agentSchemaRefusal }: DatabaseCall): Promise<Response> {
  const tableId = match[2]!;
  const r = writeRefusal() ?? agentSchemaRefusal();
  if (r) return r;
  const b = await body();
  const res = await callDatabaseActor(ctx, docId, "tables/rename", { table_id: tableId, display: b.display });
  if (res.ok) await afterDatabaseMutation(ctx, doc, { kind: "table_renamed" });
  return proxyActor(res, "could not rename the table");
}

export async function deleteTable({ ctx, match, doc, docId, writeRefusal, agentSchemaRefusal }: DatabaseCall): Promise<Response> {
  const tableId = match[2]!;
  const r = writeRefusal() ?? agentSchemaRefusal();
  if (r) return r;
  const res = await callDatabaseActor(ctx, docId, "tables/delete", { table_id: tableId });
  if (res.ok) {
    await afterDatabaseMutation(ctx, doc, { kind: "table_deleted" });
    await reconcileDocLinks(ctx, doc); // its rows' pages go to the trash
  }
  return proxyActor(res, "could not delete the table");
}

export async function addColumn({ ctx, match, doc, docId, writeRefusal, body, proposeOrError }: DatabaseCall): Promise<Response> {
  const r = writeRefusal();
  if (r) return r;
  const b = await body();
  if (ctx.isAgent) {
    return proposeOrError({ kind: "columns.add", table: match[2]!, display: b.display, type: b.type, choices: b.choices, description: b.description }, changeArgsOf(b));
  }
  const res = await callDatabaseActor(ctx, docId, "columns/add", {
    table_id: match[2]!,
    display: b.display,
    type: b.type,
    choices: b.choices,
    description: b.description,
  });
  if (res.ok) await afterDatabaseMutation(ctx, doc, { kind: "column_added" });
  return proxyActor(res, "could not add the column");
}

export async function updateColumn({ ctx, match, doc, docId, writeRefusal, body, agentSchemaRefusal }: DatabaseCall): Promise<Response> {
  const [, , tableId, columnId] = match as unknown as [string, string, string, string];
  const r = writeRefusal() ?? agentSchemaRefusal();
  if (r) return r;
  const b = await body();
  // A body names one of `type`, `display`, `description` or `format`; any two at once is ambiguous.
  if (["type", "display", "description", "format"].filter((f) => b[f] !== undefined).length > 1) {
    return error(400, "change the type, the name and the description in separate requests");
  }
  if (b.format !== undefined) {
    const res = await callDatabaseActor(ctx, docId, "columns/set-format", {
      table_id: tableId,
      column_id: columnId,
      format: b.format,
    });
    if (res.ok) await afterDatabaseMutation(ctx, doc, { kind: "column_format_changed" });
    return proxyActor(res, "could not change the number format");
  }
  if (b.description !== undefined) {
    const res = await callDatabaseActor(ctx, docId, "columns/set-description", {
      table_id: tableId,
      column_id: columnId,
      description: b.description,
    });
    if (res.ok) await afterDatabaseMutation(ctx, doc, { kind: "column_described" });
    return proxyActor(res, "could not describe the column");
  }
  if (b.type !== undefined) {
    const res = await callDatabaseActor(ctx, docId, "columns/set-type", {
      table_id: tableId,
      column_id: columnId,
      type: b.type,
      choices: b.choices,
    });
    if (res.ok) await afterDatabaseMutation(ctx, doc, { kind: "column_type_changed" });
    return proxyActor(res, "could not change the column type");
  }
  const res = await callDatabaseActor(ctx, docId, "columns/rename", {
    table_id: tableId,
    column_id: columnId,
    display: b.display,
  });
  if (res.ok) await afterDatabaseMutation(ctx, doc, { kind: "column_renamed" });
  return proxyActor(res, "could not rename the column");
}

export async function deleteColumn({ ctx, match, doc, docId, writeRefusal, agentSchemaRefusal }: DatabaseCall): Promise<Response> {
  const [, , tableId, columnId] = match as unknown as [string, string, string, string];
  const r = writeRefusal() ?? agentSchemaRefusal();
  if (r) return r;
  const res = await callDatabaseActor(ctx, docId, "columns/delete", { table_id: tableId, column_id: columnId });
  if (res.ok) await afterDatabaseMutation(ctx, doc, { kind: "column_deleted" });
  return proxyActor(res, "could not delete the column");
}

// An agent's view create or update rides the run ledger; deleting a view stays a person's act.
export async function createView({ ctx, match, doc, docId, writeRefusal, body, proposeOrError }: DatabaseCall): Promise<Response> {
  const r = writeRefusal();
  if (r) return r;
  const b = await body();
  const tableId = match[2]!;
  if (ctx.isAgent) return proposeOrError({ kind: "views.create", table: tableId, ...viewOpFields(b) }, changeArgsOf(b));
  const res = await callDatabaseActor(ctx, docId, "views/create", { table_id: tableId, ...viewFields(b) });
  if (res.ok) await afterDatabaseMutation(ctx, doc, { kind: "view_created" });
  return proxyActor(res, "could not create the view");
}

export async function updateView({ ctx, match, doc, docId, writeRefusal, body, proposeOrError }: DatabaseCall): Promise<Response> {
  const [, , tableId, viewId] = match as unknown as [string, string, string, string];
  const r = writeRefusal();
  if (r) return r;
  const b = await body();
  if (ctx.isAgent) return proposeOrError({ kind: "views.update", table: tableId, view: viewId, ...viewOpFields(b) }, changeArgsOf(b));
  const res = await callDatabaseActor(ctx, docId, "views/update", { table_id: tableId, view_id: viewId, ...viewFields(b) });
  if (res.ok) await afterDatabaseMutation(ctx, doc, { kind: "view_changed" });
  return proxyActor(res, "could not change the view");
}

export async function deleteView({ ctx, match, doc, docId, writeRefusal }: DatabaseCall): Promise<Response> {
  const [, , tableId, viewId] = match as unknown as [string, string, string, string];
  const r = writeRefusal();
  if (r) return r;
  if (ctx.isAgent) return error(403, "agents cannot delete views — ask the user to remove it");
  const res = await callDatabaseActor(ctx, docId, "views/delete", { table_id: tableId, view_id: viewId });
  if (res.ok) await afterDatabaseMutation(ctx, doc, { kind: "view_deleted" });
  return proxyActor(res, "could not delete the view");
}

export async function openRowPageRoute({ ctx, match, doc, body }: DatabaseCall): Promise<Response> {
  const b = await body();
  if (b.replace_trashed !== undefined && typeof b.replace_trashed !== "boolean") return error(400, "replace_trashed must be a boolean");
  const out = await openRowPage(ctx, doc, match[2]!, match[3]!, { replaceTrashed: b.replace_trashed === true });
  if (out.kind === "error") return error(out.status, out.message);
  return json({ doc_id: out.doc_id, created: out.created, ...(out.restored ? { restored: true } : {}) }, { status: out.created ? 201 : 200 });
}

export async function listRows({ ctx, match, docId, body }: DatabaseCall): Promise<Response> {
  // A read sent as POST for its filter body. The actor trusts agent_alias, so it comes from the credential.
  const b = await body();
  const res = await callDatabaseActor(ctx, docId, "rows/list", {
    table_id: match[2]!,
    limit: b.limit,
    offset: b.offset,
    sort: b.sort,
    filter: b.filter,
    group_by: b.group_by,
    view_id: b.view_id,
    search: b.search,
    ...(ctx.isAgent ? { agent_alias: ctx.alias } : {}),
  });
  if (!res.ok) return proxyActor(res, "could not list rows");
  const page = (await res.json().catch(() => null)) as { rows?: Array<Record<string, unknown>> } | null;
  if (!page) return error(502, "could not list rows");
  await annotateRowPages(ctx, page.rows ?? []);
  return json(page);
}

/**
 * Every row a listing's shape selects as a CSV download: `filter`, `sort`, `group_by`, `search` and
 * `view_id` as a listing takes them, and `columns`, the column ids to write in order (default every
 * column). Live data only: an agent's pending proposals are not laid over it.
 */
export async function exportRowsCsv({ ctx, match, docId, body }: DatabaseCall): Promise<Response> {
  const tableId = match[2]!;
  const b = await body();
  const schema = await projectedSchema(ctx, docId);
  const table = schema?.tables.find((t) => t.table_id === tableId && !t.pending);
  if (!table) return error(404, "no such table");
  const live = [...table.columns].filter((c) => !c.pending).sort((x, y) => x.position - y.position);
  let columns = live;
  if (b.columns !== undefined) {
    if (!Array.isArray(b.columns) || !b.columns.every((c) => typeof c === "string")) return error(400, "columns must be a list of column ids");
    const wanted = b.columns as string[];
    columns = wanted.flatMap((id) => live.filter((c) => c.column_id === id));
  }
  const res = await callDatabaseActor(ctx, docId, "rows/export", {
    table_id: tableId,
    sort: b.sort,
    filter: b.filter,
    group_by: b.group_by,
    view_id: b.view_id,
    search: b.search,
  });
  if (!res.ok) return proxyActor(res, "could not export rows");
  const out = (await res.json().catch(() => null)) as { rows?: Array<Record<string, unknown>> } | null;
  if (!out?.rows) return error(502, "could not export rows");
  const name = csvFileName(table.display);
  return new Response(rowsToCsv(columns, out.rows), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${name.replace(/[^\x20-\x7e]|"/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

export async function insertRows({ ctx, match, doc, docId, writeRefusal, body, proposeOrError }: DatabaseCall): Promise<Response> {
  const tableId = match[2]!;
  const r = writeRefusal();
  if (r) return r;
  const b = await body();
  if (ctx.isAgent) return proposeOrError({ kind: "rows.insert", table: tableId, rows: b.rows }, changeArgsOf(b));
  const res = await callDatabaseActor(ctx, docId, "rows/insert", { table_id: tableId, rows: b.rows });
  if (!res.ok) return proxyActor(res, "could not insert rows");
  const out = (await res.json().catch(() => null)) as { inserted?: number } | null;
  if (!out) return error(502, "could not insert rows");
  const n = out.inserted ?? 0;
  await afterDatabaseMutation(ctx, doc, { kind: "rows_inserted", count: n });
  return json(out);
}

export async function updateRows({ ctx, match, doc, docId, writeRefusal, body, proposeOrError }: DatabaseCall): Promise<Response> {
  const tableId = match[2]!;
  const r = writeRefusal();
  if (r) return r;
  const b = await body();
  if (ctx.isAgent) return proposeOrError({ kind: "rows.update", table: tableId, updates: b.updates }, changeArgsOf(b));
  const res = await callDatabaseActor(ctx, docId, "rows/update", { table_id: tableId, updates: b.updates });
  if (!res.ok) return proxyActor(res, "could not update rows");
  // The count the actor changed, not the count requested.
  const out = (await res.json().catch(() => null)) as { updated?: number } | null;
  if (!out) return error(502, "could not update rows");
  const n = out.updated ?? 0;
  // Nothing changed (each row refused for a conflict): no edit time, audit row or event to report.
  if (n > 0) await afterDatabaseMutation(ctx, doc, { kind: "rows_updated", count: n });
  return json(out);
}

export async function deleteRows({ ctx, match, doc, docId, writeRefusal, body, proposeOrError }: DatabaseCall): Promise<Response> {
  // POST, because the row ids ride in the body.
  const r = writeRefusal();
  if (r) return r;
  const b = await body();
  if (ctx.isAgent) return proposeOrError({ kind: "rows.delete", table: match[2]!, row_ids: b.row_ids }, changeArgsOf(b));
  const res = await callDatabaseActor(ctx, docId, "rows/delete", { table_id: match[2]!, row_ids: b.row_ids });
  if (!res.ok) return proxyActor(res, "could not delete rows");
  const out = (await res.json().catch(() => null)) as { deleted?: number } | null;
  if (!out) return error(502, "could not delete rows");
  const n = out.deleted ?? 0;
  await afterDatabaseMutation(ctx, doc, { kind: "rows_deleted", count: n });
  await reconcileDocLinks(ctx, doc); // the deleted rows' pages go to the trash
  return json(out);
}

export async function queryDatabase({ ctx, docId, body }: DatabaseCall): Promise<Response> {
  // Read-gated: the SELECT guard and the actor's rolled-back transaction make it side-effect-free.
  const b = await body();
  const sqlText = typeof b.sql === "string" ? b.sql : "";
  // The actor validates again.
  const violation = selectOnlyViolation(sqlText);
  if (violation) return error(400, violation);
  const res = await callDatabaseActor(ctx, docId, "query", { sql: sqlText, params: b.params });
  return proxyActor(res, "query failed");
}

/** Ops that landed: what they wrote is in the database and its activity for any reader. */
const LANDED: ReadonlySet<string> = new Set(["accepted", "auto_applied"]);

/**
 * The run for a person, with where they stand on it (`you`). An op that has not landed (waiting,
 * rejected or in conflict), its summary, detail, note and error included, goes only to its reviewer,
 * its approvers and the database's managers: anyone else who can read the database sees that the
 * run exists, how it went, and the ops that landed, as a document's runs show them.
 */
export function forPerson(run: DatabaseRunSummary, v: RunVerdict): DatabaseRunSummary {
  const out: DatabaseRunSummary = { ...run, you: v.standing };
  if (v.seesText) return out;
  const ops = run.ops.filter((op) => LANDED.has(op.status));
  if (ops.length === run.ops.length) return out;
  // How many wait, which the inbox shows every reader too, so the card can say whether any do.
  return { ...out, ops, ops_withheld: true, ops_pending: run.ops.filter((op) => op.status === "pending").length };
}

/**
 * The actor's 403 as the client reads it: at `colleague` it refuses the run's reviewer on its own
 * word too, when the level rose after the node read the run.
 */
async function actorRefusal(res: Response, otherwise: string): Promise<Response> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return error(403, body?.error === "own_run" ? "a colleague approves these changes, not the person who asked the AI" : otherwise);
}

/**
 * Read the run and judge whether the caller may do `act` on it, before the actor is asked: the
 * actor holds the run and re-checks; the node alone knows the database's level, its approvers and
 * who manages it.
 */
async function judgeAct(ctx: Ctx, doc: DocRow, runId: string, act: RunAct): Promise<Response | { run: DatabaseRunSummary; verdict: RunVerdict }> {
  const judged = await judgeRunAct(ctx, doc, runId, act);
  return "status" in judged ? error(judged.status, judged.message) : judged;
}

async function judgeRunAct(
  ctx: Ctx,
  doc: DocRow,
  runId: string,
  act: RunAct,
): Promise<{ status: number; message: string; block: DecisionBlock } | { run: DatabaseRunSummary; verdict: RunVerdict }> {
  const res = await databaseActor(ctx, doc.doc_id).fetch(`http://actor/runs/detail?${new URLSearchParams({ dbId: doc.doc_id, runId })}`);
  if (res.status === 404) return { status: 404, message: "not found", block: "gone" };
  if (!res.ok) return { status: 502, message: "run unavailable", block: "gone" };
  const run = ((await res.json()) as { run?: DatabaseRunSummary }).run;
  if (!run) return { status: 502, message: "run unavailable", block: "gone" };
  const verdict = (await judgeDatabaseRuns(ctx, doc, [run]))[0]!;
  if (!mayAct(ctx, run, verdict, act)) return { status: 403, message: decisionRefusal(ctx, run, verdict, act, "database"), block: "refused" };
  return { run, verdict };
}

/** What a decision on one database run came to, or why it did not go through. */
export type DatabaseRunDecision =
  | { ok: true; run: DatabaseRunSummary; verdict: RunVerdict; applied: number; rejected: number; conflicts: number; blocked: number; answer: Record<string, unknown> }
  | { ok: false; status: number; message: string; block: DecisionBlock };

/**
 * Accept or reject a database run's waiting ops as `ctx`, through the gates the decision route runs:
 * write access, the lock (an accept only), who may act on it (RunJudge, checked again by the actor),
 * and the queue. Recorded in the audit ledger as the route records it.
 */
export async function decideDatabaseRunAs(
  ctx: Ctx,
  doc: DocRow,
  runId: string,
  decision: "accept" | "reject",
  opts: { note?: string; opIds?: string[] } = {},
): Promise<DatabaseRunDecision> {
  if (ctx.isAgent) return { ok: false, status: 403, message: "agents cannot review agent edits", block: "refused" };
  if (!canWriteDoc(ctx, doc)) return { ok: false, status: 403, message: "view-only access", block: "view_only" };
  // As on a document: a lock holds the data as it is, and a rejected proposal never touched it.
  if (decision === "accept" && doc.locked) return { ok: false, status: 423, message: "this document is locked; unlock it to make changes", block: "locked" };
  const judged = await judgeRunAct(ctx, doc, runId, decision);
  if ("status" in judged) return { ok: false, ...judged };
  const res = await callDatabaseActor(ctx, doc.doc_id, "runs/decide", {
    run_id: runId,
    decision,
    op_ids: opts.opIds,
    decided_by: ctx.alias,
    ...vouched(judged.verdict),
    ...(opts.note ? { note: opts.note } : {}),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
    if (res.status === 403) {
      return body?.error === "own_run"
        ? { ok: false, status: 403, message: "a colleague approves these changes, not the person who asked the AI", block: "refused" }
        : { ok: false, status: 403, message: "only this run's reviewer (or the database's owner) can decide it", block: "refused" };
    }
    if (res.status === 409 && body?.error === "queued") return { ok: false, status: 409, message: body.message ?? "these changes wait behind earlier ones", block: "queued" };
    if (res.status === 423) return { ok: false, status: 423, message: body?.message ?? "this database is locked", block: "locked" };
    return { ok: false, status: actorRefusalStatus(res), message: body?.message ?? "decision failed", block: "gone" };
  }
  const decided = (await res.json()) as { run?: DatabaseRunSummary; applied?: number; rejected?: number; conflicts?: number; blocked?: number };
  if (decided.run) decided.run = forPerson(decided.run, judged.verdict);
  // An accepted rows.delete took its rows' pages with it.
  await reconcileDocLinks(ctx, doc);
  recordAudit(ctx, {
    action: "run.decide",
    targetKind: "database",
    targetId: doc.doc_id,
    targetLabel: doc.title,
    detail: {
      run_id: runId,
      decision,
      agent: decided.run?.agent ?? null,
      ops: opts.opIds ? opts.opIds.length : (decided.run?.ops?.length ?? 0),
      applied: decided.applied ?? 0,
      rejected: decided.rejected ?? 0,
      conflicts: decided.conflicts ?? 0,
      level: judged.verdict.level,
      // On whose behalf the agent proposed: at `colleague`, never the one who decided.
      asked_by: judged.run.reviewer,
    },
  });
  // A new database of a change is released once its changes are approved, or removed once they are declined.
  await settleHeldPage(ctx, doc, opts.note ?? null);
  return {
    ok: true,
    run: decided.run ?? judged.run,
    verdict: judged.verdict,
    applied: decided.applied ?? 0,
    rejected: decided.rejected ?? 0,
    conflicts: decided.conflicts ?? 0,
    blocked: decided.blocked ?? 0,
    answer: decided as Record<string, unknown>,
  };
}

/** Where the caller stands on runs of a database, a queued run's ops narrowed to whoever reads what it was stacked on. */
export async function judgeDatabaseRuns(ctx: Ctx, doc: DocRow, runs: readonly DatabaseRunSummary[]): Promise<RunVerdict[]> {
  const judge = new RunJudge(ctx, doc);
  const verdicts = await judge.judgeAll(runs);
  if (!runs.some((r) => r.stacked_on?.length)) return verdicts;
  return narrowStacked(ctx, judge, runs, verdicts, async (id) => {
    const res = await databaseActor(ctx, doc.doc_id).fetch(`http://actor/runs/detail?${new URLSearchParams({ dbId: doc.doc_id, runId: id })}`);
    return res.ok ? (((await res.json()) as { run?: DatabaseRunSummary }).run ?? null) : null;
  });
}

// Deciding a run is the node's call (RunJudge: the database's level, its approvers, who manages it),
// which the actor, holding the run, checks again.
export async function listDatabaseRuns({ ctx, url, doc, docId }: DatabaseCall): Promise<Response> {
  const qs = new URLSearchParams({ dbId: docId });
  const limit = url.searchParams.get("limit");
  if (limit) qs.set("limit", limit);
  const res = await databaseActor(ctx, docId).fetch(`http://actor/runs?${qs}`);
  if (!res.ok) return error(502, "runs unavailable");
  const data = (await res.json()) as { runs?: DatabaseRunSummary[] };
  const runs = data.runs ?? [];
  // An agent sees only its own runs.
  if (ctx.isAgent) return json({ runs: runs.filter((r) => r.agent_alias === ctx.alias) });
  const verdicts = await judgeDatabaseRuns(ctx, doc, runs);
  return json({ runs: runs.map((r, i) => forPerson(r, verdicts[i]!)) });
}

export async function getDatabaseRun({ ctx, url, match, doc, docId }: DatabaseCall): Promise<Response> {
  const qs = new URLSearchParams({ dbId: docId, runId: match[2]! });
  if (url.searchParams.get("full") === "1") qs.set("full", "1");
  // `sample=N` cuts a rows.insert payload to its first N rows.
  const sample = url.searchParams.get("sample");
  if (sample !== null && /^\d{1,4}$/.test(sample)) qs.set("sample", sample);
  const res = await databaseActor(ctx, docId).fetch(`http://actor/runs/detail?${qs}`);
  if (!res.ok) return error(res.status === 404 ? 404 : 502, "run unavailable");
  const detail = (await res.json()) as { run?: DatabaseRunSummary };
  if (ctx.isAgent) return detail.run?.agent_alias === ctx.alias ? json(detail) : error(404, "not found");
  if (!detail.run) return error(502, "run unavailable");
  const verdict = (await judgeDatabaseRuns(ctx, doc, [detail.run]))[0]!;
  const run = forPerson(detail.run, verdict);
  // Whoever reads its waiting ops also reads who may decide them: the review card names them.
  return json(verdict.seesText ? { ...detail, run, deciders: await runDeciders(ctx, doc, detail.run, verdict) } : { ...detail, run });
}

export async function decideDatabaseRun({ ctx, match, doc, canWrite, body }: DatabaseCall): Promise<Response> {
  if (ctx.isAgent) return error(403, "agents cannot review agent edits");
  if (!canWrite) return error(403, "view-only access");
  const b = await body();
  if (b.decision !== "accept" && b.decision !== "reject") {
    return error(400, "decision must be accept or reject");
  }
  // As on a document: a lock holds the data as it is, and a rejected proposal never touched it.
  const lk = b.decision === "accept" ? lockedError(doc) : null;
  if (lk) return lk;
  const note = parseDecisionNote(b.decision, b.note);
  if (!note.ok) return error(400, note.message);
  const opIds = Array.isArray(b.op_ids) ? b.op_ids.filter((x): x is string => typeof x === "string") : undefined;
  const decided = await decideDatabaseRunAs(ctx, doc, match[2]!, b.decision, { ...(note.note ? { note: note.note } : {}), ...(opIds ? { opIds } : {}) });
  if (!decided.ok) return error(decided.status, decided.message);
  return json(decided.answer);
}

export async function revertDatabaseRun({ ctx, match, doc, docId, writeRefusal, body }: DatabaseCall): Promise<Response> {
  if (ctx.isAgent) return error(403, "agents cannot revert agent edits");
  const r = writeRefusal();
  if (r) return r;
  const note = parseDecisionNote("revert", (await body()).note);
  if (!note.ok) return error(400, note.message);
  const judged = await judgeAct(ctx, doc, match[2]!, "revert");
  if (judged instanceof Response) return judged;
  const res = await callDatabaseActor(ctx, docId, "runs/revert", {
    run_id: match[2]!,
    requested_by: ctx.alias,
    ...vouched(judged.verdict),
    ...(note.note ? { note: note.note } : {}),
  });
  if (res.status === 403) return actorRefusal(res, "only this run's reviewer (or the database's owner) can revert it");
  if (!res.ok) return proxyActor(res, "revert failed");
  await touchDoc(ctx.sql, doc.doc_id).catch(() => {});
  // Reverted deletes bring their rows' pages back; reverted inserts may have taken some away.
  await reconcileDocLinks(ctx, doc);
  const reverted = (await res.json()) as { run?: DatabaseRunSummary; restored?: number; missing?: number };
  if (reverted.run) reverted.run = forPerson(reverted.run, judged.verdict);
  recordAudit(ctx, {
    action: "run.revert",
    targetKind: "database",
    targetId: doc.doc_id,
    targetLabel: doc.title,
    detail: {
      run_id: match[2]!,
      agent: reverted.run?.agent ?? null,
      restored: reverted.restored ?? 0,
      missing: reverted.missing ?? 0,
    },
  });
  return json(reverted);
}

export async function ackDatabaseRun({ ctx, match, doc, docId }: DatabaseCall): Promise<Response> {
  if (ctx.isAgent) return error(403, "agents cannot acknowledge agent edits");
  // Not write- or lock-gated: dismissing a catch-up card changes no data. At `colleague` only someone
  // other than the person who asked marks it reviewed.
  const judged = await judgeAct(ctx, doc, match[2]!, "ack");
  if (judged instanceof Response) return judged;
  const res = await callDatabaseActor(ctx, docId, "runs/ack", {
    run_id: match[2]!,
    acked_by: ctx.alias,
    ...vouched(judged.verdict),
  });
  if (res.status === 403) return actorRefusal(res, "only this run's reviewer (or the database's owner) can dismiss it");
  if (!res.ok) return proxyActor(res, "ack failed");
  const acked = (await res.json()) as { run?: DatabaseRunSummary };
  if (acked.run) acked.run = forPerson(acked.run, judged.verdict);
  recordAudit(ctx, {
    action: "run.ack",
    targetKind: "database",
    targetId: doc.doc_id,
    targetLabel: doc.title,
    detail: { run_id: match[2]!, agent: acked.run?.agent ?? null },
  });
  return json(acked);
}

export async function createImport({ ctx, doc, writeRefusal, body }: DatabaseCall): Promise<Response> {
  const r = writeRefusal();
  if (r) return r;
  const b = await body();
  const out = await createDatabaseImport(ctx, doc, b.table_id, b.format);
  if ("error" in out) return error(out.status, out.error);
  return json(out.ticket, { status: 201 });
}

export async function commitImport({ ctx, match, doc, writeRefusal, body }: DatabaseCall): Promise<Response> {
  const r = writeRefusal();
  if (r) return r;
  const opts = parseCommitOptions(await body());
  if ("error" in opts) return error(400, opts.error);
  const out = await commitDatabaseImport(ctx, doc, match[2]!, opts, "stdio");
  return json(out.body, { status: out.status });
}

export async function listOps({ ctx, url, docId }: DatabaseCall): Promise<Response> {
  const qs = new URLSearchParams();
  const limit = url.searchParams.get("limit");
  const before = url.searchParams.get("before_seq");
  if (limit) qs.set("limit", limit);
  if (before) qs.set("before_seq", before);
  qs.set("dbId", docId);
  const res = await databaseActor(ctx, docId).fetch(`http://actor/ops?${qs}`);
  if (!res.ok) return proxyActor(res, "could not load activity");
  const body = (await res.json().catch(() => null)) as { ops?: DatabaseOpSummary[] } | null;
  if (!body) return error(502, "could not load activity");
  // The ledger keeps an agent's id; people read the name its key or connection has now.
  const agents = (body.ops ?? []).filter((o) => o.is_agent).map((o) => o.actor);
  return json({ ...body, agent_names: await agentNameMap(ctx.sql, agents) });
}

export async function revertOp({ ctx, match, doc, docId, writeRefusal }: DatabaseCall): Promise<Response> {
  if (ctx.isAgent) return error(403, "agents cannot revert database edits");
  const r = writeRefusal();
  if (r) return r;
  const res = await callDatabaseActor(ctx, docId, "ops/revert", { op_id: match[2]! });
  if (res.ok) {
    await touchDoc(ctx.sql, doc.doc_id).catch(() => {});
    await reconcileDocLinks(ctx, doc); // a reverted delete restores its rows' pages
  }
  return proxyActor(res, "could not revert");
}
