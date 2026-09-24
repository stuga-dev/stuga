import { DATABASE_MAX_TABLES, DATABASE_REVERT_MAX_ROWS } from "@stuga/protocol/databases/limits";
import type { DbRunOpTablesCreate } from "@stuga/protocol/databases/types";
import { OpError, conflict, plural, requireDisplay } from "../request.js";
import {
  createTable,
  dropTable,
  findTable,
  getMeta,
  getTable,
  listRowDocs,
  newId,
  renameTable,
  rowCount,
  selectAllRows,
  setMeta,
  tableCount,
  tableSchemaOf,
  type CreateColumnInput,
  type SqlHandle,
} from "../schema-ops.js";
import { parseColumnSpecs } from "./columns.js";
import type { OpDef } from "./registry.js";

/** `columns` rides only a direct create; an agent proposes its columns as ops of their own. */
type TablesCreate = DbRunOpTablesCreate & { columns?: CreateColumnInput[] };
type TablesRename = { kind: "tables.rename"; table_id: string; display: string };
type TablesDelete = { kind: "tables.delete"; table_id: string };

/** What a database is born with when its creator names no columns. */
const STARTER_COLUMNS: CreateColumnInput[] = [
  { display: "Name", type: "text", options: null },
  { display: "Notes", type: "text", options: null },
  { display: "Done", type: "checkbox", options: null },
];

function tableCapError(count: number): OpError {
  return new OpError(409, "table_cap", `this database already has ${count} tables (max ${DATABASE_MAX_TABLES})`);
}

export const tablesCreate: OpDef<TablesCreate> = {
  parse(input, view) {
    const display = requireDisplay(input.display);
    const count = view.tableCount();
    if (count >= DATABASE_MAX_TABLES) throw tableCapError(count);
    const p: TablesCreate = { kind: "tables.create", table_id: newId("tbl_"), display };
    if (!view.proposal && input.columns !== undefined) p.columns = parseColumnSpecs(input.columns);
    return p;
  },
  capture: (_sql, p) => ({ kind: "tables.create", table_id: p.table_id }),
  apply(sql, p, { now }) {
    const count = tableCount(sql);
    if (count >= DATABASE_MAX_TABLES) throw tableCapError(count);
    if (findTable(sql, p.table_id)) throw conflict("this table was already created");
    const columns = p.columns ?? [];
    return {
      result: { table: createTable(sql, { tableId: p.table_id, display: p.display, columns }, now) },
      summary: columns.length === 0 ? `Created table "${p.display}"` : `Created table "${p.display}" with ${plural(columns.length, "column")}`,
    };
  },
  proposal: {
    describe: (p) => `Create table "${p.display}"`,
    minted: (p) => ({ table_id: p.table_id }),
    references: () => [],
  },
};

/** Set in the transaction that creates a database's first table, so a retried init adds nothing. */
export function isInitialized(sql: SqlHandle): boolean {
  return getMeta(sql, "initialized") === "1";
}

/**
 * The first table of a new database: the creator's columns, or the starter
 * ones. An agent naming its schema must not inherit columns it may not remove.
 */
export const schemaInit: OpDef<TablesCreate> = {
  parse(input) {
    const display = typeof input.display === "string" && input.display.trim() !== "" ? requireDisplay(input.display) : "Table 1";
    const columns = input.columns === undefined ? STARTER_COLUMNS : parseColumnSpecs(input.columns);
    return { kind: "tables.create", table_id: newId("tbl_"), display, columns };
  },
  capture: tablesCreate.capture,
  apply(sql, p, opts) {
    if (isInitialized(sql)) throw conflict("this database is already initialized");
    setMeta(sql, "initialized", "1");
    return tablesCreate.apply(sql, p, opts);
  },
};

export const tablesRename: OpDef<TablesRename> = {
  parse(input, view) {
    const table = view.table(input);
    return { kind: "tables.rename", table_id: table.table_id, display: requireDisplay(input.display) };
  },
  capture: (sql, p) => ({ kind: "tables.rename", table_id: p.table_id, prev_display: getTable(sql, p.table_id).display }),
  apply(sql, p, { now }) {
    const prev = getTable(sql, p.table_id);
    return {
      result: { table: renameTable(sql, p.table_id, p.display, now) },
      summary: `Renamed table "${prev.display}" to "${p.display}"`,
    };
  },
};

export const tablesDelete: OpDef<TablesDelete> = {
  parse: (input, view) => ({ kind: "tables.delete", table_id: view.table(input).table_id }),
  capture(sql, p) {
    const meta = getTable(sql, p.table_id);
    // A whole table is held in memory before it spills, so past the cap the op is recorded without an inverse.
    if (rowCount(sql, meta.name) > DATABASE_REVERT_MAX_ROWS) return null;
    return {
      kind: "tables.delete",
      table: tableSchemaOf(sql, meta),
      rows: selectAllRows(sql, meta.name),
      pages: listRowDocs(sql, meta.table_id).map((l) => ({ row_id: l.row_id, doc_id: l.doc_id })),
    };
  },
  apply(sql, p, { captured, now }) {
    const meta = getTable(sql, p.table_id);
    const n = rowCount(sql, meta.name);
    dropTable(sql, meta.table_id, now);
    return {
      result: { deleted: true },
      summary: `Deleted table "${meta.display}" (${plural(n, "row")})${captured ? "" : " — too large to capture for revert"}`,
    };
  },
};
