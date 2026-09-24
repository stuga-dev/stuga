/**
 * The actor's SQLite: meta tables, DDL, row-page links and type coercion.
 * Physical identifiers are the only strings interpolated into SQL, and ident()
 * re-checks each one. User columns have no declared type, so SQLite never
 * rewrites a bound value and typeof() is authoritative.
 */
import { filterGroupParts, isFilterGroup, makeFilterGroup } from "@stuga/protocol/databases/filters";
import { isSafeIdentifier, sanitizeIdentifier, uniquifyIdentifier } from "@stuga/protocol/databases/identifiers";
import {
  DATABASE_COLUMN_TYPES,
  type ColumnOptions,
  type ColumnSpec,
  type DatabaseColumnType,
  type DatabaseSchema,
  type RowFilterNode,
  type RowValue,
  type TableSchema,
  type ViewSpec,
} from "@stuga/protocol/databases/types";
import type { ActorStorage } from "@stuga/runtime";
import { OpError } from "./request.js";

export type SqlHandle = ActorStorage["sql"];

/** 9 random bytes as 12 URL-safe base64 chars, the same shape as the node's ids. */
export function newId(prefix = ""): string {
  const buf = new Uint8Array(9);
  crypto.getRandomValues(buf);
  return prefix + btoa(String.fromCharCode(...buf)).replace(/[+/=]/g, "").slice(0, 12);
}

/** The single funnel through which a physical name enters SQL text. A bad name here is our bug, so it throws a 500. */
export function ident(name: string): string {
  if (!isSafeIdentifier(name)) throw new Error(`unsafe identifier reached SQL interpolation: ${JSON.stringify(name)}`);
  return `"${name}"`;
}

// ---- meta schema ----------------------------------------------------------------

/**
 * The version of what a database keeps in its actor storage: the meta tables below and how a user
 * table is laid out. The host stamps each store with it and refuses one stamped higher. A change
 * to either raises it, together with the step in the host that brings an older store forward.
 */
export const DATABASE_STORE_VERSION = 1;

/**
 * Create every meta table. One statement per exec(): node:sqlite compiles only
 * the first statement of a multi-statement string.
 *
 * `_row_docs` links a row to its page document. `_doc_links` is the node's
 * inbox: the actor has no Postgres, so a row change that should move a page to
 * or from the trash leaves a note (latest state per doc wins) that the node
 * takes after each write route.
 */
export function ensureSchema(sql: SqlHandle): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  sql.exec(
    `CREATE TABLE IF NOT EXISTS _tables (
       table_id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, display TEXT NOT NULL,
       position INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS _columns (
       column_id TEXT PRIMARY KEY, table_id TEXT NOT NULL, name TEXT NOT NULL, display TEXT NOT NULL,
       type TEXT NOT NULL, position INTEGER NOT NULL, options TEXT, created_at INTEGER NOT NULL,
       UNIQUE (table_id, name))`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS _ops (
       op_id TEXT PRIMARY KEY, seq INTEGER NOT NULL, ts INTEGER NOT NULL, actor TEXT NOT NULL,
       is_agent INTEGER NOT NULL, on_behalf_of TEXT, kind TEXT NOT NULL, table_id TEXT, summary TEXT NOT NULL,
       inverse TEXT, blob_key TEXT, reverted_by TEXT, reverts TEXT)`,
  );
  sql.exec(`CREATE INDEX IF NOT EXISTS _ops_seq ON _ops (seq DESC)`);
  sql.exec(
    `CREATE TABLE IF NOT EXISTS _views (
       view_id TEXT PRIMARY KEY, table_id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
       position INTEGER NOT NULL, spec TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  );
  sql.exec(`CREATE INDEX IF NOT EXISTS _views_table ON _views (table_id, position)`);
  sql.exec(
    `CREATE TABLE IF NOT EXISTS _row_docs (
       row_id TEXT PRIMARY KEY, table_id TEXT NOT NULL, doc_id TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL)`,
  );
  sql.exec(`CREATE INDEX IF NOT EXISTS _row_docs_table ON _row_docs (table_id)`);
  sql.exec(
    `CREATE TABLE IF NOT EXISTS _doc_links (
       doc_id TEXT PRIMARY KEY, row_id TEXT NOT NULL, table_id TEXT NOT NULL, state TEXT NOT NULL, changed_at INTEGER NOT NULL)`,
  );
  sql.exec(
    `CREATE TABLE IF NOT EXISTS _runs (
       run_id TEXT PRIMARY KEY, source TEXT NOT NULL, agent TEXT NOT NULL,
       agent_alias TEXT NOT NULL, reviewer TEXT NOT NULL, status TEXT NOT NULL,
       acknowledged INTEGER NOT NULL, auto_applied INTEGER NOT NULL, reverted INTEGER NOT NULL,
       workspace_id TEXT NOT NULL, doc_title TEXT NOT NULL, review_mode TEXT NOT NULL, client TEXT, model TEXT,
       created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  );
  sql.exec(`CREATE INDEX IF NOT EXISTS _runs_created ON _runs (created_at DESC)`);
  sql.exec(
    `CREATE TABLE IF NOT EXISTS _run_ops (
       run_id TEXT NOT NULL, op_id TEXT NOT NULL, position INTEGER NOT NULL,
       kind TEXT NOT NULL, table_id TEXT NOT NULL, summary TEXT NOT NULL,
       status TEXT NOT NULL, payload TEXT, blob_key TEXT, bytes INTEGER NOT NULL,
       decided_by TEXT, ledger_op_id TEXT, error TEXT, review TEXT NOT NULL,
       PRIMARY KEY (run_id, op_id))`,
  );
}

export function getMeta(sql: SqlHandle, key: string): string | null {
  const row = sql.exec(`SELECT value FROM _meta WHERE key = ?`, key).toArray()[0];
  return row ? String(row.value) : null;
}

export function setMeta(sql: SqlHandle, key: string, value: string): void {
  sql.exec(`INSERT INTO _meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, key, value);
}

// ---- tables and columns -----------------------------------------------------------

export interface TableMeta {
  table_id: string;
  name: string;
  display: string;
  position: number;
}

function asTableMeta(row: Record<string, unknown>): TableMeta {
  return { table_id: String(row.table_id), name: String(row.name), display: String(row.display), position: Number(row.position) };
}

export function listTables(sql: SqlHandle): TableMeta[] {
  return sql.exec(`SELECT * FROM _tables ORDER BY position, created_at, table_id`).toArray().map(asTableMeta);
}

export function findTable(sql: SqlHandle, tableId: string): TableMeta | null {
  const row = sql.exec(`SELECT * FROM _tables WHERE table_id = ?`, tableId).toArray()[0];
  return row ? asTableMeta(row) : null;
}

export function getTable(sql: SqlHandle, tableId: unknown): TableMeta {
  if (typeof tableId !== "string" || tableId === "") throw new OpError(400, "bad_request", "table_id must be a non-empty string");
  const table = findTable(sql, tableId);
  if (!table) throw new OpError(404, "table_not_found", `no table with id ${tableId}`);
  return table;
}

/**
 * What `_columns.options` holds: the wire options plus the column's
 * description. The actor is the only layer that knows this: a description is
 * read out of the blob and presented on the ColumnSpec itself, and the options
 * handed out are rebuilt from `choices` alone, so `description` never leaks
 * back into them.
 */
interface StoredColumnOptions extends ColumnOptions {
  description?: string;
}

function readStoredOptions(raw: unknown): StoredColumnOptions | null {
  return raw == null ? null : (JSON.parse(String(raw)) as StoredColumnOptions);
}

/** The blob to store for a column, or null when it has neither choices nor a description. */
function storedOptionsJson(options: ColumnOptions | null, description: string | null): string | null {
  const stored: StoredColumnOptions = {
    ...(options?.choices ? { choices: options.choices } : {}),
    ...(description ? { description } : {}),
  };
  return Object.keys(stored).length === 0 ? null : JSON.stringify(stored);
}

function asColumnSpec(row: Record<string, unknown>): ColumnSpec {
  const stored = readStoredOptions(row.options);
  return {
    column_id: String(row.column_id),
    name: String(row.name),
    display: String(row.display),
    type: String(row.type) as DatabaseColumnType,
    position: Number(row.position),
    options: stored?.choices ? { choices: stored.choices } : null,
    ...(stored?.description ? { description: stored.description } : {}),
  };
}

export function getColumns(sql: SqlHandle, tableId: string): ColumnSpec[] {
  return sql
    .exec(`SELECT * FROM _columns WHERE table_id = ? ORDER BY position, created_at, column_id`, tableId)
    .toArray()
    .map(asColumnSpec);
}

export function getColumn(sql: SqlHandle, tableId: string, columnId: unknown): ColumnSpec {
  if (typeof columnId !== "string" || columnId === "") throw new OpError(400, "bad_request", "column_id must be a non-empty string");
  const row = sql.exec(`SELECT * FROM _columns WHERE table_id = ? AND column_id = ?`, tableId, columnId).toArray()[0];
  if (!row) throw new OpError(404, "column_not_found", `no column with id ${columnId}`);
  return asColumnSpec(row);
}

export function tableCount(sql: SqlHandle): number {
  return Number(sql.exec(`SELECT COUNT(*) AS n FROM _tables`).one().n);
}

export function rowCount(sql: SqlHandle, physName: string): number {
  return Number(sql.exec(`SELECT COUNT(*) AS n FROM ${ident(physName)}`).one().n);
}

/** Bound parameters per IN list, well under SQLite's variable limit. */
const IN_CHUNK = 500;

/** The subset of `ids` that are rows of the table. */
export function existingRowIds(sql: SqlHandle, physName: string, ids: string[]): Set<string> {
  const found = new Set<string>();
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const chunk = ids.slice(i, i + IN_CHUNK);
    const inList = chunk.map(() => "?").join(", ");
    for (const r of sql.exec(`SELECT _id FROM ${ident(physName)} WHERE _id IN (${inList})`, ...chunk)) found.add(String(r._id));
  }
  return found;
}

export function tableSchemaOf(sql: SqlHandle, meta: TableMeta): TableSchema {
  return {
    table_id: meta.table_id,
    name: meta.name,
    display: meta.display,
    position: meta.position,
    row_count: rowCount(sql, meta.name),
    columns: getColumns(sql, meta.table_id),
    views: listViews(sql, meta.table_id),
  };
}

export function readSchema(sql: SqlHandle, databaseId: string): DatabaseSchema {
  return { database_id: databaseId, tables: listTables(sql).map((t) => tableSchemaOf(sql, t)) };
}

/**
 * Resolve a column reference: column_id, then physical name, then a unique
 * display name. An ambiguous display name lists the candidates so the caller
 * can retry with a precise ref.
 */
export function resolveColRef(columns: ColumnSpec[], ref: string): ColumnSpec {
  const byId = columns.find((c) => c.column_id === ref);
  if (byId) return byId;
  const byName = columns.find((c) => c.name === ref);
  if (byName) return byName;
  const byDisplay = columns.filter((c) => c.display === ref);
  if (byDisplay.length === 1) return byDisplay[0]!;
  if (byDisplay.length > 1) {
    const candidates = byDisplay.map((c) => `${c.column_id} ("${c.name}")`).join(", ");
    throw new OpError(400, "ambiguous_column", `column reference "${ref}" is ambiguous; use a column_id or physical name (candidates: ${candidates})`);
  }
  throw new OpError(400, "unknown_column", `unknown column reference "${ref}"`);
}

export function isColumnType(type: unknown): type is DatabaseColumnType {
  return typeof type === "string" && (DATABASE_COLUMN_TYPES as readonly string[]).includes(type);
}

export interface CreateColumnInput {
  columnId?: string;
  /** Recorded physical name, when a revert recreates a column; derived from display otherwise. */
  name?: string;
  display: string;
  type: DatabaseColumnType;
  options: ColumnOptions | null;
  /** What the column holds, in the creator's words; stored inside the options blob. */
  description?: string;
  position?: number;
}

function nextPosition(sql: SqlHandle, query: string, ...bindings: unknown[]): number {
  return Number(sql.exec(query, ...bindings).one().p);
}

function insertColumnRow(sql: SqlHandle, tableId: string, columnId: string, name: string, col: CreateColumnInput, position: number, now: number): void {
  sql.exec(
    `INSERT INTO _columns (column_id, table_id, name, display, type, position, options, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    columnId,
    tableId,
    name,
    col.display,
    col.type,
    position,
    storedOptionsJson(col.options, col.description ?? null),
    now,
  );
}

/**
 * One _tables row, its _columns rows and one CREATE TABLE. Rows are keyed by an
 * app-minted `_id`, never rowid: SQLite recycles rowids, and a revert must not
 * resurrect a row under an id a later row owns.
 */
export function createTable(
  sql: SqlHandle,
  input: { tableId: string; display: string; name?: string; position?: number; columns: CreateColumnInput[] },
  now: number,
): TableSchema {
  const name = uniquifyIdentifier(input.name ?? sanitizeIdentifier(input.display), new Set(listTables(sql).map((t) => t.name)));
  const position = input.position ?? nextPosition(sql, `SELECT COALESCE(MAX(position) + 1, 0) AS p FROM _tables`);
  sql.exec(
    `INSERT INTO _tables (table_id, name, display, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    input.tableId,
    name,
    input.display,
    position,
    now,
    now,
  );
  const taken = new Set<string>();
  const colDefs: string[] = [];
  for (const [i, col] of input.columns.entries()) {
    const colName = uniquifyIdentifier(col.name ?? sanitizeIdentifier(col.display), taken);
    taken.add(colName);
    insertColumnRow(sql, input.tableId, col.columnId ?? newId("col_"), colName, col, col.position ?? i, now);
    colDefs.push(`, ${ident(colName)}`);
  }
  sql.exec(`CREATE TABLE ${ident(name)} (_id TEXT PRIMARY KEY, _created_at INTEGER NOT NULL, _updated_at INTEGER NOT NULL${colDefs.join("")})`);
  return tableSchemaOf(sql, getTable(sql, input.tableId));
}

/** Rename a table; the physical name moves only when the new display sanitizes differently. */
export function renameTable(sql: SqlHandle, tableId: string, display: string, now: number): TableSchema {
  const meta = getTable(sql, tableId);
  const taken = new Set(listTables(sql).filter((t) => t.table_id !== tableId).map((t) => t.name));
  const newName = uniquifyIdentifier(sanitizeIdentifier(display), taken);
  if (newName !== meta.name) sql.exec(`ALTER TABLE ${ident(meta.name)} RENAME TO ${ident(newName)}`);
  sql.exec(`UPDATE _tables SET name = ?, display = ?, updated_at = ? WHERE table_id = ?`, newName, display, now, tableId);
  return tableSchemaOf(sql, getTable(sql, tableId));
}

/** Drop a table with its meta rows; every page its rows had is queued for the trash. */
export function dropTable(sql: SqlHandle, tableId: string, now: number): void {
  const meta = getTable(sql, tableId);
  queueDocLinks(sql, listRowDocs(sql, tableId), "trash", now);
  sql.exec(`DELETE FROM _row_docs WHERE table_id = ?`, tableId);
  sql.exec(`DELETE FROM _views WHERE table_id = ?`, tableId);
  sql.exec(`DELETE FROM _columns WHERE table_id = ?`, tableId);
  sql.exec(`DELETE FROM _tables WHERE table_id = ?`, tableId);
  sql.exec(`DROP TABLE ${ident(meta.name)}`);
}

export function addColumn(sql: SqlHandle, tableId: string, col: CreateColumnInput & { columnId: string }, now: number): ColumnSpec {
  const meta = getTable(sql, tableId);
  const name = uniquifyIdentifier(col.name ?? sanitizeIdentifier(col.display), new Set(getColumns(sql, tableId).map((c) => c.name)));
  const position = col.position ?? nextPosition(sql, `SELECT COALESCE(MAX(position) + 1, 0) AS p FROM _columns WHERE table_id = ?`, tableId);
  insertColumnRow(sql, tableId, col.columnId, name, col, position, now);
  sql.exec(`ALTER TABLE ${ident(meta.name)} ADD COLUMN ${ident(name)}`);
  return getColumn(sql, tableId, col.columnId);
}

export function renameColumn(sql: SqlHandle, tableId: string, columnId: string, display: string): ColumnSpec {
  const meta = getTable(sql, tableId);
  const col = getColumn(sql, tableId, columnId);
  const taken = new Set(getColumns(sql, tableId).filter((c) => c.column_id !== columnId).map((c) => c.name));
  const newName = uniquifyIdentifier(sanitizeIdentifier(display), taken);
  if (newName !== col.name) sql.exec(`ALTER TABLE ${ident(meta.name)} RENAME COLUMN ${ident(col.name)} TO ${ident(newName)}`);
  sql.exec(`UPDATE _columns SET name = ?, display = ? WHERE column_id = ?`, newName, display, columnId);
  return getColumn(sql, tableId, columnId);
}

/** Drop a column and every reference views hold to it. */
export function dropColumn(sql: SqlHandle, tableId: string, columnId: string, now: number): void {
  const meta = getTable(sql, tableId);
  const col = getColumn(sql, tableId, columnId);
  sql.exec(`DELETE FROM _columns WHERE column_id = ?`, columnId);
  sql.exec(`ALTER TABLE ${ident(meta.name)} DROP COLUMN ${ident(col.name)}`);
  for (const view of listViews(sql, tableId)) {
    const pruned = pruneViewColumns(view, (id) => id !== columnId);
    if (pruned !== view) writeView(sql, pruned, now);
  }
}

/** A type change rewrites the options blob, so the description already in it is carried over: a retype never erases it. */
export function setColumnTypeMeta(sql: SqlHandle, columnId: string, type: DatabaseColumnType, options: ColumnOptions | null): void {
  const kept = readStoredOptions(sql.exec(`SELECT options FROM _columns WHERE column_id = ?`, columnId).toArray()[0]?.options)?.description ?? null;
  sql.exec(`UPDATE _columns SET type = ?, options = ? WHERE column_id = ?`, type, storedOptionsJson(options, kept), columnId);
}

/** Write a column's description (null clears it), keeping its choices. */
export function setColumnDescriptionMeta(sql: SqlHandle, tableId: string, columnId: string, description: string | null): ColumnSpec {
  const col = getColumn(sql, tableId, columnId);
  sql.exec(`UPDATE _columns SET options = ? WHERE column_id = ?`, storedOptionsJson(col.options, description), columnId);
  return getColumn(sql, tableId, columnId);
}

// ---- views --------------------------------------------------------------------------

/** The JSON half of a _views row: everything but identity and ordering. */
type ViewShape = Pick<ViewSpec, "filter" | "sorts" | "group_by" | "hidden_columns" | "config">;

function asViewSpec(row: Record<string, unknown>): ViewSpec {
  const shape = JSON.parse(String(row.spec)) as ViewShape;
  return {
    view_id: String(row.view_id),
    table_id: String(row.table_id),
    kind: String(row.kind) as ViewSpec["kind"],
    name: String(row.name),
    position: Number(row.position),
    filter: shape.filter,
    sorts: shape.sorts,
    group_by: shape.group_by,
    hidden_columns: shape.hidden_columns,
    config: shape.config,
  };
}

function shapeJson(shape: ViewShape): string {
  return JSON.stringify({
    filter: shape.filter,
    sorts: shape.sorts,
    group_by: shape.group_by,
    hidden_columns: shape.hidden_columns,
    config: shape.config,
  });
}

export function listViews(sql: SqlHandle, tableId: string): ViewSpec[] {
  return sql.exec(`SELECT * FROM _views WHERE table_id = ? ORDER BY position, created_at, view_id`, tableId).toArray().map(asViewSpec);
}

export function findView(sql: SqlHandle, viewId: string): ViewSpec | null {
  const row = sql.exec(`SELECT * FROM _views WHERE view_id = ?`, viewId).toArray()[0];
  return row ? asViewSpec(row) : null;
}

export function getView(sql: SqlHandle, tableId: string, viewId: unknown): ViewSpec {
  if (typeof viewId !== "string" || viewId === "") throw new OpError(400, "bad_request", "view_id must be a non-empty string");
  const view = findView(sql, viewId);
  if (!view || view.table_id !== tableId) throw new OpError(404, "view_not_found", `no view with id ${viewId}`);
  return view;
}

export function insertView(
  sql: SqlHandle,
  tableId: string,
  input: { viewId: string; kind: ViewSpec["kind"]; name: string; position?: number; shape: ViewShape },
  now: number,
): ViewSpec {
  const position = input.position ?? nextPosition(sql, `SELECT COALESCE(MAX(position) + 1, 0) AS p FROM _views WHERE table_id = ?`, tableId);
  sql.exec(
    `INSERT INTO _views (view_id, table_id, kind, name, position, spec, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    input.viewId,
    tableId,
    input.kind,
    input.name,
    position,
    shapeJson(input.shape),
    now,
    now,
  );
  return getView(sql, tableId, input.viewId);
}

/** Overwrite a view's settable fields. */
export function writeView(sql: SqlHandle, view: ViewSpec, now: number): ViewSpec {
  sql.exec(
    `UPDATE _views SET kind = ?, name = ?, position = ?, spec = ?, updated_at = ? WHERE view_id = ?`,
    view.kind,
    view.name,
    view.position,
    shapeJson(view),
    now,
    view.view_id,
  );
  return getView(sql, view.table_id, view.view_id);
}

export function deleteView(sql: SqlHandle, viewId: string): void {
  sql.exec(`DELETE FROM _views WHERE view_id = ?`, viewId);
}

/**
 * A view without the column references `keep` rejects: their conditions (a
 * group left empty goes too), sort keys, grouping and hidden entries. Returns
 * the same object when nothing was dropped.
 */
export function pruneViewColumns(view: ViewSpec, keep: (columnId: string) => boolean): ViewSpec {
  const pruneNode = (node: RowFilterNode): RowFilterNode | null => {
    if (!isFilterGroup(node)) return keep(node.column_id) ? node : null;
    const { op, children: kids } = filterGroupParts(node);
    const children = kids.map(pruneNode).filter((c): c is RowFilterNode => c !== null);
    if (children.length === 0) return null;
    return children.length === kids.length && children.every((c, i) => c === kids[i]) ? node : makeFilterGroup(op, children);
  };
  const filter = view.filter === null ? null : pruneNode(view.filter);
  const sorts = view.sorts.filter((s) => keep(s.column_id));
  const groupBy = view.group_by !== null && keep(view.group_by) ? view.group_by : null;
  const hidden = view.hidden_columns.filter(keep);
  const unchanged =
    filter === view.filter && sorts.length === view.sorts.length && groupBy === view.group_by && hidden.length === view.hidden_columns.length;
  return unchanged ? view : { ...view, filter, sorts, group_by: groupBy, hidden_columns: hidden };
}

// ---- row pages ------------------------------------------------------------------------

export interface RowDocLink {
  row_id: string;
  table_id: string;
  doc_id: string;
}

type DocLinkState = "trash" | "restore";

function asRowDocLink(row: Record<string, unknown>): RowDocLink {
  return { row_id: String(row.row_id), table_id: String(row.table_id), doc_id: String(row.doc_id) };
}

export function docIdOfRow(sql: SqlHandle, rowId: string): string | null {
  const row = sql.exec(`SELECT doc_id FROM _row_docs WHERE row_id = ?`, rowId).toArray()[0];
  return row ? String(row.doc_id) : null;
}

export function rowOfDoc(sql: SqlHandle, docId: string): RowDocLink | null {
  const row = sql.exec(`SELECT row_id, table_id, doc_id FROM _row_docs WHERE doc_id = ?`, docId).toArray()[0];
  return row ? asRowDocLink(row) : null;
}

/** The links of these rows (only rows that have a page appear). */
export function rowDocsOf(sql: SqlHandle, rowIds: string[]): RowDocLink[] {
  if (rowIds.length === 0) return [];
  const inList = rowIds.map(() => "?").join(", ");
  return sql
    .exec(`SELECT row_id, table_id, doc_id FROM _row_docs WHERE row_id IN (${inList}) ORDER BY row_id`, ...rowIds)
    .toArray()
    .map(asRowDocLink);
}

export function listRowDocs(sql: SqlHandle, tableId: string): RowDocLink[] {
  return sql.exec(`SELECT row_id, table_id, doc_id FROM _row_docs WHERE table_id = ? ORDER BY row_id`, tableId).toArray().map(asRowDocLink);
}

/** Link a row to its page. A row has one page and a page one row; linking the page a row already has returns false. */
export function linkRowDoc(sql: SqlHandle, tableId: string, rowId: string, docId: string, now: number): boolean {
  const current = docIdOfRow(sql, rowId);
  if (current === docId) return false;
  if (current !== null) throw new OpError(409, "already_linked", `row ${rowId} already has a page (${current})`);
  const claimed = rowOfDoc(sql, docId);
  if (claimed) throw new OpError(409, "doc_linked", `document ${docId} is already the page of row ${claimed.row_id}`);
  sql.exec(`INSERT INTO _row_docs (row_id, table_id, doc_id, created_at) VALUES (?, ?, ?, ?)`, rowId, tableId, docId, now);
  return true;
}

/** Drop a row's link; the page itself is untouched. */
export function unlinkRowDoc(sql: SqlHandle, rowId: string): void {
  sql.exec(`DELETE FROM _row_docs WHERE row_id = ?`, rowId);
}

/** Leave notes for the node, inside the transaction of the row change they describe. */
export function queueDocLinks(sql: SqlHandle, links: RowDocLink[], state: DocLinkState, now: number): void {
  for (const link of links) {
    sql.exec(
      `INSERT INTO _doc_links (doc_id, row_id, table_id, state, changed_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (doc_id) DO UPDATE SET row_id = excluded.row_id, table_id = excluded.table_id,
         state = excluded.state, changed_at = excluded.changed_at`,
      link.doc_id,
      link.row_id,
      link.table_id,
      state,
      now,
    );
  }
}

/** Read and clear the node's notes of one state. */
export function takeDocLinks(sql: SqlHandle, state: DocLinkState): RowDocLink[] {
  const rows = sql
    .exec(`SELECT doc_id, row_id, table_id FROM _doc_links WHERE state = ? ORDER BY changed_at, doc_id`, state)
    .toArray()
    .map(asRowDocLink);
  sql.exec(`DELETE FROM _doc_links WHERE state = ?`, state);
  return rows;
}

// ---- type-change coercion --------------------------------------------------------------

/**
 * "The whole text is one number", matching exactly the text SQLite's CAST fully
 * consumes. Number() is wider (hex, "Infinity"): '0x1A' passes it but CASTs to 0.
 */
const STRICT_NUMBER_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

function isCastableNumberText(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const t = value.trim();
  return STRICT_NUMBER_RE.test(t) && Number.isFinite(Number(t));
}

/**
 * The predicate selecting cells that do not conform to `type` (NULL always
 * conforms). The inverse capture and the coercion UPDATE share it, so they agree
 * on which rows change. Numbers may be stored as 'integer' or 'real' (node:sqlite
 * binds JS numbers as REAL, SQL arithmetic may yield INTEGER), so both conform.
 */
function nonConformingWhere(colName: string, type: DatabaseColumnType, choices: string[] | null): { where: string; params: RowValue[] } {
  const c = ident(colName);
  switch (type) {
    case "number":
      return { where: `${c} IS NOT NULL AND typeof(${c}) NOT IN ('integer', 'real')`, params: [] };
    case "text":
      return { where: `${c} IS NOT NULL AND typeof(${c}) <> 'text'`, params: [] };
    case "checkbox":
      return { where: `${c} IS NOT NULL AND NOT (typeof(${c}) IN ('integer', 'real') AND ${c} IN (0, 1))`, params: [] };
    case "date":
      // date() normalizes out-of-range days ('2026-02-31' → '2026-03-03'), so equality is the validity check.
      return {
        where: `${c} IS NOT NULL AND NOT (typeof(${c}) = 'text' AND ${c} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(${c}) IS NOT NULL AND date(${c}) = ${c})`,
        params: [],
      };
    case "single_select": {
      const list = choices ?? [];
      const placeholders = list.map(() => "?").join(", ");
      return { where: `${c} IS NOT NULL AND NOT (typeof(${c}) = 'text' AND ${c} IN (${placeholders || "NULL"}))`, params: list };
    }
  }
}

/** The cells a set-type would change: exactly what its inverse must remember. */
export function captureNonConforming(
  sql: SqlHandle,
  physTable: string,
  colName: string,
  type: DatabaseColumnType,
  choices: string[] | null,
): Array<{ _id: string; value: RowValue }> {
  const { where, params } = nonConformingWhere(colName, type, choices);
  return sql
    .exec(`SELECT _id, ${ident(colName)} AS value FROM ${ident(physTable)} WHERE ${where} ORDER BY _id`, ...params)
    .toArray()
    .map((r) => ({ _id: String(r._id), value: r.value as RowValue }));
}

/**
 * One UPDATE over the non-conforming rows only:
 *   → number: text that fully parses as a number is CAST AS REAL, the rest NULL
 *   → checkbox: 'true'/'false' text becomes 1/0, the rest NULL
 *   → text: everything non-text is CAST AS TEXT
 *   → date / single_select: non-conforming values become NULL
 * Stock SQLite cannot say "the whole text is numeric", so for → number the
 * castable `_id`s are decided in JS from the captured cells and bound.
 */
export function coerceNonConforming(
  sql: SqlHandle,
  physTable: string,
  colName: string,
  type: DatabaseColumnType,
  choices: string[] | null,
  cells: Array<{ _id: string; value: RowValue }>,
  now: number,
): number {
  if (cells.length === 0) return 0;
  const { where, params } = nonConformingWhere(colName, type, choices);
  const t = ident(physTable);
  const c = ident(colName);
  switch (type) {
    case "number": {
      const castable = cells.filter((cell) => isCastableNumberText(cell.value)).map((cell) => cell._id);
      const inList = castable.map(() => "?").join(", ");
      sql.exec(
        `UPDATE ${t} SET ${c} = CASE WHEN _id IN (${inList || "NULL"}) THEN CAST(${c} AS REAL) ELSE NULL END, _updated_at = ? WHERE ${where}`,
        ...castable,
        now,
        ...params,
      );
      break;
    }
    case "checkbox":
      sql.exec(
        `UPDATE ${t} SET ${c} = CASE
           WHEN typeof(${c}) = 'text' AND lower(${c}) = 'true' THEN 1
           WHEN typeof(${c}) = 'text' AND lower(${c}) = 'false' THEN 0
           ELSE NULL END, _updated_at = ? WHERE ${where}`,
        now,
        ...params,
      );
      break;
    case "text":
      sql.exec(`UPDATE ${t} SET ${c} = CAST(${c} AS TEXT), _updated_at = ? WHERE ${where}`, now, ...params);
      break;
    case "date":
    case "single_select":
      sql.exec(`UPDATE ${t} SET ${c} = NULL, _updated_at = ? WHERE ${where}`, now, ...params);
      break;
  }
  return cells.length;
}

/** Full table contents in `_id` order, so a re-captured inverse serializes identically. */
export function selectAllRows(sql: SqlHandle, physTable: string): Record<string, RowValue>[] {
  return sql.exec(`SELECT * FROM ${ident(physTable)} ORDER BY _id`).toArray() as Record<string, RowValue>[];
}

export function selectNonNullCells(sql: SqlHandle, physTable: string, colName: string): Array<{ _id: string; value: RowValue }> {
  return sql
    .exec(`SELECT _id, ${ident(colName)} AS value FROM ${ident(physTable)} WHERE ${ident(colName)} IS NOT NULL ORDER BY _id`)
    .toArray()
    .map((r) => ({ _id: String(r._id), value: r.value as RowValue }));
}
