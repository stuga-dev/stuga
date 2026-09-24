/**
 * Run storage: one agent's session of proposed ops on this database, in
 * `_runs` / `_run_ops`. The ids an op creates are minted when it is proposed,
 * so later ops can name what an earlier pending op will create. A payload over
 * DATABASE_RUN_INLINE_MAX_BYTES lives at `<dbId>/db-runs/<runId>/<random>.json`.
 */
import {
  DATABASE_RUN_INLINE_MAX_BYTES,
  DATABASE_RUN_KEEP,
  DATABASE_RUN_LIST_DEFAULT,
  DATABASE_RUN_WIRE_MAX_BYTES,
} from "@stuga/protocol/databases/limits";
import type {
  DatabaseRunOp,
  DatabaseRunOpKind,
  DatabaseRunOpPayload,
  DatabaseRunOpStatus,
  DatabaseRunSource,
  DatabaseRunStatus,
  DatabaseRunSummary,
} from "@stuga/protocol/databases/types";
import type { ReviewMode } from "@stuga/protocol/domain/events";
import { closedStatus } from "@stuga/protocol/domain/runs";
import type { RunIndexEntry } from "@stuga/protocol/internal/jobs";
import type { BlobStore } from "@stuga/runtime";
import { OpError } from "../request.js";
import type { SqlHandle } from "../schema-ops.js";

export interface RunRow {
  run_id: string;
  source: DatabaseRunSource;
  agent: string;
  agent_alias: string;
  reviewer: string;
  status: DatabaseRunStatus;
  acknowledged: boolean;
  auto_applied: boolean;
  reverted: boolean;
  workspace_id: string;
  doc_title: string;
  /** The strictest review mode any proposal in this run carried. */
  review_mode: ReviewMode;
  client: string | null;
  model: string | null;
  created_at: number;
  updated_at: number;
}

export interface RunOpRow {
  run_id: string;
  op_id: string;
  position: number;
  kind: DatabaseRunOpKind;
  table_id: string;
  summary: string;
  status: DatabaseRunOpStatus;
  /** Inline payload JSON, or null when spilled to blob_key. */
  payload: string | null;
  blob_key: string | null;
  /** UTF-8 size of the payload JSON, so wire truncation needs no load. */
  bytes: number;
  decided_by: string | null;
  ledger_op_id: string | null;
  error: string | null;
  /** The review mode the op was proposed under. */
  review: ReviewMode;
}

const nullable = (v: unknown): string | null => (v == null ? null : String(v));

function asRunRow(row: Record<string, unknown>): RunRow {
  return {
    run_id: String(row.run_id),
    source: String(row.source) as DatabaseRunSource,
    agent: String(row.agent),
    agent_alias: String(row.agent_alias),
    reviewer: String(row.reviewer),
    status: String(row.status) as DatabaseRunStatus,
    acknowledged: Number(row.acknowledged) !== 0,
    auto_applied: Number(row.auto_applied) !== 0,
    reverted: Number(row.reverted) !== 0,
    workspace_id: String(row.workspace_id),
    doc_title: String(row.doc_title),
    review_mode: String(row.review_mode) as ReviewMode,
    client: nullable(row.client),
    model: nullable(row.model),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

function asRunOpRow(row: Record<string, unknown>): RunOpRow {
  return {
    run_id: String(row.run_id),
    op_id: String(row.op_id),
    position: Number(row.position),
    kind: String(row.kind) as DatabaseRunOpKind,
    table_id: String(row.table_id),
    summary: String(row.summary),
    status: String(row.status) as DatabaseRunOpStatus,
    payload: nullable(row.payload),
    blob_key: nullable(row.blob_key),
    bytes: Number(row.bytes),
    decided_by: nullable(row.decided_by),
    ledger_op_id: nullable(row.ledger_op_id),
    error: nullable(row.error),
    review: String(row.review) as ReviewMode,
  };
}

// ---- reads ----------------------------------------------------------------------------

export function getRun(sql: SqlHandle, runId: unknown): RunRow | null {
  if (typeof runId !== "string" || runId === "") throw new OpError(400, "bad_request", "run_id must be a non-empty string");
  const row = sql.exec(`SELECT * FROM _runs WHERE run_id = ?`, runId).toArray()[0];
  return row ? asRunRow(row) : null;
}

/** The agent's newest open run. */
export function openRunOf(sql: SqlHandle, agentAlias: string): RunRow | null {
  const row = sql.exec(`SELECT * FROM _runs WHERE agent_alias = ? AND status = 'open' ORDER BY created_at DESC LIMIT 1`, agentAlias).toArray()[0];
  return row ? asRunRow(row) : null;
}

export function getRunOp(sql: SqlHandle, runId: string, opId: string): RunOpRow | null {
  const row = sql.exec(`SELECT * FROM _run_ops WHERE run_id = ? AND op_id = ?`, runId, opId).toArray()[0];
  return row ? asRunOpRow(row) : null;
}

export function listRunOps(sql: SqlHandle, runId: string): RunOpRow[] {
  return sql.exec(`SELECT * FROM _run_ops WHERE run_id = ? ORDER BY position`, runId).toArray().map(asRunOpRow);
}

/** Pending ops only: an `auto` run accumulates decided ops without bound, so apply paths never load the whole run. */
export function listPendingRunOps(sql: SqlHandle, runId: string): RunOpRow[] {
  return sql.exec(`SELECT * FROM _run_ops WHERE run_id = ? AND status = 'pending' ORDER BY position`, runId).toArray().map(asRunOpRow);
}

export function pendingCountOf(sql: SqlHandle, runId: string): number {
  return Number(sql.exec(`SELECT COUNT(*) AS n FROM _run_ops WHERE run_id = ? AND status = 'pending'`, runId).one().n);
}

export function totalOpsOf(sql: SqlHandle, runId: string): number {
  return Number(sql.exec(`SELECT COUNT(*) AS n FROM _run_ops WHERE run_id = ?`, runId).one().n);
}

/** Open runs first, then newest. */
export function listRuns(sql: SqlHandle, limit: number): RunRow[] {
  return sql.exec(`SELECT * FROM _runs ORDER BY (status = 'open') DESC, created_at DESC LIMIT ?`, limit).toArray().map(asRunRow);
}

/** What a reviewer's fresh socket replays: open runs and unacknowledged auto-applied ones. */
export function outstandingRunsFor(sql: SqlHandle, reviewer: string): RunRow[] {
  return sql
    .exec(
      `SELECT * FROM _runs WHERE reviewer = ? AND (status = 'open' OR (auto_applied = 1 AND acknowledged = 0))
       ORDER BY created_at DESC LIMIT ?`,
      reviewer,
      DATABASE_RUN_LIST_DEFAULT,
    )
    .toArray()
    .map(asRunRow);
}

/** The run as the workspace inbox mirrors it: counts by op status. */
export function runIndexEntry(sql: SqlHandle, run: RunRow, databaseId: string): RunIndexEntry {
  const counts = new Map<string, number>();
  for (const r of sql.exec(`SELECT status, COUNT(*) AS n FROM _run_ops WHERE run_id = ? GROUP BY status`, run.run_id)) {
    counts.set(String(r.status), Number(r.n));
  }
  const count = (status: DatabaseRunOpStatus) => counts.get(status) ?? 0;
  return {
    runId: run.run_id,
    workspaceId: run.workspace_id,
    docId: databaseId,
    docKind: "database",
    docTitle: run.doc_title,
    source: run.source,
    agent: run.agent,
    agentAlias: run.agent_alias,
    client: run.client,
    model: run.model,
    reviewer: run.reviewer,
    status: run.status,
    reviewMode: run.review_mode,
    autoApplied: run.auto_applied,
    reverted: run.reverted,
    acknowledged: run.acknowledged,
    pending: count("pending"),
    accepted: count("accepted"),
    rejected: count("rejected"),
    conflicts: count("conflict"),
    applied: count("auto_applied"),
    createdAt: run.created_at,
    updatedAt: run.updated_at,
  };
}

// ---- writes ---------------------------------------------------------------------------

export function insertRun(
  sql: SqlHandle,
  d: {
    runId: string;
    source: DatabaseRunSource;
    agent: string;
    agentAlias: string;
    reviewer: string;
    workspaceId: string;
    docTitle: string;
    reviewMode: ReviewMode;
    client: string | null;
    model: string | null;
  },
  now: number,
): void {
  sql.exec(
    `INSERT INTO _runs (run_id, source, agent, agent_alias, reviewer, status, acknowledged, auto_applied, reverted,
       workspace_id, doc_title, review_mode, client, model, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'open', 0, 0, 0, ?, ?, ?, ?, ?, ?, ?)`,
    d.runId,
    d.source,
    d.agent,
    d.agentAlias,
    d.reviewer,
    d.workspaceId,
    d.docTitle,
    d.reviewMode,
    d.client,
    d.model,
    now,
    now,
  );
}

export function touchRun(sql: SqlHandle, runId: string, now: number): void {
  sql.exec(`UPDATE _runs SET updated_at = ? WHERE run_id = ?`, now, runId);
}

export function setRunReviewMode(sql: SqlHandle, runId: string, mode: ReviewMode): void {
  sql.exec(`UPDATE _runs SET review_mode = ? WHERE run_id = ?`, mode, runId);
}

export function markRunAutoApplied(sql: SqlHandle, runId: string): void {
  sql.exec(`UPDATE _runs SET auto_applied = 1 WHERE run_id = ?`, runId);
}

export function acknowledgeRun(sql: SqlHandle, runId: string, now: number): void {
  sql.exec(`UPDATE _runs SET acknowledged = 1, updated_at = ? WHERE run_id = ?`, now, runId);
}

/** A reverted run is expired, flagged reverted, and needs no acknowledgement. */
export function markRunReverted(sql: SqlHandle, runId: string, now: number): void {
  sql.exec(`UPDATE _runs SET status = 'expired', reverted = 1, acknowledged = 1, updated_at = ? WHERE run_id = ?`, now, runId);
}

/** Close a run with nothing pending: "applied" if any op landed, else "rejected". */
export function closeRun(sql: SqlHandle, runId: string, now: number): void {
  const status = closedStatus(sql.exec(`SELECT status FROM _run_ops WHERE run_id = ?`, runId).toArray() as Array<{ status: string }>);
  sql.exec(`UPDATE _runs SET status = ?, updated_at = ? WHERE run_id = ?`, status, now, runId);
}

const encoder = new TextEncoder();

/**
 * Serialize an op payload, spilling it when large. The key is random, not the
 * op id: op ids are positional and minted after this await, so keying on them
 * would let two concurrent proposals share a blob.
 */
export async function finalizeRunPayload(
  bucket: BlobStore,
  dbId: string,
  runId: string,
  payload: DatabaseRunOpPayload,
): Promise<{ inline: string | null; blobKey: string | null; bytes: number }> {
  const json = JSON.stringify(payload);
  const bytes = encoder.encode(json).length;
  if (bytes <= DATABASE_RUN_INLINE_MAX_BYTES) return { inline: json, blobKey: null, bytes };
  const spill = crypto.getRandomValues(new Uint8Array(9));
  const key = `${dbId}/db-runs/${runId}/${Array.from(spill, (b) => b.toString(16).padStart(2, "0")).join("")}.json`;
  await bucket.put(key, json);
  return { inline: null, blobKey: key, bytes };
}

/** Append a pending op at the run's next position; returns its id ("o<position>"). */
export function insertRunOp(
  sql: SqlHandle,
  d: { runId: string; kind: DatabaseRunOpKind; tableId: string; summary: string; inline: string | null; blobKey: string | null; bytes: number; review: ReviewMode },
): string {
  const position = Number(sql.exec(`SELECT COALESCE(MAX(position) + 1, 1) AS p FROM _run_ops WHERE run_id = ?`, d.runId).one().p);
  const opId = `o${position}`;
  sql.exec(
    `INSERT INTO _run_ops (run_id, op_id, position, kind, table_id, summary, status, payload, blob_key, bytes,
       decided_by, ledger_op_id, error, review)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, NULL, NULL, NULL, ?)`,
    d.runId,
    opId,
    position,
    d.kind,
    d.tableId,
    d.summary,
    d.inline,
    d.blobKey,
    d.bytes,
    d.review,
  );
  return opId;
}

/**
 * Move one op out of pending. Guarded on `status = 'pending'`, so of two racing
 * deciders only one lands; returns whether this call won.
 */
export function setOpStatus(
  sql: SqlHandle,
  runId: string,
  opId: string,
  status: Exclude<DatabaseRunOpStatus, "pending">,
  opts: { decidedBy: string; ledgerOpId?: string; error?: string },
): boolean {
  const won = sql.exec(
    `UPDATE _run_ops SET status = ?, decided_by = ?, ledger_op_id = ?, error = ?
     WHERE run_id = ? AND op_id = ? AND status = 'pending' RETURNING op_id`,
    status,
    opts.decidedBy,
    opts.ledgerOpId ?? null,
    opts.error ?? null,
    runId,
    opId,
  );
  return won.toArray().length > 0;
}

/**
 * Drop runs beyond DATABASE_RUN_KEEP, oldest first. Open runs are never pruned:
 * they may hold proposals nobody has decided. Returns spill keys to delete after
 * the write.
 */
export function pruneRuns(sql: SqlHandle): string[] {
  const doomed = sql
    .exec(
      `SELECT run_id FROM _runs WHERE status <> 'open'
       AND run_id NOT IN (SELECT run_id FROM _runs ORDER BY created_at DESC LIMIT ?)`,
      DATABASE_RUN_KEEP,
    )
    .toArray()
    .map((r) => String(r.run_id));
  if (doomed.length === 0) return [];
  const inList = doomed.map(() => "?").join(", ");
  const blobKeys = sql
    .exec(`SELECT blob_key FROM _run_ops WHERE run_id IN (${inList}) AND blob_key IS NOT NULL`, ...doomed)
    .toArray()
    .map((r) => String(r.blob_key));
  sql.exec(`DELETE FROM _run_ops WHERE run_id IN (${inList})`, ...doomed);
  sql.exec(`DELETE FROM _runs WHERE run_id IN (${inList})`, ...doomed);
  return blobKeys;
}

// ---- payloads and the wire ------------------------------------------------------------

async function loadRunPayloadText(bucket: BlobStore, blobKey: string): Promise<string | null> {
  const obj = await bucket.get(blobKey);
  return obj ? await obj.text() : null;
}

/** One op's payload, inline or spilled; 503 when the spill cannot be read. */
export async function loadOpPayload(bucket: BlobStore, op: RunOpRow): Promise<DatabaseRunOpPayload> {
  const text = op.payload ?? (op.blob_key !== null ? await loadRunPayloadText(bucket, op.blob_key) : null);
  if (text === null) throw new OpError(503, "run_unavailable", "this proposal's contents could not be read; try again shortly");
  return JSON.parse(text) as DatabaseRunOpPayload;
}

/** A run's pending ops with their payloads, in position order. */
export async function pendingPayloads(sql: SqlHandle, bucket: BlobStore, runId: string): Promise<Array<{ row: RunOpRow; payload: DatabaseRunOpPayload }>> {
  const out: Array<{ row: RunOpRow; payload: DatabaseRunOpPayload }> = [];
  for (const row of listPendingRunOps(sql, runId)) out.push({ row, payload: await loadOpPayload(bucket, row) });
  return out;
}

/**
 * A run's wire summary. Payloads ride along while the run is small and fully
 * inline; otherwise they are elided (`ops_truncated`) unless `full` asks for
 * them, or `sample` asks for every payload with rows.insert cut to its first N rows.
 */
export async function toRunSummary(
  sql: SqlHandle,
  bucket: BlobStore,
  run: RunRow,
  databaseId: string,
  opts: { full?: boolean; sample?: number } = {},
): Promise<DatabaseRunSummary> {
  const rows = listRunOps(sql, run.run_id);
  const total = rows.reduce((n, r) => n + r.bytes, 0);
  const withPayloads =
    opts.full === true || opts.sample !== undefined || (total <= DATABASE_RUN_WIRE_MAX_BYTES && rows.every((r) => r.blob_key === null));
  const ops: DatabaseRunOp[] = [];
  for (const r of rows) {
    const op: DatabaseRunOp = { id: r.op_id, kind: r.kind, table_id: r.table_id, summary: r.summary, status: r.status, review: r.review };
    if (withPayloads) {
      const json = r.payload ?? (r.blob_key !== null ? await loadRunPayloadText(bucket, r.blob_key) : null);
      if (json !== null) {
        const payload = JSON.parse(json) as DatabaseRunOpPayload;
        if (opts.sample !== undefined && payload.kind === "rows.insert" && payload.rows.length > opts.sample) {
          op.payload = {
            ...payload,
            rows: payload.rows.slice(0, opts.sample),
            row_ids: payload.row_ids.slice(0, opts.sample),
            rows_sampled_from: payload.rows.length,
          };
        } else op.payload = payload;
      }
    }
    if (r.decided_by !== null) op.decided_by = r.decided_by;
    if (r.ledger_op_id !== null) op.ledger_op_id = r.ledger_op_id;
    if (r.error !== null) op.error = r.error;
    ops.push(op);
  }
  const summary: DatabaseRunSummary = {
    id: run.run_id,
    database_id: databaseId,
    source: run.source,
    agent: run.agent,
    agent_alias: run.agent_alias,
    reviewer: run.reviewer,
    status: run.status,
    ops,
    acknowledged: run.acknowledged,
    auto_applied: run.auto_applied,
    review_mode: run.review_mode,
    created_at: run.created_at,
    updated_at: run.updated_at,
  };
  if (!withPayloads) summary.ops_truncated = true;
  if (run.reverted) summary.reverted = true;
  return summary;
}
