/**
 * A table's views, drawn as pills so they read as a level below the table tabs:
 * the implicit "All rows", each saved view, and "+" to save the current shape as one.
 */
import { IconButton } from "@astryxdesign/core/IconButton";
import { Pencil, Plus, Trash2 } from "lucide-react";
import type { ViewSpec } from "@stuga/protocol/databases/types";
import { MenuTab } from "./MenuTab";
import { t } from "../i18n/i18n";

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
    <div className="db-tabs db-views" role="tablist" aria-label={t("database.views.label")}>
      <MenuTab
        label={t("database.views.allRows")}
        title={t("database.views.allRowsTitle")}
        isActive={activeId === null}
        onSelect={() => onSelect(null)}
      />
      {views.map((v) => {
        const label = v.name || t("database.views.untitled");
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
                    label: t("database.views.actions", { name: label }),
                    items: [
                      { label: t("common.renameEllipsis"), icon: <Pencil size={15} />, onClick: () => onRename(v) },
                      { label: t("database.views.delete"), icon: <Trash2 size={15} />, onClick: () => onDelete(v) },
                    ],
                  }
            }
            onSelect={() => onSelect(v.view_id)}
          />
        );
      })}
      {!readOnly && <IconButton label={t("database.views.saveNew")} variant="ghost" size="sm" icon={<Plus size={15} />} onClick={onCreate} />}
    </div>
  );
}
