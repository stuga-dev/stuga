/**
 * A column header: the label is the sort button, cycling none, ascending,
 * descending. Every menu item acts on this column; appending lives in the
 * header row's trailing "+", since a new column always lands at the far right.
 */
import { MoreMenu } from "@astryxdesign/core/MoreMenu";
import { ArrowDown, ArrowUp, EyeOff, Info, Pencil, Trash2, Type } from "lucide-react";
import type { ColumnSpec } from "@stuga/protocol/databases/types";
import { columnTypeLabel } from "./model/column-types";

interface ColumnMenuProps {
  column: ColumnSpec;
  sortDir: "asc" | "desc" | null;
  readOnly: boolean;
  onSortCycle: () => void;
  /** A view setting, not a schema change, so offered to readers too. */
  onHide: () => void;
  onRename: () => void;
  onChangeType: () => void;
  onDescribe: () => void;
  onDelete: () => void;
}

export function ColumnMenu({
  column,
  sortDir: dir,
  readOnly,
  onSortCycle,
  onHide,
  onRename,
  onChangeType,
  onDescribe,
  onDelete,
}: ColumnMenuProps) {
  // A native title, not a Tooltip: the trigger beside it is a popover, and the two fight (see AccountMenu).
  const head = `${column.display} (${columnTypeLabel(column.type)}) — click to sort`;
  const description = column.description?.trim();
  return (
    <span className="db-col-head">
      <button
        className="db-col-head__sort"
        onClick={onSortCycle}
        title={description ? `${head}\n\n${description}` : head}
        aria-label={`Sort by ${column.display}`}
      >
        <span className="db-col-head__label">{column.display}</span>
        {dir === "asc" && <ArrowUp size={13} aria-label="sorted ascending" />}
        {dir === "desc" && <ArrowDown size={13} aria-label="sorted descending" />}
      </button>
      <span className="db-col-head__menu">
        <MoreMenu
          label={`Actions for column ${column.display}`}
          variant="ghost"
          size="sm"
          alignment="end"
          items={[
            { label: "Hide in this view", icon: <EyeOff size={15} />, onClick: onHide },
            ...(readOnly
              ? []
              : [
                  { label: "Rename…", icon: <Pencil size={15} />, onClick: onRename },
                  { label: "Change type…", icon: <Type size={15} />, onClick: onChangeType },
                  { label: "Describe…", icon: <Info size={15} />, onClick: onDescribe },
                  { label: "Delete column…", icon: <Trash2 size={15} />, onClick: onDelete },
                ]),
          ]}
        />
      </span>
    </span>
  );
}
