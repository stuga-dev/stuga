import type { DatabaseColumnType } from "@stuga/protocol/databases/types";
import { t, type MessageKey } from "../../i18n/i18n";

const TYPES: readonly DatabaseColumnType[] = ["text", "number", "checkbox", "date", "single_select", "files"];

function labelKey(type: DatabaseColumnType): MessageKey | null {
  switch (type) {
    case "text":
      return "database.columnType.text";
    case "number":
      return "database.columnType.number";
    case "checkbox":
      return "database.columnType.checkbox";
    case "date":
      return "database.columnType.date";
    case "single_select":
      return "database.columnType.singleSelect";
    case "files":
      return "database.columnType.files";
    default:
      return null;
  }
}

/** The column types in the order the type picker lists them, labelled in the interface language. */
export function columnTypeOptions(): Array<{ value: DatabaseColumnType; label: string }> {
  return TYPES.map((value) => ({ value, label: columnTypeLabel(value) }));
}

/** A type's name as a person reads it; a type this app does not know shows as its identifier. */
export function columnTypeLabel(type: DatabaseColumnType): string {
  const key = labelKey(type);
  return key ? t(key) : type;
}
