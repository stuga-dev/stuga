import { validateCellValue } from "@stuga/protocol/databases/cells";
import type { ColumnSpec, DatabaseColumnType, RowInputValue, RowValue } from "@stuga/protocol/databases/types";
import { formatLocale, t } from "../../i18n/i18n";
import { cellProblem } from "./cell-problems";
import { parseNumberText } from "./numbers";

/** What a person typed, read for its column: the value to validate, or why it is not one. */
export type FieldInput = { ok: true; value: RowInputValue } | { ok: false; problem: string };

/** The cell to store, or the problem to show. */
export type CellCheck = { ok: true; value: RowValue } | { ok: false; problem: string };

/** The dates a person may pick: the date inputs' bounds. The years a typo leaves behind fall outside them. */
export const DATE_MIN = "1900-01-01";
export const DATE_MAX = "2100-12-31";

/**
 * A typed value as the cell validator takes it: empty is null, and a number is read in the
 * reader's locale; anything that is not exactly one number is refused here, with the reason.
 */
export function parseFieldInput(type: DatabaseColumnType, raw: string, locale = formatLocale()): FieldInput {
  const trimmed = type === "number" ? raw.trim() : raw;
  if (trimmed === "") return { ok: true, value: null };
  if (type !== "number") return { ok: true, value: trimmed };
  const n = parseNumberText(trimmed, locale);
  if (n.ok) return { ok: true, value: n.value };
  return { ok: false, problem: n.reason === "too_large" ? t("database.cell.numberTooLarge") : t("database.cell.expectedNumber") };
}

/** A date the person's date input could not read, such as a half-typed one. */
export const unreadableDate = (): FieldInput => ({ ok: false, problem: t("database.cell.pickDate") });

/**
 * What a person's input stores in `col`, validated as the node will and in the reader's words.
 * A date outside DATE_MIN..DATE_MAX is refused here and not by the node, which agents and the API
 * write through: in a date picker those years are a typo, not data.
 */
export function checkCell(col: ColumnSpec, input: FieldInput): CellCheck {
  if (!input.ok) return input;
  const v = validateCellValue(col.type, col.options, input.value);
  if (!v.ok) return { ok: false, problem: col.type === "date" ? t("database.cell.pickDate") : cellProblem(v.reason) };
  if (col.type === "date" && typeof v.value === "string" && (v.value < DATE_MIN || v.value > DATE_MAX)) {
    return { ok: false, problem: t("database.cell.pickDate") };
  }
  return v;
}
