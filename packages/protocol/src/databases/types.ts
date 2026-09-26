/**
 * Structured databases: one DatabaseActor with a private SQLite database of
 * user-defined typed tables, edited by humans in a grid and by agents through
 * structured ops and read-only SQL. No Yjs.
 */
import type { ReviewMode } from "../domain/events.js";

// ---- Column types ------------------------------------------------------------

/**
 * Column types, each a plain SQLite storage class so agent SQL is predictable:
 *   text TEXT · number REAL · checkbox INTEGER 0/1
 *   date TEXT "YYYY-MM-DD" (lexical order is chronological)
 *   single_select TEXT, checked against options.choices in code rather than a
 *   CHECK constraint, so editing choices never rebuilds the table
 */
export const DATABASE_COLUMN_TYPES = [
  "text",
  "number",
  "checkbox",
  "date",
  "single_select",
] as const;

export type DatabaseColumnType = (typeof DATABASE_COLUMN_TYPES)[number];

export interface ColumnOptions {
  /** single_select only: the allowed values. */
  choices?: string[];
}

export interface ColumnSpec {
  column_id: string;
  /** Physical SQLite column name (sanitized; what SQL queries use). */
  name: string;
  /** The user's display name, verbatim. */
  display: string;
  type: DatabaseColumnType;
  position: number;
  options: ColumnOptions | null;
  /**
   * Short human-written help: what this column holds — units, codes,
   * conventions. Read by people, and by the text-to-SQL model, which sees only
   * names and types otherwise. Absent when nobody wrote one.
   */
  description?: string;
  /** Agent read-projection only: this column is a still-pending proposal. */
  pending?: boolean;
}

export interface TableSchema {
  table_id: string;
  /** Physical SQLite table name (sanitized; what SQL queries use). */
  name: string;
  /** The user's display name, verbatim. */
  display: string;
  position: number;
  row_count: number;
  columns: ColumnSpec[];
  /** Saved views of this table, in position order. */
  views: ViewSpec[];
  /** Agent read-projection only: this table is a still-pending proposal. */
  pending?: boolean;
}

export interface DatabaseSchema {
  database_id: string;
  tables: TableSchema[];
}

// ---- Rows ----------------------------------------------------------------------

/** A cell value as stored and read: checkbox is 0/1, date is "YYYY-MM-DD". */
export type RowValue = string | number | null;

/** What callers may send for a cell before normalization. */
export type RowInputValue = string | number | boolean | null;

/** A stored row: user columns plus the bookkeeping columns every table has. */
export type RowRecord = {
  _id: string;
  _created_at: number;
  _updated_at: number;
  /** The row's page document, when one exists. Filterable in listings; not a SQL column. */
  _doc_id?: string | null;
  /** The row's page is in the trash. */
  _doc_trashed?: boolean;
} & Record<string, RowValue>;

export interface RowSort {
  column_id: string;
  dir: "asc" | "desc";
}

export type RowFilterOp = "contains" | "not_contains" | "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "empty" | "not_empty";

export const ROW_FILTER_OPS: readonly RowFilterOp[] = [
  "contains",
  "not_contains",
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "empty",
  "not_empty",
];

/** One condition on one column — the leaf of a filter tree. */
export interface RowFilter {
  column_id: string;
  op: RowFilterOp;
  value?: RowValue;
}

/**
 * A filter tree: leaves joined by `and` / `or` groups, at most
 * DATABASE_FILTER_MAX_DEPTH deep and DATABASE_FILTER_MAX_LEAVES leaves. A bare
 * leaf is a valid tree.
 */
export type RowFilterGroup = { and: RowFilterNode[] } | { or: RowFilterNode[] };
export type RowFilterNode = RowFilter | RowFilterGroup;

/** One group of a grouped listing: the grouping column's value and how many rows share it. */
export interface RowGroup {
  value: RowValue;
  count: number;
}

// ---- Views --------------------------------------------------------------------
//
// A view is a shared, saved way of looking at one table, stored in the actor's
// SQLite. Other layouts would be further kinds of the same record.

export const DATABASE_VIEW_KINDS = ["table"] as const;
export type DatabaseViewKind = (typeof DATABASE_VIEW_KINDS)[number];

export interface ViewSpec {
  view_id: string;
  table_id: string;
  kind: DatabaseViewKind;
  name: string;
  position: number;
  filter: RowFilterNode | null;
  sorts: RowSort[];
  /** column_id to group rows by, or null. */
  group_by: string | null;
  /** column_ids the view hides; a new column is visible until hidden. */
  hidden_columns: string[];
  /** Kind-specific settings (column widths, card fields …); opaque to the actor. */
  config: Record<string, unknown>;
  /** Agent read-projection only: this view is a still-pending proposal. */
  pending?: boolean;
}

/** The settable half of a view: what create takes and update may change. */
export type ViewInput = Partial<Pick<ViewSpec, "name" | "kind" | "filter" | "sorts" | "group_by" | "hidden_columns" | "config" | "position">>;

// ---- Ops ledger ---------------------------------------------------------------

/** Who performed a mutation; resolved by the node, trusted by the actor. */
export interface DatabaseActor {
  alias: string;
  is_agent: boolean;
  /** For agents: the human the API key was minted by (notify/review target). */
  on_behalf_of?: string;
}

export type DatabaseOpKind =
  | "tables.create"
  | "tables.rename"
  | "tables.delete"
  | "columns.add"
  | "columns.rename"
  | "columns.set_type"
  | "columns.set_description"
  | "columns.delete"
  | "rows.insert"
  | "rows.update"
  | "rows.delete"
  /** A row was linked to its page document; the inverse unlinks. */
  | "rows.link_page"
  /** Many rows were linked to new pages at once; the inverse unlinks them. */
  | "rows.link_pages"
  | "views.create"
  | "views.update"
  | "views.delete"
  | "revert";

export interface DatabaseOpSummary {
  op_id: string;
  seq: number;
  /** epoch ms */
  ts: number;
  actor: string;
  /** Recorded, not inferred from the alias. */
  is_agent: boolean;
  on_behalf_of: string | null;
  kind: DatabaseOpKind;
  table_id: string | null;
  /** Human-readable one-liner, e.g. `Inserted 3 rows into "Projects"`. */
  summary: string;
  /** op_id of the revert that undid this op, else null. */
  reverted_by: string | null;
  /** For kind "revert": the op_id it undid. */
  reverts: string | null;
  /** True when an inverse payload exists — i.e. the UI may offer Revert. */
  revertible: boolean;
}

// ---- Agent-change review ("database runs") --------------------------------------
//
// One agent's mutation session on one database, accumulating ops. The database's
// `agent_mode` alone decides: `review` parks each op as pending with the tables
// untouched, `auto` applies it at once, attributed and revertible.

export type DatabaseRunSource = "connector" | "stdio" | "panel";

export type DatabaseRunOpStatus = "pending" | "accepted" | "rejected" | "conflict" | "auto_applied";

/**
 * Run op payloads. Ids are minted at propose time so an agent can reference
 * what it just proposed and the ids survive accept. Cell values are validated
 * at propose time and keyed by column_id, so renames cannot orphan a pending op.
 */
export interface DbRunOpTablesCreate {
  kind: "tables.create";
  /** Pre-minted. */
  table_id: string;
  display: string;
}
export interface DbRunOpColumnsAdd {
  kind: "columns.add";
  table_id: string;
  /** Pre-minted column_id. */
  column_id: string;
  display: string;
  type: DatabaseColumnType;
  options: ColumnOptions | null;
  /** What the column holds, as the proposer described it; absent when none was given. */
  description?: string;
}
export interface DbRunOpRowsInsert {
  kind: "rows.insert";
  table_id: string;
  /** Cells keyed by column_id, index-aligned with `row_ids`. A staged import is one op
   *  that may exceed DATABASE_MAX_ROWS_PER_WRITE; the table row cap still applies. */
  rows: Array<Record<string, RowValue>>;
  /** Pre-minted _ids for the inserted rows. */
  row_ids: string[];
  /** A staged import the node validated whole: one op past the per-write cap, worded as an import. */
  import?: true;
  /** Wire only, when fetched with `sample=N`: `rows`/`row_ids` hold the first N of this many. */
  rows_sampled_from?: number;
}
export interface DbRunOpRowsUpdate {
  kind: "rows.update";
  table_id: string;
  updates: Array<{ _id: string; values: Record<string, RowValue> }>;
}
export interface DbRunOpRowsDelete {
  kind: "rows.delete";
  table_id: string;
  row_ids: string[];
}
export interface DbRunOpViewsCreate {
  kind: "views.create";
  table_id: string;
  /** Pre-minted view_id. */
  view_id: string;
  /** The normalized view minus its identity; column refs are column_ids. */
  view: Omit<ViewSpec, "view_id" | "table_id" | "position" | "pending">;
}
export interface DbRunOpViewsUpdate {
  kind: "views.update";
  table_id: string;
  view_id: string;
  /** Only the fields the proposal changes, normalized. */
  changes: ViewInput;
}
export type DatabaseRunOpPayload =
  | DbRunOpTablesCreate
  | DbRunOpColumnsAdd
  | DbRunOpRowsInsert
  | DbRunOpRowsUpdate
  | DbRunOpRowsDelete
  | DbRunOpViewsCreate
  | DbRunOpViewsUpdate;

export type DatabaseRunOpKind = DatabaseRunOpPayload["kind"];

export interface DatabaseRunOp {
  /** "o1","o2",… unique within the run, stable. */
  id: string;
  kind: DatabaseRunOpKind;
  /** The table this op targets (for tables.create, the pre-minted id). */
  table_id: string;
  /** Human one-liner, e.g. `Insert 3 rows into "Tasks"`. */
  summary: string;
  status: DatabaseRunOpStatus;
  /** The review mode the op was proposed under (see AgentRunHunk.review). */
  review: ReviewMode;
  /** Elided on the wire when the run is large — see ops_truncated. */
  payload?: DatabaseRunOpPayload;
  decided_by?: string;
  /** The _ops ledger row this op produced once it applied (accept/auto-apply). */
  ledger_op_id?: string;
  /** For status "conflict": why the op could not apply. */
  error?: string;
}

export type DatabaseRunStatus = "open" | "applied" | "rejected" | "expired";

/** Wire summary of a database run (WS frames + REST). */
export interface DatabaseRunSummary {
  /** "run_<12 hex>", namespaced by the database id. */
  id: string;
  database_id: string;
  source: DatabaseRunSource;
  /** Display name, e.g. "Claude (Connector)" or "AI co-author". */
  agent: string;
  /** Actor alias of the proposing agent (run identity key). */
  agent_alias: string;
  /** Alias of the human who reviews. */
  reviewer: string;
  status: DatabaseRunStatus;
  /** Op payloads may be elided when huge — see ops_truncated. */
  ops: DatabaseRunOp[];
  /** true → payloads elided; fetch full detail via REST. */
  ops_truncated?: boolean;
  /** Catch-up card dismissed. */
  acknowledged: boolean;
  /** true if any op applied at once because the database is set to `auto`. */
  auto_applied: boolean;
  /** true once the run's applied ops were reverted. */
  reverted?: boolean;
  /** The strictest review mode any proposal in this run carried. */
  review_mode: ReviewMode;
  /** epoch ms */
  created_at: number;
  updated_at: number;
}

// ---- Staged imports -------------------------------------------------------------
//
// A CSV/JSONL file is staged on the node (create → upload → commit), every row
// is validated before anything is written, and the file lands as one
// `rows.insert` op.

export const DATABASE_IMPORT_FORMATS = ["csv", "jsonl"] as const;
export type DatabaseImportFormat = (typeof DATABASE_IMPORT_FORMATS)[number];

export type DatabaseImportErrorCode =
  | "unknown_column"
  | "duplicate_column"
  | "malformed_row"
  | "invalid_text"
  | "invalid_number"
  | "invalid_checkbox"
  | "invalid_date"
  | "invalid_choice";

/** One bad cell, located precisely enough to fix in place without re-reading the file. */
export interface DatabaseImportError {
  /** 1-based data row (the header line of a CSV is not a row). 0 = a header/file-level problem. */
  row: number;
  /** The file's column header, when the error is about one cell. */
  column?: string;
  /** The offending value as it appeared in the file (truncated). */
  value?: string;
  code: DatabaseImportErrorCode;
  message: string;
  /** For near-misses (a single_select value one typo away from a choice): the likely intent. */
  hint?: string;
}

/** What `POST /api/databases/:id/imports` hands back. */
export interface DatabaseImportTicket {
  import_id: string;
  table_id: string;
  format: DatabaseImportFormat;
  /** Absolute, on the node's public origin: PUT the file's bytes here, no auth header needed. */
  upload_url: string;
  /** The same target as a path, for clients reaching the node at another origin. */
  upload_path: string;
  upload_method: "PUT";
  max_bytes: number;
  /** ISO timestamp after which the upload and the commit are refused. */
  expires_at: string;
  /** How the commit will land: parked, applied by `auto`, or a human's direct write. */
  review: "review" | "auto" | "direct";
  /** The table's Import dialog, for a person to upload the file when the caller cannot. */
  import_page_url: string;
}

/** What a `dry_run` commit hands back: the verdict on the file, nothing written. */
export interface DatabaseImportCheck {
  import_id: string;
  dry_run: true;
  rows_total: number;
  /** Rows that would land; the rest are listed in `errors`. */
  rows_ready: number;
  rows_failed: number;
  errors: DatabaseImportError[];
  errors_truncated: boolean;
  /** Display names of the table columns the file's headers matched, in file order. */
  matched_columns: string[];
  ignored_columns: string[];
  notes: string[];
  guessed_date_order?: "mdy" | "dmy";
}

/** What a commit hands back once the file validated. */
export interface DatabaseImportResult {
  import_id: string;
  /** "proposed" = parked for the reviewer; "applied" = landed. */
  mode: "proposed" | "applied";
  rows_total: number;
  rows_ingested: number;
  /** Rows dropped under on_error "skip_bad_rows"; their errors are listed. */
  rows_skipped: number;
  errors: DatabaseImportError[];
  errors_truncated: boolean;
  /** File headers that matched no column and were mapped to null (dropped on purpose). */
  ignored_columns: string[];
  /** Assumptions the file forced, e.g. an ambiguous day/month order read as month-first. */
  notes?: string[];
  /** The day/month order applied to dates no column settled; pass `date_order` to change it. */
  guessed_date_order?: "mdy" | "dmy";
  /** Replay of an already-committed import: nothing was loaded twice. */
  already_applied?: boolean;
  run?: DatabaseRunSummary;
  pending?: number;
}
