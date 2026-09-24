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
import { useToast } from "@astryxdesign/core/Toast";
import { Share2, Table2, Database, Upload } from "lucide-react";
import { DockToggle } from "../ui/Dock";
import { ItemOptionsMenu } from "../library/ItemOptionsMenu";
import { ItemTitle, useTitleRename } from "./ItemTitle";
import { Databases, type DocSummary } from "../api";
import type { DatabaseSchema, TableSchema } from "@stuga/protocol/databases/types";
import { ShareDialog } from "../library/ShareDialog";
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
import { Brand } from "../shell/Brand";
import { DbRunsProvider } from "../review/db-runs-context";
import { DatabaseSocket } from "../sync/database-socket";
import { errorMessage } from "../lib/http/client";

/** Shown once the socket stops retrying, a state the link-health model has no phase for. */
const LINK_GAVE_UP: IndicatorReadout = {
  phase: "prolonged",
  tone: "error",
  label: "Not connected",
  srText: "Live updates are off. Reload the page to reconnect.",
  expanded: true,
  persistent: true,
};

export function DatabasePage({ doc }: { doc: DocSummary }) {
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
  const [dockW, setDockW] = usePanelWidth("stuga_db_dock_w", 360, 280, 640);

  const [newTableOpen, setNewTableOpen] = useState(false);
  const [renamingTable, setRenamingTable] = useState<TableSchema | null>(null);
  const [deletingTable, setDeletingTable] = useState<TableSchema | null>(null);
  const [deleteTableBusy, setDeleteTableBusy] = useState(false);

  // Seeded from the prop: the ⋯ menu updates it optimistically and again with the server's row.
  const [docState, setDocState] = useState<DocSummary>(doc);
  const locked = !!docState.locked;
  const searchHidden = !!docState.search_hidden;
  const agentAuto = docState.agent_mode === "auto";
  const readOnly = locked || writeDenied || (schema ? !schema.can_write : false);

  const dock = useDatabaseDock({ rowOpen: openRowId !== null, readOnly });
  // In a compact window Share gives up its label, as on the document page.
  const isCompact = useIsCompact();
  const rename = useTitleRename(docId, doc.title, readOnly, noteWriteError);
  // A row arriving through the URL opens its panel; hiding the dock sticks until another row opens.
  useEffect(() => {
    if (openRowId) dock.open("row");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the dock's handlers close over the current state
  }, [openRowId]);

  function noteWriteError(e: unknown) {
    if ((e as { status?: number }).status === 403) setWriteDenied(true);
  }

  // A ref keeps loadSchema stable while it reads the current tab.
  const activeTidRef = useRef<string | null>(null);
  activeTidRef.current = activeTid;

  const loadSchema = useCallback(async (): Promise<DatabaseSchema | null> => {
    try {
      const s = await Databases.schema(docId);
      const tables = [...s.tables].sort((a, b) => a.position - b.position);
      setSchema({ ...s, tables });
      setSchemaError(false);
      setRowsKey((k) => k + 1);
      // The URL wins over the tab on screen, and whatever is settled on is written back.
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the URL params are read on the load they arrive with
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
        // The model's terminal event stops its clock; LINK_GAVE_UP hides its wording.
        connSignals.onRevoked();
        setLinkGaveUp(true);
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
    socket.changedListener = () => scheduleRefresh(600);
    return () => {
      socket.changedListener = null;
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = null;
    };
  }, [socket, loadSchema]);

  async function createTable(display: string) {
    try {
      const r = await Databases.createTable(docId, display);
      await loadSchema();
      setActiveTid(r.table.table_id);
    } catch (e) {
      noteWriteError(e);
      toast({ body: errorMessage(e, "Couldn't create the table."), type: "error" });
    }
  }

  async function renameTable(display: string) {
    if (!renamingTable) return;
    try {
      await Databases.renameTable(docId, renamingTable.table_id, display);
      await loadSchema();
    } catch (e) {
      noteWriteError(e);
      toast({ body: errorMessage(e, "Couldn't rename the table."), type: "error" });
    }
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
      toast({ body: errorMessage(e, "Couldn't delete the table."), type: "error" });
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
      onDelete={setDeletingTable}
    />
  );

  return (
    <DbRunsProvider socket={socket} docId={docId} onApplied={() => void loadSchema()}>
    <div className="doc-page">
      <TopNav
        label="Database"
        className="item-nav"
        startContent={
          <HStack gap={2} vAlign="center">
            <button className="brand brand--link" onClick={() => nav("/")} title="All documents" aria-label="All documents">
              <Brand />
            </button>
            <ItemTitle rename={rename} readOnly={readOnly} label="Database title" />
            <DocStateChips
              locked={locked}
              searchHidden={searchHidden}
              agentAuto={agentAuto}
              readOnly={readOnly}
              noun="database"
            />
            <ConnectionStatus status={linkGaveUp ? LINK_GAVE_UP : connStatus} />
          </HStack>
        }
        endContent={
          <HStack gap={1} vAlign="center">
            <DockToggle isPressed={dock.state.visible} onToggle={dock.toggle} tooltip="Side panels — AI co-author, activity" />
            <ItemOptionsMenu
              doc={docState}
              readOnly={readOnly}
              onRename={rename.startEditing}
              onStateChanged={onStateChanged}
              extras={[
                {
                  label: "Import…",
                  icon: <Upload size={15} />,
                  isDisabled: readOnly || !activeTable,
                  onClick: () => setImportOpen(true),
                },
              ]}
            />
            <Button label="Share" variant="secondary" icon={<Share2 size={16} />} isIconOnly={isCompact} onClick={() => setShowShare(true)} />
            <NotificationsBell />
            <AccountMenu />
          </HStack>
        }
      />
      {linkGaveUp && (
        <Banner
          status="warning"
          title="Live updates are off"
          description="Rows and agent proposals may be outdated. Reload to reconnect."
          endContent={<Button label="Reload" variant="secondary" size="sm" onClick={() => window.location.reload()} />}
        />
      )}
      <div className="doc-body">
        <main className="db-main">
          {schema === null && !schemaError && (
            <VStack gap={2} hAlign="center" style={{ paddingTop: "18vh" }}>
              <Spinner label="Loading database…" />
            </VStack>
          )}
          {schemaError && (
            <VStack gap={3} hAlign="center" style={{ paddingTop: "18vh" }}>
              <LoadFailed
                title="Couldn’t load this database"
                icon={<Database size={28} />}
                onRetry={() => void loadSchema()}
              />
            </VStack>
          )}
          {schema !== null && (
            <>
              {/* Tables are the top level; the proposals, views and grid below all belong to the one chosen here. */}
              <div className="db-tablebar">{tableTabs}</div>
              <DbRunBar tables={tables} activeTableId={activeTable?.table_id ?? null} />
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
                />
              ) : (
                <div className="db-grid-center">
                  <EmptyState
                    title="No tables yet"
                    description="Create a table to start entering data."
                    icon={<Table2 size={28} />}
                    actions={
                      !readOnly ? (
                        <Button label="New table" variant="primary" size="sm" onClick={() => setNewTableOpen(true)} />
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
          onClose={() => setImportOpen(false)}
          onImported={() => void loadSchema()}
        />
      )}
      <PromptDialog
        isOpen={newTableOpen}
        title="New table"
        label="Table name"
        submitLabel="Create"
        onSubmit={createTable}
        onClose={() => setNewTableOpen(false)}
      />
      <PromptDialog
        isOpen={renamingTable !== null}
        title="Rename table"
        label="Table name"
        initialValue={renamingTable?.display ?? ""}
        submitLabel="Rename"
        onSubmit={renameTable}
        onClose={() => setRenamingTable(null)}
      />
      <AlertDialog
        isOpen={deletingTable !== null}
        onOpenChange={(o) => !o && !deleteTableBusy && setDeletingTable(null)}
        title={`Delete table “${deletingTable?.display ?? ""}”?`}
        description={`Its ${deletingTable?.row_count ?? 0} row${(deletingTable?.row_count ?? 0) === 1 ? "" : "s"} and columns are deleted permanently.`}
        actionLabel="Delete table"
        isActionLoading={deleteTableBusy}
        onAction={deleteTable}
      />
    </div>
    </DbRunsProvider>
  );
}
