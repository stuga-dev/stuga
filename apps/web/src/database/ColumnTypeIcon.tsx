import { Calendar, CircleChevronDown, Hash, LetterText, Paperclip, SquareCheck } from "lucide-react";
import type { DatabaseColumnType } from "@stuga/protocol/databases/types";

/** A column type's mark, beside its name in the header. Decorative: the header's title names the type. */
export function ColumnTypeIcon({ type, size = 13 }: { type: DatabaseColumnType; size?: number }) {
  const props = { size, "aria-hidden": true, className: "db-col-head__type" } as const;
  switch (type) {
    case "number":
      return <Hash {...props} />;
    case "checkbox":
      return <SquareCheck {...props} />;
    case "date":
      return <Calendar {...props} />;
    case "single_select":
      return <CircleChevronDown {...props} />;
    case "files":
      return <Paperclip {...props} />;
    default:
      return <LetterText {...props} />;
  }
}
