import type { DatabaseColumnType, RowInputValue } from "@stuga/protocol/databases/types";

/**
 * A typed value as the cell validator takes it: empty is null and a number is
 * parsed. NaN passes through so the validator can say why it was refused.
 */
export function parseFieldInput(type: DatabaseColumnType, raw: string): RowInputValue {
  const trimmed = type === "number" ? raw.trim() : raw;
  if (trimmed === "") return null;
  return type === "number" ? parseFloat(trimmed) : trimmed;
}
