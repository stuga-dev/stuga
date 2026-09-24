import type { DatabaseColumnType } from "@stuga/protocol/databases/types";

export const COLUMN_TYPES: ReadonlyArray<{ value: DatabaseColumnType; label: string }> = [
  { value: "text", label: "Text" },
  { value: "number", label: "Number" },
  { value: "checkbox", label: "Checkbox" },
  { value: "date", label: "Date" },
  { value: "single_select", label: "Single select" },
];

export function columnTypeLabel(type: DatabaseColumnType): string {
  return COLUMN_TYPES.find((t) => t.value === type)?.label ?? type;
}
