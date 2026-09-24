/**
 * An agent's reads with its own pending proposals laid over them, so it sees
 * the database as it will be once its work is accepted and does not propose the
 * same change again. People always read the live database.
 */
import { sanitizeIdentifier } from "@stuga/protocol/databases/identifiers";
import type { DatabaseRunOpPayload, DatabaseSchema, RowValue } from "@stuga/protocol/databases/types";
import type { Database } from "./database.js";
import { listPendingRunOps, openRunOf, pendingPayloads } from "./ledger/runs.js";
import type { ListedRow, RowPage } from "./query/row-query.js";
import { getColumns } from "./schema-ops.js";

/** Pending tables, columns and views flagged `pending`, and row counts moved by pending inserts and deletes. */
export function projectSchema(db: Database, schema: DatabaseSchema, agentAlias: string | null): DatabaseSchema {
  const run = agentAlias ? openRunOf(db.sql, agentAlias) : null;
  if (!run) return schema;
  // Inline payloads only: schema ops are small, and a spilled row op is not worth a blob read per schema read.
  const payloads = listPendingRunOps(db.sql, run.run_id).flatMap((o) => (o.payload === null ? [] : [JSON.parse(o.payload) as DatabaseRunOpPayload]));
  if (payloads.length === 0) return schema;
  const tables = schema.tables.map((t) => ({ ...t, columns: [...t.columns], views: [...t.views] }));
  for (const p of payloads) {
    if (p.kind === "tables.create") {
      tables.push({ table_id: p.table_id, name: sanitizeIdentifier(p.display), display: p.display, position: tables.length, row_count: 0, columns: [], views: [], pending: true });
      continue;
    }
    const t = tables.find((x) => x.table_id === p.table_id);
    if (!t) continue;
    if (p.kind === "columns.add") {
      t.columns.push({
        column_id: p.column_id,
        name: sanitizeIdentifier(p.display),
        display: p.display,
        type: p.type,
        position: t.columns.length,
        options: p.options,
        ...(p.description ? { description: p.description } : {}),
        pending: true,
      });
    } else if (p.kind === "views.create") {
      t.views.push({ view_id: p.view_id, table_id: p.table_id, position: t.views.length, ...p.view, pending: true });
    } else if (p.kind === "rows.insert") {
      t.row_count += p.row_ids.length;
    } else if (p.kind === "rows.delete") {
      t.row_count = Math.max(0, t.row_count - p.row_ids.length);
    }
  }
  return { ...schema, tables };
}

/**
 * One page with pending row ops laid over it: deletes vanish, updates merge,
 * inserts append on the page that holds the table's tail. Sort and filter are
 * not re-run over projected values.
 */
export async function projectRows(
  db: Database,
  tableId: string,
  agentAlias: string,
  page: RowPage,
  window: { offset: number },
): Promise<{ rows: ListedRow[]; total: number; pending_ops: number } | null> {
  const run = openRunOf(db.sql, agentAlias);
  if (!run) return null;
  const pending = (await pendingPayloads(db.sql, db.bucket, run.run_id)).filter((p) => p.payload.table_id === tableId);
  if (pending.length === 0) return null;
  const live = new Set(getColumns(db.sql, tableId).map((c) => c.column_id));

  const deleted = new Set<string>();
  const updates = new Map<string, Record<string, RowValue>>();
  const inserts: ListedRow[] = [];
  for (const { payload } of pending) {
    if (payload.kind === "rows.delete") {
      for (const id of payload.row_ids) deleted.add(id);
    } else if (payload.kind === "rows.update") {
      for (const u of payload.updates) updates.set(u._id, { ...updates.get(u._id), ...u.values });
    } else if (payload.kind === "rows.insert") {
      for (const [i, cells] of payload.rows.entries()) {
        const row: ListedRow = { _id: payload.row_ids[i]!, _created_at: run.created_at, _updated_at: run.updated_at, _doc_id: null };
        for (const id of live) row[id] = null;
        inserts.push(merge(row, cells));
      }
    }
  }
  function merge(row: ListedRow, cells: Record<string, RowValue> | undefined): ListedRow {
    if (!cells) return row;
    const out = { ...row };
    for (const [id, v] of Object.entries(cells)) if (live.has(id)) out[id] = v;
    return out;
  }

  const kept = page.rows.filter((r) => !deleted.has(r._id)).map((r) => merge(r, updates.get(r._id)));
  const projectedInserts = inserts.filter((r) => !deleted.has(r._id)).map((r) => merge(r, updates.get(r._id)));
  // Only the page holding the tail gets the inserts; a page past the end would repeat them.
  const atTail = window.offset + page.rows.length >= page.total && window.offset <= page.total;
  const insertedIds = new Set(inserts.map((r) => r._id));
  return {
    rows: atTail ? [...kept, ...projectedInserts] : kept,
    total: page.total - [...deleted].filter((id) => !insertedIds.has(id)).length + projectedInserts.length,
    pending_ops: pending.length,
  };
}
