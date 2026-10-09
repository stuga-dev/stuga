import { describe, expect, it } from "vitest";
import { validateCellValue, validateSelectChoices } from "@stuga/protocol/databases/cells";
import { DATABASE_MAX_CELL_BYTES, DATABASE_MAX_DISPLAY_LENGTH, DATABASE_MAX_FILES_PER_CELL, DATABASE_MAX_SELECT_CHOICES } from "@stuga/protocol/databases/limits";
import type { ColumnOptions, DatabaseColumnType, RowInputValue } from "@stuga/protocol/databases/types";
import { cellProblem, knownCellProblem } from "./cell-problems";

function reasonOf(type: DatabaseColumnType, value: RowInputValue, options: ColumnOptions | null = null): string {
  const v = validateCellValue(type, options, value);
  if (v.ok) throw new Error(`expected ${type} to refuse ${String(value)}`);
  return v.reason;
}

function choicesReason(choices: unknown): string {
  const v = validateSelectChoices(choices);
  if (v.ok) throw new Error("expected the choices to be refused");
  return v.reason;
}

describe("cellProblem", () => {
  it("maps every reason the cell validator gives to a message", () => {
    const link = `/api/docs/d1/media/${"a".repeat(64)}/file`;
    expect(knownCellProblem(reasonOf("text", 4))).toBe("Expected text.");
    expect(knownCellProblem(reasonOf("text", "x".repeat(DATABASE_MAX_CELL_BYTES + 1)))).toBe(
      `Text too long: the limit is ${DATABASE_MAX_CELL_BYTES.toLocaleString("en")} bytes.`,
    );
    expect(knownCellProblem(reasonOf("number", Number.NaN))).toBe("Enter a number.");
    expect(knownCellProblem(reasonOf("checkbox", 2))).toBe("Expected checked or unchecked.");
    expect(knownCellProblem(reasonOf("date", "4 Jan"))).toBe("Enter a date as YYYY-MM-DD.");
    expect(knownCellProblem(reasonOf("date", "2026-02-31"))).toBe("Not a real calendar date.");
    expect(knownCellProblem(reasonOf("single_select", "Maybe", { choices: ["Yes", "No"] }))).toBe(
      "Not one of the column’s choices: Yes, No.",
    );
    expect(knownCellProblem(reasonOf("files", 1))).toBe("Expected file links, one per line.");
    expect(knownCellProblem(reasonOf("files", "notes.txt"))).toBe("Not a file link: notes.txt. Upload the file to this database first.");
    expect(knownCellProblem(reasonOf("files", Array.from({ length: DATABASE_MAX_FILES_PER_CELL + 1 }, (_, i) => `${link}${i}`).join("\n")))).toBe(
      `Too many files: the limit is ${DATABASE_MAX_FILES_PER_CELL}.`,
    );
  });

  it("maps every reason the choice validator gives to a message", () => {
    expect(knownCellProblem(choicesReason([]))).toBe("Enter at least one choice.");
    expect(knownCellProblem(choicesReason(Array.from({ length: DATABASE_MAX_SELECT_CHOICES + 1 }, (_, i) => `c${i}`)))).toBe(
      `Too many choices: the limit is ${DATABASE_MAX_SELECT_CHOICES}.`,
    );
    expect(knownCellProblem(choicesReason(["a", " "]))).toBe("Choices can’t be empty.");
    expect(knownCellProblem(choicesReason(["x".repeat(DATABASE_MAX_DISPLAY_LENGTH + 1)]))).toBe(
      `A choice is too long: the limit is ${DATABASE_MAX_DISPLAY_LENGTH} characters.`,
    );
    expect(knownCellProblem(choicesReason(["Todo", "Todo"]))).toBe("“Todo” is listed twice.");
  });

  it("shows a reason it does not know as it was given", () => {
    expect(knownCellProblem("something new")).toBeNull();
    expect(cellProblem("something new")).toBe("something new");
  });
});
