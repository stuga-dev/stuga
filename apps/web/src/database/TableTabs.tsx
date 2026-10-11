/**
 * The database's tables, the top level of the page: a tab bar of its own above
 * the views, with "+" for a new table, and download, rename and delete per tab.
 */
import { IconButton } from "@astryxdesign/core/IconButton";
import { Download, Pencil, Plus, Table2, Trash2 } from "lucide-react";
import type { TableSchema } from "@stuga/protocol/databases/types";
import { MenuTab } from "./MenuTab";
import { t } from "../i18n/i18n";

export function TableTabs({
  tables,
  activeId,
  readOnly,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  onDownload,
}: {
  /** Already in position order. */
  tables: TableSchema[];
  activeId: string | null;
  readOnly: boolean;
  onSelect: (tableId: string) => void;
  onCreate: () => void;
  onRename: (table: TableSchema) => void;
  onDelete: (table: TableSchema) => void;
  onDownload: (table: TableSchema) => void;
}) {
  return (
    <div className="db-tabs db-tables" role="tablist" aria-label={t("database.tables.label")}>
      {tables.map((table) => {
        const label = table.display || t("database.tables.untitled");
        return (
          <MenuTab
            key={table.table_id}
            label={label}
            title={label}
            icon={<Table2 size={14} aria-hidden="true" />}
            isActive={table.table_id === activeId}
            menu={{
              label: t("database.tables.actions", { name: label }),
              items: [
                { label: t("database.export.csv"), icon: <Download size={15} />, onClick: () => onDownload(table) },
                ...(readOnly
                  ? []
                  : [
                      { label: t("common.renameEllipsis"), icon: <Pencil size={15} />, onClick: () => onRename(table) },
                      { label: t("database.tables.delete"), icon: <Trash2 size={15} />, onClick: () => onDelete(table) },
                    ]),
              ],
            }}
            onSelect={() => onSelect(table.table_id)}
          />
        );
      })}
      {!readOnly && <IconButton label={t("database.tables.new")} variant="ghost" size="sm" icon={<Plus size={15} />} onClick={onCreate} />}
    </div>
  );
}
