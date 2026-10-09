/**
 * The library's filter row. Owner filters on the server, so it narrows the
 * capped listing itself; type and name only narrow the rows already loaded.
 */
import { Button } from "@astryxdesign/core/Button";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Check, Filter, ListFilter, User, X } from "lucide-react";
import { t, type MessageKey } from "../i18n/i18n";

export type OwnerFilter = "anyone" | "me";
export type TypeFilter = "all" | "prose" | "database";

interface LibraryToolbarProps {
  ownerFilter: OwnerFilter;
  onOwnerFilterChange: (v: OwnerFilter) => void;
  typeFilter: TypeFilter;
  onTypeFilterChange: (v: TypeFilter) => void;
  nameFilter: string;
  onNameFilterChange: (v: string) => void;
}

const OWNER_LABEL: Record<OwnerFilter, MessageKey> = { anyone: "library.toolbar.ownerAnyone", me: "library.toolbar.ownerMe" };
const TYPE_LABEL: Record<TypeFilter, MessageKey> = {
  all: "library.toolbar.typeAll",
  prose: "library.toolbar.typeDocuments",
  database: "library.toolbar.typeDatabases",
};

export function LibraryToolbar({
  ownerFilter,
  onOwnerFilterChange,
  typeFilter,
  onTypeFilterChange,
  nameFilter,
  onNameFilterChange,
}: LibraryToolbarProps) {
  return (
    <div className="library-toolbar">
      <div className="library-toolbar__filter">
        <TextInput
          label={t("library.toolbar.filterLabel")}
          isLabelHidden
          size="sm"
          value={nameFilter}
          onChange={onNameFilterChange}
          placeholder={t("library.toolbar.filterPlaceholder")}
          startIcon={<ListFilter size={15} />}
          hasClear
        />
      </div>
      <DropdownMenu
        button={{ label: t(OWNER_LABEL[ownerFilter]), variant: "ghost", size: "sm", icon: <User size={15} /> }}
        menuWidth={180}
        placement="below"
        hasChevron
        items={(["anyone", "me"] as OwnerFilter[]).map((v) => ({
          label: t(OWNER_LABEL[v]),
          icon: ownerFilter === v ? <Check size={15} /> : undefined,
          onClick: () => onOwnerFilterChange(v),
        }))}
      />
      <DropdownMenu
        button={{ label: t(TYPE_LABEL[typeFilter]), variant: "ghost", size: "sm", icon: <Filter size={15} /> }}
        menuWidth={180}
        placement="below"
        hasChevron
        items={(["all", "prose", "database"] as TypeFilter[]).map((v) => ({
          label: t(TYPE_LABEL[v]),
          icon: typeFilter === v ? <Check size={15} /> : undefined,
          onClick: () => onTypeFilterChange(v),
        }))}
      />
    </div>
  );
}

/** A plain button, or a button that opens a menu. */
type SelectionAction =
  | { label: string; icon?: React.ReactNode; onClick: () => void }
  | {
      label: string;
      icon?: React.ReactNode;
      items: Array<{ label: string; icon?: React.ReactNode; onClick: () => void } | { type: "divider" }>;
    };

interface LibrarySelectionBarProps {
  count: number;
  onClear: () => void;
  actions: SelectionAction[];
  isBusy?: boolean;
}

/**
 * Takes the filter row's place while several items are selected. The count is
 * live, since rows of a plain table cannot announce their own selection.
 */
export function LibrarySelectionBar({ count, onClear, actions, isBusy }: LibrarySelectionBarProps) {
  return (
    <div className="library-toolbar library-toolbar--selection">
      <IconButton label={t("library.toolbar.clearSelection")} variant="ghost" size="sm" icon={<X size={16} />} onClick={onClear} />
      <Text weight="semibold" aria-live="polite">
        {t("library.toolbar.selected", { count })}
      </Text>
      <span className="library-toolbar__spacer" />
      {actions.map((a) =>
        "items" in a ? (
          <DropdownMenu
            key={a.label}
            button={{ label: a.label, variant: "secondary", size: "sm", icon: a.icon, isDisabled: isBusy }}
            menuWidth={260}
            placement="below"
            alignment="end"
            hasChevron
            items={a.items}
          />
        ) : (
          <Button
            key={a.label}
            label={a.label}
            icon={a.icon}
            variant="secondary"
            size="sm"
            isDisabled={isBusy}
            onClick={a.onClick}
          />
        ),
      )}
    </div>
  );
}
