/**
 * A column header: the label is the sort button, cycling none, ascending,
 * descending. Every menu item acts on this column; appending lives in the
 * header row's trailing "+", since a new column always lands at the far right.
 */
import { MoreMenu } from "@astryxdesign/core/MoreMenu";
import { ArrowDown, ArrowUp, EyeOff, Info, Pencil, Percent, Trash2, Type } from "lucide-react";
import type { ColumnSpec } from "@stuga/protocol/databases/types";
import { columnTypeLabel } from "./model/column-types";
import { ColumnTypeIcon } from "./ColumnTypeIcon";
import { t } from "../i18n/i18n";

interface ColumnMenuProps {
  column: ColumnSpec;
  sortDir: "asc" | "desc" | null;
  readOnly: boolean;
  onSortCycle: () => void;
  /** A view setting, not a schema change, so offered to readers too. */
  onHide: () => void;
  onRename: () => void;
  onChangeType: () => void;
  /** Number columns only. */
  onNumberFormat: () => void;
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
  onNumberFormat,
  onDescribe,
  onDelete,
}: ColumnMenuProps) {
  // A native title, not a Tooltip: the trigger beside it is a popover, and the two fight (see AccountMenu).
  const head = t("database.column.sortTitle", { name: column.display, type: columnTypeLabel(column.type) });
  const description = column.description?.trim();
  return (
    <span className="db-col-head">
      <button
        className="db-col-head__sort"
        onClick={onSortCycle}
        title={description ? `${head}\n\n${description}` : head}
        aria-label={t("database.column.sortBy", { name: column.display })}
      >
        <ColumnTypeIcon type={column.type} />
        <span className="db-col-head__label">{column.display}</span>
        {dir === "asc" && <ArrowUp size={13} aria-label={t("database.column.sortedAscending")} />}
        {dir === "desc" && <ArrowDown size={13} aria-label={t("database.column.sortedDescending")} />}
      </button>
      <span className="db-col-head__menu">
        <MoreMenu
          label={t("database.column.actions", { name: column.display })}
          variant="ghost"
          size="sm"
          alignment="end"
          items={[
            { label: t("database.column.hide"), icon: <EyeOff size={15} />, onClick: onHide },
            ...(readOnly
              ? []
              : [
                  { label: t("common.renameEllipsis"), icon: <Pencil size={15} />, onClick: onRename },
                  { label: t("database.column.changeTypeEllipsis"), icon: <Type size={15} />, onClick: onChangeType },
                  ...(column.type === "number" ? [{ label: t("database.column.numberFormatEllipsis"), icon: <Percent size={15} />, onClick: onNumberFormat }] : []),
                  { label: t("database.column.describe"), icon: <Info size={15} />, onClick: onDescribe },
                  { label: t("database.column.deleteEllipsis"), icon: <Trash2 size={15} />, onClick: onDelete },
                ]),
          ]}
        />
      </span>
    </span>
  );
}
