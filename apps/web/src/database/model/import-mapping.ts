/**
 * Where each of an import file's columns goes: into a column of the table, into
 * a new column made from it, or nowhere. The node reads the file and says what
 * matched; a person changes any of it before anything is written.
 */
import type { DatabaseImportCheck, DatabaseImportHeader } from "@stuga/protocol/databases/types";
import type { ImportShape } from "../../api/databases";

export type HeaderChoice = { kind: "column"; columnId: string } | { kind: "new" } | { kind: "skip" };

/** The table on screen, or a new one of this name. */
export type ImportTarget = { kind: "table" } | { kind: "new"; name: string };

/** One entry per header the node maps, in file order; empty and `_…` headers (an export's own fields) it leaves out itself. */
export function mappableHeaders(check: Pick<DatabaseImportCheck, "headers">): DatabaseImportHeader[] {
  const seen = new Set<string>();
  return check.headers.filter((h) => {
    if (h.header === "" || h.header.startsWith("_") || seen.has(h.header)) return false;
    seen.add(h.header);
    return true;
  });
}

/**
 * Where each header goes before anyone chooses: the column it matched, else
 * the column a typo away, else a new column, so nothing in the file is lost
 * without a person saying so. Into a new table, every header is a new column.
 */
export function defaultChoices(check: Pick<DatabaseImportCheck, "headers">, target: ImportTarget): Record<string, HeaderChoice> {
  const out: Record<string, HeaderChoice> = {};
  const claimed = new Set<string>();
  for (const h of mappableHeaders(check)) {
    if (target.kind === "new") out[h.header] = { kind: "new" };
    else if (h.column_id) out[h.header] = { kind: "column", columnId: h.column_id };
    else if (h.suggestion && !claimed.has(h.suggestion) && !check.headers.some((o) => o.column_id === h.suggestion)) {
      out[h.header] = { kind: "column", columnId: h.suggestion };
    } else out[h.header] = { kind: "new" };
    const choice = out[h.header]!;
    if (choice.kind === "column") claimed.add(choice.columnId);
  }
  return out;
}

/** What the commit (and its dry run) is told for these choices. */
export function importShape(choices: Record<string, HeaderChoice>, target: ImportTarget): ImportShape {
  const columnMap: Record<string, string | null> = {};
  const newColumns: string[] = [];
  for (const [header, choice] of Object.entries(choices)) {
    if (choice.kind === "skip") columnMap[header] = null;
    else if (choice.kind === "new") newColumns.push(header);
    else if (target.kind === "table") columnMap[header] = choice.columnId;
  }
  return {
    ...(Object.keys(columnMap).length > 0 ? { column_map: columnMap } : {}),
    ...(target.kind === "new" ? { new_table: target.name } : newColumns.length > 0 ? { new_columns: newColumns } : {}),
  };
}

/** Whether the node's reading of the file already is what `choices` say, so no second check is needed. */
export function checkedAs(check: Pick<DatabaseImportCheck, "headers" | "ignored_columns">, choices: Record<string, HeaderChoice>): boolean {
  return mappableHeaders(check).every((h) => {
    const choice = choices[h.header];
    if (!choice) return true;
    if (choice.kind === "column") return h.column_id === choice.columnId;
    if (choice.kind === "new") return h.new === true;
    return h.column_id === null && !h.new && check.ignored_columns.includes(h.header);
  });
}

/** How many headers go to a column of the table, to new columns, and nowhere. */
export function choiceCounts(choices: Record<string, HeaderChoice>): { matched: number; added: number; skipped: number } {
  const all = Object.values(choices);
  return {
    matched: all.filter((c) => c.kind === "column").length,
    added: all.filter((c) => c.kind === "new").length,
    skipped: all.filter((c) => c.kind === "skip").length,
  };
}

/** A file's name without its extension: what a table made from it is called. */
export function tableNameFromFile(fileName: string): string {
  return fileName.replace(/\.[^./\\]+$/, "").trim();
}
