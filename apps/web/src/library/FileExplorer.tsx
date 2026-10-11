/**
 * The library's browse view: the current folder as a sortable table, a
 * folder heading with a breadcrumb trail, and a detail rail for the selected
 * document. Items can be dropped on a folder row, on the table background (this
 * folder) or on a breadcrumb segment (any ancestor); "Move to folder…" is the
 * keyboard path to the same moves.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Section } from "@astryxdesign/core/Section";
import { useAppShellMobile } from "@astryxdesign/core/AppShell";
import type { LayerAlignment } from "@astryxdesign/core/Layer";
import { Breadcrumbs, BreadcrumbItem } from "@astryxdesign/core/Breadcrumbs";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { VStack } from "@astryxdesign/core/VStack";
import { HStack } from "@astryxdesign/core/HStack";
import { Heading } from "@astryxdesign/core/Text";
import { Button } from "@astryxdesign/core/Button";
import { Banner } from "@astryxdesign/core/Banner";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { LoadFailed } from "../ui/LoadFailed";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { useToast } from "../ui/use-toast";
import { Folder as FolderIcon, FileText, FileUp, FolderInput, Trash2, Pencil, Share2, Files, Library, Search, Users as UsersIcon } from "lucide-react";
import { LIBRARY_LIST_CAP, TRASH_RETENTION_DAYS } from "@stuga/protocol/domain/limits";
import { Docs, Folders, type DocSummary } from "../api";
import { errorMessage, getAlias } from "../lib/http/client";
import { SetupCard } from "./SetupCard";
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
import { useMoveCheck } from "./use-move-check";
import { useDocFileActions } from "./doc-file-actions";
import { useIsCompact, useIsNarrow } from "../ui/narrow";
import { LibraryCreateMenu } from "./LibraryCreateMenu";
import { moveAndReport, movableTo, trashAndReport, type LibraryDragItem, type LibraryItemRef } from "./move-items";
import { t } from "../i18n/i18n";
import { usePageTitle } from "../state/branding";

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
  /** False for a guest, who creates nothing here: no New, and an empty library says nothing has been shared yet. */
  canCreate: boolean;
  /** Creation actions, offered beside the heading while the side nav is hidden and in empty states. */
  onCreateDoc: () => void;
  onCreateDatabase: () => void;
  onCreateDatabaseFromFile: (file: File) => void;
  onCreateFolder: () => void;
  onImport: () => void;
  /** Search the whole workspace, for a filter that found nothing in this folder. */
  onSearch: (query: string) => void;
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
  canCreate,
  onCreateDoc,
  onCreateDatabase,
  onCreateDatabaseFromFile,
  onCreateFolder,
  onImport,
  onSearch,
}: FileExplorerProps) {
  const [renaming, setRenaming] = useState<{ kind: "folder" | "doc"; id: string; title: string } | null>(null);
  const [deleting, setDeleting] = useState<{ id: string; title: string; counts: { docs: number; folders: number } | null } | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [dragging, setDragging] = useState<LibraryDragItem[] | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [dropTarget, setDropTarget] = useState<string | "background" | null>(null);
  const [localKey, setLocalKey] = useState(0);
  /** Null for a folder the caller cannot read; its crumb shows "…" and goes nowhere. */
  const [crumbTitles, setCrumbTitles] = useState<Record<string, string | null>>({});
  const [rows, setRows] = useState<LibraryRow[] | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ok" | "error">("loading");
  const [atCap, setAtCap] = useState(false);

  const [ownerFilter, setOwnerFilter] = useState<OwnerFilter>("anyone");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [nameFilter, setNameFilter] = useState("");
  // The name filter narrows one folder's rows, so it does not follow the person into another.
  const [filterFolder, setFilterFolder] = useState(path.at(-1) ?? null);
  if (filterFolder !== (path.at(-1) ?? null)) {
    setFilterFolder(path.at(-1) ?? null);
    setNameFilter("");
  }
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
  const hereName = currentFolder ? (crumbTitles[currentFolder] ?? t("common.folder")) : t("common.allDocuments");
  usePageTitle(hereName);
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
  const moveCheck = useMoveCheck();
  const fileActions = useDocFileActions({ onCopied: bump });

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
      // A crumb whose title did not load shows "…" and still navigates.
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [currentFolder, refreshKey]);

  /** Which listing the rows on screen answer; a re-read of the same one swaps rows in place, without the skeleton. */
  const shownListing = useRef<string | null>(null);
  const listing = `${currentFolder ?? ""}|${sort.key}|${sort.direction}|${ownerFilter}`;

  useEffect(() => {
    let live = true;
    const rereading = shownListing.current === listing;
    if (!rereading) setLoadState("loading");
    const alias = ownerFilter === "me" ? getAlias() : null;
    const owner = alias ? `user:${alias}` : undefined;
    const order = sort.direction === "ascending" ? "asc" : "desc";
    Promise.all([
      Folders.list(currentFolder, { sort: sort.key, order }).then((r) => r.folders),
      Docs.list(false, currentFolder, { sort: sort.key, order, owner }).then((r) => r.docs),
    ])
      .then(([folders, docs]) => {
        if (!live) return;
        shownListing.current = listing;
        // A document's newer title and state reach the rail too.
        setPreviewDoc((cur) => (cur ? (docs.find((d) => d.doc_id === cur.doc_id) ?? cur) : cur));
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
      // A failed re-read keeps the rows on screen; the next one tries again.
      .catch(() => {
        if (live && !rereading) setLoadState("error");
      });
    return () => {
      live = false;
    };
  }, [currentFolder, refreshKey, localKey, sort.key, sort.direction, ownerFilter, listing, setPreviewDoc]);

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
      toast({ body: t("library.explorer.favoriteFailed"), type: "error" });
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
      toast({ body: errorMessage(e, t("library.explorer.renameFailed")), type: "error" });
    }
    bump();
  }

  async function trashRow(row: LibraryRow) {
    forget(await trashAndReport([{ id: row.id, title: row.title }], toast, bump));
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
            ? t("library.explorer.deletedWithDocs", { title, count: res.docs_trashed })
            : t("library.explorer.deleted", { title }),
        type: "info",
      });
      bump();
    } catch (e) {
      setDeleting(null);
      toast({ body: errorMessage(e, t("library.explorer.deleteFailed", { title })), type: "error" });
    } finally {
      setDeleteBusy(false);
    }
  }

  /** A drop target's name for the toast: a folder row, a crumb, or the top level. */
  const placeName = useCallback(
    (destId: string | null): string => {
      if (destId === null) return t("common.allDocuments");
      const title = rows?.find((r) => r.id === destId)?.title ?? crumbTitles[destId];
      return title || t("common.untitledFolder");
    },
    [rows, crumbTitles],
  );

  /** The server re-checks every move; `ancestors` are the folders enclosing the destination. */
  const moveItems = useCallback(
    async (items: LibraryDragItem[], destId: string | null, ancestors: string[]) => {
      const legal = movableTo(items, destId, ancestors);
      if (legal.length === 0) return;
      if (!(await moveCheck.confirmMove(legal, destId))) return;
      setBulkBusy(true);
      await moveAndReport(legal, { id: destId, title: placeName(destId) }, toast, bump);
      setBulkBusy(false);
      // Only this batch: the user may have selected something else while it ran.
      forget(new Set(legal.map((i) => i.id)));
    },
    [bump, toast, forget, placeName, moveCheck.confirmMove],
  );

  const trashSelected = useCallback(async () => {
    const docs = selectedRows.filter((r) => r.kind === "doc").map((r) => ({ id: r.id, title: r.title }));
    if (docs.length === 0) return;
    setBulkBusy(true);
    const trashed = await trashAndReport(docs, toast, bump);
    setBulkBusy(false);
    forget(trashed);
  }, [selectedRows, bump, toast, forget]);

  function rowActions(row: LibraryRow) {
    // A submenu, so the row's menu keeps its length however many collections there are; a guest makes none.
    const addToCollection = canCreate
      ? [{ label: t("library.item.addToCollection"), icon: <Library size={15} />, items: collectionsMenu.menuItems(refsOf([row])) }]
      : [];
    const instructionsItem = (kind: "folder" | "document" | "database") => instructions.item({ kind, id: row.id, title: row.title });
    if (row.kind === "folder") {
      return [
        { label: t("library.item.share"), icon: <Share2 size={15} />, onClick: () => onShareFolder(row.id) },
        { label: t("common.renameEllipsis"), icon: <Pencil size={15} />, onClick: () => setRenaming({ kind: "folder", id: row.id, title: row.title }) },
        instructionsItem("folder"),
        { label: t("library.item.moveToFolder"), icon: <FolderInput size={15} />, onClick: () => onMoveFolder(row.id) },
        ...addToCollection,
        { label: t("library.item.deleteFolder"), icon: <Trash2 size={15} />, onClick: () => askDelete(row.id, row.title) },
      ];
    }
    return [
      { label: t("library.item.share"), icon: <Share2 size={15} />, onClick: () => onShareDoc(row.id, shareKindOfDoc(row.doc)) },
      { label: t("common.renameEllipsis"), icon: <Pencil size={15} />, onClick: () => setRenaming({ kind: "doc", id: row.id, title: row.title }) },
      { label: t("library.item.moveToFolder"), icon: <FolderInput size={15} />, onClick: () => onMoveDoc(row.id) },
      ...fileActions.items(row.doc ?? null),
      ...(row.doc
        ? [
            {
              type: "section" as const,
              title: row.doc.doc_type === "database" ? t("common.database") : t("common.document"),
              items: [
                ...stateMenu.items(row.doc, applyDocState),
                instructionsItem(row.doc.doc_type === "database" ? "database" : "document"),
              ],
            },
          ]
        : []),
      ...addToCollection,
      { label: t("library.item.moveToTrash"), icon: <Trash2 size={15} />, onClick: () => void trashRow(row) },
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
      onNewDatabaseFromFile={onCreateDatabaseFromFile}
      onNewFolder={onCreateFolder}
      onImport={onImport}
      alignment={alignment}
    />
  );
  // While the side nav is hidden, New sits beside the heading and an empty state repeats none.
  const emptyActions = sideNavHidden || !canCreate ? undefined : createMenu();
  const searchFor = nameFilter.trim();
  const emptyState = filtering ? (
    <EmptyState
      title={t("library.explorer.noMatches")}
      // The filter narrows this folder's rows only; search reaches into every folder.
      description={currentFolder === null ? t("library.explorer.noMatchesTop") : t("library.explorer.noMatchesFolder")}
      icon={<FileText size={26} />}
      actions={
        <HStack gap={2} hAlign="center" wrap="wrap">
          {searchFor && (
            <Button
              label={t("library.explorer.searchEverywhere", { query: searchFor })}
              icon={<Search size={15} />}
              variant="secondary"
              size="sm"
              onClick={() => onSearch(searchFor)}
            />
          )}
          <Button
            label={t("library.explorer.clearFilters")}
            variant={searchFor ? "ghost" : "secondary"}
            size="sm"
            onClick={() => {
              setNameFilter("");
              setTypeFilter("all");
              setOwnerFilter("anyone");
            }}
          />
        </HStack>
      }
    />
  ) : currentFolder === null && !canCreate ? (
    <EmptyState title={t("library.explorer.guestEmpty")} description={t("library.explorer.guestEmptyBody")} icon={<UsersIcon size={26} />} />
  ) : currentFolder === null ? (
    <VStack gap={6} hAlign="center">
      <EmptyState
        title={t("library.explorer.noDocs")}
        description={t("library.explorer.noDocsBody")}
        icon={<FileText size={26} />}
        actions={
          <HStack gap={2} hAlign="center" wrap="wrap">
            {emptyActions}
            <Button label={t("library.create.importMarkdown")} icon={<FileUp size={15} />} variant="secondary" size="sm" onClick={onImport} />
          </HStack>
        }
      />
      <SetupCard />
    </VStack>
  ) : (
    <EmptyState
      title={t("library.explorer.emptyFolder")}
      description={canCreate ? t("library.explorer.emptyFolderBody") : undefined}
      icon={<FolderIcon size={26} />}
      actions={emptyActions}
    />
  );

  return (
    <div className="explorer">
      <HStack className="explorer-heading" gap={2} vAlign="center" justify="between" wrap="wrap">
        <VStack gap={1}>
          {/* Shown at the top level too, so opening a folder does not push the heading down. */}
          <Breadcrumbs label={t("library.explorer.folderPath")} variant="supporting">
            {path.length === 0 ? (
              <BreadcrumbItem isCurrent startIcon={<Files size={14} />}>
                {t("common.allDocuments")}
              </BreadcrumbItem>
            ) : (
              <BreadcrumbItem onClick={() => onPathChange([])} startIcon={<Files size={14} />} {...crumbDropProps(-1)}>
                {t("common.allDocuments")}
              </BreadcrumbItem>
            )}
            {path.map((id, i) =>
              crumbTitles[id] === null ? (
                // A folder the caller cannot read is a place in the chain, nowhere to open or drop into.
                <BreadcrumbItem key={id} isCurrent={i === path.length - 1}>
                  <span aria-hidden="true">…</span>
                  <VisuallyHidden>{t("library.explorer.folderNoAccess")}</VisuallyHidden>
                </BreadcrumbItem>
              ) : (
                <BreadcrumbItem key={id} isCurrent={i === path.length - 1} onClick={() => onPathChange(path.slice(0, i + 1))} {...crumbDropProps(i)}>
                  {crumbTitles[id] ?? "…"}
                </BreadcrumbItem>
              ),
            )}
          </Breadcrumbs>
          <Heading level={1} maxLines={1}>
            {hereName}
          </Heading>
        </VStack>
        {sideNavHidden && canCreate && createMenu("end")}
      </HStack>

      {selectedIds.size > 1 ? (
        <LibrarySelectionBar
          count={selectedIds.size}
          isBusy={bulkBusy}
          onClear={() => select([], null)}
          actions={[
            ...(canCreate
              ? [{ label: t("library.item.addToCollectionEllipsis"), icon: <Library size={15} />, items: collectionsMenu.menuItems(refsOf(selectedRows)) }]
              : []),
            { label: t("library.item.moveToFolder"), icon: <FolderInput size={15} />, onClick: () => onMoveMany(refsOf(selectedRows)) },
            ...(selectedRows.some((r) => r.kind === "doc")
              ? [{ label: t("library.item.moveToTrash"), icon: <Trash2 size={15} />, onClick: () => void trashSelected() }]
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
              title={t("library.explorer.capTitle", { count: LIBRARY_LIST_CAP })}
              description={t("library.explorer.capBody")}
            />
          )}
          {loadState === "error" ? (
            <div className="explorer-center">
              <LoadFailed
                title={t("library.explorer.loadFailed")}
                description={t("library.explorer.loadFailedBody")}
                icon={<FolderIcon size={26} />}
                onRetry={bump}
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
              folderHref={(id) => `/?${new URLSearchParams({ folder: [...path, id].join("/") })}`}
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
            {!isCompact && <ResizeHandle width={railWidth} onResize={setRailWidth} dir={-1} label={t("library.explorer.resizeDetails")} />}
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
        title={renaming?.kind === "folder" ? t("library.explorer.renameFolder") : t("library.explorer.renameDocument")}
        label={renaming?.kind === "folder" ? t("library.explorer.folderName") : t("library.explorer.documentTitle")}
        initialValue={renaming?.title ?? ""}
        submitLabel={t("common.rename")}
        onSubmit={doRename}
        onClose={() => setRenaming(null)}
      />
      {collectionsMenu.dialog}
      {instructions.dialog}
      {moveCheck.dialog}
      {stateMenu.dialog}
      <AlertDialog
        isOpen={deleting !== null}
        onOpenChange={(o) => !o && !deleteBusy && setDeleting(null)}
        title={t("common.deleteNamed", { name: deleting?.title || t("common.untitledFolder") })}
        description={describeDelete(deleting?.counts ?? null)}
        actionLabel={t("library.explorer.deleteAction")}
        isActionLoading={deleteBusy}
        onAction={doDelete}
      />
    </div>
  );
}

function describeDelete(counts: { docs: number; folders: number } | null): string {
  if (!counts) return t("library.explorer.deleteChecking");
  const { docs, folders } = counts;
  const days = TRASH_RETENTION_DAYS;
  if (docs > 0 && folders > 0) return t("library.explorer.deleteBoth", { docs, folders, days });
  if (docs > 0) return t("library.explorer.deleteDocs", { docs, days });
  if (folders > 0) return t("library.explorer.deleteFolders", { folders });
  return t("library.explorer.deleteEmpty");
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
