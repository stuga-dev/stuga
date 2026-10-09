/**
 * An op's detail in English: the ledger's `summary`, which agents read as run feedback. The web
 * says the same detail in the reader's language (apps/web/src/database/ActivityPanel.tsx).
 */
import type { DatabaseOpChangeDetail, DatabaseOpDetail } from "@stuga/protocol/databases/types";
import { plural } from "../request.js";

export function describeOp(d: DatabaseOpChangeDetail): string {
  switch (d.kind) {
    case "tables.create":
      return d.columns === 0 ? `Created table "${d.table}"` : `Created table "${d.table}" with ${plural(d.columns, "column")}`;
    case "tables.rename":
      return `Renamed table "${d.table}" to "${d.to}"`;
    case "tables.delete":
      return `Deleted table "${d.table}" (${plural(d.rows, "row")})${d.captured ? "" : " — too large to capture for revert"}`;
    case "columns.add":
      return `Added column "${d.column}" to "${d.table}"`;
    case "columns.rename":
      return `Renamed column "${d.column}" to "${d.to}" in "${d.table}"`;
    case "columns.set_type":
      return `Changed column "${d.column}" in "${d.table}" to ${d.type} (${plural(d.coerced, "cell")} coerced)`;
    case "columns.set_description":
      return d.cleared ? `Cleared the description of column "${d.column}" in "${d.table}"` : `Described column "${d.column}" in "${d.table}"`;
    case "columns.delete":
      return `Deleted column "${d.column}" from "${d.table}"`;
    case "rows.insert":
      return `${d.imported ? "Imported" : "Inserted"} ${plural(d.rows, "row")} into "${d.table}"`;
    case "rows.update":
      return `Updated ${plural(d.rows, "row")} in "${d.table}" (${d.columns.join(", ")}${d.more_columns ? ", …" : ""})`;
    case "rows.delete":
      return `Deleted ${plural(d.rows, "row")} from "${d.table}"`;
    case "rows.link_page":
      return `Linked a page to a row of "${d.table}"`;
    case "rows.link_pages":
      return `Linked ${plural(d.pages, "page")} to rows of "${d.table}"`;
    case "views.create":
      return `Created view "${d.view}" on "${d.table}"`;
    case "views.update":
      return `Changed view "${d.view}" on "${d.table}"${d.renamed_to === null ? "" : ` (renamed to "${d.renamed_to}")`}`;
    case "views.delete":
      return `Deleted view "${d.view}" from "${d.table}"`;
  }
}

/** A stored detail, or null for an op recorded without one. */
export function readOpDetail(raw: unknown): DatabaseOpDetail | null {
  if (raw == null) return null;
  try {
    return JSON.parse(String(raw)) as DatabaseOpDetail;
  } catch {
    return null;
  }
}
