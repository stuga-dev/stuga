import type { ReactNode } from "react";
import { MoreMenu } from "@astryxdesign/core/MoreMenu";

/**
 * A tab with an action menu beside its label, drawn as one pill. A TabList tab
 * is a single button, so a menu inside it would nest buttons.
 */
export function MenuTab({
  label,
  title,
  icon,
  isActive,
  menu,
  onSelect,
}: {
  label: string;
  title: string;
  icon?: ReactNode;
  isActive: boolean;
  /** Omitted for a read-only viewer. */
  menu?: { label: string; items: Array<{ label: string; icon: ReactNode; onClick: () => void }> };
  onSelect: () => void;
}) {
  return (
    <div className={`db-tab${isActive ? " db-tab--active" : ""}`}>
      <button className="db-tab__btn" role="tab" aria-selected={isActive} onClick={onSelect} title={title}>
        {icon}
        <span className="db-tab__label">{label}</span>
      </button>
      {menu && (
        <span className="db-tab__menu">
          <MoreMenu label={menu.label} variant="ghost" size="sm" alignment="end" items={menu.items} />
        </span>
      )}
    </div>
  );
}
