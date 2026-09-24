import { DATABASE_MAX_CELL_BYTES, DATABASE_MAX_DISPLAY_LENGTH, DATABASE_MAX_SELECT_CHOICES } from "./limits.js";
import type { ColumnOptions, DatabaseColumnType, RowInputValue, RowValue } from "./types.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type CellValidation = { ok: true; value: RowValue } | { ok: false; reason: string };

/**
 * Validate a cell against its column type and return the stored value
 * (checkbox booleans → 0/1). Null always passes: every user column is nullable.
 */
export function validateCellValue(
  type: DatabaseColumnType,
  options: ColumnOptions | null | undefined,
  value: RowInputValue,
): CellValidation {
  if (value === null || value === undefined) return { ok: true, value: null };
  switch (type) {
    case "text": {
      if (typeof value !== "string") return { ok: false, reason: "expected a string" };
      if (utf8Length(value) > DATABASE_MAX_CELL_BYTES) {
        return { ok: false, reason: `text too long (max ${DATABASE_MAX_CELL_BYTES} bytes)` };
      }
      return { ok: true, value };
    }
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return { ok: false, reason: "expected a finite number" };
      }
      return { ok: true, value };
    }
    case "checkbox": {
      if (typeof value === "boolean") return { ok: true, value: value ? 1 : 0 };
      if (value === 0 || value === 1) return { ok: true, value };
      return { ok: false, reason: "expected true/false" };
    }
    case "date": {
      if (typeof value !== "string" || !DATE_RE.test(value)) {
        return { ok: false, reason: "expected YYYY-MM-DD" };
      }
      // Round-trip through UTC to reject dates like 2026-02-31.
      const d = new Date(`${value}T00:00:00Z`);
      if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) {
        return { ok: false, reason: "not a real calendar date" };
      }
      return { ok: true, value };
    }
    case "single_select": {
      if (typeof value !== "string") return { ok: false, reason: "expected a string" };
      const choices = options?.choices ?? [];
      if (!choices.includes(value)) {
        return { ok: false, reason: `not one of the column's choices (${choices.join(", ")})` };
      }
      return { ok: true, value };
    }
  }
}

/** Validate a single_select choice list. */
export function validateSelectChoices(choices: unknown): { ok: true; choices: string[] } | { ok: false; reason: string } {
  if (!Array.isArray(choices) || choices.length === 0) {
    return { ok: false, reason: "single_select needs a non-empty choices array" };
  }
  if (choices.length > DATABASE_MAX_SELECT_CHOICES) {
    return { ok: false, reason: `too many choices (max ${DATABASE_MAX_SELECT_CHOICES})` };
  }
  const seen = new Set<string>();
  for (const c of choices) {
    if (typeof c !== "string" || c.trim() === "") return { ok: false, reason: "choices must be non-empty strings" };
    if (c.length > DATABASE_MAX_DISPLAY_LENGTH) return { ok: false, reason: `choice too long (max ${DATABASE_MAX_DISPLAY_LENGTH} chars)` };
    if (seen.has(c)) return { ok: false, reason: `duplicate choice: ${c}` };
    seen.add(c);
  }
  return { ok: true, choices: choices as string[] };
}

function utf8Length(s: string): number {
  return new TextEncoder().encode(s).length;
}
