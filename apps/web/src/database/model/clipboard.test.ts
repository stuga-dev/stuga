import { describe, expect, it } from "vitest";
import type { ColumnSpec, RowRecord } from "@stuga/protocol/databases/types";
import { copiedText, isBlockPaste, parseClipboard, planPaste } from "./clipboard";

const col = (column_id: string, type: ColumnSpec["type"], choices?: string[]): ColumnSpec => ({
  column_id,
  name: column_id,
  display: column_id,
  type,
  position: 0,
  options: choices ? { choices } : null,
});
const row = (id: string): RowRecord => ({ _id: id, _created_at: 0, _updated_at: 0 }) as RowRecord;

describe("parseClipboard", () => {
  it("reads a spreadsheet block, its trailing line break included", () => {
    expect(parseClipboard("Matcha cake\t抹茶蛋糕\r\nChocolate tart\t巧克力挞\r\n")).toEqual([
      ["Matcha cake", "抹茶蛋糕"],
      ["Chocolate tart", "巧克力挞"],
    ]);
  });

  it("keeps quoted tabs, line breaks and quotes inside one field", () => {
    expect(parseClipboard('"two\nlines"\t"say ""hi"""\nplain\t"a\tb"')).toEqual([
      ["two\nlines", 'say "hi"'],
      ["plain", "a\tb"],
    ]);
  });

  it("tells a block from one value", () => {
    expect(isBlockPaste("one value\n")).toBe(false);
    expect(isBlockPaste("a\tb")).toBe(true);
    expect(isBlockPaste("a\nb")).toBe(true);
  });
});

describe("planPaste", () => {
  const columns = [col("name", "text"), col("qty", "number"), col("done", "checkbox"), col("kind", "single_select", ["Cake", "Bread"])];

  it("fills right and down from the cell, adding rows past the last", () => {
    const plan = planPaste({
      block: parseClipboard("12\tyes\tcake\n4,50\tno\tBread\n7\tx\t"),
      rows: [row("r1"), row("r2")],
      columns,
      rowId: "r1",
      columnId: "qty",
      canAddRows: true,
      locale: "en",
    });
    expect(plan.updates).toEqual([
      { _id: "r1", values: { qty: 12, done: 1, kind: "Cake" } },
      { _id: "r2", values: { qty: 4.5, done: 0, kind: "Bread" } },
    ]);
    expect(plan.inserts).toEqual([{ qty: 7, done: 1, kind: null }]);
    expect(plan).toMatchObject({ rows: 3, columns: 3, skipped: 0 });
  });

  it("leaves out what does not fit its column, and columns past the last", () => {
    const plan = planPaste({
      block: [["abc", "maybe", "Pie", "extra"]],
      rows: [row("r1")],
      columns,
      rowId: "r1",
      columnId: "qty",
      canAddRows: true,
      locale: "en",
    });
    expect(plan.updates).toEqual([]);
    expect(plan).toMatchObject({ rows: 1, columns: 3, skipped: 3 });
  });

  it("adds no rows while more rows wait to be loaded", () => {
    const plan = planPaste({ block: [["a"], ["b"]], rows: [row("r1")], columns, rowId: "r1", columnId: "name", canAddRows: false, locale: "en" });
    expect(plan.updates).toEqual([{ _id: "r1", values: { name: "a" } }]);
    expect(plan.inserts).toEqual([]);
    expect(plan.rows).toBe(1);
  });
});

describe("copiedText", () => {
  it("copies what pastes back as the same value", () => {
    expect(copiedText(col("qty", "number"), 1234.5, "de")).toBe("1234,5");
    expect(copiedText(col("done", "checkbox"), 1)).toBe("TRUE");
    expect(copiedText(col("name", "text"), null)).toBe("");
  });
});
