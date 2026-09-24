/**
 * The database's tables, the top level of the page: a tab bar of its own above
 * the views, with "+" for a new table and rename/delete per tab.
 */
import { IconButton } from "@astryxdesign/core/IconButton";
import { Pencil, Plus, Table2, Trash2 } from "lucide-react";
import type { TableSchema } from "@stuga/protocol/databases/types";
import { MenuTab } from "./MenuTab";

export function TableTabs({
  tables,
  activeId,
  readOnly,
  onSelect,
  onCreate,
  onRename,
  onDelete,
}: {
  /** Already in position order. */
  tables: TableSchema[];
  activeId: string | null;
  readOnly: boolean;
  onSelect: (tableId: string) => void;
  onCreate: () => void;
  onRename: (table: TableSchema) => void;
  onDelete: (table: TableSchema) => void;
}) {
  return (
    <div className="db-tabs db-tables" role="tablist" aria-label="Tables">
      {tables.map((t) => {
        const label = t.display || "Untitled table";
        return (
          <MenuTab
            key={t.table_id}
            label={label}
            title={label}
            icon={<Table2 size={14} aria-hidden="true" />}
            isActive={t.table_id === activeId}
            menu={
              readOnly
                ? undefined
                : {
                    label: `Actions for table ${label}`,
                    items: [
                      { label: "Rename…", icon: <Pencil size={15} />, onClick: () => onRename(t) },
                      { label: "Delete table…", icon: <Trash2 size={15} />, onClick: () => onDelete(t) },
                    ],
                  }
            }
            onSelect={() => onSelect(t.table_id)}
          />
        );
      })}
      {!readOnly && <IconButton label="New table" variant="ghost" size="sm" icon={<Plus size={15} />} onClick={onCreate} />}
    </div>
  );
}
