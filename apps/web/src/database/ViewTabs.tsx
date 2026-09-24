/**
 * A table's views, drawn as pills so they read as a level below the table tabs:
 * the implicit "All rows", each saved view, and "+" to save the current shape as one.
 */
import { IconButton } from "@astryxdesign/core/IconButton";
import { Pencil, Plus, Trash2 } from "lucide-react";
import type { ViewSpec } from "@stuga/protocol/databases/types";
import { MenuTab } from "./MenuTab";

export function ViewTabs({
  views,
  activeId,
  readOnly,
  onSelect,
  onCreate,
  onRename,
  onDelete,
}: {
  views: ViewSpec[];
  /** null is the implicit "All rows". */
  activeId: string | null;
  readOnly: boolean;
  onSelect: (viewId: string | null) => void;
  onCreate: () => void;
  onRename: (view: ViewSpec) => void;
  onDelete: (view: ViewSpec) => void;
}) {
  return (
    <div className="db-tabs db-views" role="tablist" aria-label="Views">
      <MenuTab
        label="All rows"
        title="Every row, unfiltered"
        isActive={activeId === null}
        onSelect={() => onSelect(null)}
      />
      {views.map((v) => {
        const label = v.name || "Untitled view";
        return (
          <MenuTab
            key={v.view_id}
            label={label}
            title={label}
                isActive={v.view_id === activeId}
            menu={
              readOnly
                ? undefined
                : {
                    label: `Actions for view ${label}`,
                    items: [
                      { label: "Rename…", icon: <Pencil size={15} />, onClick: () => onRename(v) },
                      { label: "Delete view…", icon: <Trash2 size={15} />, onClick: () => onDelete(v) },
                    ],
                  }
            }
            onSelect={() => onSelect(v.view_id)}
          />
        );
      })}
      {!readOnly && <IconButton label="Save current settings as a new view" variant="ghost" size="sm" icon={<Plus size={15} />} onClick={onCreate} />}
    </div>
  );
}
