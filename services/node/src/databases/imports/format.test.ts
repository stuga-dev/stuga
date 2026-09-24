import { describe, expect, it } from "vitest";
import { DATABASE_IMPORT_MAX_ERRORS, DATABASE_IMPORT_TTL_MS } from "@stuga/protocol/databases/limits";
import type { ColumnSpec } from "@stuga/protocol/databases/types";
import {
  coerceCell,
  csvToTable,
  detectDelimiter,
  importExpiry,
  inferDateOrder,
  jsonlToTable,
  mapHeaders,
  nearest,
  newImportId,
  parseCsv,
  parseDate,
  signUpload,
  validateImportRows,
  verifyUpload,
} from "./format.js";

function col(over: Partial<ColumnSpec> & { name: string; type: ColumnSpec["type"] }): ColumnSpec {
  return {
    column_id: `col_${over.name}`,
    display: over.name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    position: 0,
    options: null,
    ...over,
  };
}

const COLUMNS: ColumnSpec[] = [
  col({ name: "booking_ref", type: "text" }),
  col({ name: "nightly_rate", type: "number" }),
  col({ name: "breakfast", type: "checkbox" }),
  col({ name: "check_in", type: "date" }),
  col({ name: "status", type: "single_select", options: { choices: ["Confirmed", "Checked Out", "Cancelled"] } }),
];

describe("parseCsv", () => {
  it("handles quotes, escaped quotes, embedded newlines and delimiters, CRLF, BOM and blank lines", () => {
    const text = '﻿a,b,c\r\n1,"x, y","say ""hi"""\r\n\r\n2,"multi\nline",3\n';
    expect(parseCsv(text)).toEqual([
      ["a", "b", "c"],
      ["1", "x, y", 'say "hi"'],
      ["2", "multi\nline", "3"],
    ]);
  });

  it("detects semicolon and tab delimiters from the header", () => {
    expect(detectDelimiter("a;b;c")).toBe(";");
    expect(detectDelimiter("a\tb\tc")).toBe("\t");
    expect(detectDelimiter("plain")).toBe(",");
    expect(parseCsv("a;b\n1;2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("keeps trailing empty fields and a last line without a newline", () => {
    expect(parseCsv("a,b\n1,\n2,3")).toEqual([
      ["a", "b"],
      ["1", ""],
      ["2", "3"],
    ]);
  });
});

describe("jsonlToTable", () => {
  it("refuses a file whose rows never agree on a key, instead of building a huge sparse table", () => {
    // The table is dense, so a new key per line grows it quadratically; the width cap applies while collecting headers.
    const lines = Array.from({ length: 3000 }, (_, i) => `{"k${i}":1}`).join("\n");
    const t = jsonlToTable(lines);
    expect(t.headers).toEqual([]);
    expect(t.rows).toEqual([]);
    expect(t.errors).toHaveLength(1);
    expect(t.errors[0]!.message).toMatch(/too many columns/);
  });

  it("unions keys in order of first appearance and reports bad lines by row", () => {
    const t = jsonlToTable('{"a":1}\n\nnot json\n{"b":2,"a":3}\n[1]\n');
    expect(t.headers).toEqual(["a", "b"]);
    expect(t.rows).toEqual([[1, undefined], [undefined, undefined], [3, 2], [undefined, undefined]]);
    expect(t.errors.map((e) => [e.row, e.code])).toEqual([
      [2, "malformed_row"],
      [4, "malformed_row"],
    ]);
  });

  it("accepts a top-level JSON array too", () => {
    const t = jsonlToTable('[{"a":1},{"a":2}]');
    expect(t.headers).toEqual(["a"]);
    expect(t.rows).toEqual([[1], [2]]);
  });
});

describe("mapHeaders", () => {
  it("maps by id, physical name, display (case-insensitively) and sanitized form; drops bookkeeping", () => {
    const m = mapHeaders(["col_booking_ref", "Nightly Rate", "BREAKFAST", "Check-In", "_id", ""], COLUMNS);
    expect(m.errors).toEqual([]);
    expect(m.targets.map((t) => t?.name ?? null)).toEqual(["booking_ref", "nightly_rate", "breakfast", "check_in", null, null]);
    expect(m.ignored).toEqual(["_id", "column 6 (no header)"]);
  });

  it("refuses an unknown header with the table's columns and a hint, instead of dropping it", () => {
    const m = mapHeaders(["bookin_ref"], COLUMNS);
    expect(m.errors).toHaveLength(1);
    expect(m.errors[0]).toMatchObject({ row: 0, column: "bookin_ref", code: "unknown_column", hint: 'did you mean "Booking Ref"?' });
    expect(m.errors[0]!.message).toContain("column_map");
    expect(m.errors[0]!.message).toContain("(booking_ref)");
  });

  it("honours column_map, including null to skip, and refuses a bad map target", () => {
    const m = mapHeaders(["ref", "junk", "rate"], COLUMNS, { ref: "booking_ref", junk: null, rate: "nope" });
    expect(m.targets[0]?.name).toBe("booking_ref");
    expect(m.ignored).toEqual(["junk"]);
    expect(m.errors).toEqual([expect.objectContaining({ column: "rate", code: "unknown_column" })]);
  });

  it("refuses two headers feeding one column", () => {
    const m = mapHeaders(["Booking Ref", "booking_ref"], COLUMNS);
    expect(m.errors).toEqual([expect.objectContaining({ code: "duplicate_column", column: "booking_ref" })]);
    expect(m.targets[1]).toBeNull();
  });
});

describe("coerceCell", () => {
  it("translates what a CSV can carry into what the validator accepts", () => {
    expect(coerceCell("number", "1,234.5", undefined)).toBe(1234.5);
    expect(coerceCell("number", " 42 ", undefined)).toBe(42);
    expect(coerceCell("number", "$1,234.50", undefined)).toBe(1234.5);
    expect(coerceCell("number", "12 €", undefined)).toBe(12);
    expect(coerceCell("number", "(12)", undefined)).toBe(-12);
    expect(coerceCell("number", "1 234,5", undefined)).toBe(1234.5);
    expect(coerceCell("number", "1.234,50", undefined)).toBe(1234.5);
    expect(coerceCell("number", "3,5", undefined)).toBe(3.5);
    expect(coerceCell("number", "n/a", undefined)).toEqual({ invalid: "n/a" });
    expect(coerceCell("checkbox", "Yes", undefined)).toBe(true);
    expect(coerceCell("checkbox", "0", undefined)).toBe(false);
    expect(coerceCell("checkbox", "maybe", undefined)).toEqual({ invalid: "maybe" });
    expect(coerceCell("date", "2026-09-05T10:00:00Z", undefined)).toBe("2026-09-05");
    expect(coerceCell("date", "2026/09/05", undefined)).toBe("2026-09-05");
    expect(coerceCell("date", "1/4/26", undefined)).toBe("2026-01-04");
    expect(coerceCell("date", "1/4/26", undefined, "dmy")).toBe("2026-04-01");
    expect(coerceCell("date", "soon", undefined)).toEqual({ invalid: "soon" });
    expect(coerceCell("single_select", "checked out", ["Checked Out"])).toBe("Checked Out");
    expect(coerceCell("single_select", "CHECKED-OUT", ["Checked Out"])).toBe("Checked Out");
    expect(coerceCell("single_select", "checked_out", ["Checked Out", "Checked-Out"])).toEqual({ invalid: "checked_out" });
    expect(coerceCell("text", 12, undefined)).toBe("12");
    expect(coerceCell("text", "   ", undefined)).toBeNull();
    expect(coerceCell("number", "", undefined)).toBeNull();
  });
});

describe("parseDate", () => {
  it("reads the ways people write a date", () => {
    expect(parseDate("2026-1-4", "mdy")).toBe("2026-01-04");
    expect(parseDate("2026.01.04", "mdy")).toBe("2026-01-04");
    expect(parseDate("20260104", "mdy")).toBe("2026-01-04");
    expect(parseDate("1/4/26", "mdy")).toBe("2026-01-04");
    expect(parseDate("1/4/26", "dmy")).toBe("2026-04-01");
    expect(parseDate("14/4/26", "mdy")).toBe("2026-04-14"); // 14 cannot be a month, whatever the order
    expect(parseDate("04-01-2026", "mdy")).toBe("2026-04-01");
    expect(parseDate("4.1.2026", "dmy")).toBe("2026-01-04");
    expect(parseDate("1/4/99", "mdy")).toBe("1999-01-04");
    expect(parseDate("4 Jan 2026", "mdy")).toBe("2026-01-04");
    expect(parseDate("4th January, 26", "mdy")).toBe("2026-01-04");
    expect(parseDate("Jan 4, 2026", "mdy")).toBe("2026-01-04");
    expect(parseDate("Sept. 30 2026", "mdy")).toBe("2026-09-30");
    expect(parseDate("Foo 4, 2026", "mdy")).toBeNull();
    expect(parseDate("tomorrow", "mdy")).toBeNull();
    // Well-formed nonsense is handed to the validator to refuse by name.
    expect(parseDate("2/31/26", "mdy")).toBe("2026-02-31");
  });
});

describe("inferDateOrder", () => {
  it("lets the column settle the order, and admits when it cannot", () => {
    expect(inferDateOrder(["1/4/26", "25/12/26"], "mdy")).toEqual({ order: "dmy", ambiguous: false });
    expect(inferDateOrder(["1/4/26", "12/25/26"], "dmy")).toEqual({ order: "mdy", ambiguous: false });
    expect(inferDateOrder(["1/4/26", "2/3/26"], "dmy")).toEqual({ order: "dmy", ambiguous: true });
    expect(inferDateOrder(["2026-01-04", null, 3], "mdy")).toEqual({ order: "mdy", ambiguous: false });
  });
});

describe("validateImportRows", () => {
  it("returns the good rows keyed by column_id and one precise error per bad cell", () => {
    const table = csvToTable(
      [
        "booking_ref,nightly_rate,breakfast,check_in,status",
        "B1,120,yes,2026-09-01,Confirmed",
        "B2,n/a,no,2026-13-02,Checked Outt",
        "B3,99.5,,2026-09-03,Cancelled",
      ].join("\n"),
    );
    const out = validateImportRows(table, mapHeaders(table.headers, COLUMNS));
    expect(out.rows_total).toBe(3);
    expect(out.rows_failed).toBe(1);
    expect(out.rows).toEqual([
      { col_booking_ref: "B1", col_nightly_rate: 120, col_breakfast: 1, col_check_in: "2026-09-01", col_status: "Confirmed" },
      { col_booking_ref: "B3", col_nightly_rate: 99.5, col_check_in: "2026-09-03", col_status: "Cancelled" },
    ]);
    expect(out.errors).toEqual([
      { row: 2, column: "nightly_rate", value: "n/a", code: "invalid_number", message: "not a number", hint: expect.stringContaining("digits") },
      { row: 2, column: "check_in", value: "2026-13-02", code: "invalid_date", message: "not a real calendar date" },
      {
        row: 2,
        column: "status",
        value: "Checked Outt",
        code: "invalid_choice",
        message: "not one of the column's choices",
        hint: 'did you mean "Checked Out"?',
      },
    ]);
    expect(out.errors_truncated).toBe(false);
  });

  it("flags a row with more fields than the header, and caps the error list", () => {
    const lines = ["booking_ref,nightly_rate", "B0,1,extra"];
    for (let i = 0; i < DATABASE_IMPORT_MAX_ERRORS + 5; i++) lines.push(`B${i + 1},bad`);
    const table = csvToTable(lines.join("\n"));
    const out = validateImportRows(table, mapHeaders(table.headers, COLUMNS));
    expect(out.errors[0]).toMatchObject({ row: 1, code: "malformed_row" });
    expect(out.rows_failed).toBe(DATABASE_IMPORT_MAX_ERRORS + 6);
    expect(out.errors).toHaveLength(DATABASE_IMPORT_MAX_ERRORS);
    expect(out.errors_truncated).toBe(true);
  });

  it("reads a column's slash dates in the order the column proves, and says when it had to guess", () => {
    const proven = csvToTable("check_in\n1/4/26\n25/12/26\n");
    const a = validateImportRows(proven, mapHeaders(proven.headers, COLUMNS));
    expect(a.rows.map((r) => r.col_check_in)).toEqual(["2026-04-01", "2026-12-25"]);
    expect(a.notes).toEqual([]);

    const guessed = csvToTable("check_in\n1/4/26\n");
    const b = validateImportRows(guessed, mapHeaders(guessed.headers, COLUMNS));
    expect(b.rows.map((r) => r.col_check_in)).toEqual(["2026-01-04"]);
    expect(b.notes).toEqual([expect.stringContaining('Dates like 1/4/26 in "check_in" were read as month/day/year')]);
    expect(b.guessedDateOrder).toBe("mdy");
    expect(a.guessedDateOrder).toBeUndefined();

    const told = validateImportRows(guessed, mapHeaders(guessed.headers, COLUMNS), { dateOrder: "dmy" });
    expect(told.rows.map((r) => r.col_check_in)).toEqual(["2026-04-01"]);
    expect(told.notes).toEqual([]);
    expect(told.guessedDateOrder).toBeUndefined();
  });

  it("caps and counts malformed lines with the cell errors, truncating on the combined total", () => {
    const lines = Array.from({ length: DATABASE_IMPORT_MAX_ERRORS + 10 }, (_, i) => `{"booking_ref": "B${i}"`);
    const table = jsonlToTable(lines.join("\n"));
    expect(table.errors).toHaveLength(DATABASE_IMPORT_MAX_ERRORS + 10);
    const out = validateImportRows(table, mapHeaders(table.headers, COLUMNS));
    expect(out.errors).toHaveLength(DATABASE_IMPORT_MAX_ERRORS);
    expect(out.errors_truncated).toBe(true);
    expect(out.rows_failed).toBe(DATABASE_IMPORT_MAX_ERRORS + 10);

    // A few malformed lines plus cell errors past the cap together.
    const mixed = [
      '{"booking_ref": "A", "nightly_rate": 1}',
      "not json",
      ...Array.from({ length: DATABASE_IMPORT_MAX_ERRORS }, (_, i) => `{"booking_ref": "C${i}", "nightly_rate": "bad"}`),
    ];
    const t2 = jsonlToTable(mixed.join("\n"));
    const out2 = validateImportRows(t2, mapHeaders(t2.headers, COLUMNS));
    expect(out2.errors).toHaveLength(DATABASE_IMPORT_MAX_ERRORS);
    expect(out2.errors[0]).toMatchObject({ row: 2, code: "malformed_row" });
    expect(out2.errors_truncated).toBe(true);
  });

  it("counts a malformed JSON line as a failed row without validating it", () => {
    const table = jsonlToTable('{"booking_ref":"B1"}\nnope\n');
    const out = validateImportRows(table, mapHeaders(table.headers, COLUMNS));
    expect(out.rows_total).toBe(2);
    expect(out.rows_failed).toBe(1);
    expect(out.rows).toEqual([{ col_booking_ref: "B1" }]);
  });
});

describe("nearest", () => {
  it("suggests only a close candidate", () => {
    expect(nearest("Checked-Out", ["Confirmed", "Checked Out"])).toBe("Checked Out");
    expect(nearest("Banana", ["Confirmed", "Checked Out"])).toBeNull();
  });
});

describe("import ids and upload signatures", () => {
  it("carries its expiry in the id", () => {
    const id = newImportId(1_000_000);
    expect(importExpiry(id)).toBe(1_000_000 + DATABASE_IMPORT_TTL_MS);
    expect(importExpiry("imp_zz")).toBeNull();
    expect(importExpiry("run_abc")).toBeNull();
  });

  it("verifies only the exact database + import the signature was minted for", () => {
    const sig = signUpload("secret", "db1", "imp_a_000000000000000000");
    expect(verifyUpload("secret", "db1", "imp_a_000000000000000000", sig)).toBe(true);
    expect(verifyUpload("secret", "db2", "imp_a_000000000000000000", sig)).toBe(false);
    expect(verifyUpload("other", "db1", "imp_a_000000000000000000", sig)).toBe(false);
    expect(verifyUpload("secret", "db1", "imp_a_000000000000000000", null)).toBe(false);
    expect(verifyUpload("secret", "db1", "imp_a_000000000000000000", "nothex")).toBe(false);
  });
});
