import { describe, expect, it } from "vitest";
import { fileLinks, validateCellValue, validateSelectChoices } from "./cells.js";
import { DATABASE_MAX_CELL_BYTES, DATABASE_MAX_FILES_PER_CELL } from "./limits.js";

describe("validateCellValue", () => {
  it("null always passes, for every type", () => {
    for (const t of ["text", "number", "checkbox", "date", "single_select", "files"] as const) {
      expect(validateCellValue(t, null, null)).toEqual({ ok: true, value: null });
    }
  });

  it("text: strings within the byte cap", () => {
    expect(validateCellValue("text", null, "hello")).toEqual({ ok: true, value: "hello" });
    expect(validateCellValue("text", null, 5).ok).toBe(false);
    // multi-byte aware: 6000 three-byte chars exceed the 16KB cap
    expect(validateCellValue("text", null, "€".repeat(6000)).ok).toBe(false);
    expect(validateCellValue("text", null, "x".repeat(DATABASE_MAX_CELL_BYTES)).ok).toBe(true);
  });

  it("number: finite numbers only", () => {
    expect(validateCellValue("number", null, 3.14)).toEqual({ ok: true, value: 3.14 });
    expect(validateCellValue("number", null, Number.NaN).ok).toBe(false);
    expect(validateCellValue("number", null, Number.POSITIVE_INFINITY).ok).toBe(false);
    expect(validateCellValue("number", null, "3").ok).toBe(false);
  });

  it("checkbox: booleans normalize to 0/1; 0/1 pass through", () => {
    expect(validateCellValue("checkbox", null, true)).toEqual({ ok: true, value: 1 });
    expect(validateCellValue("checkbox", null, false)).toEqual({ ok: true, value: 0 });
    expect(validateCellValue("checkbox", null, 1)).toEqual({ ok: true, value: 1 });
    expect(validateCellValue("checkbox", null, 2).ok).toBe(false);
    expect(validateCellValue("checkbox", null, "true").ok).toBe(false);
  });

  it("files: one link per line to a stored file with its name, blank lines and repeats dropped", () => {
    const a = `/api/docs/db_1/media/${"a".repeat(64)}/Q3%20brief.pdf`;
    const b = `/api/docs/db_1/media/${"b".repeat(64)}/photo.png`;
    expect(validateCellValue("files", null, `${a}\n\n ${b} \n${a}`)).toEqual({ ok: true, value: `${a}\n${b}` });
    expect(validateCellValue("files", null, "\n")).toEqual({ ok: true, value: null });
    expect(fileLinks(`${a}\n${b}`).map((f) => [f.docId, f.name])).toEqual([["db_1", "Q3 brief.pdf"], ["db_1", "photo.png"]]);
    for (const bad of ["Q3 brief.pdf", `/api/docs/db_1/media/${"a".repeat(64)}`, "https://example.com/a.pdf", `/api/docs/db_1/media/${"a".repeat(64)}/%E0`, 3]) {
      expect(validateCellValue("files", null, bad).ok).toBe(false);
    }
    const many = Array.from({ length: DATABASE_MAX_FILES_PER_CELL + 1 }, (_, i) => `/api/docs/d/media/${i.toString(16).padStart(64, "0")}/f`).join("\n");
    expect(validateCellValue("files", null, many).ok).toBe(false);
  });

  it("date: real ISO calendar dates only", () => {
    expect(validateCellValue("date", null, "2026-08-12")).toEqual({ ok: true, value: "2026-08-12" });
    expect(validateCellValue("date", null, "2026-02-31").ok).toBe(false); // well-formed nonsense
    expect(validateCellValue("date", null, "12/08/2026").ok).toBe(false);
    expect(validateCellValue("date", null, "2026-8-1").ok).toBe(false);
  });

  it("single_select: must be one of the choices", () => {
    const opts = { choices: ["Todo", "Doing", "Done"] };
    expect(validateCellValue("single_select", opts, "Doing")).toEqual({ ok: true, value: "Doing" });
    expect(validateCellValue("single_select", opts, "Blocked").ok).toBe(false);
    expect(validateCellValue("single_select", null, "anything").ok).toBe(false);
  });
});

describe("validateSelectChoices", () => {
  it("accepts a clean list and rejects empties, dups, oversizes", () => {
    expect(validateSelectChoices(["A", "B"])).toEqual({ ok: true, choices: ["A", "B"] });
    expect(validateSelectChoices([]).ok).toBe(false);
    expect(validateSelectChoices(["A", "A"]).ok).toBe(false);
    expect(validateSelectChoices(["A", ""]).ok).toBe(false);
    expect(validateSelectChoices(Array.from({ length: 51 }, (_, i) => `c${i}`)).ok).toBe(false);
    expect(validateSelectChoices("not an array").ok).toBe(false);
  });
});
