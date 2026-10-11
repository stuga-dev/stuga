import { describe, expect, it } from "vitest";
import type { ColumnSpec } from "@stuga/protocol/databases/types";
import { checkCell, parseFieldInput } from "./field-input";

const col = (type: ColumnSpec["type"]): ColumnSpec => ({ column_id: "c", name: "c", display: "C", type, position: 0, options: null });

describe("parseFieldInput", () => {
  it("reads empty input as null", () => {
    expect(parseFieldInput("text", "")).toEqual({ ok: true, value: null });
    expect(parseFieldInput("number", "  ")).toEqual({ ok: true, value: null });
  });

  it("parses numbers and refuses what is not one, with the reason", () => {
    expect(parseFieldInput("number", " 4.5 ", "en")).toEqual({ ok: true, value: 4.5 });
    expect(parseFieldInput("number", "abc", "en")).toEqual({ ok: false, problem: "Enter a number." });
    expect(parseFieldInput("number", "12345678901234567890", "en")).toEqual({ ok: false, problem: "That number is too large to store exactly." });
  });

  it("keeps text as typed, surrounding spaces included", () => {
    expect(parseFieldInput("text", " hi ")).toEqual({ ok: true, value: " hi " });
    expect(parseFieldInput("date", "2026-09-16")).toEqual({ ok: true, value: "2026-09-16" });
  });
});

describe("checkCell", () => {
  it("refuses a date outside the pickable years in the date input's words", () => {
    expect(checkCell(col("date"), { ok: true, value: "0006-02-02" })).toEqual({ ok: false, problem: "Pick a valid date." });
    expect(checkCell(col("date"), { ok: true, value: "2101-01-01" })).toEqual({ ok: false, problem: "Pick a valid date." });
    expect(checkCell(col("date"), { ok: true, value: "2026-02-31" })).toEqual({ ok: false, problem: "Pick a valid date." });
    expect(checkCell(col("date"), { ok: true, value: "2026-10-15" })).toEqual({ ok: true, value: "2026-10-15" });
  });

  it("passes a parse problem through and stores a checkbox as 0/1", () => {
    expect(checkCell(col("number"), { ok: false, problem: "Enter a number." })).toEqual({ ok: false, problem: "Enter a number." });
    expect(checkCell(col("checkbox"), { ok: true, value: true })).toEqual({ ok: true, value: 1 });
  });
});
