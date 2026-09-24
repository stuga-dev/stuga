import { describe, expect, it } from "vitest";
import type { ColumnSpec, RowRecord } from "@stuga/protocol/databases/types";
import { UNTITLED_ROW, formatRowRef, pageHref, pageStateOf, parseRowRef, rowHref, rowTitle, pageRefOf } from "./row-ref";

const col = (id: string, name: string, type: ColumnSpec["type"], position: number): ColumnSpec => ({
  column_id: id,
  name,
  display: name,
  type,
  position,
  options: null,
});
// Out of position order: the first text column is taken by position.
const columns = [col("c_notes", "notes", "text", 2), col("c_done", "done", "checkbox", 0), col("c_name", "name", "text", 1), col("c_n", "n", "number", 3)];
const row = (cells: Record<string, unknown>): RowRecord => ({ _id: "row_1", _created_at: 0, _updated_at: 0, ...cells }) as RowRecord;

describe("rowTitle", () => {
  it("takes the first text column by position, trimmed", () => {
    expect(rowTitle(columns, row({ c_name: "  Task 11 ", c_notes: "later" }))).toBe("Task 11");
    expect(rowTitle(columns, row({ c_done: 1, c_n: 42, c_name: null, c_notes: "only notes" }))).toBe("only notes");
  });

  it("falls back to a placeholder when no text column holds anything", () => {
    expect(rowTitle(columns, row({ c_done: 1, c_n: 42, c_name: "   ", c_notes: null }))).toBe(UNTITLED_ROW);
    expect(rowTitle(columns, null)).toBe(UNTITLED_ROW);
    expect(rowTitle([], row({ c_name: "ignored: no columns" }))).toBe(UNTITLED_ROW);
  });
});

describe("pageStateOf", () => {
  it("reads the listing's annotations: no page, a live page, a page in the trash", () => {
    expect(pageStateOf(null)).toEqual({ kind: "none" });
    expect(pageStateOf({ _doc_id: null })).toEqual({ kind: "none" });
    expect(pageStateOf({ _doc_id: "" })).toEqual({ kind: "none" });
    expect(pageStateOf({ _doc_id: "d1" })).toEqual({ kind: "live", doc_id: "d1" });
    expect(pageStateOf({ _doc_id: "d1", _doc_trashed: true })).toEqual({ kind: "trashed", doc_id: "d1" });
  });
});

describe("row references", () => {
  const ref = { database_id: "db_A", table_id: "tbl_B", row_id: "row_C" };

  it("round-trips through the page's ?row= value, and refuses a malformed one", () => {
    expect(parseRowRef(formatRowRef(ref))).toEqual(ref);
    expect(parseRowRef(null)).toBeNull();
    expect(parseRowRef("")).toBeNull();
    expect(parseRowRef("db.tbl")).toBeNull();
    expect(parseRowRef("db..row")).toBeNull();
    expect(parseRowRef("a.b.c.d")).toBeNull();
  });

  it("reads the reference off the document's own metadata, and refuses a half-written one", () => {
    expect(pageRefOf({ page_of: "db_A", page_row: "tbl_B.row_C" })).toEqual(ref);
    expect(pageRefOf({ page_of: null, page_row: null })).toBeNull();
    expect(pageRefOf({ page_of: "db_A", page_row: null })).toBeNull();
    expect(pageRefOf({ page_of: "db_A", page_row: "tbl_B" })).toBeNull();
    expect(pageRefOf({ page_of: "db_A", page_row: "tbl_B.row_C.extra" })).toBeNull();
    expect(pageRefOf(undefined)).toBeNull();
  });

  it("builds the page's URL with the way back, and the row's URL beside its table", () => {
    expect(pageHref("doc_P", ref)).toBe("/doc/doc_P?row=db_A.tbl_B.row_C");
    expect(rowHref(ref)).toBe("/doc/db_A?table=tbl_B&row=row_C");
  });
});
