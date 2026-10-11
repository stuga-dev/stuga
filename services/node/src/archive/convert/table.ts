/**
 * A table from another app's CSV export, where every cell is text: each column typed by what all
 * its cells hold, as a person would type it by hand, and the rows as an archive stores them.
 */
import {
  DATABASE_MAX_CELL_BYTES,
  DATABASE_MAX_COLUMNS,
  DATABASE_MAX_DISPLAY_LENGTH,
  DATABASE_MAX_ROWS,
  DATABASE_MAX_SELECT_CHOICES,
} from "@stuga/protocol/databases/limits";
import type { RowValue } from "@stuga/protocol/databases/types";
import { coerceCell, inferDateOrder, parseDate } from "../../databases/imports/format.js";
import { ROW_FIELDS, archiveCellValue, type ArchiveColumn, type ArchiveRow } from "../format.js";

export interface CsvTable {
  columns: ArchiveColumn[];
  /** Cells as stored: a checkbox is 0 or 1, a files cell its files' source paths, one per line. */
  rows: ArchiveRow[];
  /** The text columns whose cells list several values, as a multi-select writes them. */
  lists: string[];
}

/** A time after a date, which a date column does not keep: `September 27, 2026 3:00 PM (GMT+8)`. */
const TIME = /\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:[AP]M)?(?:\s*\([^()]*\))?$/i;
const CHECKBOX: Record<string, number> = { yes: 1, no: 0, true: 1, false: 0 };
/** A leading zero a number would drop, as in an id or a postcode: `007`. */
const LEADING_ZERO = /^-?0\d/;

/** A column name as a table takes one: one trimmed line, unique ignoring case, and not a row's own field. */
function columnName(raw: string, index: number, taken: Set<string>): string {
  // eslint-disable-next-line no-control-regex
  const line = raw.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim();
  const base = line.slice(0, DATABASE_MAX_DISPLAY_LENGTH - 5).trim() || `Column ${index + 1}`;
  let name = base;
  for (let n = 2; taken.has(name.toLowerCase()) || ROW_FIELDS.has(name); n++) name = `${base} (${n})`;
  taken.add(name.toLowerCase());
  return name;
}

/** Text as a cell holds it: at most DATABASE_MAX_CELL_BYTES of UTF-8. */
function clipCell(text: string): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= DATABASE_MAX_CELL_BYTES) return text;
  return new TextDecoder().decode(bytes.slice(0, DATABASE_MAX_CELL_BYTES)).replace(/�$/, "");
}

/** A list of short values, as a multi-select or a list of people writes them: `launch, bakery`. */
const LIST_ITEM_MAX = 40;
function isList(values: string[]): boolean {
  const items = values.map((v) => v.split(/,\s*/));
  return items.some((parts) => parts.length > 1) && items.every((parts) => parts.every((part) => part.trim() !== "" && part.length <= LIST_ITEM_MAX));
}

/**
 * The type every one of `values` fits, and each value as that type stores it; `text` when no other
 * fits them all. A select needs a value that repeats, so a column of names stays text, and one
 * without commas, unless every value is one of a set in `choiceSets`, which it then offers whole.
 */
function typed(
  values: Array<string | null>,
  textOnly: boolean,
  choiceSets: readonly (readonly string[])[],
): { column: Omit<ArchiveColumn, "name">; cells: RowValue[] } {
  const present = values.filter((v): v is string => v !== null);
  const all = <T>(parse: (v: string) => T | null): T[] | null => {
    const out: T[] = [];
    for (const v of present) {
      const parsed = parse(v);
      if (parsed === null) return null;
      out.push(parsed);
    }
    return out;
  };
  const cellsFrom = (parse: (v: string) => RowValue): RowValue[] => values.map((v) => (v === null ? null : parse(v)));

  if (!textOnly && present.length > 0) {
    if (all((v) => CHECKBOX[v.toLowerCase()] ?? null)) return { column: { type: "checkbox" }, cells: cellsFrom((v) => CHECKBOX[v.toLowerCase()]!) };
    const number = (v: string): number | null => {
      if (LEADING_ZERO.test(v)) return null;
      const n = coerceCell("number", v, undefined);
      return typeof n === "number" ? n : null;
    };
    if (all(number)) return { column: { type: "number" }, cells: cellsFrom((v) => number(v)!) };
    const { order } = inferDateOrder(present.map((v) => v.replace(TIME, "")), "mdy");
    const date = (v: string): string | null => {
      const day = parseDate(v.replace(TIME, ""), order);
      return day !== null && archiveCellValue({ name: "", type: "date" }, day).ok ? day : null;
    };
    if (all(date)) return { column: { type: "date" }, cells: cellsFrom((v) => date(v)!) };
    const known = choiceSets.find((set) => present.every((v) => set.includes(v)));
    if (known) return { column: { type: "single_select", choices: [...known] }, cells: cellsFrom((v) => v) };
    const choices = [...new Set(present)];
    // A comma lists several values, as a multi-select or a list of people writes them.
    const selectable = present.every((v) => v.length <= DATABASE_MAX_DISPLAY_LENGTH && !/[\n,]/.test(v));
    if (selectable && choices.length <= DATABASE_MAX_SELECT_CHOICES && choices.length < present.length) {
      return { column: { type: "single_select", choices }, cells: cellsFrom((v) => v) };
    }
  }
  return { column: { type: "text" }, cells: cellsFrom(clipCell) };
}

/**
 * The table `records` hold: the first record names the columns, and each other is a row, keyed
 * by `keyOf` its index among the rows. `textColumns` are kept as text whatever they hold,
 * `filesColumns` are files columns, each row's files by their source paths, and a column whose
 * every value is in one of `choiceSets` is a select offering that set. Past
 * DATABASE_MAX_COLUMNS columns and DATABASE_MAX_ROWS rows, the rest is left out.
 */
export function csvTable(
  records: string[][],
  keyOf: (index: number) => string,
  textColumns: ReadonlySet<number> = new Set(),
  filesColumns: ReadonlyMap<number, string[][]> = new Map(),
  choiceSets: readonly (readonly string[])[] = [],
): CsvTable {
  const [header = [], ...body] = records;
  const rows = body.slice(0, DATABASE_MAX_ROWS);
  const width = Math.min(DATABASE_MAX_COLUMNS, Math.max(header.length, ...rows.map((r) => r.length)));
  const taken = new Set<string>();
  const columns: ArchiveColumn[] = [];
  const cells: RowValue[][] = [];
  const lists: string[] = [];
  for (let c = 0; c < width; c++) {
    const files = filesColumns.get(c);
    const values = rows.map((r) => (r[c] ?? "").trim() || null);
    const { column, cells: parsed } = files
      ? { column: { type: "files" as const }, cells: rows.map((_, r) => (files[r]?.length ? files[r]!.join("\n") : null)) }
      : typed(values, textColumns.has(c), choiceSets);
    const name = columnName(header[c] ?? "", c, taken);
    columns.push({ name, ...column });
    cells.push(parsed);
    if (column.type === "text" && !textColumns.has(c) && isList(values.filter((v): v is string => v !== null))) lists.push(name);
  }
  return {
    columns,
    lists,
    rows: rows.map((_, r) => {
      const values: Record<string, RowValue> = Object.create(null);
      columns.forEach((column, c) => {
        const value = cells[c]![r];
        if (value !== null && value !== undefined) values[column.name] = value;
      });
      return { key: keyOf(r), values };
    }),
  };
}

/** The type a new column made from these values would get, as `csvTable` types a column: what all of them fit. */
export function guessColumn(values: Array<string | null>): Omit<ArchiveColumn, "name"> {
  return typed(values, false, []).column;
}
