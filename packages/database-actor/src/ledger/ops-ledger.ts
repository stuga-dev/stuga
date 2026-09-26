/**
 * The _ops ledger: every mutation, recorded in its own transaction with an
 * inverse that undoes it. A large inverse (and every tables.delete) spills to
 * `<dbId>/db-ops/<opId>.json` before the transaction, so a failed one leaves
 * only a harmless orphan blob.
 */
import { DATABASE_OP_INLINE_MAX_BYTES } from "@stuga/protocol/databases/limits";
import type {
  ColumnOptions,
  ColumnSpec,
  DatabaseActor,
  DatabaseColumnType,
  DatabaseOpKind,
  DatabaseOpSummary,
  RowValue,
  TableSchema,
  ViewSpec,
} from "@stuga/protocol/databases/types";
import type { BlobStore } from "@stuga/runtime";
import { isLiveViewRef } from "../query/row-query.js";
import { OpError } from "../request.js";
import {
  addColumn,
  createTable,
  deleteView,
  docIdOfRow,
  dropColumn,
  dropTable,
  existingRowIds,
  findTable,
  findView,
  getColumns,
  ident,
  insertView,
  linkRowDoc,
  pruneViewColumns,
  queueDocLinks,
  renameColumn,
  renameTable,
  setColumnDescriptionMeta,
  setColumnTypeMeta,
  unlinkRowDoc,
  writeView,
  type RowDocLink,
  type SqlHandle,
} from "../schema-ops.js";

/**
 * One undoable mutation. Row cells are keyed by column_id, never physical name:
 * a deleted column's physical name is handed to the next column of the same
 * name, and ids are never reused, so a vanished column drops out of a restore
 * instead of filling its successor.
 */
export type InverseJson =
  | { kind: "rows.insert"; table_id: string; row_ids: string[] }
  | { kind: "rows.update"; table_id: string; cells: Array<{ _id: string; values: Record<string, RowValue> }> }
  | {
      kind: "rows.delete";
      table_id: string;
      /** `doc_id`: the row's page, re-linked and restored with the row. */
      rows: Array<{ _id: string; _created_at: number; _updated_at: number; cells: Record<string, RowValue>; doc_id?: string }>;
    }
  | {
      kind: "rows.link_page";
      table_id: string;
      row_id: string;
      doc_id: string;
      /** The page this link replaced, which the revert points the row back at. */
      prev_doc_id: string | null;
    }
  | { kind: "rows.link_pages"; table_id: string; links: Array<{ row_id: string; doc_id: string }> }
  | { kind: "columns.add"; table_id: string; column_id: string }
  | { kind: "columns.rename"; table_id: string; column_id: string; prev_display: string }
  | { kind: "columns.set_description"; table_id: string; column_id: string; prev_description: string | null }
  | {
      kind: "columns.set_type";
      table_id: string;
      column_id: string;
      prev_type: DatabaseColumnType;
      prev_options: ColumnOptions | null;
      cells: Array<{ _id: string; value: RowValue }>;
    }
  | { kind: "columns.delete"; table_id: string; column: ColumnSpec; cells: Array<{ _id: string; value: RowValue }> }
  | { kind: "tables.create"; table_id: string }
  | { kind: "tables.rename"; table_id: string; prev_display: string }
  | {
      kind: "tables.delete";
      table: TableSchema;
      rows: Array<Record<string, RowValue>>;
      /** Kept apart from the cells, which may have a user column named doc_id. */
      pages: Array<{ row_id: string; doc_id: string }>;
    }
  | { kind: "views.create"; table_id: string; view_id: string }
  | { kind: "views.update"; table_id: string; view: ViewSpec }
  | { kind: "views.delete"; table_id: string; view: ViewSpec };

const encoder = new TextEncoder();

/**
 * Serialize an inverse, spilling it when large. On the spill path `recapture`
 * (a pure read of current state) re-runs after every put until two
 * serializations agree; after three drifts the latest put stands.
 */
export async function finalizeInverse(
  bucket: BlobStore,
  dbId: string,
  opId: string,
  kind: DatabaseOpKind,
  captured: InverseJson,
  recapture: () => InverseJson,
): Promise<{ inline: string | null; blobKey: string | null }> {
  let json = JSON.stringify(captured);
  if (kind !== "tables.delete" && encoder.encode(json).length <= DATABASE_OP_INLINE_MAX_BYTES) return { inline: json, blobKey: null };
  const key = `${dbId}/db-ops/${opId}.json`;
  for (let attempt = 0; attempt < 3; attempt++) {
    await bucket.put(key, json);
    const fresh = JSON.stringify(recapture());
    if (fresh === json) return { inline: null, blobKey: key };
    json = fresh;
  }
  await bucket.put(key, json);
  return { inline: null, blobKey: key };
}

// ---- _ops rows ---------------------------------------------------------------------------

export interface OpRow {
  op_id: string;
  seq: number;
  ts: number;
  actor: string;
  is_agent: boolean;
  on_behalf_of: string | null;
  kind: DatabaseOpKind;
  table_id: string | null;
  summary: string;
  inverse: string | null;
  blob_key: string | null;
  reverted_by: string | null;
  reverts: string | null;
}

function asOpRow(row: Record<string, unknown>): OpRow {
  return {
    op_id: String(row.op_id),
    seq: Number(row.seq),
    ts: Number(row.ts),
    actor: String(row.actor),
    is_agent: Number(row.is_agent) !== 0,
    on_behalf_of: row.on_behalf_of == null ? null : String(row.on_behalf_of),
    kind: String(row.kind) as DatabaseOpKind,
    table_id: row.table_id == null ? null : String(row.table_id),
    summary: String(row.summary),
    inverse: row.inverse == null ? null : String(row.inverse),
    blob_key: row.blob_key == null ? null : String(row.blob_key),
    reverted_by: row.reverted_by == null ? null : String(row.reverted_by),
    reverts: row.reverts == null ? null : String(row.reverts),
  };
}

export function getOp(sql: SqlHandle, opId: unknown): OpRow | null {
  if (typeof opId !== "string" || opId === "") throw new OpError(400, "bad_request", "op_id must be a non-empty string");
  const row = sql.exec(`SELECT * FROM _ops WHERE op_id = ?`, opId).toArray()[0];
  return row ? asOpRow(row) : null;
}

export function isRevertible(op: OpRow): boolean {
  return (op.inverse !== null || op.blob_key !== null) && op.kind !== "revert" && op.reverted_by === null;
}

export function listOps(sql: SqlHandle, limit: number, beforeSeq: number | null): DatabaseOpSummary[] {
  const rows =
    beforeSeq === null
      ? sql.exec(`SELECT * FROM _ops ORDER BY seq DESC LIMIT ?`, limit).toArray()
      : sql.exec(`SELECT * FROM _ops WHERE seq < ? ORDER BY seq DESC LIMIT ?`, beforeSeq, limit).toArray();
  return rows.map((raw) => {
    const op = asOpRow(raw);
    return {
      op_id: op.op_id,
      seq: op.seq,
      ts: op.ts,
      actor: op.actor,
      is_agent: op.is_agent,
      on_behalf_of: op.on_behalf_of,
      kind: op.kind,
      table_id: op.table_id,
      summary: op.summary,
      reverted_by: op.reverted_by,
      reverts: op.reverts,
      revertible: isRevertible(op),
    };
  });
}

/**
 * Insert an op row and prune the tail to `keep` (0 = never). Must run inside the
 * mutation's transaction, which makes the MAX(seq)+1 read-then-insert atomic.
 * Pruned spill keys come back for deletion after commit.
 */
export function recordOp(
  sql: SqlHandle,
  draft: {
    opId: string;
    actor: DatabaseActor;
    kind: DatabaseOpKind;
    tableId: string | null;
    summary: string;
    inline: string | null;
    blobKey: string | null;
    reverts: string | null;
    keep: number;
  },
  now: number,
): string[] {
  const seq = Number(sql.exec(`SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM _ops`).one().seq);
  sql.exec(
    `INSERT INTO _ops (op_id, seq, ts, actor, is_agent, on_behalf_of, kind, table_id, summary, inverse, blob_key, reverted_by, reverts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    draft.opId,
    seq,
    now,
    draft.actor.alias,
    draft.actor.is_agent ? 1 : 0,
    draft.actor.on_behalf_of ?? null,
    draft.kind,
    draft.tableId,
    draft.summary,
    draft.inline,
    draft.blobKey,
    draft.reverts,
  );
  const cutoff = draft.keep > 0 ? seq - draft.keep : 0;
  if (cutoff <= 0) return [];
  const pruned = sql
    .exec(`SELECT blob_key FROM _ops WHERE seq <= ? AND blob_key IS NOT NULL`, cutoff)
    .toArray()
    .map((r) => String(r.blob_key));
  sql.exec(`DELETE FROM _ops WHERE seq <= ?`, cutoff);
  return pruned;
}

/** An op's inverse. The blob read is an await, so the caller re-checks the op inside its transaction. */
export async function loadInverse(bucket: BlobStore, op: OpRow): Promise<InverseJson> {
  if (op.inverse !== null) return JSON.parse(op.inverse) as InverseJson;
  if (op.blob_key !== null) {
    const obj = await bucket.get(op.blob_key);
    if (!obj) throw new OpError(409, "inverse_missing", "the revert payload for this op has been pruned");
    return JSON.parse(await obj.text()) as InverseJson;
  }
  throw new OpError(409, "not_revertible", "this op has no recorded inverse");
}

// ---- revert -----------------------------------------------------------------------------

export interface RevertOutcome {
  restored: number;
  missing: number;
}

/** Re-link a restored row's page and ask the node to bring it back; a page another row claimed since stays theirs. */
function relinkPage(sql: SqlHandle, link: RowDocLink, now: number): void {
  try {
    linkRowDoc(sql, link.table_id, link.row_id, link.doc_id, now);
    queueDocLinks(sql, [link], "restore", now);
  } catch (e) {
    if (!(e instanceof OpError)) throw e;
  }
}

/**
 * Apply an inverse inside the caller's transaction, tolerating a world that
 * moved on: rows gone since count as `missing`, cells of vanished columns are
 * dropped, recreated tables and columns take a uniquified physical name when
 * theirs was retaken. Last writer wins over later edits.
 */
export function applyInverse(sql: SqlHandle, inv: InverseJson, now: number): RevertOutcome {
  switch (inv.kind) {
    case "rows.insert": {
      const table = findTable(sql, inv.table_id);
      if (!table) return { restored: 0, missing: inv.row_ids.length };
      const live = existingRowIds(sql, table.name, inv.row_ids);
      for (const id of live) sql.exec(`DELETE FROM ${ident(table.name)} WHERE _id = ?`, id);
      return { restored: live.size, missing: inv.row_ids.length - live.size };
    }

    case "rows.update": {
      const table = findTable(sql, inv.table_id);
      if (!table) return { restored: 0, missing: inv.cells.length };
      const live = new Map(getColumns(sql, inv.table_id).map((c) => [c.column_id, c.name]));
      const rows = existingRowIds(sql, table.name, inv.cells.map((c) => c._id));
      let restored = 0;
      for (const cell of inv.cells) {
        const entries = Object.entries(cell.values).filter(([columnId]) => live.has(columnId));
        if (!rows.has(cell._id) || entries.length === 0) continue;
        const sets = entries.map(([columnId]) => `${ident(live.get(columnId)!)} = ?`).join(", ");
        sql.exec(`UPDATE ${ident(table.name)} SET ${sets}, _updated_at = ? WHERE _id = ?`, ...entries.map(([, v]) => v), now, cell._id);
        restored++;
      }
      return { restored, missing: inv.cells.length - restored };
    }

    case "rows.delete": {
      const table = findTable(sql, inv.table_id);
      if (!table) return { restored: 0, missing: inv.rows.length };
      const live = new Map(getColumns(sql, inv.table_id).map((c) => [c.column_id, c.name]));
      const taken = existingRowIds(sql, table.name, inv.rows.map((r) => r._id));
      let restored = 0;
      for (const row of inv.rows) {
        // Never overwrite a live row that holds this id.
        if (taken.has(row._id)) continue;
        const entries = Object.entries(row.cells).filter(([columnId]) => live.has(columnId));
        const colSql = entries.map(([columnId]) => `, ${ident(live.get(columnId)!)}`).join("");
        const placeholders = entries.map(() => ", ?").join("");
        sql.exec(
          `INSERT INTO ${ident(table.name)} (_id, _created_at, _updated_at${colSql}) VALUES (?, ?, ?${placeholders})`,
          row._id,
          row._created_at,
          row._updated_at,
          ...entries.map(([, v]) => v),
        );
        if (row.doc_id) relinkPage(sql, { row_id: row._id, table_id: inv.table_id, doc_id: row.doc_id }, now);
        restored++;
      }
      return { restored, missing: inv.rows.length - restored };
    }

    case "rows.link_page": {
      // Undo the link, never the page. A row pointing at another page by now keeps it.
      if (docIdOfRow(sql, inv.row_id) !== inv.doc_id) return { restored: 0, missing: 1 };
      unlinkRowDoc(sql, inv.row_id);
      if (inv.prev_doc_id !== null) {
        try {
          linkRowDoc(sql, inv.table_id, inv.row_id, inv.prev_doc_id, now);
        } catch (e) {
          if (!(e instanceof OpError)) throw e;
        }
      }
      return { restored: 1, missing: 0 };
    }

    case "rows.link_pages": {
      // As one link's revert: a row pointing at another page by now keeps it.
      let restored = 0;
      for (const link of inv.links) {
        if (docIdOfRow(sql, link.row_id) !== link.doc_id) continue;
        unlinkRowDoc(sql, link.row_id);
        restored++;
      }
      return { restored, missing: inv.links.length - restored };
    }

    case "columns.add": {
      if (!getColumns(sql, inv.table_id).some((c) => c.column_id === inv.column_id)) return { restored: 0, missing: 1 };
      dropColumn(sql, inv.table_id, inv.column_id, now);
      return { restored: 1, missing: 0 };
    }

    case "columns.rename": {
      if (!getColumns(sql, inv.table_id).some((c) => c.column_id === inv.column_id)) return { restored: 0, missing: 1 };
      renameColumn(sql, inv.table_id, inv.column_id, inv.prev_display);
      return { restored: 1, missing: 0 };
    }

    case "columns.set_description": {
      if (!getColumns(sql, inv.table_id).some((c) => c.column_id === inv.column_id)) return { restored: 0, missing: 1 };
      setColumnDescriptionMeta(sql, inv.table_id, inv.column_id, inv.prev_description);
      return { restored: 1, missing: 0 };
    }

    case "columns.set_type": {
      const table = findTable(sql, inv.table_id);
      const col = table ? getColumns(sql, inv.table_id).find((c) => c.column_id === inv.column_id) : undefined;
      if (!table || !col) return { restored: 0, missing: 1 + inv.cells.length };
      setColumnTypeMeta(sql, inv.column_id, inv.prev_type, inv.prev_options);
      return restoreCells(sql, table.name, col.name, inv.cells, now);
    }

    case "columns.delete": {
      const table = findTable(sql, inv.table_id);
      if (!table) return { restored: 0, missing: 1 + inv.cells.length };
      const col = addColumn(
        sql,
        inv.table_id,
        {
          columnId: inv.column.column_id,
          name: inv.column.name,
          display: inv.column.display,
          type: inv.column.type,
          options: inv.column.options,
          ...(inv.column.description ? { description: inv.column.description } : {}),
          position: inv.column.position,
        },
        now,
      );
      return restoreCells(sql, table.name, col.name, inv.cells, now);
    }

    case "tables.create": {
      if (!findTable(sql, inv.table_id)) return { restored: 0, missing: 1 };
      dropTable(sql, inv.table_id, now);
      return { restored: 1, missing: 0 };
    }

    case "tables.rename": {
      if (!findTable(sql, inv.table_id)) return { restored: 0, missing: 1 };
      renameTable(sql, inv.table_id, inv.prev_display, now);
      return { restored: 1, missing: 0 };
    }

    case "tables.delete": {
      if (findTable(sql, inv.table.table_id)) return { restored: 0, missing: 1 + inv.rows.length };
      const created = createTable(
        sql,
        {
          tableId: inv.table.table_id,
          display: inv.table.display,
          name: inv.table.name,
          position: inv.table.position,
          columns: inv.table.columns.map((c) => ({
            columnId: c.column_id,
            name: c.name,
            display: c.display,
            type: c.type,
            options: c.options,
            ...(c.description ? { description: c.description } : {}),
            position: c.position,
          })),
        },
        now,
      );
      const colNames = created.columns.map((c) => c.name);
      const colSql = colNames.map((c) => `, ${ident(c)}`).join("");
      const placeholders = colNames.map(() => ", ?").join("");
      for (const row of inv.rows) {
        sql.exec(
          `INSERT INTO ${ident(created.name)} (_id, _created_at, _updated_at${colSql}) VALUES (?, ?, ?${placeholders})`,
          row._id,
          row._created_at,
          row._updated_at,
          ...colNames.map((c) => row[c] ?? null),
        );
      }
      for (const page of inv.pages) relinkPage(sql, { row_id: page.row_id, table_id: inv.table.table_id, doc_id: page.doc_id }, now);
      return { restored: inv.rows.length, missing: 0 };
    }

    case "views.create": {
      if (findView(sql, inv.view_id) === null) return { restored: 0, missing: 1 };
      deleteView(sql, inv.view_id);
      return { restored: 1, missing: 0 };
    }

    case "views.update": {
      if (findView(sql, inv.view.view_id) === null) return { restored: 0, missing: 1 };
      writeView(sql, pruneToLiveColumns(sql, inv.view), now);
      return { restored: 1, missing: 0 };
    }

    case "views.delete": {
      if (!findTable(sql, inv.table_id) || findView(sql, inv.view.view_id) !== null) return { restored: 0, missing: 1 };
      const view = pruneToLiveColumns(sql, inv.view);
      insertView(sql, inv.table_id, { viewId: view.view_id, position: view.position, kind: view.kind, name: view.name, shape: view }, now);
      return { restored: 1, missing: 0 };
    }
  }
}

function restoreCells(sql: SqlHandle, physTable: string, colName: string, cells: Array<{ _id: string; value: RowValue }>, now: number): RevertOutcome {
  const rows = existingRowIds(sql, physTable, cells.map((c) => c._id));
  let restored = 0;
  for (const cell of cells) {
    if (!rows.has(cell._id)) continue;
    sql.exec(`UPDATE ${ident(physTable)} SET ${ident(colName)} = ?, _updated_at = ? WHERE _id = ?`, cell.value, now, cell._id);
    restored++;
  }
  return { restored, missing: cells.length - restored };
}

/** A restored view must not point at columns dropped since. */
function pruneToLiveColumns(sql: SqlHandle, view: ViewSpec): ViewSpec {
  const live = new Set(getColumns(sql, view.table_id).map((c) => c.column_id));
  return pruneViewColumns(view, (id) => isLiveViewRef(live, id));
}
