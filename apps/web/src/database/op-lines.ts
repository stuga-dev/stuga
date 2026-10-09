/**
 * A database change said from its detail in the reader's language: what an op did, for the
 * activity feed, and what a pending proposal would do, for the run bar. The node's English
 * `summary` is what agents read.
 */
import type { DatabaseOpChangeDetail } from "@stuga/protocol/databases/types";
import { t } from "../i18n/i18n";
import { columnTypeLabel } from "./model/column-types";

/** The columns a row update touched, listed with the reader's separator; "…" when it touched more. */
function columnList(names: string[], more: boolean): string {
  const list = names.join(t("activity.op.listSeparator"));
  return more ? t("activity.op.columnsAndMore", { columns: list }) : list;
}

/** What an op did, in the past tense, as the activity feed lists it. */
export function describeChange(d: DatabaseOpChangeDetail): string {
  switch (d.kind) {
    case "tables.create":
      return d.columns === 0
        ? t("activity.op.tableCreated", { table: d.table })
        : t("activity.op.tableCreatedWithColumns", { table: d.table, columns: d.columns });
    case "tables.rename":
      return t("activity.op.tableRenamed", { table: d.table, to: d.to });
    case "tables.delete":
      return t(d.captured ? "activity.op.tableDeleted" : "activity.op.tableDeletedUncaptured", { table: d.table, rows: d.rows });
    case "columns.add":
      return t("activity.op.columnAdded", { table: d.table, column: d.column });
    case "columns.rename":
      return t("activity.op.columnRenamed", { table: d.table, column: d.column, to: d.to });
    case "columns.set_type":
      return t("activity.op.columnTypeChanged", { table: d.table, column: d.column, type: columnTypeLabel(d.type), coerced: d.coerced });
    case "columns.set_description":
      return t(d.cleared ? "activity.op.columnDescriptionCleared" : "activity.op.columnDescribed", { table: d.table, column: d.column });
    case "columns.delete":
      return t("activity.op.columnDeleted", { table: d.table, column: d.column });
    case "rows.insert":
      return t(d.imported ? "activity.op.rowsImported" : "activity.op.rowsInserted", { table: d.table, rows: d.rows });
    case "rows.update":
      return t("activity.op.rowsUpdated", { table: d.table, rows: d.rows, columns: columnList(d.columns, d.more_columns) });
    case "rows.delete":
      return t("activity.op.rowsDeleted", { table: d.table, rows: d.rows });
    case "rows.link_page":
      return t("activity.op.pageLinked", { table: d.table });
    case "rows.link_pages":
      return t("activity.op.pagesLinked", { table: d.table, pages: d.pages });
    case "views.create":
      return t("activity.op.viewCreated", { table: d.table, view: d.view });
    case "views.update":
      return d.renamed_to === null
        ? t("activity.op.viewChanged", { table: d.table, view: d.view })
        : t("activity.op.viewChangedRenamed", { table: d.table, view: d.view, to: d.renamed_to });
    case "views.delete":
      return t("activity.op.viewDeleted", { table: d.table, view: d.view });
  }
}

/** What a proposed op would do, in the imperative, as the run bar lists it. */
export function describeProposal(d: DatabaseOpChangeDetail): string {
  switch (d.kind) {
    case "tables.create":
      return t("review.runBar.op.tableCreate", { table: d.table });
    case "columns.add":
      return t("review.runBar.op.columnAdd", { table: d.table, column: d.column });
    case "rows.insert":
      return t(d.imported ? "review.runBar.op.rowsImport" : "review.runBar.op.rowsInsert", { table: d.table, rows: d.rows });
    case "rows.update":
      return t("review.runBar.op.rowsUpdate", { table: d.table, rows: d.rows });
    case "rows.delete":
      return t("review.runBar.op.rowsDelete", { table: d.table, rows: d.rows });
    case "views.create":
      return t("review.runBar.op.viewCreate", { table: d.table, view: d.view });
    case "views.update":
      return d.renamed_to === null
        ? t("review.runBar.op.viewChange", { table: d.table, view: d.view })
        : t("review.runBar.op.viewChangeRenamed", { table: d.table, view: d.view, to: d.renamed_to });
    default:
      // Kinds an agent cannot propose.
      return describeChange(d);
  }
}
