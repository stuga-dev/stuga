import { validateCellValue } from "@stuga/protocol/databases/cells";
import { DATABASE_MAX_ROWS, DATABASE_MAX_ROWS_PER_WRITE } from "@stuga/protocol/databases/limits";
import type {
  ColumnSpec,
  DbRunOpRowsDelete,
  DbRunOpRowsInsert,
  DbRunOpRowsUpdate,
  RowInputValue,
  RowValue,
} from "@stuga/protocol/databases/types";
import type { InverseJson } from "../ledger/ops-ledger.js";
import { OpError, conflict, plural, requireId, requireObject, type Body } from "../request.js";
import {
  docIdOfRow,
  existingRowIds,
  getColumns,
  getTable,
  ident,
  linkRowDoc,
  newId,
  queueDocLinks,
  resolveColRef,
  rowCount,
  rowDocsOf,
  rowOfDoc,
  unlinkRowDoc,
  type SqlHandle,
  type TableMeta,
} from "../schema-ops.js";
import type { OpDef } from "./registry.js";

type RowsLinkPage = { kind: "rows.link_page"; table_id: string; row_id: string; doc_id: string; replaces: string | null };
type RowsLinkPages = { kind: "rows.link_pages"; table_id: string; links: Array<{ row_id: string; doc_id: string }> };

function batchCapError(): OpError {
  return new OpError(409, "batch_cap", `too many rows in one write (max ${DATABASE_MAX_ROWS_PER_WRITE})`);
}

function rowCapError(tableDisplay: string): OpError {
  return new OpError(409, "row_cap", `table "${tableDisplay}" would exceed ${DATABASE_MAX_ROWS} rows`);
}

/**
 * One row object as column_id → stored value. Unknown and ambiguous refs, a
 * column named twice, and invalid values are refused with the column named.
 */
function cellsOf(columns: ColumnSpec[], obj: unknown): Record<string, RowValue> {
  const row = requireObject(obj, "each row must be an object of column → value");
  const cells: Record<string, RowValue> = {};
  for (const [ref, raw] of Object.entries(row)) {
    const col = resolveColRef(columns, ref);
    if (Object.hasOwn(cells, col.column_id)) throw new OpError(400, "validation", `column "${col.display}" is referenced twice in one row`);
    const v = validateCellValue(col.type, col.options, raw as RowInputValue);
    if (!v.ok) throw new OpError(400, "validation", `column "${col.display}": ${v.reason}`);
    cells[col.column_id] = v.value;
  }
  return cells;
}

/** A row-id list from a body: non-empty strings, at most one write's worth. */
function parseRowIds(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.some((id) => typeof id !== "string" || id === "")) {
    throw new OpError(400, "validation", "row_ids must be a non-empty array of strings");
  }
  if (raw.length > DATABASE_MAX_ROWS_PER_WRITE) throw batchCapError();
  return raw as string[];
}

/**
 * Cells were validated when the op was made, against a schema that may have
 * changed since (a type change, a dropped column). Each must still validate
 * against its column now; returns today's columns by id.
 */
function liveColumnsFor(sql: SqlHandle, tableId: string, rows: Array<Record<string, RowValue>>): Map<string, ColumnSpec> {
  const byId = new Map(getColumns(sql, tableId).map((c) => [c.column_id, c]));
  for (const cells of rows) {
    for (const [columnId, value] of Object.entries(cells)) {
      const col = byId.get(columnId);
      if (!col) throw conflict("a column this change writes no longer exists — the schema changed after the change was made");
      const v = validateCellValue(col.type, col.options, value as RowInputValue);
      if (!v.ok) throw conflict(`column "${col.display}": ${v.reason} (the schema changed after the change was made)`);
    }
  }
  return byId;
}

export const rowsInsert: OpDef<DbRunOpRowsInsert> = {
  parse(input, view) {
    const table = view.table(input);
    const rows = input.rows;
    if (!Array.isArray(rows) || rows.length === 0) throw new OpError(400, "validation", "rows must be a non-empty array");
    const bulk = input.import === true;
    if (!bulk && rows.length > DATABASE_MAX_ROWS_PER_WRITE) throw batchCapError();
    const cells = rows.map((r) => cellsOf(table.columns, r));
    if (table.rowCount() + rows.length > DATABASE_MAX_ROWS) throw rowCapError(table.display);
    return {
      kind: "rows.insert",
      table_id: table.table_id,
      rows: cells,
      row_ids: rows.map(() => newId("row_")),
      ...(bulk ? { import: true as const } : {}),
    };
  },
  capture: (_sql, p) => ({ kind: "rows.insert", table_id: p.table_id, row_ids: p.row_ids }),
  apply(sql, p, { now }) {
    const meta = getTable(sql, p.table_id);
    const byId = liveColumnsFor(sql, meta.table_id, p.rows);
    if (rowCount(sql, meta.name) + p.rows.length > DATABASE_MAX_ROWS) throw rowCapError(meta.display);
    for (const [i, cells] of p.rows.entries()) {
      const entries = Object.entries(cells);
      const colSql = entries.map(([columnId]) => `, ${ident(byId.get(columnId)!.name)}`).join("");
      const placeholders = entries.map(() => ", ?").join("");
      sql.exec(
        `INSERT INTO ${ident(meta.name)} (_id, _created_at, _updated_at${colSql}) VALUES (?, ?, ?${placeholders})`,
        p.row_ids[i]!,
        now,
        now,
        ...entries.map(([, v]) => v),
      );
    }
    return {
      result: { inserted: p.rows.length, row_ids: p.row_ids },
      summary: `${p.import ? "Imported" : "Inserted"} ${plural(p.rows.length, "row")} into "${meta.display}"`,
    };
  },
  proposal: {
    describe: (p, view) => `${p.import ? "Import" : "Insert"} ${plural(p.rows.length, "row")} into "${view.displayOf(p.table_id)}"`,
    minted: (p) => ({ row_ids: p.row_ids }),
    references: (p) => [p.table_id, ...p.rows.flatMap((cells) => Object.keys(cells))],
  },
};

export const rowsUpdate: OpDef<DbRunOpRowsUpdate> = {
  parse(input, view) {
    const table = view.table(input);
    const updates = input.updates;
    if (!Array.isArray(updates) || updates.length === 0) throw new OpError(400, "validation", "updates must be a non-empty array");
    if (updates.length > DATABASE_MAX_ROWS_PER_WRITE) throw batchCapError();
    const parsed = updates.map((u) => {
      const upd = u as Body | null;
      if (upd === null || typeof upd !== "object" || typeof upd._id !== "string" || upd._id === "") {
        throw new OpError(400, "validation", "each update needs a string _id");
      }
      const values = cellsOf(table.columns, upd.values);
      if (Object.keys(values).length === 0) throw new OpError(400, "validation", `update for ${upd._id} has no values`);
      return { _id: upd._id, values };
    });
    if (view.proposal) table.checkRows(parsed.map((u) => u._id));
    return { kind: "rows.update", table_id: table.table_id, updates: parsed };
  },
  capture(sql, p) {
    const meta = getTable(sql, p.table_id);
    const byId = new Map(getColumns(sql, meta.table_id).map((c) => [c.column_id, c]));
    return {
      kind: "rows.update",
      table_id: p.table_id,
      cells: p.updates.flatMap((u) => {
        // A column dropped since is skipped here; apply refuses the write anyway.
        const touched = Object.keys(u.values).flatMap((id) => byId.get(id) ?? []);
        if (touched.length === 0) return [];
        const row = sql.exec(`SELECT ${touched.map((c) => ident(c.name)).join(", ")} FROM ${ident(meta.name)} WHERE _id = ?`, u._id).toArray()[0];
        if (!row) return [];
        const values: Record<string, RowValue> = {};
        for (const c of touched) values[c.column_id] = row[c.name] as RowValue;
        return [{ _id: u._id, values }];
      }),
    };
  },
  apply(sql, p, { proposal, now }) {
    const meta = getTable(sql, p.table_id);
    const byId = liveColumnsFor(sql, meta.table_id, p.updates.map((u) => u.values));
    const exists = existingRowIds(sql, meta.name, p.updates.map((u) => u._id));
    let updated = 0;
    const missing: string[] = [];
    for (const u of p.updates) {
      if (!exists.has(u._id)) {
        missing.push(u._id);
        continue;
      }
      const entries = Object.entries(u.values);
      const sets = entries.map(([columnId]) => `${ident(byId.get(columnId)!.name)} = ?`).join(", ");
      sql.exec(`UPDATE ${ident(meta.name)} SET ${sets}, _updated_at = ? WHERE _id = ?`, ...entries.map(([, v]) => v), now, u._id);
      updated++;
    }
    if (proposal && updated === 0) throw conflict("none of the proposed rows exist any more");
    // The grid saves one cell at a time, so the column names are what tell entries apart.
    const touched = [...new Set(p.updates.flatMap((u) => Object.keys(u.values)))].map((id) => byId.get(id)!.display);
    const cols = ` (${touched.slice(0, 3).join(", ")}${touched.length > 3 ? ", …" : ""})`;
    return { result: { updated, missing }, summary: `Updated ${plural(updated, "row")} in "${meta.display}"${cols}` };
  },
  proposal: {
    describe: (p, view) => `Update ${plural(p.updates.length, "row")} in "${view.displayOf(p.table_id)}"`,
    minted: () => ({}),
    references: (p) => [p.table_id, ...p.updates.flatMap((u) => [u._id, ...Object.keys(u.values)])],
  },
};

/** The rows.delete inverse: whole rows, cells keyed by column_id, with each row's page. */
function captureDeletedRows(sql: SqlHandle, meta: TableMeta, rowIds: string[]): InverseJson {
  const cols = getColumns(sql, meta.table_id);
  const pageOf = new Map(rowDocsOf(sql, rowIds).map((l) => [l.row_id, l.doc_id]));
  const inList = rowIds.map(() => "?").join(", ");
  return {
    kind: "rows.delete",
    table_id: meta.table_id,
    rows: sql
      .exec(`SELECT * FROM ${ident(meta.name)} WHERE _id IN (${inList}) ORDER BY _id`, ...rowIds)
      .toArray()
      .map((row) => {
        const cells: Record<string, RowValue> = {};
        for (const c of cols) cells[c.column_id] = (row[c.name] ?? null) as RowValue;
        const id = String(row._id);
        const docId = pageOf.get(id);
        return { _id: id, _created_at: Number(row._created_at), _updated_at: Number(row._updated_at), cells, ...(docId ? { doc_id: docId } : {}) };
      }),
  };
}

export const rowsDelete: OpDef<DbRunOpRowsDelete> = {
  parse(input, view) {
    const table = view.table(input);
    const rowIds = parseRowIds(input.row_ids);
    if (view.proposal) table.checkRows(rowIds);
    return { kind: "rows.delete", table_id: table.table_id, row_ids: rowIds };
  },
  capture: (sql, p) => captureDeletedRows(sql, getTable(sql, p.table_id), p.row_ids),
  apply(sql, p, { proposal, now }) {
    const meta = getTable(sql, p.table_id);
    const found = existingRowIds(sql, meta.name, p.row_ids);
    if (proposal && found.size === 0) throw conflict("none of the proposed rows exist any more");
    const inList = p.row_ids.map(() => "?").join(", ");
    // The rows take their pages with them: the links go, and the pages are queued for the trash.
    const links = rowDocsOf(sql, p.row_ids);
    sql.exec(`DELETE FROM ${ident(meta.name)} WHERE _id IN (${inList})`, ...p.row_ids);
    if (links.length > 0) {
      sql.exec(`DELETE FROM _row_docs WHERE row_id IN (${inList})`, ...p.row_ids);
      queueDocLinks(sql, links, "trash", now);
    }
    return { result: { deleted: found.size }, summary: `Deleted ${plural(found.size, "row")} from "${meta.display}"` };
  },
  proposal: {
    describe: (p, view) => `Delete ${plural(p.row_ids.length, "row")} from "${view.displayOf(p.table_id)}"`,
    minted: () => ({}),
    references: (p) => [p.table_id, ...p.row_ids],
  },
};

function alreadyLinked(current: string): OpError {
  // The existing page rides along so the caller can decide whether it is gone.
  return new OpError(409, "already_linked", `this row already has a page (${current})`, { doc_id: current });
}

/**
 * Link a row to the document that is its page. The node creates the document
 * first; a row already linked to another page is refused unless the caller
 * names that page as `replaces` (how a link to a deleted page is repaired). The
 * revert unlinks and leaves the page alone.
 */
export const rowsLinkPage: OpDef<RowsLinkPage> = {
  parse(input, view) {
    const table = view.table(input);
    const rowId = requireId(input.row_id, "row_id");
    const docId = requireId(input.doc_id, "doc_id");
    const replaces = input.replaces === undefined || input.replaces === null ? null : requireId(input.replaces, "replaces");
    const meta = getTable(view.sql, table.table_id);
    if (!existingRowIds(view.sql, meta.name, [rowId]).has(rowId)) throw new OpError(404, "row_not_found", `no row ${rowId} in "${table.display}"`);
    const current = docIdOfRow(view.sql, rowId);
    if (current !== null && current !== docId && current !== replaces) throw alreadyLinked(current);
    const claimed = rowOfDoc(view.sql, docId);
    if (claimed && claimed.row_id !== rowId) throw new OpError(409, "doc_linked", `document ${docId} is already the page of another row`);
    return { kind: "rows.link_page", table_id: table.table_id, row_id: rowId, doc_id: docId, replaces };
  },
  unchanged: (sql, p) => (docIdOfRow(sql, p.row_id) === p.doc_id ? { linked: false, doc_id: p.doc_id, replaced: null } : null),
  capture: (sql, p) => ({ kind: "rows.link_page", table_id: p.table_id, row_id: p.row_id, doc_id: p.doc_id, prev_doc_id: docIdOfRow(sql, p.row_id) }),
  apply(sql, p, { now }) {
    const meta = getTable(sql, p.table_id);
    const prev = docIdOfRow(sql, p.row_id);
    const replaced = prev !== null && prev !== p.doc_id ? prev : null;
    if (replaced !== null) {
      if (replaced !== p.replaces) throw alreadyLinked(replaced);
      unlinkRowDoc(sql, p.row_id);
    }
    const linked = linkRowDoc(sql, meta.table_id, p.row_id, p.doc_id, now);
    return { result: { linked, doc_id: p.doc_id, replaced }, summary: `Linked a page to a row of "${meta.display}"` };
  },
};

/**
 * Link many rows to their new pages in one mutation, for a bulk import that
 * would otherwise spend one of the alias's mutations per page. Every link is
 * checked as rowsLinkPage checks one, and none replaces a page. The revert
 * unlinks the links it made and leaves the pages alone.
 */
export const rowsLinkPages: OpDef<RowsLinkPages> = {
  parse(input, view) {
    const table = view.table(input);
    const raw = input.links;
    if (!Array.isArray(raw) || raw.length === 0) throw new OpError(400, "validation", "links must be a non-empty array of { row_id, doc_id }");
    if (raw.length > DATABASE_MAX_ROWS_PER_WRITE) throw batchCapError();
    const links = raw.map((l) => {
      const link = requireObject(l, "each link must be an object of { row_id, doc_id }");
      return { row_id: requireId(link.row_id, "row_id"), doc_id: requireId(link.doc_id, "doc_id") };
    });
    if (new Set(links.map((l) => l.row_id)).size !== links.length || new Set(links.map((l) => l.doc_id)).size !== links.length) {
      throw new OpError(400, "validation", "each row and each document is linked once");
    }
    const meta = getTable(view.sql, table.table_id);
    const exists = existingRowIds(view.sql, meta.name, links.map((l) => l.row_id));
    for (const { row_id: rowId, doc_id: docId } of links) {
      if (!exists.has(rowId)) throw new OpError(404, "row_not_found", `no row ${rowId} in "${table.display}"`);
      const current = docIdOfRow(view.sql, rowId);
      if (current !== null && current !== docId) throw alreadyLinked(current);
      const claimed = rowOfDoc(view.sql, docId);
      if (claimed && claimed.row_id !== rowId) throw new OpError(409, "doc_linked", `document ${docId} is already the page of another row`);
    }
    return { kind: "rows.link_pages", table_id: table.table_id, links };
  },
  unchanged: (sql, p) => (p.links.every((l) => docIdOfRow(sql, l.row_id) === l.doc_id) ? { linked: 0 } : null),
  // Only the links this op makes: one already in place is not its to undo.
  capture: (sql, p) => ({ kind: "rows.link_pages", table_id: p.table_id, links: p.links.filter((l) => docIdOfRow(sql, l.row_id) !== l.doc_id) }),
  apply(sql, p, { now }) {
    const meta = getTable(sql, p.table_id);
    let linked = 0;
    for (const l of p.links) if (linkRowDoc(sql, meta.table_id, l.row_id, l.doc_id, now)) linked++;
    return { result: { linked }, summary: `Linked ${plural(linked, "page")} to rows of "${meta.display}"` };
  },
};
