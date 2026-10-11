/**
 * A table's rows as plain text: CSV for a spreadsheet, and the words search
 * reads. Both show a cell as a person reads it, so a files cell is the names of
 * its files, never their links.
 */
import { csvCell } from "../domain/audit.js";
import { fileLinks } from "./cells.js";
import type { ColumnSpec, RowValue } from "./types.js";

/** A cell as words: a number as written, a checkbox as TRUE or FALSE, a files cell as its file names. Empty is "". */
export function cellPlainText(type: ColumnSpec["type"], value: RowValue | undefined): string {
  if (value === null || value === undefined) return "";
  switch (type) {
    case "checkbox":
      return Number(value) === 1 ? "TRUE" : "FALSE";
    case "files":
      return fileLinks(value)
        .map((f) => f.name)
        .join(", ");
    default:
      return String(value);
  }
}

/**
 * Rows as a spreadsheet opens them: a byte-order mark so Excel reads UTF-8,
 * CRLF line ends, a header of column names. Numbers stay bare so they stay
 * numbers; any other text a spreadsheet would run as a formula is neutralised.
 */
export function rowsToCsv(columns: readonly Pick<ColumnSpec, "column_id" | "display" | "type">[], rows: Iterable<Record<string, unknown>>): string {
  const lines = [columns.map((c) => csvCell(c.display)).join(",")];
  for (const row of rows) {
    lines.push(
      columns
        .map((c) => {
          const value = row[c.column_id] as RowValue | undefined;
          return c.type === "number" && typeof value === "number" ? String(value) : csvCell(cellPlainText(c.type, value));
        })
        .join(","),
    );
  }
  return `﻿${lines.join("\r\n")}\r\n`;
}

/** A file name for a table's CSV: the table's name without characters a file system refuses. */
export function csvFileName(tableName: string): string {
  // eslint-disable-next-line no-control-regex -- control characters are what a file name may not hold
  const base = tableName.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().replace(/^\.+/, "");
  return `${base || "Table"}.csv`;
}
