/**
 * The pure half of staged imports: parsing, header mapping, cell coercion and
 * validation, and the signed upload ticket. Errors name the row, header, value
 * and a code, so an agent can fix the exact cells without re-reading its file.
 */
import { createHmac, randomBytes } from "node:crypto";
import { constantTimeEqual } from "@stuga/auth";
import { validateCellValue } from "@stuga/protocol/databases/cells";
import { sanitizeIdentifier } from "@stuga/protocol/databases/identifiers";
import {
  DATABASE_IMPORT_MAX_ERRORS,
  DATABASE_MAX_COLUMNS,
  DATABASE_IMPORT_TTL_MS,
} from "@stuga/protocol/databases/limits";
import type {
  ColumnSpec,
  DatabaseColumnType,
  DatabaseImportError,
  DatabaseImportErrorCode,
  RowInputValue,
  RowValue,
} from "@stuga/protocol/databases/types";

/** `imp_<expiry base36>_<random>`: the expiry rides in the id so a listing finds stale stagings unopened. */
export function newImportId(now = Date.now()): string {
  const exp = now + DATABASE_IMPORT_TTL_MS;
  return `imp_${exp.toString(36)}_${randomBytes(9).toString("hex")}`;
}

/** The expiry an import id carries, or null when the id is not one of ours. */
export function importExpiry(importId: string): number | null {
  const m = /^imp_([0-9a-z]+)_[0-9a-f]{18}$/.exec(importId);
  if (!m) return null;
  const exp = parseInt(m[1]!, 36);
  return Number.isFinite(exp) ? exp : null;
}

/** The upload URL's credential: domain-separated, scoped to one database and one import, expiring with the id. */
export function signUpload(secret: string, docId: string, importId: string): string {
  return createHmac("sha256", secret).update(`db-import-upload:${docId}:${importId}`).digest("hex");
}

export function verifyUpload(secret: string, docId: string, importId: string, sig: string | null): boolean {
  if (!sig || !/^[0-9a-f]{64}$/.test(sig)) return false;
  return constantTimeEqual(signUpload(secret, docId, importId), sig);
}

/** Pick the delimiter the header line actually uses: comma, semicolon or tab. */
export function detectDelimiter(headerLine: string): "," | ";" | "\t" {
  const count = (re: RegExp): number => (headerLine.match(re) ?? []).length;
  const commas = count(/,/g);
  const semis = count(/;/g);
  const tabs = count(/\t/g);
  if (tabs > commas && tabs > semis) return "\t";
  if (semis > commas) return ";";
  return ",";
}

/**
 * RFC 4180 with the usual tolerances: quoted fields may hold the delimiter,
 * doubled quotes and newlines; CRLF, LF and bare CR all end a record; a BOM is
 * skipped; fully blank lines are not records. Returns raw string fields.
 */
export function parseCsv(text: string, delimiter?: "," | ";" | "\t"): string[][] {
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const firstBreak = text.search(/\r|\n/);
  const delim = delimiter ?? detectDelimiter(firstBreak === -1 ? text : text.slice(i, firstBreak));
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const n = text.length;
  const endRecord = (): void => {
    row.push(field);
    field = "";
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
    row = [];
  };
  while (i < n) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === "") {
      quoted = true;
      i++;
      continue;
    }
    if (ch === delim) {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      endRecord();
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (field !== "" || row.length > 0) endRecord();
  return rows;
}

/** A parsed file: a header row plus index-aligned rows of raw cell values. */
export interface ImportTable {
  headers: string[];
  rows: unknown[][];
  /** File-level problems found while parsing (malformed JSON lines). */
  errors: DatabaseImportError[];
}

export function csvToTable(text: string): ImportTable {
  const records = parseCsv(text);
  if (records.length === 0) return { headers: [], rows: [], errors: [] };
  const [headers, ...rows] = records;
  return { headers: headers!.map((h) => h.trim()), rows, errors: [] };
}

/**
 * Line-delimited JSON objects (a top-level JSON array of objects is accepted
 * too). Headers are the keys in order of first appearance, so the mapping and
 * validation path is the same one CSV takes.
 */
export function jsonlToTable(text: string): ImportTable {
  const errors: DatabaseImportError[] = [];
  const objects: Array<Record<string, unknown> | null> = [];
  const trimmed = text.replace(/^\uFEFF/, "").trim();
  if (trimmed.startsWith("[")) {
    let arr: unknown;
    try {
      arr = JSON.parse(trimmed);
    } catch (e) {
      return { headers: [], rows: [], errors: [{ row: 0, code: "malformed_row", message: `not valid JSON: ${(e as Error).message}` }] };
    }
    if (!Array.isArray(arr)) return { headers: [], rows: [], errors: [{ row: 0, code: "malformed_row", message: "expected a JSON array of objects" }] };
    for (const [i, v] of arr.entries()) {
      if (v === null || typeof v !== "object" || Array.isArray(v)) {
        errors.push({ row: i + 1, code: "malformed_row", message: "each element must be an object of column → value" });
        objects.push(null);
      } else objects.push(v as Record<string, unknown>);
    }
  } else {
    let rowNo = 0;
    for (const line of trimmed.split(/\r?\n/)) {
      if (line.trim() === "") continue;
      rowNo++;
      try {
        const v: unknown = JSON.parse(line);
        if (v === null || typeof v !== "object" || Array.isArray(v)) {
          errors.push({ row: rowNo, code: "malformed_row", message: "each line must be a JSON object of column → value" });
          objects.push(null);
        } else objects.push(v as Record<string, unknown>);
      } catch (e) {
        errors.push({ row: rowNo, code: "malformed_row", message: `not valid JSON: ${(e as Error).message}` });
        objects.push(null);
      }
    }
  }
  // Headers stop at the column ceiling while collecting: the table below is
  // dense (rows x headers), so one new key per line would grow quadratically.
  const headers: string[] = [];
  const index = new Map<string, number>();
  let overflowed = false;
  for (const o of objects) {
    if (!o) continue;
    for (const k of Object.keys(o)) {
      if (index.has(k)) continue;
      if (headers.length >= DATABASE_MAX_COLUMNS) {
        overflowed = true;
        continue;
      }
      index.set(k, headers.length);
      headers.push(k);
    }
  }
  if (overflowed) {
    return {
      headers: [],
      rows: [],
      errors: [
        {
          row: 0,
          code: "malformed_row",
          message: `too many columns: this file has more than ${DATABASE_MAX_COLUMNS} distinct keys across its rows`,
        },
      ],
    };
  }
  const rows = objects.map((o) => {
    const cells: unknown[] = Array.from({ length: headers.length }, () => undefined);
    if (o) for (const [k, v] of Object.entries(o)) cells[index.get(k)!] = v;
    return cells;
  });
  return { headers, rows, errors };
}

export interface HeaderMapping {
  headers: string[];
  /** Index-aligned with `headers`: the column each feeds, or null when dropped. */
  targets: Array<ColumnSpec | null>;
  /** Headers dropped on purpose (mapped to null, bookkeeping `_…` names, empty headers). */
  ignored: string[];
  errors: DatabaseImportError[];
}

function findColumn(columns: ColumnSpec[], ref: string): ColumnSpec | null {
  const exact = columns.find((c) => c.column_id === ref || c.name === ref || c.display === ref);
  if (exact) return exact;
  const lower = ref.toLowerCase();
  const ci = columns.filter((c) => c.display.toLowerCase() === lower || c.name === lower);
  if (ci.length === 1) return ci[0]!;
  const phys = sanitizeIdentifier(ref);
  const byPhys = columns.filter((c) => c.name === phys);
  return byPhys.length === 1 ? byPhys[0]! : null;
}

/**
 * Which column each file header feeds. `column_map` (header → column ref, or
 * null to drop it) wins; otherwise a header matches by id, physical name,
 * display name (case-insensitively) or sanitized form. An unmatched header is an
 * error, never silently dropped.
 */
export function mapHeaders(headers: string[], columns: ColumnSpec[], columnMap: Record<string, string | null> = {}): HeaderMapping {
  const targets: Array<ColumnSpec | null> = [];
  const ignored: string[] = [];
  const errors: DatabaseImportError[] = [];
  const claimed = new Map<string, string>();
  const available = columns.map((c) => `"${c.display}" (${c.name})`).join(", ") || "none";

  for (const [i, header] of headers.entries()) {
    let target: ColumnSpec | null = null;
    if (header === "") {
      ignored.push(`column ${i + 1} (no header)`);
    } else if (Object.prototype.hasOwnProperty.call(columnMap, header)) {
      const ref = columnMap[header];
      if (ref === null || ref === undefined) ignored.push(header);
      else {
        target = findColumn(columns, ref);
        if (!target) {
          errors.push({
            row: 0,
            column: header,
            code: "unknown_column",
            message: `column_map sends "${header}" to "${ref}", which is not a column of this table — columns: ${available}`,
          });
        }
      }
    } else if (header.startsWith("_")) {
      // _id / _created_at / _updated_at: export bookkeeping, never user data.
      ignored.push(header);
    } else {
      target = findColumn(columns, header);
      if (!target) {
        const near = nearest(
          header,
          columns.map((c) => c.display),
        );
        errors.push({
          row: 0,
          column: header,
          code: "unknown_column",
          message: `no column matches header "${header}" — map it in column_map (to a column, or to null to skip it); columns: ${available}`,
          ...(near ? { hint: `did you mean "${near}"?` } : {}),
        });
      }
    }
    if (target) {
      const prior = claimed.get(target.column_id);
      if (prior !== undefined) {
        errors.push({
          row: 0,
          column: header,
          code: "duplicate_column",
          message: `headers "${prior}" and "${header}" both feed column "${target.display}"`,
        });
        target = null;
      } else claimed.set(target.column_id, header);
    }
    targets.push(target);
  }
  return { headers, targets, ignored, errors };
}

/** Which of the two small numbers in `1/4/26` is the day. */
export type DateOrder = "mdy" | "dmy";

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12,
};

const SLASH_DATE = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/;

function fullYear(y: string): number {
  const n = Number(y);
  return y.length === 4 ? n : n < 70 ? 2000 + n : 1900 + n;
}

function iso(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * A written date as YYYY-MM-DD, or null. ISO first, then day/month/year in
 * either order (two-digit years pivot at 70), then `4 Jan 2026` and `Jan 4,
 * 2026`. An impossible date comes back as written for the validator to refuse.
 */
export function parseDate(raw: string, order: DateOrder): string | null {
  const s = raw.trim();
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ].*)?$/.exec(s);
  if (m) return iso(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (m) return iso(Number(m[1]), Number(m[2]), Number(m[3]));
  m = SLASH_DATE.exec(s);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const [d, mo] = order === "dmy" || a > 12 ? [a, b] : [b, a];
    return iso(fullYear(m[3]!), mo, d);
  }
  m = /^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\.?,?\s+(\d{2}|\d{4})$/.exec(s);
  if (m) {
    const mo = MONTHS[m[2]!.toLowerCase()];
    return mo === undefined ? null : iso(fullYear(m[3]!), mo, Number(m[1]));
  }
  m = /^([A-Za-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{2}|\d{4})$/.exec(s);
  if (m) {
    const mo = MONTHS[m[1]!.toLowerCase()];
    return mo === undefined ? null : iso(fullYear(m[3]!), mo, Number(m[2]));
  }
  return null;
}

/**
 * Which order a column's `1/4/26`-style dates use: a first number over 12 proves
 * day-first, a second over 12 month-first. `ambiguous` means the column never
 * settled it and the fallback applied.
 */
export function inferDateOrder(values: unknown[], fallback: DateOrder): { order: DateOrder; ambiguous: boolean } {
  let dmy = 0;
  let mdy = 0;
  let slashy = 0;
  for (const v of values) {
    if (typeof v !== "string") continue;
    const m = SLASH_DATE.exec(v.trim());
    if (!m) continue;
    slashy++;
    if (Number(m[1]) > 12) dmy++;
    else if (Number(m[2]) > 12) mdy++;
  }
  if (dmy > 0 || mdy > 0) return { order: dmy > mdy ? "dmy" : "mdy", ambiguous: false };
  return { order: fallback, ambiguous: slashy > 0 };
}

/** Truncate a raw value for an error report. */
function shown(raw: unknown): string {
  const s = raw === undefined || raw === null ? "" : typeof raw === "string" ? raw : JSON.stringify(raw);
  return s.length > 80 ? `${s.slice(0, 77)}…` : s;
}

const TRUE_WORDS = new Set(["1", "true", "yes", "y", "x", "✓", "checked", "on"]);
const FALSE_WORDS = new Set(["0", "false", "no", "n", "unchecked", "off"]);

/**
 * What a file cell means for a column of this type, before the shared validator
 * sees it. CSV has only strings: empty means null, numbers parse with common
 * dressing, checkboxes accept the usual words, a select matches its choice
 * loosely. Anything unplaceable comes back as `invalid` with the original value.
 */
export function coerceCell(
  type: DatabaseColumnType,
  raw: unknown,
  choices: string[] | undefined,
  dateOrder: DateOrder = "mdy",
): RowInputValue | { invalid: unknown } {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "string" && raw.trim() === "") return null;
  switch (type) {
    case "text":
      if (typeof raw === "string") return raw;
      if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
      return { invalid: raw };
    case "number": {
      if (typeof raw === "number") return raw;
      if (typeof raw === "string") {
        // "$1,234.50", "(12)" for a negative, "1 234,5".
        let s = raw.trim().replace(/^[$€£¥]\s*|\s*[$€£¥]$/g, "");
        const negative = /^\(.*\)$/.test(s);
        if (negative) s = s.slice(1, -1).trim();
        if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, "");
        else if (/^-?\d{1,3}([ .]\d{3})+(,\d+)?$/.test(s)) s = s.replace(/[ .]/g, "").replace(",", ".");
        else if (/^-?\d+,\d+$/.test(s)) s = s.replace(",", ".");
        const n = Number(s);
        return Number.isFinite(n) && s !== "" ? (negative ? -n : n) : { invalid: raw };
      }
      return { invalid: raw };
    }
    case "checkbox": {
      if (typeof raw === "boolean") return raw;
      if (raw === 0 || raw === 1) return raw;
      if (typeof raw === "string") {
        const s = raw.trim().toLowerCase();
        if (TRUE_WORDS.has(s)) return true;
        if (FALSE_WORDS.has(s)) return false;
      }
      return { invalid: raw };
    }
    case "date": {
      if (typeof raw !== "string") return { invalid: raw };
      return parseDate(raw, dateOrder) ?? { invalid: raw };
    }
    case "single_select": {
      if (typeof raw !== "string") return { invalid: raw };
      const s = raw.trim();
      if (choices?.includes(s)) return s;
      // Case, spaces, dashes and underscores fold, when exactly one choice matches.
      const fold = (x: string) => x.toLowerCase().replace(/[\s_-]+/g, "");
      const key = fold(s);
      const ci = choices?.filter((c) => fold(c) === key) ?? [];
      return ci.length === 1 ? ci[0]! : { invalid: raw };
    }
  }
}

function codeFor(type: DatabaseColumnType): DatabaseImportErrorCode {
  switch (type) {
    case "text":
      return "invalid_text";
    case "number":
      return "invalid_number";
    case "checkbox":
      return "invalid_checkbox";
    case "date":
      return "invalid_date";
    case "single_select":
      return "invalid_choice";
  }
}

function levenshtein(a: string, b: string): number {
  const m = Math.min(a.length, 64);
  const n = Math.min(b.length, 64);
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n]!;
}

/** The candidate a typo away from `value`, if any (case-folded, spaces/dashes ignored). */
export function nearest(value: string, candidates: string[]): string | null {
  const fold = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, "");
  const v = fold(value);
  if (v === "") return null;
  let best: { c: string; d: number } | null = null;
  for (const c of candidates) {
    const d = levenshtein(v, fold(c));
    if (best === null || d < best.d) best = { c, d };
  }
  if (!best) return null;
  return best.d <= Math.max(2, Math.floor(v.length / 3)) ? best.c : null;
}

export interface ValidatedImport {
  /** Rows that validated, keyed by column_id, in file order. */
  rows: Array<Record<string, RowValue>>;
  rows_total: number;
  rows_failed: number;
  errors: DatabaseImportError[];
  errors_truncated: boolean;
  /** Assumptions the file forced, such as an ambiguous day/month order. */
  notes: string[];
  /** Set when some date column never settled its day/month order and the default was used. */
  guessedDateOrder?: DateOrder;
}

export interface ValidateOptions {
  /** Day/month order for `1/4/26`-style dates a column does not settle itself. */
  dateOrder?: DateOrder;
}

/**
 * Validate every row against the mapped columns. A row with any bad cell fails;
 * the good rows come back so the caller can abort or land them without the
 * failures. Errors are counted without limit and kept up to the cap, so the
 * report never costs more memory than the file.
 */
export function validateImportRows(table: ImportTable, mapping: HeaderMapping, opts: ValidateOptions = {}): ValidatedImport {
  const errors: DatabaseImportError[] = [];
  let errorCount = 0;
  const recordError = (e: DatabaseImportError): void => {
    errorCount++;
    if (errors.length < DATABASE_IMPORT_MAX_ERRORS) errors.push(e);
  };
  for (const e of table.errors) recordError(e);
  const rows: Array<Record<string, RowValue>> = [];
  const notes: string[] = [];
  let guessedDateOrder: DateOrder | undefined;
  let failed = 0;
  const badLines = new Set(table.errors.map((e) => e.row));
  const fallbackOrder = opts.dateOrder ?? "mdy";
  const active = mapping.targets
    .map((t, j) => {
      if (!t) return null;
      let dateOrder = fallbackOrder;
      if (t.type === "date") {
        const inferred = inferDateOrder(table.rows.map((r) => r[j]), fallbackOrder);
        dateOrder = inferred.order;
        if (inferred.ambiguous && opts.dateOrder === undefined) {
          guessedDateOrder = dateOrder;
          notes.push(
            `Dates like 1/4/26 in "${mapping.headers[j]}" were read as ${dateOrder === "mdy" ? "month/day/year" : "day/month/year"}, ` +
              `since nothing in the column says otherwise.`,
          );
        }
      }
      return { j, col: t, header: mapping.headers[j]!, dateOrder };
    })
    .filter((x) => x !== null);

  for (const [idx, cells] of table.rows.entries()) {
    const rowNo = idx + 1;
    if (badLines.has(rowNo)) {
      failed++;
      continue;
    }
    if (cells.length > mapping.headers.length) {
      failed++;
      recordError({
        row: rowNo,
        code: "malformed_row",
        message: `row has ${cells.length} fields but the header has ${mapping.headers.length}`,
      });
      continue;
    }
    const out: Record<string, RowValue> = {};
    let ok = true;
    for (const { j, col, header, dateOrder } of active) {
      const raw = cells[j];
      const coerced = coerceCell(col.type, raw, col.options?.choices, dateOrder);
      let reason: string | null = null;
      let howTo: string | undefined;
      if (typeof coerced === "object" && coerced !== null) {
        const r = reasonFor(col.type, col.options?.choices);
        reason = r.reason;
        howTo = r.hint;
      } else {
        const v = validateCellValue(col.type, col.options, coerced);
        // Empty cells are left out rather than sent as null.
        if (v.ok) {
          if (v.value !== null) out[col.column_id] = v.value;
        } else reason = v.reason;
      }
      if (reason !== null) {
        ok = false;
        // Past the cap, skip composing the error: `nearest` scans every choice.
        if (errors.length < DATABASE_IMPORT_MAX_ERRORS) {
          const near = col.type === "single_select" && typeof raw === "string" ? nearest(raw, col.options?.choices ?? []) : null;
          const hint = near ? `did you mean "${near}"?` : howTo;
          recordError({
            row: rowNo,
            column: header,
            value: shown(raw),
            code: codeFor(col.type),
            message: reason,
            ...(hint ? { hint } : {}),
          });
        } else {
          errorCount++;
        }
      }
    }
    if (ok) rows.push(out);
    else failed++;
  }
  return {
    rows,
    rows_total: table.rows.length,
    rows_failed: failed,
    errors,
    errors_truncated: errorCount > errors.length,
    notes,
    ...(guessedDateOrder ? { guessedDateOrder } : {}),
  };
}

/** Why a cell was refused, and how to write one that is not. */
function reasonFor(type: DatabaseColumnType, choices: string[] | undefined): { reason: string; hint?: string } {
  switch (type) {
    case "text":
      return { reason: "expected text" };
    case "number":
      return { reason: "not a number", hint: "digits, with an optional sign, decimal point or thousands separator" };
    case "checkbox":
      return { reason: "not a yes or no", hint: "yes/no, true/false or 1/0 all work" };
    case "date":
      return { reason: "not a date", hint: "2026-01-04, 1/4/26 and 4 Jan 2026 all work" };
    case "single_select":
      return { reason: "not one of the column's choices", hint: `choices: ${(choices ?? []).join(", ")}` };
  }
}
