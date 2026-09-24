/**
 * The library's browse view: the current folder as a sortable table, a
 * folder heading with a breadcrumb trail, and a detail rail for the selected
 * document. Items can be dropped on a folder row, on the table background (this
 * folder) or on a breadcrumb segment (any ancestor); "Move to folder…" is the
 * keyboard path to the same moves.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Section } from "@astryxdesign/core/Section";
import { useAppShellMobile } from "@astryxdesign/core/AppShell";
import type { LayerAlignment } from "@astryxdesign/core/Layer";
import { Breadcrumbs, BreadcrumbItem } from "@astryxdesign/core/Breadcrumbs";
import { VStack } from "@astryxdesign/core/VStack";
import { HStack } from "@astryxdesign/core/HStack";
import { Heading } from "@astryxdesign/core/Text";
import { Button } from "@astryxdesign/core/Button";
import { Banner } from "@astryxdesign/core/Banner";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { useToast } from "@astryxdesign/core/Toast";
import { Folder as FolderIcon, FileText, FolderInput, Trash2, Pencil, Share2, Files, Library } from "lucide-react";
import { LIBRARY_LIST_CAP, TRASH_RETENTION_DAYS } from "@stuga/protocol/domain/limits";
import { Docs, Folders, type DocSummary } from "../api";
import { errorMessage, getAlias } from "../lib/http/client";
import { useFavorites } from "../state/favorites";
import { PromptDialog } from "../ui/PromptDialog";
import { ResizeHandle, usePanelWidth } from "../ui/ResizeHandle";
import { DocDetail } from "./DocDetail";
import { DocTable, docRow, DND_MIME, type LibraryRow, type LibrarySort } from "./DocTable";
import { useDocStateMenu } from "./doc-state";
import { shareKindOfDoc, type ShareKind } from "./ShareDialog";
import { LibraryToolbar, LibrarySelectionBar, type OwnerFilter, type TypeFilter } from "./LibraryToolbar";
import { useLibrarySelection } from "./use-library-selection";
import { useCollectionsMenu } from "./use-collections-menu";
import { useInstructionsDialog } from "./use-instructions-dialog";
import { useIsCompact, useIsNarrow } from "../ui/narrow";
import { LibraryCreateMenu } from "./LibraryCreateMenu";
import {
  moveEach,
  moveReport,
  movableTo,
  trashEach,
  trashReport,
  type LibraryDragItem,
  type LibraryItemRef,
} from "./move-items";

interface FileExplorerProps {
  /** Bumped by the parent to force a reload. */
  refreshKey: number;
  /** Bumped when the parent's move dialog finished; the moved items leave the selection. */
  movedAway: number;
  /** Open folder ids, outermost first. */
  path: string[];
  /** The previewed document, from the URL. */
  selectedDocId: string | null;
  onPathChange: (path: string[]) => void;
  onSelectDoc: (docId: string | null) => void;
  /** Server-side, and owned by the URL so it survives a reload. */
  sort: LibrarySort;
  onSortChange: (next: LibrarySort) => void;
  onMoveDoc: (docId: string) => void;
  onMoveFolder: (folderId: string) => void;
  onMoveMany: (items: LibraryItemRef[]) => void;
  onShareFolder: (folderId: string) => void;
  onShareDoc: (docId: string, kind: ShareKind) => void;
  /** Creation actions, offered beside the heading while the side nav is hidden and in empty states. */
  onCreateDoc: () => void;
  onCreateDatabase: () => void;
  onCreateFolder: () => void;
  onImport: () => void;
}

export function FileExplorer({
  refreshKey,
  movedAway,
  path,
  selectedDocId,
  onPathChange,
  onSelectDoc,
  sort,
  onSortChange,
  onMoveDoc,
  onMoveFolder,
  onMoveMany,
  onShareFolder,
  onShareDoc,
  onCreateDoc,
  onCreateDatabase,
  onCreateFolder,
  onImport,
}: FileExplorerProps) {
  const [renaming, setRenaming] = useState<{ kind: "folder" | "doc"; id: string; title: string } | null>(null);
  const [deleting, setDeleting] = useState<{ id: string; title: string; counts: { docs: number; folders: number } | null } | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [dragging, setDragging] = useState<LibraryDragItem[] | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [dropTarget, setDropTarget] = useState<string | "background" | null>(null);
  const [localKey, setLocalKey] = useState(0);
  const [crumbTitles, setCrumbTitles] = useState<Record<string, string>>({});
  const [rows, setRows] = useState<LibraryRow[] | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ok" | "error">("loading");
  const [atCap, setAtCap] = useState(false);

  const [ownerFilter, setOwnerFilter] = useState<OwnerFilter>("anyone");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [nameFilter, setNameFilter] = useState("");
  const [railWidth, setRailWidth] = usePanelWidth("stuga_library_detail_w", 320, 300, 400);

  const favorites = useFavorites(refreshKey);
  const nav = useNavigate();
  const isCompact = useIsCompact();
  // A phone opens a document on a tap, and details there would cover the whole list, so it shows none.
  const isNarrow = useIsNarrow();
  // AppShell's own breakpoint: below it the side nav, and its New, sit behind the menu button.
  const { isMobile: sideNavHidden } = useAppShellMobile();
  const toast = useToast();
  const stateMenu = useDocStateMenu();

  const currentFolder = path.at(-1) ?? null;
  const bump = useCallback(() => setLocalKey((k) => k + 1), []);

  const { selectedIds, previewDoc, setPreviewDoc, railVisible, select, forget } = useLibrarySelection({
    selectedDocId,
    onSelectDoc,
    rows,
    loaded: loadState === "ok",
    movedAway,
  });
  const collectionsMenu = useCollectionsMenu({ refreshKey: refreshKey + localKey, setBusy: setBulkBusy });
  const instructions = useInstructionsDialog();

  /** A state change shows on the row and in the rail together. */
  const applyDocState = useCallback(
    (next: DocSummary) => {
      setRows((cur) => cur?.map((r) => (r.id === next.doc_id ? docRow(next) : r)) ?? cur);
      setPreviewDoc((cur) => (cur?.doc_id === next.doc_id ? next : cur));
    },
    [setPreviewDoc],
  );

  // The URL carries folder ids only; one call resolves the whole chain's titles.
  useEffect(() => {
    if (!currentFolder) return;
    let live = true;
    Folders.ancestors(currentFolder)
      .then((r) => {
        if (!live) return;
        setCrumbTitles((cur) => {
          const next = { ...cur };
          for (const f of r.ancestors) next[f.folder_id] = f.title;
          return next;
        });
      })
      // A crumb without its title shows "…" and still navigates.
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [currentFolder, refreshKey]);

  useEffect(() => {
    let live = true;
    setLoadState("loading");
    const alias = ownerFilter === "me" ? getAlias() : null;
    const owner = alias ? `user:${alias}` : undefined;
    const order = sort.direction === "ascending" ? "asc" : "desc";
    Promise.all([
      Folders.list(currentFolder, { sort: sort.key, order }).then((r) => r.folders),
      Docs.list(false, currentFolder, { sort: sort.key, order, owner }).then((r) => r.docs),
    ])
      .then(([folders, docs]) => {
        if (!live) return;
        setRows([
          ...folders.map(
            (f): LibraryRow => ({
              id: f.folder_id,
              kind: "folder",
              title: f.title,
              updated_at: f.updated_at,
              created_at: f.created_at,
              owner: f.owner,
              folder: f,
            }),
          ),
          ...docs.map(docRow),
        ]);
        setAtCap(docs.length >= LIBRARY_LIST_CAP);
        setLoadState("ok");
      })
      .catch(() => live && setLoadState("error"));
    return () => {
      live = false;
    };
  }, [currentFolder, refreshKey, localKey, sort.key, sort.direction, ownerFilter]);

  /** The name and type filters narrow what the server returned. */
  const visibleRows = useMemo(() => {
    const q = nameFilter.trim().toLowerCase();
    return (rows ?? []).filter((r) => {
      if (q && !r.title.toLowerCase().includes(q)) return false;
      // Folders stay visible under a type filter: they are how you reach the matches.
      return typeFilter === "all" || r.kind === "folder" || r.doc?.doc_type === typeFilter;
    });
  }, [rows, nameFilter, typeFilter]);

  const selectedRows = useMemo(() => (rows ?? []).filter((r) => selectedIds.has(r.id)), [rows, selectedIds]);
  const refsOf = (items: LibraryRow[]): LibraryItemRef[] => items.map((r) => ({ kind: r.kind, id: r.id }));

  function activateRow(row: LibraryRow) {
    if (row.kind === "folder") onPathChange([...path, row.id]);
    else nav(`/doc/${row.id}`);
  }

  async function toggleFav(docId: string) {
    if (!(await favorites.toggle(docId))) {
      toast({ body: "Couldn’t update that favorite.", type: "error" });
    }
  }

  async function doRename(title: string) {
    if (!renaming) return;
    const { kind, id } = renaming;
    try {
      if (kind === "folder") {
        await Folders.rename(id, title);
      } else {
        await Docs.rename(id, title);
        setPreviewDoc((cur) => (cur?.doc_id === id ? { ...cur, title } : cur));
      }
    } catch (e) {
      toast({ body: errorMessage(e, "Couldn’t rename that item."), type: "error" });
    }
    bump();
  }

  async function trashRow(row: LibraryRow) {
    try {
      await Docs.trash(row.id, true);
    } catch (e) {
      toast({ body: errorMessage(e, `Couldn’t move “${row.title || "Untitled"}” to Trash.`), type: "error" });
      return;
    }
    forget(new Set([row.id]));
    bump();
  }

  /** Opens the confirmation at once and fills in what the folder holds when that arrives. */
  function askDelete(id: string, title: string) {
    setDeleting({ id, title, counts: null });
    Folders.contents(id)
      .then((counts) => setDeleting((cur) => (cur?.id === id ? { ...cur, counts } : cur)))
      .catch(() => setDeleting((cur) => (cur?.id === id ? { ...cur, counts: { docs: 0, folders: 0 } } : cur)));
  }

  async function doDelete() {
    if (!deleting) return;
    const { id, title } = deleting;
    setDeleteBusy(true);
    try {
      const res = await Folders.remove(id);
      setDeleting(null);
      const at = path.indexOf(id);
      if (at !== -1) onPathChange(path.slice(0, at));
      toast({
        body:
          res.docs_trashed > 0
            ? `Deleted “${title}”. ${res.docs_trashed} document${res.docs_trashed === 1 ? "" : "s"} moved to Trash.`
            : `Deleted “${title}”.`,
        type: "info",
      });
      bump();
    } catch (e) {
      setDeleting(null);
      toast({ body: errorMessage(e, `Couldn’t delete “${title}”.`), type: "error" });
    } finally {
      setDeleteBusy(false);
    }
  }

  /** The server re-checks every move; `ancestors` are the folders enclosing the destination. */
  const moveItems = useCallback(
    async (items: LibraryDragItem[], destId: string | null, ancestors: string[]) => {
      const legal = movableTo(items, destId, ancestors);
      if (legal.length === 0) return;
      setBulkBusy(true);
      const failures = await moveEach(legal, destId);
      setBulkBusy(false);
      const report = moveReport(legal.length, failures);
      if (report) toast(report);
      // Only this batch: the user may have selected something else while it ran.
      forget(new Set(legal.map((i) => i.id)));
      bump();
    },
    [bump, toast, forget],
  );

  const trashSelected = useCallback(async () => {
    const ids = selectedRows.filter((r) => r.kind === "doc").map((r) => r.id);
    if (ids.length === 0) return;
    setBulkBusy(true);
    const failed = await trashEach(ids);
    setBulkBusy(false);
    toast(trashReport(ids.length, failed));
    forget(new Set(ids));
    bump();
  }, [selectedRows, bump, toast, forget]);

  function rowActions(row: LibraryRow) {
    const addToCollection = { type: "section" as const, title: "Add to collection", items: collectionsMenu.menuItems(refsOf([row])) };
    const instructionsItem = (kind: "folder" | "document" | "database") => instructions.item({ kind, id: row.id, title: row.title });
    if (row.kind === "folder") {
      return [
        { label: "Share…", icon: <Share2 size={15} />, onClick: () => onShareFolder(row.id) },
        { label: "Rename…", icon: <Pencil size={15} />, onClick: () => setRenaming({ kind: "folder", id: row.id, title: row.title }) },
        instructionsItem("folder"),
        { label: "Move to folder…", icon: <FolderInput size={15} />, onClick: () => onMoveFolder(row.id) },
        addToCollection,
        { label: "Delete folder…", icon: <Trash2 size={15} />, onClick: () => askDelete(row.id, row.title) },
      ];
    }
    return [
      { label: "Share…", icon: <Share2 size={15} />, onClick: () => onShareDoc(row.id, shareKindOfDoc(row.doc)) },
      { label: "Rename…", icon: <Pencil size={15} />, onClick: () => setRenaming({ kind: "doc", id: row.id, title: row.title }) },
      { label: "Move to folder…", icon: <FolderInput size={15} />, onClick: () => onMoveDoc(row.id) },
      ...(row.doc
        ? [
            {
              type: "section" as const,
              title: row.doc.doc_type === "database" ? "Database" : "Document",
              items: [
                ...stateMenu(row.doc, applyDocState),
                instructionsItem(row.doc.doc_type === "database" ? "database" : "document"),
              ],
            },
          ]
        : []),
      addToCollection,
      { label: "Move to Trash", icon: <Trash2 size={15} />, onClick: () => void trashRow(row) },
    ];
  }

  /** A breadcrumb segment accepts drops; `index` is -1 for the root. */
  function crumbDropProps(index: number) {
    const destId = index < 0 ? null : (path[index] ?? null);
    const ancestors = index < 0 ? [] : path.slice(0, index);
    const key = `crumb:${destId ?? "root"}`;
    // A drop is accepted when any dragged item would move; the rest stay put.
    const legal = () => movableTo(dragging ?? [], destId, ancestors).length > 0;
    return {
      className: dropTarget === key ? "crumb-drop" : undefined,
      onDragOver: (e: React.DragEvent) => {
        if (!e.dataTransfer.types.includes(DND_MIME) || !legal()) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move" as const;
        setDropTarget(key);
      },
      onDragLeave: () => setDropTarget((cur) => (cur === key ? null : cur)),
      onDrop: (e: React.DragEvent) => {
        if (!e.dataTransfer.types.includes(DND_MIME)) return;
        e.preventDefault();
        e.stopPropagation();
        setDropTarget(null);
        if (dragging && legal()) void moveItems(dragging, destId, ancestors);
        setDragging(null);
      },
    };
  }

  const filtering = nameFilter.trim() !== "" || typeFilter !== "all" || ownerFilter !== "anyone";
  const createMenu = (alignment?: LayerAlignment) => (
    <LibraryCreateMenu
      onNewDoc={onCreateDoc}
      onNewDatabase={onCreateDatabase}
      onNewFolder={onCreateFolder}
      onImport={onImport}
      alignment={alignment}
    />
  );
  // While the side nav is hidden, New sits beside the heading and an empty state repeats none.
  const emptyActions = sideNavHidden ? undefined : createMenu();
  const emptyState = filtering ? (
    <EmptyState
      title="No matches"
      description="No item here matches the current filters."
      icon={<FileText size={26} />}
      actions={
        <Button
          label="Clear filters"
          variant="secondary"
          size="sm"
          onClick={() => {
            setNameFilter("");
            setTypeFilter("all");
            setOwnerFilter("anyone");
          }}
        />
      }
    />
  ) : currentFolder === null ? (
    <EmptyState
      title="No documents yet"
      description="Create your first document to start writing. You can bring in existing notes later."
      icon={<FileText size={26} />}
      actions={emptyActions}
    />
  ) : (
    <EmptyState
      title="Empty folder"
      description="Create a document here, or move one from another folder."
      icon={<FolderIcon size={26} />}
      actions={emptyActions}
    />
  );

  return (
    <div className="explorer">
      <HStack className="explorer-heading" gap={2} vAlign="center" justify="between" wrap="wrap">
        <VStack gap={1}>
          {path.length > 0 && (
            <Breadcrumbs label="Folder path" variant="supporting">
              <BreadcrumbItem onClick={() => onPathChange([])} startIcon={<Files size={14} />} {...crumbDropProps(-1)}>
                All documents
              </BreadcrumbItem>
              {path.map((id, i) => (
                <BreadcrumbItem key={id} isCurrent={i === path.length - 1} onClick={() => onPathChange(path.slice(0, i + 1))} {...crumbDropProps(i)}>
                  {crumbTitles[id] ?? "…"}
                </BreadcrumbItem>
              ))}
            </Breadcrumbs>
          )}
          <Heading level={1} maxLines={1}>
            {currentFolder ? (crumbTitles[currentFolder] ?? "Folder") : "All documents"}
          </Heading>
        </VStack>
        {sideNavHidden && createMenu("end")}
      </HStack>

      {selectedIds.size > 1 ? (
        <LibrarySelectionBar
          count={selectedIds.size}
          isBusy={bulkBusy}
          onClear={() => select([], null)}
          actions={[
            { label: "Add to collection…", icon: <Library size={15} />, items: collectionsMenu.menuItems(refsOf(selectedRows)) },
            { label: "Move to folder…", icon: <FolderInput size={15} />, onClick: () => onMoveMany(refsOf(selectedRows)) },
            ...(selectedRows.some((r) => r.kind === "doc")
              ? [{ label: "Move to Trash", icon: <Trash2 size={15} />, onClick: () => void trashSelected() }]
              : []),
          ]}
        />
      ) : (
        <LibraryToolbar
          ownerFilter={ownerFilter}
          onOwnerFilterChange={setOwnerFilter}
          typeFilter={typeFilter}
          onTypeFilterChange={setTypeFilter}
          nameFilter={nameFilter}
          onNameFilterChange={setNameFilter}
        />
      )}

      <div className="explorer-body">
        <div className="explorer-main">
          {atCap && (
            <Banner
              status="info"
              title={`Showing the first ${LIBRARY_LIST_CAP} documents`}
              description="Narrow this down with the filters, or open a folder."
            />
          )}
          {loadState === "error" ? (
            <div className="explorer-center">
              <EmptyState
                title="Couldn’t load"
                description="This folder’s contents failed to load."
                icon={<FolderIcon size={26} />}
                actions={<Button label="Retry" variant="secondary" size="sm" onClick={bump} />}
              />
            </div>
          ) : loadState === "loading" ? (
            <TableSkeleton />
          ) : (
            <DocTable
              rows={visibleRows}
              // The Owner column is decided from the whole listing, so it does not flicker as the filters narrow it.
              unfilteredRows={rows ?? []}
              selectedIds={selectedIds}
              onSelectionChange={select}
              favorites={favorites.ids}
              sort={sort}
              onSortChange={onSortChange}
              onActivate={activateRow}
              onToggleFavorite={toggleFav}
              rowActions={rowActions}
              emptyState={emptyState}
              dnd={{
                dragging,
                onDragItem: setDragging,
                onDrop: (items, destId) => void moveItems(items, destId, path),
                ancestors: path,
                currentFolderId: currentFolder,
                dropTarget,
                onDropTarget: setDropTarget,
              }}
            />
          )}
        </div>

        {railVisible && previewDoc && !isNarrow && (
          <>
            {/* At compact widths the stylesheet lays the rail over the table at a fixed width. */}
            {!isCompact && <ResizeHandle width={railWidth} onResize={setRailWidth} dir={-1} label="Resize details" />}
            <Section
              padding={0}
              variant="muted"
              dividers={isCompact ? undefined : ["start"]}
              className="library-detail"
              style={isCompact ? undefined : { width: railWidth, flex: `0 0 ${railWidth}px` }}
            >
              <DocDetail
                doc={previewDoc}
                isFavorite={favorites.ids.has(previewDoc.doc_id)}
                onToggleFavorite={() => void toggleFav(previewDoc.doc_id)}
                onOpen={() => nav(`/doc/${previewDoc.doc_id}`)}
                onShare={() => onShareDoc(previewDoc.doc_id, shareKindOfDoc(previewDoc))}
                onClose={() => onSelectDoc(null)}
                folderTitle={previewDoc.parent_id ? (crumbTitles[previewDoc.parent_id] ?? null) : null}
                onStateChange={applyDocState}
              />
            </Section>
          </>
        )}
      </div>

      <PromptDialog
        isOpen={renaming !== null}
        title={renaming?.kind === "folder" ? "Rename folder" : "Rename document"}
        label={renaming?.kind === "folder" ? "Folder name" : "Document title"}
        initialValue={renaming?.title ?? ""}
        submitLabel="Rename"
        onSubmit={doRename}
        onClose={() => setRenaming(null)}
      />
      {collectionsMenu.dialog}
      {instructions.dialog}
      <AlertDialog
        isOpen={deleting !== null}
        onOpenChange={(o) => !o && !deleteBusy && setDeleting(null)}
        title={`Delete “${deleting?.title || "Untitled folder"}”?`}
        description={describeDelete(deleting?.counts ?? null)}
        actionLabel="Delete folder"
        isActionLoading={deleteBusy}
        onAction={doDelete}
      />
    </div>
  );
}

function describeDelete(counts: { docs: number; folders: number } | null): string {
  if (!counts) return "Checking what’s inside this folder…";
  const parts: string[] = [];
  if (counts.docs > 0) parts.push(`${counts.docs} document${counts.docs === 1 ? "" : "s"}`);
  if (counts.folders > 0) parts.push(`${counts.folders} subfolder${counts.folders === 1 ? "" : "s"}`);
  if (parts.length === 0) return "This folder is empty. The folder will be deleted.";
  return `Contains ${parts.join(" and ")}. ${
    counts.docs > 0
      ? `The documents move to Trash, where you can restore them for ${TRASH_RETENTION_DAYS} days.`
      : "The subfolders will be deleted."
  }`;
}

/** Shaped like the table, header included, so a slow load does not look like a different component. */
export function TableSkeleton() {
  return (
    <VStack gap={0} aria-busy="true" aria-live="polite">
      <div className="skel-row skel-row--head">
        <Skeleton width={90} height={11} radius="rounded" index={0} />
      </div>
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <div className="skel-row" key={i}>
          <Skeleton width={16} height={16} radius="rounded" index={i} />
          <div className="skel-row__text">
            <Skeleton width={`${56 - i * 5}%`} height={12} radius="rounded" index={i} />
          </div>
          <Skeleton width={64} height={11} radius="rounded" index={i} />
          <Skeleton width={90} height={11} radius="rounded" index={i} />
        </div>
      ))}
    </VStack>
  );
}
