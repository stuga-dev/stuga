/**
 * The library's list: a sortable table of folders and documents, shared by
 * Browse, Favorites, Shared with me and Trash. Sorting is the server's, since a
 * listing is capped and sorting one page here would mislabel it; the only local
 * order is folders above documents.
 */
import { useMemo, useRef } from "react";
import { Table, proportional, pixel, type TableColumn, type TablePlugin, type TableSortState } from "@astryxdesign/core/Table";
import { useTableSortable } from "@astryxdesign/core/Table";
import { MoreMenu } from "@astryxdesign/core/MoreMenu";
import { Avatar } from "@astryxdesign/core/Avatar";
import { Badge } from "@astryxdesign/core/Badge";
import { HStack } from "@astryxdesign/core/HStack";
import { Link } from "@astryxdesign/core/Link";
import { Folder as FolderIcon, FileText, Database, Star, ChevronRight } from "lucide-react";
import { getAlias } from "../lib/http/client";
import { useElementWidth } from "../lib/use-element-width";
import type { DocSummary, Folder } from "../api";
import { relativeTime, absoluteTime } from "../lib/format";
import { principalName, useUserNames } from "../state/identity";
import { DocStateMarks } from "./doc-state";
import { movableTo, type LibraryDragItem } from "./move-items";
import { pageParentLabel, usePageParents } from "../database/model/row-ref";
import { useIsNarrow } from "../ui/narrow";

/** A type alias, not an interface: Astryx Table requires rows with an implicit index signature. */
export type LibraryRow = {
  /** folder_id or doc_id. */
  id: string;
  kind: "folder" | "doc";
  title: string;
  updated_at: string;
  created_at: string;
  /** Full principal. */
  owner: string;
  /** Set on a document row. */
  doc?: DocSummary;
  /** Set on a folder row. */
  folder?: Folder;
  /** Trash only: the folder path the item was deleted from. */
  location?: string;
  /** Trash only: days until permanent deletion. */
  expiresInDays?: number;
};

/** The one place a document becomes a row, so the mirrored fields cannot drift from `doc`. */
export function docRow(d: DocSummary): LibraryRow {
  return {
    id: d.doc_id,
    kind: "doc",
    title: d.title,
    updated_at: d.updated_at,
    created_at: d.created_at,
    owner: d.owner,
    doc: d,
  };
}

type LibraryColumn = "name" | "updated" | "owner" | "location" | "expires" | "star" | "actions";
type LibrarySortKey = "title" | "updated_at" | "created_at";
export interface LibrarySort {
  key: LibrarySortKey;
  direction: "ascending" | "descending";
}

interface DocTableDnd {
  /** Dragging a selected row drags the whole selection. */
  dragging: LibraryDragItem[] | null;
  onDragItem: (items: LibraryDragItem[] | null) => void;
  onDrop: (items: LibraryDragItem[], destFolderId: string | null) => void;
  /** Folders enclosing this view, outermost first. */
  ancestors: string[];
  /** Where a drop on the background lands; null is the top level. */
  currentFolderId: string | null;
  /** The row id a drag hovers, or "background". */
  dropTarget: string | "background" | null;
  onDropTarget: (t: string | "background" | null) => void;
}

type SelectMode = "replace" | "toggle" | "range";

type RowMenuLeaf = { label: string; icon?: React.ReactNode; onClick: () => void };
/** Astryx MoreMenu sections hold leaves only. */
type RowMenuItem = RowMenuLeaf | { type: "divider" } | { type: "section"; title: string; items: RowMenuLeaf[] };

interface DocTableProps {
  rows: LibraryRow[];
  /** What `rows` was narrowed from on the client; the Owner column is decided from it. */
  unfilteredRows?: LibraryRow[];
  /** Omitted, rows cannot be selected. */
  selectedIds?: ReadonlySet<string>;
  /** The next selection, resolved against display order; `primary` is the clicked row, null when cleared. */
  onSelectionChange?: (ids: string[], primary: LibraryRow | null) => void;
  favorites?: ReadonlySet<string>;
  sort: LibrarySort;
  onSortChange: (next: LibrarySort) => void;
  columns?: LibraryColumn[];
  /** A plain click on the document name, a double click or Enter on a row, or one tap on a phone. */
  onActivate?: (row: LibraryRow) => void;
  onToggleFavorite?: (docId: string) => void;
  rowActions: (row: LibraryRow) => RowMenuItem[];
  /** Omitted, rows are not draggable. */
  dnd?: DocTableDnd;
  emptyState?: React.ReactNode;
}

/** Our own MIME type, so a drag from outside the app is ignored. */
export const DND_MIME = "application/x-stuga-item";

const DEFAULT_COLUMNS: LibraryColumn[] = ["name", "updated", "owner", "star", "actions"];
const NONE: ReadonlySet<string> = new Set();

/** The row is the table's one tab stop and opens its ⋯ menu on Shift+F10; MoreMenu has no tabIndex prop. */
const outOfTabOrder = (el: HTMLButtonElement | null) => el?.setAttribute("tabindex", "-1");

export function DocTable({
  rows,
  unfilteredRows = rows,
  selectedIds = NONE,
  onSelectionChange,
  favorites = NONE,
  sort,
  onSortChange,
  columns = DEFAULT_COLUMNS,
  onActivate,
  onToggleFavorite,
  rowActions,
  dnd,
  emptyState,
}: DocTableProps) {
  const ownerPrincipals = useMemo(() => rows.map((r) => r.owner), [rows]);
  const isNarrow = useIsNarrow();
  useUserNames(ownerPrincipals);
  usePageParents(rows.map((r) => r.doc?.page_of));

  // An Owner column that only ever names the reader says nothing. A null alias keeps the column.
  const me = getAlias();
  const allRowsAreMine = unfilteredRows.length > 0 && me !== null && unfilteredRows.every((r) => r.owner === `user:${me}`);

  const ordered = useMemo(() => {
    const folders = rows.filter((r) => r.kind === "folder");
    const docs = rows.filter((r) => r.kind === "doc");
    return [...folders, ...docs];
  }, [rows]);

  const sortPlugin = useTableSortable<LibraryRow, LibrarySortKey>({
    sort: [{ sortKey: sort.key, direction: sort.direction }],
    onSortChange: (next: TableSortState<LibrarySortKey>) => {
      const first = next[0];
      onSortChange(first ? { key: first.sortKey, direction: first.direction } : { key: "updated_at", direction: "descending" });
    },
    allowUnsortedState: false,
  });

  // The shift-range anchor; a ref, since it never affects rendering.
  const anchorRef = useRef<string | null>(null);

  function selectFrom(row: LibraryRow, mode: SelectMode) {
    if (!onSelectionChange) return;
    if (mode === "toggle") {
      const next = new Set(selectedIds);
      if (next.has(row.id)) next.delete(row.id);
      else next.add(row.id);
      anchorRef.current = row.id;
      onSelectionChange([...next], next.size === 1 ? (ordered.find((r) => next.has(r.id)) ?? null) : null);
      return;
    }
    if (mode === "range") {
      // A refetch remounts the table and loses the ref, while the selection survives in the parent.
      const anchor =
        anchorRef.current ??
        (selectedIds.size > 0 ? (ordered.find((r) => selectedIds.has(r.id))?.id ?? row.id) : row.id);
      const a = ordered.findIndex((r) => r.id === anchor);
      const b = ordered.findIndex((r) => r.id === row.id);
      if (a === -1 || b === -1) return selectFrom(row, "replace");
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      const next = ordered.slice(lo, hi + 1).map((r) => r.id);
      onSelectionChange(next, next.length === 1 ? row : null);
      return;
    }
    anchorRef.current = row.id;
    onSelectionChange([row.id], row);
  }

  const tabStopId = useMemo(() => ordered.find((r) => selectedIds.has(r.id))?.id ?? null, [ordered, selectedIds]);

  const interaction = useRowInteraction({
    selectedIds,
    tabStopId,
    onSelectRow: selectFrom,
    onActivate,
    openOnPointerClick: isNarrow,
    onToggleFavorite,
    dnd,
    // No selection change on dragstart: mounting the detail rail mid-drag moves the drop target away.
    dragItemsFor: (row) => {
      const dragged = selectedIds.has(row.id) ? ordered.filter((r) => selectedIds.has(r.id)) : [row];
      return dragged.map((r) => ({ kind: r.kind, id: r.id, title: r.title, parentId: dnd?.currentFolderId ?? null }));
    },
  });

  const allColumns: Record<LibraryColumn, TableColumn<LibraryRow>> = {
    name: {
      key: "name",
      header: "Name",
      width: proportional(3),
      sortable: { sortKey: "title" },
      renderCell: (r) => (
        <HStack gap={2} vAlign="center">
          <span className="doc-table__glyph" data-kind={r.kind} data-doc-type={r.doc?.doc_type ?? ""}>
            {r.kind === "folder" ? <FolderIcon size={16} /> : r.doc?.doc_type === "database" ? <Database size={16} /> : <FileText size={16} />}
          </span>
          <span className="doc-table__title" data-col="name">
            {r.kind === "doc" && onActivate && !r.doc?.trashed ? (
              <Link
                href={`/doc/${r.id}`}
                color="inherit"
                isStandalone
                // The row is the roving tab stop; Enter on it opens the same document.
                tabIndex={-1}
                onClick={(e) => {
                  // Middle-click never reaches onClick, so it still opens a tab through the href.
                  e.preventDefault();
                  // A modified click reaches the row and selects as a click on any other cell does.
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                  e.stopPropagation();
                  onActivate(r);
                }}
              >
                {r.title || "Untitled"}
              </Link>
            ) : (
              r.title || (r.kind === "folder" ? "Untitled folder" : "Untitled")
            )}
          </span>
          {r.doc?.page_of && (
            <span className="doc-table__page-mark" title={`Page of a row in ${pageParentLabel(r.doc.page_of)}`} aria-label={`Page of a row in ${pageParentLabel(r.doc.page_of)}`}>
              <Database size={12} />
              <span className="doc-table__page-mark-name">{pageParentLabel(r.doc.page_of)}</span>
            </span>
          )}
          <DocStateMarks doc={r.doc} />
          {r.kind === "folder" && <ChevronRight size={14} className="doc-table__chev" />}
        </HStack>
      ),
    },
    updated: {
      key: "updated",
      header: "Last edited",
      // Fits the longest relative form ("Jun 24, 2025").
      width: pixel(120),
      sortable: { sortKey: "updated_at" },
      renderCell: (r) => (
        <span className="doc-table__muted" data-col="updated" title={absoluteTime(r.updated_at)}>
          {relativeTime(r.updated_at)}
        </span>
      ),
    },
    owner: {
      key: "owner",
      header: "Owner",
      width: pixel(190),
      // Not sortable: the server has no owner sort.
      renderCell: (r) => {
        const name = principalName(r.owner);
        return (
          <HStack gap={2} vAlign="center">
            <Avatar name={name} size="xsm" tooltip={false} />
            <span className="doc-table__muted" data-col="owner" title={r.owner}>
              {name}
            </span>
          </HStack>
        );
      },
    },
    location: {
      key: "location",
      header: "Location",
      width: proportional(1),
      renderCell: (r) => (
        <span className="doc-table__muted" data-col="location">
          {r.location ?? "—"}
        </span>
      ),
    },
    expires: {
      key: "expires",
      header: "Deletes in",
      width: pixel(140),
      renderCell: (r) => {
        if (r.expiresInDays === undefined) return <span className="doc-table__muted">—</span>;
        const left = r.expiresInDays === 1 ? "1 day" : `${r.expiresInDays} days`;
        return r.expiresInDays <= 3 ? (
          <Badge variant="warning" label={r.expiresInDays <= 0 ? "Deletes soon" : left} />
        ) : (
          <span className="doc-table__muted" data-col="expires">{left}</span>
        );
      },
    },
    star: {
      key: "star",
      header: "",
      // A cell's 12px padding each side leaves a 40px column too narrow for the button, which then truncates to an ellipsis.
      width: pixel(48),
      resizable: false,
      renderCell: (r) => {
        if (r.kind !== "doc" || !onToggleFavorite) return null;
        const on = favorites.has(r.id);
        return (
          <button
            className={`doc-table__star${on ? " doc-table__star--on" : ""}`}
            // The row is the table's one tab stop; Space on it toggles the favorite.
            tabIndex={-1}
            // The row owns click and double click.
            onClick={(e) => {
              e.stopPropagation();
              onToggleFavorite(r.id);
            }}
            onDoubleClick={(e) => e.stopPropagation()}
            title={on ? "Remove from favorites" : "Add to favorites"}
            aria-pressed={on}
          >
            <Star size={15} fill={on ? "currentColor" : "none"} />
          </button>
        );
      },
    },
    actions: {
      key: "actions",
      header: "",
      width: pixel(52),
      resizable: false,
      renderCell: (r) => {
        const items = rowActions(r);
        if (items.length === 0) return null;
        return (
          <span className="doc-table__more" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
            <MoreMenu ref={outOfTabOrder} label={`Actions for ${r.title || "Untitled"}`} variant="ghost" size="sm" alignment="end" items={items} />
          </span>
        );
      },
    },
  };

  // Not memoised: the cells close over the caller's current handlers.
  const { ref: wrapRef, width: wrapWidth } = useElementWidth();
  let keep = columns;
  if (allRowsAreMine) keep = keep.filter((c) => c !== "owner");
  // Shed metadata before Name is squeezed: Owner first as the widest, Last edited only when Name would drop under ~260px.
  if (wrapWidth > 0) {
    if (wrapWidth < 720) keep = keep.filter((c) => c !== "owner");
    if (wrapWidth < 460) keep = keep.filter((c) => c !== "updated" && c !== "location");
  }
  const cols = keep.map((c) => allColumns[c]);

  return (
    <div
      ref={wrapRef}
      className={`doc-table${dnd?.dropTarget === "background" ? " doc-table--drop" : ""}`}
      // The background is a drop target for the current folder, the way back out of a subfolder.
      onDragOver={dnd ? (e) => acceptDrag(e, dnd, dnd.currentFolderId, "background") : undefined}
      onDragLeave={
        dnd
          ? (e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) dnd.onDropTarget(null);
            }
          : undefined
      }
      onDrop={dnd ? (e) => handleDrop(e, dnd, dnd.currentFolderId) : undefined}
      onClick={(e) => {
        if (e.target === e.currentTarget && selectedIds.size > 0) onSelectionChange?.([], null);
      }}
      onKeyDown={(e) => {
        // An Escape that closes a row's ⋯ menu also bubbles here, already consumed; it only closes the menu.
        if (e.key === "Escape" && selectedIds.size > 0 && !e.defaultPrevented) {
          e.stopPropagation();
          onSelectionChange?.([], null);
        }
      }}
    >
      <Table
        data={ordered}
        columns={cols}
        idKey="id"
        density="balanced"
        dividers="rows"
        hasHover
        textOverflow="truncate"
        plugins={{ sort: sortPlugin, interaction }}
        emptyState={emptyState}
      />
    </div>
  );
}

function droppable(dnd: DocTableDnd, destId: string | null): LibraryDragItem[] {
  return movableTo(dnd.dragging ?? [], destId, dnd.ancestors);
}

/** Accepted when any dragged item would move; the others stay put on drop. */
function acceptDrag(e: React.DragEvent, dnd: DocTableDnd, destId: string | null, target: string | "background") {
  if (!e.dataTransfer.types.includes(DND_MIME) || droppable(dnd, destId).length === 0) return;
  e.preventDefault();
  e.stopPropagation();
  e.dataTransfer.dropEffect = "move";
  dnd.onDropTarget(target);
}

function handleDrop(e: React.DragEvent, dnd: DocTableDnd, destId: string | null) {
  if (!e.dataTransfer.types.includes(DND_MIME)) return;
  e.preventDefault();
  e.stopPropagation();
  dnd.onDropTarget(null);
  const items = droppable(dnd, destId);
  if (items.length > 0) dnd.onDrop(items, destId);
  dnd.onDragItem(null);
}

/** Row behaviour as a Table plugin, since Astryx Table has no row click. Focus is roving: one row is tabbable. */
function useRowInteraction(cfg: {
  selectedIds: ReadonlySet<string>;
  tabStopId: string | null;
  onSelectRow: (row: LibraryRow, mode: SelectMode) => void;
  onActivate?: (row: LibraryRow) => void;
  openOnPointerClick: boolean;
  onToggleFavorite?: (docId: string) => void;
  dnd?: DocTableDnd;
  dragItemsFor: (row: LibraryRow) => LibraryDragItem[];
}): TablePlugin<LibraryRow> {
  const { selectedIds, tabStopId, onSelectRow, onActivate, openOnPointerClick, onToggleFavorite, dnd, dragItemsFor } = cfg;
  return {
    transformBodyRow: (props, item, index) => {
      const isSelected = selectedIds.has(item.id);
      const isDragging = !!dnd?.dragging?.some((d) => d.id === item.id);
      const isDropTarget = dnd?.dropTarget === item.id;
      return {
        ...props,
        htmlProps: {
          ...props.htmlProps,
          className: ["doc-row", isDragging ? "is-dragging" : "", isDropTarget ? "is-drop-target" : ""].filter(Boolean).join(" "),
          // aria-selected is only valid inside a grid; aria-current marks the one row whose details show.
          "aria-current": isSelected && selectedIds.size === 1 ? "true" : undefined,
          "data-selected": isSelected ? "true" : undefined,
          "data-row-kind": item.kind,
          tabIndex: (tabStopId ? item.id === tabStopId : index === 0) ? 0 : -1,
          onClick: (e: React.MouseEvent) => {
            // A phone tap opens the item directly. Keyboard arrow navigation dispatches a click
            // with detail=0, so it still moves selection instead of opening each row.
            if (openOnPointerClick && onActivate && e.detail > 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
              onActivate(item);
              return;
            }
            onSelectRow(item, e.metaKey || e.ctrlKey ? "toggle" : e.shiftKey ? "range" : "replace");
          },
          onDoubleClick: (e: React.MouseEvent) => {
            if ((e.target as Element).closest("a, button, [role='button']")) return;
            onActivate?.(item);
          },
          onKeyDown: (e: React.KeyboardEvent<HTMLTableRowElement>) => {
            // Only the row's own keys: a button and the open ⋯ menu, whose keys reach here through
            // its portal, keep theirs. The name link, which a click can focus, keeps only Enter.
            const target = e.target as Element;
            const fromLink = target.tagName === "A" && e.currentTarget.contains(target);
            if (target !== e.currentTarget && !(fromLink && e.key !== "Enter")) return;
            if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
              const menu = e.currentTarget.querySelector<HTMLButtonElement>(".doc-table__more button");
              if (!menu) return;
              e.preventDefault();
              // A click without a pointer opens the menu with its first item focused.
              menu.click();
            } else if (e.key === "Enter") {
              e.preventDefault();
              onActivate?.(item);
            } else if (e.key === " ") {
              if (item.kind !== "doc" || !onToggleFavorite) return;
              e.preventDefault();
              onToggleFavorite(item.id);
            } else if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
              e.preventDefault();
              const row = e.currentTarget;
              const body = row.parentElement;
              const target = (
                e.key === "ArrowDown"
                  ? row.nextElementSibling
                  : e.key === "ArrowUp"
                    ? row.previousElementSibling
                    : e.key === "Home"
                      ? body?.firstElementChild
                      : body?.lastElementChild
              ) as HTMLElement | null;
              if (!target) return;
              target.focus();
              // A dispatched click, not .click(), which drops the modifiers that Shift-extends the run.
              target.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: e.shiftKey }));
            }
          },
          ...(dnd
            ? {
                draggable: true,
                onDragStart: (e: React.DragEvent) => {
                  const items = dragItemsFor(item);
                  e.dataTransfer.setData(DND_MIME, items.map((i) => i.id).join(","));
                  e.dataTransfer.effectAllowed = "move";
                  dnd.onDragItem(items);
                },
                onDragEnd: () => {
                  dnd.onDragItem(null);
                  dnd.onDropTarget(null);
                },
                onDragOver: (e: React.DragEvent) => {
                  if (item.kind === "folder") acceptDrag(e, dnd, item.id, item.id);
                },
                onDragLeave: (e: React.DragEvent) => {
                  if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null) && dnd.dropTarget === item.id) {
                    dnd.onDropTarget(null);
                  }
                },
                onDrop: (e: React.DragEvent) => {
                  if (item.kind === "folder") handleDrop(e, dnd, item.id);
                },
              }
            : {}),
        },
      };
    },
  };
}
