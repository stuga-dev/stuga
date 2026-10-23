/**
 * `POST /rows/read` on a database actor: rows as a person reads them, for what Save to Stuga and Ask
 * Stuga read of a table, the wiki's Log and its check. The node calls it only after its own gate, for a
 * database the caller may read; what comes back is that database's live rows, never a proposal.
 */
import type { DatabaseColumnType } from "./types.js";

/** Rows one read returns at most, over every table of the database. */
export const ROWS_READ_MAX = 5_000;
/** Words one read narrows a large table by, at most. */
export const ROWS_READ_NEEDLES_MAX = 24;
/** Rows one read may name by id. */
export const ROWS_READ_IDS_MAX = 1_000;

export interface RowsReadRequest {
  /** Only these rows, those that exist; otherwise every row, up to `max_rows`. */
  rows?: Array<{ table_id: string; row_id: string }>;
  /**
   * Words, lower-cased: a table holding more rows than the read has left keeps only the rows holding one of
   * them in a cell, as the grid's search finds them. A table that fits is read whole.
   */
  needles?: string[];
  /** At most ROWS_READ_MAX, and that by default. */
  max_rows?: number;
  /** Ids and titles alone: no cells, no columns. */
  titles_only?: boolean;
}

/** Who made the change that last wrote a row, as the database's ledger records it. */
export interface RowEditor {
  /** A person's alias, an agent's (`agent-…`), or the AI co-author's (`panel:<alias>`). */
  alias: string;
  is_agent: boolean;
  on_behalf_of: string | null;
}

export interface RowsReadColumn {
  column_id: string;
  /** The physical name `query` reads it by. */
  name: string;
  display: string;
  type: DatabaseColumnType;
  choices?: string[];
  description?: string;
}

export interface RowsReadRow {
  row_id: string;
  /** Epoch milliseconds. */
  created_at: number;
  updated_at: number;
  /** Null when the ledger no longer holds the change, which it keeps only so long. */
  updated_by: RowEditor | null;
  /** Its first non-empty text cell by column order, "" when it has none: what a person sees it called. */
  title: string;
  /** Each non-empty cell, by column id, as a person reads it (a checkbox as TRUE or FALSE, a file by its name). */
  cells: Record<string, string>;
}

export interface RowsReadTable {
  table_id: string;
  /** The physical name `query` reads it by. */
  name: string;
  display: string;
  row_count: number;
  /** Empty for a titles-only read. */
  columns: RowsReadColumn[];
  rows: RowsReadRow[];
  /** Not every row was read: the table holds more than the read had left, and those read hold a needle when there were any. */
  partial: boolean;
}

export interface RowsReadResponse {
  tables: RowsReadTable[];
}
