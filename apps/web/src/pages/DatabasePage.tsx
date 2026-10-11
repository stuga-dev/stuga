/**
 * A database. Data travels over REST; the live socket carries presence, run
 * frames and change nudges. The schema lives here, `rowsKey` is bumped with
 * every schema reload so the grid refetches its window, and the grid is keyed on
 * the active table so a tab switch starts from clean sort, filter and selection.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { TopNav } from "@astryxdesign/core/TopNav";
import { Button } from "@astryxdesign/core/Button";
import { Banner } from "@astryxdesign/core/Banner";
import { Spinner } from "@astryxdesign/core/Spinner";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { HStack } from "@astryxdesign/core/HStack";
import { VStack } from "@astryxdesign/core/VStack";
import { useToast } from "../ui/use-toast";
import { Share2, Table2, Database, Download, Upload } from "lucide-react";
import { DockToggle } from "../ui/Dock";
import { ItemOptionsMenu } from "../library/ItemOptionsMenu";
import { ItemTitle, useTitleRename } from "./ItemTitle";
import { usePageTitle } from "../state/branding";
import { Databases, Docs, type DocSummary } from "../api";
import { EndedBanner } from "../document/ItemStateBanner";
import { csvFileName } from "@stuga/protocol/databases/csv";
import type { DatabaseImportResult, DatabaseSchema, TableSchema } from "@stuga/protocol/databases/types";
import { ShareDialog } from "../library/ShareDialog";
import { useShareRequested } from "../library/share-request";
import { DocStateChips } from "../library/DocStateChips";
import { ConnectionStatus } from "../document/ConnectionStatus";
import { LoadFailed } from "../ui/LoadFailed";
import { useLinkHealth } from "../sync/use-link-health";
import type { IndicatorReadout } from "../sync/link-health";
import { AccountMenu } from "../shell/AccountMenu";
import { NotificationsBell } from "../shell/NotificationsBell";
import { usePanelWidth } from "../ui/ResizeHandle";
import { useIsCompact } from "../ui/narrow";
import { PromptDialog } from "../ui/PromptDialog";
import { TableTabs } from "../database/TableTabs";
import { DatabaseGrid } from "../database/DatabaseGrid";
import { DbRunBar } from "../review/DbRunBar";
import { DbCatchUpCard } from "../review/DbCatchUpCard";
import { DatabaseDock, useDatabaseDock } from "../database/DatabaseDock";
import { ImportDialog } from "../database/ImportDialog";
import { takeHandedImport } from "../database/handed-import";
import type { GridListing } from "../database/DatabaseGrid";
import { saveBlob } from "../lib/download";
import { Brand } from "../shell/Brand";
import { DbRunsProvider } from "../review/db-runs-context";
import { DatabaseSocket } from "../sync/database-socket";
import { errorMessage } from "../lib/http/client";
import { t } from "../i18n/i18n";

/** Shown once the socket stops retrying, a state the link-health model has no phase for. */
function linkGaveUpReadout(): IndicatorReadout {
  return {
    phase: "prolonged",
    tone: "error",
    label: t("pages.database.notConnected"),
    srText: t("pages.database.notConnectedNote"),
    expanded: true,
    persistent: true,
  };
}

/** `onTrashed`: the database went into the trash while open; the page hands over to the trash card. */
export function DatabasePage({ doc, onTrashed }: { doc: DocSummary; onTrashed?: (doc: DocSummary) => void }) {
  const nav = useNavigate();
  // The open table, view and row live in the URL, so a reload or a shared link
  // lands on the same place. `?import` (the link an agent hands over when it
  // cannot deliver a file) opens the import dialog once.
  const [searchParams, setSearchParams] = useSearchParams();
  const tableParam = searchParams.get("table");
  const viewParam = searchParams.get("view");
  const rowParam = searchParams.get("row");
  const openRowId = rowParam && rowParam !== "" ? rowParam : null;
  const wantsImport = searchParams.has("import");
  const toast = useToast();
  const docId = doc.doc_id;

  const [schema, setSchema] = useState<(DatabaseSchema & { can_write: boolean }) | null>(null);
  const [schemaError, setSchemaError] = useState(false);
  const [activeTid, setActiveTid] = useState<string | null>(null);
  const [rowsKey, setRowsKey] = useState(0);
  // The caller's own row writes are applied in place and never nudge the socket; only Activity needs to hear of them.
  const [editsKey, setEditsKey] = useState(0);
  const [importOpen, setImportOpen] = useState(false);
  // No permission frames reach this page, so a 403 on a write flips it read-only.
  const [writeDenied, setWriteDenied] = useState(false);

  const [showShare, setShowShare] = useState(false);
  // An access request's notification opens the page with the Share dialog up.
  useShareRequested(() => setShowShare(true));
  const [dockW, setDockW] = usePanelWidth("stuga_db_dock_w", 360, 280, 640);

  const [newTableOpen, setNewTableOpen] = useState(false);
  const [renamingTable, setRenamingTable] = useState<TableSchema | null>(null);
  const [deletingTable, setDeletingTable] = useState<TableSchema | null>(null);
  const [deleteTableBusy, setDeleteTableBusy] = useState(false);
  /** A file chosen in the library for this new database, imported as soon as the page opens. */
  const [handedFile, setHandedFile] = useState<File | null>(null);
  useEffect(() => {
    const f = takeHandedImport(docId);
    if (f) setHandedFile(f);
  }, [docId]);
  /** What the grid shows of the open table: a download writes those rows and columns. */
  const listingRef = useRef<GridListing | null>(null);

  // Seeded from the prop: the ⋯ menu updates it optimistically and again with the server's row.
  const [docState, setDocState] = useState<DocSummary>(doc);
  const locked = !!docState.locked;
  const searchHidden = !!docState.search_hidden;
  const agentAuto = docState.agent_mode === "auto";
  /** The live channel closed for good: deleted, or the membership ended. */
  const [ended, setEnded] = useState<"deleted" | "removed" | null>(null);
  /** Read-only for a reason the state chips show: the lock or the caller's access. */
  const chipsReadOnly = locked || writeDenied || (schema ? !schema.can_write : false);
  const readOnly = chipsReadOnly || ended !== null;

  const dock = useDatabaseDock({ rowOpen: openRowId !== null, readOnly });
  // In a compact window Share gives up its label, as on the document page.
  const isCompact = useIsCompact();
  // The item as last read: a rename elsewhere re-reads it, so the new title shows here too. A new
  // database's one table follows its name (the node renames it), so the tabs are read again.
  const rename = useTitleRename(docId, docState.title, readOnly, noteWriteError, (row) => {
    setDocState(row);
    void loadSchema();
  });
  usePageTitle(rename.name);
  // A row arriving through the URL opens its panel; hiding the dock sticks until another row opens.
  useEffect(() => {
    if (openRowId) dock.open("row");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the dock's handlers close over the current state
  }, [openRowId]);

  function noteWriteError(e: unknown) {
    if ((e as { status?: number }).status === 403) setWriteDenied(true);
  }

  // Refs keep loadSchema stable while it reads the current tab and URL: a reload long after the
  // first would otherwise write back the URL of the first render, dropping the view chosen since.
  const activeTidRef = useRef<string | null>(null);
  activeTidRef.current = activeTid;
  const urlRef = useRef({ tableParam, wantsImport, setSearchParams });
  urlRef.current = { tableParam, wantsImport, setSearchParams };

  const loadSchema = useCallback(async (): Promise<DatabaseSchema | null> => {
    try {
      const s = await Databases.schema(docId);
      const tables = [...s.tables].sort((a, b) => a.position - b.position);
      setSchema({ ...s, tables });
      setSchemaError(false);
      setRowsKey((k) => k + 1);
      // The URL wins over the tab on screen, and whatever is settled on is written back.
      const { tableParam, wantsImport, setSearchParams } = urlRef.current;
      const wanted = tableParam && tables.some((t) => t.table_id === tableParam) ? tableParam : null;
      const held = activeTidRef.current;
      const open = wanted ?? (held && tables.some((t) => t.table_id === held) ? held : (tables[0]?.table_id ?? null));
      if (open !== held) setActiveTid(open);
      if (open !== tableParam || wantsImport) {
        setSearchParams(
          (p) => {
            if (open) p.set("table", open);
            else p.delete("table");
            p.delete("import");
            return p;
          },
          { replace: true },
        );
      }
      if (wantsImport) setImportOpen(true);
      return s;
    } catch {
      setSchemaError(true);
      return null;
    }
  }, [docId]);

  useEffect(() => {
    void loadSchema();
  }, [loadSchema]);

  /**
   * A lock change leaves `can_write` and the `writeDenied` latch stale, so drop
   * the latch and re-read the schema, which is the authority on write access.
   */
  const onStateChanged = useCallback(
    (next: DocSummary) => {
      setDocState(next);
      setWriteDenied(false);
      void loadSchema();
    },
    [loadSchema],
  );

  // Without the socket, edits still save over REST while rows go stale and
  // proposals stop painting, so its health is shown. It has no receipts: an open
  // socket counts as both transport and handshake.
  const [socket, setSocket] = useState<DatabaseSocket | null>(null);
  const { status: connStatus, signals: connSignals } = useLinkHealth(docId);
  const [linkGaveUp, setLinkGaveUp] = useState(false);
  useEffect(() => {
    setLinkGaveUp(false);
    const s = new DatabaseSocket(docId);
    s.onStatus = (st) => {
      if (st === "open") {
        connSignals.onSocketOpen();
        connSignals.onSyncDone();
        setLinkGaveUp(false);
      } else if (st === "gave_up") {
        // The model's terminal event stops its clock; linkGaveUpReadout() hides its wording.
        connSignals.onEnded("revoked");
        setLinkGaveUp(true);
      } else if (st === "deleted" || st === "removed") {
        connSignals.onEnded(st);
        setEnded(st);
      } else {
        connSignals.onSocketDown();
      }
    };
    setSocket(s);
    return () => {
      setSocket(null);
      s.destroy();
    };
  }, [docId, connSignals]);

  const onTrashedRef = useRef(onTrashed);
  onTrashedRef.current = onTrashed;
  // Debounced, and deferred while a cell editor has focus so a refetch cannot wipe an edit.
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!socket) return;
    const scheduleRefresh = (delay: number) => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => {
        refreshTimer.current = null;
        const el = typeof document !== "undefined" ? document.activeElement : null;
        if (el && (el.classList.contains("db-cell-input") || el.classList.contains("db-cell-select"))) {
          scheduleRefresh(2000);
          return;
        }
        void loadSchema();
      }, delay);
    };
    // A lock, unlock, trash or restore: the item itself is read again, and the trash card takes over.
    const refreshItem = () => {
      Docs.get(docId)
        .then((d) => {
          if (d.trashed) {
            onTrashedRef.current?.(d);
            return;
          }
          setDocState(d);
          setWriteDenied(false);
          void loadSchema();
        })
        .catch(() => {});
    };
    socket.changedListener = (change) => (change.reason === "state" ? refreshItem() : scheduleRefresh(600));
    return () => {
      socket.changedListener = null;
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = null;
    };
  }, [socket, loadSchema, docId]);

  async function createTable(display: string) {
    try {
      const r = await Databases.createTable(docId, display);
      await loadSchema();
      selectTable(r.table.table_id);
    } catch (e) {
      noteWriteError(e);
      toast({ body: errorMessage(e, t("pages.database.createTableFailed")), type: "error" });
    }
  }

  async function renameTable(display: string) {
    if (!renamingTable) return;
    try {
      await Databases.renameTable(docId, renamingTable.table_id, display);
      await loadSchema();
    } catch (e) {
      noteWriteError(e);
      toast({ body: errorMessage(e, t("pages.database.renameTableFailed")), type: "error" });
    }
  }

  /** The delete confirmation names what goes, counted now: the schema on screen may be minutes old. */
  async function askDeleteTable(table: TableSchema) {
    const fresh = await Databases.schema(docId)
      .then((s) => s.tables.find((x) => x.table_id === table.table_id))
      .catch(() => undefined);
    setDeletingTable(fresh ?? table);
  }

  async function downloadCsv(table: TableSchema) {
    const shown = listingRef.current?.tableId === table.table_id ? listingRef.current : null;
    try {
      const blob = await Databases.downloadCsv(docId, table.table_id, shown ? { ...shown.listing, columns: shown.columns } : {});
      saveBlob(blob, csvFileName(table.display || t("database.tables.untitled")));
    } catch (e) {
      toast({ body: errorMessage(e, t("database.export.failed")), type: "error" });
    }
  }

  async function afterImport(result: DatabaseImportResult) {
    await loadSchema();
    if (result.table_id && result.table_id !== activeTidRef.current) selectTable(result.table_id);
  }

  async function deleteTable() {
    if (!deletingTable) return;
    setDeleteTableBusy(true);
    try {
      await Databases.deleteTable(docId, deletingTable.table_id);
      setDeletingTable(null);
      await loadSchema();
    } catch (e) {
      noteWriteError(e);
      toast({ body: errorMessage(e, t("pages.database.deleteTableFailed")), type: "error" });
    } finally {
      setDeleteTableBusy(false);
    }
  }

  const tables = schema?.tables ?? [];
  const activeTable = tables.find((t) => t.table_id === activeTid) ?? null;
  const activeViewId = viewParam && activeTable?.views.some((v) => v.view_id === viewParam) ? viewParam : null;
  /** Replaces the URL entry: a tab is not a page. Views and rows belong to one table, so they drop. */
  const selectTable = (tableId: string) => {
    setActiveTid(tableId);
    setSearchParams(
      (p) => {
        p.set("table", tableId);
        p.delete("view");
        p.delete("row");
        return p;
      },
      { replace: true },
    );
  };
  const selectView = (viewId: string | null) => {
    setSearchParams(
      (p) => {
        if (viewId) p.set("view", viewId);
        else p.delete("view");
        return p;
      },
      { replace: true },
    );
  };
  const openRow = (rowId: string) => {
    setSearchParams(
      (p) => {
        p.set("row", rowId);
        return p;
      },
      { replace: true },
    );
    dock.open("row");
  };
  const closeRow = () => {
    setSearchParams(
      (p) => {
        p.delete("row");
        return p;
      },
      { replace: true },
    );
  };
  const tableTabs = (
    <TableTabs
      tables={tables}
      activeId={activeTid}
      readOnly={readOnly}
      onSelect={selectTable}
      onCreate={() => setNewTableOpen(true)}
      onRename={setRenamingTable}
      onDelete={(table) => void askDeleteTable(table)}
      onDownload={(table) => void downloadCsv(table)}
    />
  );

  return (
    <DbRunsProvider socket={socket} docId={docId} onApplied={() => void loadSchema()}>
    <div className="doc-page">
      <TopNav
        label={t("common.database")}
        className="item-nav"
        startContent={
          <HStack gap={2} vAlign="center">
            <button className="brand brand--link" onClick={() => nav("/")} title={t("common.allDocuments")} aria-label={t("common.allDocuments")}>
              <Brand />
            </button>
            <ItemTitle rename={rename} readOnly={readOnly} label={t("pages.database.titleLabel")} />
            <DocStateChips
              locked={locked}
              searchHidden={searchHidden}
              agentAuto={agentAuto}
              readOnly={chipsReadOnly}
              noun="database"
            />
            <ConnectionStatus status={linkGaveUp ? linkGaveUpReadout() : connStatus} />
          </HStack>
        }
        endContent={
          <HStack gap={1} vAlign="center">
            <DockToggle isPressed={dock.state.visible} onToggle={dock.toggle} tooltip={t("pages.database.dockTooltip")} />
            <ItemOptionsMenu
              doc={docState}
              readOnly={readOnly}
              onRename={rename.startEditing}
              onStateChanged={onStateChanged}
              extras={[
                {
                  label: t("pages.database.import"),
                  icon: <Upload size={15} />,
                  isDisabled: readOnly || !activeTable,
                  onClick: () => setImportOpen(true),
                },
                {
                  label: t("database.export.csv"),
                  icon: <Download size={15} />,
                  isDisabled: !activeTable,
                  onClick: () => activeTable && void downloadCsv(activeTable),
                },
              ]}
            />
            <Button label={t("common.share")} variant="secondary" icon={<Share2 size={16} />} isIconOnly={isCompact} onClick={() => setShowShare(true)} />
            <NotificationsBell />
            <AccountMenu />
          </HStack>
        }
      />
      {ended && <EndedBanner why={ended} noun="database" />}
      {linkGaveUp && (
        <Banner
          status="warning"
          title={t("pages.database.liveOff.title")}
          description={t("pages.database.liveOff.body")}
          endContent={<Button label={t("pages.database.reload")} variant="secondary" size="sm" onClick={() => window.location.reload()} />}
        />
      )}
      <div className="doc-body">
        <main className="db-main">
          {schema === null && !schemaError && (
            <VStack gap={2} hAlign="center" style={{ paddingTop: "18vh" }}>
              <Spinner label={t("pages.database.loading")} />
            </VStack>
          )}
          {schemaError && (
            <VStack gap={3} hAlign="center" style={{ paddingTop: "18vh" }}>
              <LoadFailed
                title={t("pages.database.loadFailed")}
                icon={<Database size={28} />}
                onRetry={() => void loadSchema()}
              />
            </VStack>
          )}
          {schema !== null && (
            <>
              {/* Tables are the top level; the proposals, views and grid below all belong to the one chosen here. */}
              <div className="db-tablebar">{tableTabs}</div>
              <DbRunBar tables={tables} activeTableId={activeTable?.table_id ?? null} locked={locked} />
              <DbCatchUpCard onViewActivity={() => dock.open("activity")} />
              {activeTable ? (
                <DatabaseGrid
                  key={activeTable.table_id}
                  docId={docId}
                  table={activeTable}
                  readOnly={readOnly}
                  rowsKey={rowsKey}
                  onSchemaChange={() => void loadSchema()}
                  onWriteDenied={() => setWriteDenied(true)}
                  activeViewId={activeViewId}
                  onSelectView={selectView}
                  onOpenRow={openRow}
                  openRowId={openRowId}
                  onRowsMutated={() => setEditsKey((k) => k + 1)}
                  onListing={(listing) => {
                    listingRef.current = listing;
                  }}
                />
              ) : (
                <div className="db-grid-center">
                  <EmptyState
                    title={t("pages.database.noTables.title")}
                    description={t("pages.database.noTables.body")}
                    icon={<Table2 size={28} />}
                    actions={
                      !readOnly ? (
                        <Button label={t("pages.database.newTable")} variant="primary" size="sm" onClick={() => setNewTableOpen(true)} />
                      ) : undefined
                    }
                  />
                </div>
              )}
            </>
          )}
        </main>
        {dock.state.visible && dock.state.active && (
          <DatabaseDock
            dock={dock}
            width={dockW}
            onResize={setDockW}
            docId={docId}
            table={activeTable}
            rowId={openRowId}
            readOnly={readOnly}
            agentAuto={agentAuto}
            rowsKey={rowsKey}
            editsKey={editsKey}
            onRowSaved={() => setRowsKey((k) => k + 1)}
            onRowClosed={closeRow}
            onReverted={() => void loadSchema()}
            onWriteDenied={() => setWriteDenied(true)}
          />
        )}
      </div>
      {/* No comment tier: a database renders no comments. */}
      {showShare && <ShareDialog docId={docId} kind="database" onClose={() => setShowShare(false)} />}
      {activeTable && (
        <ImportDialog
          isOpen={importOpen}
          docId={docId}
          table={activeTable}
          initialFile={handedFile}
          onClose={() => {
            setImportOpen(false);
            setHandedFile(null);
          }}
          onImported={(result) => void afterImport(result)}
        />
      )}
      <PromptDialog
        isOpen={newTableOpen}
        title={t("pages.database.newTable")}
        label={t("pages.database.tableName")}
        submitLabel={t("common.create")}
        onSubmit={createTable}
        onClose={() => setNewTableOpen(false)}
      />
      <PromptDialog
        isOpen={renamingTable !== null}
        title={t("pages.database.renameTable")}
        label={t("pages.database.tableName")}
        initialValue={renamingTable?.display ?? ""}
        submitLabel={t("common.rename")}
        onSubmit={renameTable}
        onClose={() => setRenamingTable(null)}
      />
      <AlertDialog
        isOpen={deletingTable !== null}
        onOpenChange={(o) => !o && !deleteTableBusy && setDeletingTable(null)}
        title={t("pages.database.deleteTable.title", { name: deletingTable?.display ?? "" })}
        description={t("pages.database.deleteTable.counts", { rows: deletingTable?.row_count ?? 0, columns: deletingTable?.columns.length ?? 0 })}
        actionLabel={t("pages.database.deleteTable.action")}
        isActionLoading={deleteTableBusy}
        onAction={deleteTable}
      />
    </div>
    </DbRunsProvider>
  );
}
