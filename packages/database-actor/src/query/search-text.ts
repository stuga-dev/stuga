/**
 * What the workspace search reads of a database: each table's name, then a
 * line per row of its cells as a person reads them, in the order the rows were
 * added, cut at a fixed size. Checkboxes say nothing a search would look for.
 */
import { cellPlainText } from "@stuga/protocol/databases/csv";
import { DATABASE_SEARCH_TEXT_MAX_CHARS } from "@stuga/protocol/databases/limits";
import type { RowValue } from "@stuga/protocol/databases/types";
import type { ActorStorage } from "@stuga/runtime";
import { getColumns, ident, listTables } from "../schema-ops.js";

/** Between two cells of a row line. */
const CELL_SEPARATOR = " · ";

export function databaseSearchText(storage: Pick<ActorStorage, "sql" | "transactionSync">, maxChars = DATABASE_SEARCH_TEXT_MAX_CHARS): string {
  const lines: string[] = [];
  let size = 0;
  const add = (line: string): boolean => {
    if (size + line.length + 1 > maxChars) return false;
    lines.push(line);
    size += line.length + 1;
    return true;
  };
  for (const table of listTables(storage.sql)) {
    if (!add(table.display)) break;
    const columns = getColumns(storage.sql, table.table_id).filter((c) => c.type !== "checkbox");
    if (columns.length === 0) continue;
    let full = false;
    storage.transactionSync(() => {
      // Row at a time, so a large table is read only as far as the cut.
      const stream = storage.sql.iterate(`SELECT * FROM ${ident(table.name)} ORDER BY "_created_at", rowid`);
      for (const row of stream.rows) {
        const cells = columns.map((c) => cellPlainText(c.type, row[c.name] as RowValue)).filter((s) => s.trim() !== "");
        if (cells.length === 0) continue;
        if (!add(cells.join(CELL_SEPARATOR).replace(/\s*\n\s*/g, " "))) {
          full = true;
          break;
        }
      }
    });
    if (full) break;
  }
  return lines.join("\n");
}
