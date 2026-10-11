import { describe, expect, it } from "vitest";
import { cellPlainText, csvFileName, rowsToCsv } from "./csv.js";

const HASH = "a".repeat(64);

const COLUMNS = [
  { column_id: "c1", display: "Name, full", type: "text" as const },
  { column_id: "c2", display: "Price", type: "number" as const },
  { column_id: "c3", display: "Paid", type: "checkbox" as const },
  { column_id: "c4", display: "Receipt", type: "files" as const },
];

describe("rowsToCsv", () => {
  it("writes a BOM, CRLF lines, bare numbers, TRUE/FALSE, and file names rather than links", () => {
    const csv = rowsToCsv(COLUMNS, [
      { c1: "抹茶蛋糕", c2: -4.5, c3: 1, c4: `/api/docs/db1/media/${HASH}/receipt%201.pdf\n/api/docs/db1/media/${HASH}/photo.jpg` },
      { c1: "Line one\nline two", c2: null, c3: 0, c4: null },
    ]);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv.slice(1)).toBe(
      ['"Name, full",Price,Paid,Receipt', '抹茶蛋糕,-4.5,TRUE,"receipt 1.pdf, photo.jpg"', '"Line one\nline two",,FALSE,'].join("\r\n") + "\r\n",
    );
  });

  it("neutralises text a spreadsheet would run as a formula", () => {
    expect(rowsToCsv([COLUMNS[0]!], [{ c1: "=HYPERLINK(1)" }, { c1: "-5" }])).toBe("﻿\"Name, full\"\r\n\"'=HYPERLINK(1)\"\r\n\"'-5\"\r\n");
  });
});

describe("cellPlainText", () => {
  it("reads an empty cell as nothing, whatever its type", () => {
    expect(cellPlainText("checkbox", null)).toBe("");
    expect(cellPlainText("files", undefined)).toBe("");
    expect(cellPlainText("date", "2026-10-15")).toBe("2026-10-15");
  });
});

describe("csvFileName", () => {
  it("names the file after the table, without characters a file system refuses", () => {
    expect(csvFileName("Orders 2026")).toBe("Orders 2026.csv");
    expect(csvFileName("Q1/Q2: sales?")).toBe("Q1 Q2 sales.csv");
    expect(csvFileName("..hidden")).toBe("hidden.csv");
    expect(csvFileName("  ")).toBe("Table.csv");
    expect(csvFileName("訂單")).toBe("訂單.csv");
  });
});
