/**
 * Cells to and from the clipboard as spreadsheets exchange them: tab-separated columns, one line
 * per row, a field holding a tab, a line break or a quote wrapped in quotes. A pasted block is
 * planned against the grid here and written through the ordinary row updates and inserts.
 */
import type { ColumnSpec, RowInputValue, RowRecord, RowValue } from "@stuga/protocol/databases/types";
import { fileLinks } from "@stuga/protocol/databases/cells";
import { formatLocale } from "../../i18n/i18n";
import { checkCell, parseFieldInput, type FieldInput } from "./field-input";
import { numberForEditing } from "./numbers";

/** Text a paste turns into more than one cell. */
export const isBlockPaste = (text: string): boolean => /[\t\n]/.test(text.replace(/\r?\n$/, ""));

/**
 * Text a paste into an open cell editor turns into more than one cell: a range of columns, as a
 * spreadsheet copies it. Lines alone (an address from an email) stay in the cell being edited.
 */
export const isRangePaste = (text: string): boolean => text.replace(/\r?\n$/, "").includes("\t");

/** Lines as one cell's text, joined by spaces where an input would run them together. */
export const asOneLine = (text: string): string => text.replace(/\r?\n$/, "").replace(/[ \t]*\r?\n[ \t]*/g, " ");

/** Clipboard text as rows of fields. A spreadsheet's trailing line break ends the last row rather than adding an empty one. */
export function parseClipboard(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let i = 0;
  const s = text.replace(/\r\n?/g, "\n");
  while (i <= s.length) {
    if (field === "" && s[i] === '"') {
      // A quoted field runs to the quote that is not doubled.
      const end = closingQuote(s, i + 1);
      if (end !== -1 && (end + 1 === s.length || s[end + 1] === "\t" || s[end + 1] === "\n")) {
        field = s.slice(i + 1, end).replace(/""/g, '"');
        i = end + 1;
        continue;
      }
    }
    const ch = s[i];
    if (ch === undefined || ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch === "\t") {
      row.push(field);
      field = "";
    } else {
      field += ch;
    }
    i++;
  }
  if (rows.length > 1 && rows[rows.length - 1]!.every((f) => f === "")) rows.pop();
  return rows;
}

function closingQuote(s: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    if (s[i] !== '"') continue;
    if (s[i + 1] === '"') {
      i++;
      continue;
    }
    return i;
  }
  return -1;
}

const CHECKED = new Set(["1", "true", "yes", "y", "x", "✓", "✔", "checked"]);
const UNCHECKED = new Set(["", "0", "false", "no", "n", "—", "-", "unchecked"]);

/** One pasted field as input for its column. */
export function pastedInput(col: ColumnSpec, text: string, locale = formatLocale()): FieldInput {
  const trimmed = text.trim();
  switch (col.type) {
    case "checkbox": {
      const k = trimmed.toLowerCase();
      if (CHECKED.has(k)) return { ok: true, value: true };
      if (UNCHECKED.has(k)) return { ok: true, value: false };
      return { ok: false, problem: "" };
    }
    case "single_select": {
      if (trimmed === "") return { ok: true, value: null };
      const choice = (col.options?.choices ?? []).find((c) => c === trimmed) ?? (col.options?.choices ?? []).find((c) => c.toLowerCase() === trimmed.toLowerCase());
      return { ok: true, value: choice ?? trimmed };
    }
    case "date":
    case "number":
      return parseFieldInput(col.type, trimmed, locale);
    default:
      return parseFieldInput(col.type, text, locale);
  }
}

/** A cell as text to copy: what the editor would show, so a copy pastes back as the same value. */
export function copiedText(col: ColumnSpec, value: RowValue | undefined, locale = formatLocale()): string {
  if (value === null || value === undefined) return "";
  if (col.type === "number" && typeof value === "number") return numberForEditing(value, locale);
  if (col.type === "checkbox") return value === 1 ? "TRUE" : "FALSE";
  if (col.type === "files") return fileLinks(value).map((f) => f.name).join(", ");
  return String(value);
}

export interface PastePlan {
  updates: Array<{ _id: string; values: Record<string, RowInputValue> }>;
  /** New rows for the lines past the last row. */
  inserts: Array<Record<string, RowInputValue>>;
  rows: number;
  columns: number;
  /** Fields that did not fit their column and were left out. */
  skipped: number;
}

/**
 * Where a block lands: from `rowId`/`columnId` rightwards over the visible columns and downwards
 * over the rows in the order they are shown, with new rows for what runs past the end when every
 * row is loaded. Columns past the last are dropped; a files column takes nothing.
 */
export function planPaste({
  block,
  rows,
  columns,
  rowId,
  columnId,
  canAddRows,
  locale = formatLocale(),
}: {
  block: string[][];
  rows: RowRecord[];
  columns: ColumnSpec[];
  rowId: string;
  columnId: string;
  canAddRows: boolean;
  locale?: string;
}): PastePlan {
  const startRow = rows.findIndex((r) => r._id === rowId);
  const startCol = columns.findIndex((c) => c.column_id === columnId);
  const plan: PastePlan = { updates: [], inserts: [], rows: 0, columns: 0, skipped: 0 };
  if (startRow === -1 || startCol === -1) return plan;
  const targets = columns.slice(startCol);
  const lines = canAddRows ? block : block.slice(0, rows.length - startRow);
  for (const [i, fields] of lines.entries()) {
    const values: Record<string, RowInputValue> = {};
    for (const [j, text] of fields.slice(0, targets.length).entries()) {
      const col = targets[j]!;
      plan.columns = Math.max(plan.columns, j + 1);
      if (col.type === "files") {
        if (text.trim() !== "") plan.skipped++;
        continue;
      }
      const v = checkCell(col, pastedInput(col, text, locale));
      if (v.ok) values[col.column_id] = v.value;
      else plan.skipped++;
    }
    const row = rows[startRow + i];
    if (row) {
      if (Object.keys(values).length > 0) plan.updates.push({ _id: row._id, values });
    } else {
      plan.inserts.push(values);
    }
    plan.rows++;
  }
  return plan;
}
