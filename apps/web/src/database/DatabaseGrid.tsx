/**
 * The editable grid for one table. A bespoke <table>: sorting, filtering and
 * paging are server-side over a window of a large table, which a client-data
 * table component can't express. Cells are keyed by column_id and travel
 * stored-normalized (checkbox 0/1, date "YYYY-MM-DD"). The active saved view
 * seeds a working shape that stays local until "Save view". Pending agent
 * proposals for this table paint over the rows.
 */
import { useEffect, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { IconButton } from "@astryxdesign/core/IconButton";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Spinner } from "@astryxdesign/core/Spinner";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Text } from "@astryxdesign/core/Text";
import { HStack } from "@astryxdesign/core/HStack";
import { useToast } from "@astryxdesign/core/Toast";
import { Columns3, Filter as FilterIcon, Plus, Rows3, Trash2, X } from "lucide-react";
import { validateCellValue } from "@stuga/protocol/databases/cells";
import type { ColumnSpec, RowInputValue, RowRecord, TableSchema, ViewSpec } from "@stuga/protocol/databases/types";
import { Databases } from "../api";
import { itemKey } from "../review/run-ledger";
import { useDbRuns } from "../review/db-runs-context";
import { PromptDialog } from "../ui/PromptDialog";
import { ColumnMenu } from "./ColumnMenu";
import { ColumnDialog, type ColumnDialogSubmit } from "./ColumnDialog";
import { ColumnDescriptionDialog } from "./ColumnDescriptionDialog";
import { ViewTabs } from "./ViewTabs";
import { ViewToolbar } from "./ViewToolbar";
import { GhostInsertRows, GridRow, GroupSection } from "./grid/GridRow";
import { pendingOverlay } from "./grid/pending-overlay";
import { useRowWindow } from "./grid/use-row-window";
import {
  cycleHeaderSort,
  groupKey,
  groupLabel,
  isEmptyShape,
  pruneShape,
  sameShape,
  segmentGroups,
  shapeOf,
  sortDirOf,
  type ViewShape,
} from "./model/view-shape";
import { errorMessage } from "../lib/http/client";
import { useElementWidth } from "../lib/use-element-width";

/** Below this the view bar's buttons drop their labels, as when the dock takes half the page. */
const COMPACT_BAR_WIDTH = 640;

export function DatabaseGrid({
  docId,
  table,
  readOnly,
  rowsKey,
  onSchemaChange,
  onWriteDenied,
  onRowsMutated,
  activeViewId,
  onSelectView,
  onOpenRow,
  openRowId,
}: {
  docId: string;
  table: TableSchema;
  readOnly: boolean;
  /** Bumped by the page after schema changes or reverts. */
  rowsKey: number;
  /** Ask the page to refetch the schema. */
  onSchemaChange: () => void;
  /** A write was refused with 403; the page turns read-only. */
  onWriteDenied: () => void;
  /** A row write of this user's landed in place; the server doesn't push it back to its author's Activity feed. */
  onRowsMutated: () => void;
  /** The saved view on screen; null is the implicit "All rows". */
  activeViewId: string | null;
  onSelectView: (viewId: string | null) => void;
  onOpenRow: (rowId: string) => void;
  openRowId: string | null;
}) {
  const toast = useToast();
  const runs = useDbRuns();
  const columns = [...table.columns].sort((a, b) => a.position - b.position);
  const views = [...table.views].sort((a, b) => a.position - b.position);
  const activeView = views.find((v) => v.view_id === activeViewId) ?? null;
  const overlay = pendingOverlay(runs.pending.filter((p) => p.op.table_id === table.table_id));

  // Keyed on the view's spec, so a collaborator's change to it, or our own save landing, re-seeds the shape.
  const [shape, setShape] = useState<ViewShape>(() => shapeOf(activeView));
  const viewKey = activeView ? `${activeView.view_id}:${JSON.stringify(shapeOf(activeView))}` : "";
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  useEffect(() => {
    setShape(shapeOf(activeView));
    setCollapsed(new Set());
    // eslint-disable-next-line react-hooks/exhaustive-deps -- viewKey stands for the view's identity and spec
  }, [viewKey]);

  // A schema change can delete a column the shape names; requests always use the pruned shape, and this clears the chips.
  const colIdSet = new Set(columns.map((c) => c.column_id));
  useEffect(() => {
    setShape((s) => pruneShape(s, colIdSet));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table]);
  const effShape = pruneShape(shape, colIdSet);
  const savedShape = shapeOf(activeView);
  const dirty = !sameShape(effShape, savedShape);
  const visibleColumns = columns.filter((c) => !effShape.hidden_columns.includes(c.column_id));
  const gridSpan = 1 + visibleColumns.length + overlay.ghostCols.length + (readOnly ? 0 : 1);
  const groupCol = effShape.group_by === null ? undefined : columns.find((c) => c.column_id === effShape.group_by);
  const filtered = effShape.filter !== null;

  const win = useRowWindow(docId, table.table_id, effShape, rowsKey);
  const { rows, total } = win;
  const { ref: barRef, width: barWidth } = useElementWidth();
  const compact = barWidth > 0 && barWidth < COMPACT_BAR_WIDTH;

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<{ rowId: string; columnId: string } | null>(null);
  useEffect(() => {
    setSelected(new Set());
    setEditing(null);
  }, [win.windowKey]);

  const [colDialog, setColDialog] = useState<{ retypeOf: ColumnSpec | null } | null>(null);
  const [colBusy, setColBusy] = useState(false);
  const [renamingCol, setRenamingCol] = useState<ColumnSpec | null>(null);
  const [describingCol, setDescribingCol] = useState<ColumnSpec | null>(null);
  const [deletingCol, setDeletingCol] = useState<ColumnSpec | null>(null);
  const [deleteColBusy, setDeleteColBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [newViewOpen, setNewViewOpen] = useState(false);
  const [renamingView, setRenamingView] = useState<ViewSpec | null>(null);
  const [deletingView, setDeletingView] = useState<ViewSpec | null>(null);
  const [deleteViewBusy, setDeleteViewBusy] = useState(false);

  function surfaceError(e: unknown, fallback: string) {
    if ((e as { status?: number }).status === 403) onWriteDenied();
    toast({ body: errorMessage(e, fallback), type: "error" });
  }

  /** False when the input is invalid, so the editor stays open for a fix. */
  function commitCell(rowId: string, col: ColumnSpec, input: RowInputValue): boolean {
    const v = validateCellValue(col.type, col.options, input);
    if (!v.ok) {
      toast({ body: v.reason, type: "error" });
      return false;
    }
    setEditing(null);
    const row = rows.find((r) => r._id === rowId);
    if (!row || (row[col.column_id] ?? null) === v.value) return true;
    win.patchCell(rowId, col.column_id, v.value);
    Databases.updateRows(docId, table.table_id, [{ _id: rowId, values: { [col.column_id]: v.value } }])
      .then((r) => {
        onRowsMutated();
        if (r.missing.length > 0) {
          toast({ body: "That row was deleted by someone else.", type: "error" });
          win.refetch();
        }
      })
      .catch((e) => {
        // Refetch instead of restoring the old value, which could clobber a newer save that raced this one.
        surfaceError(e, "Couldn't save the change.");
        win.refetch();
      });
    return true;
  }

  async function addRow() {
    try {
      const r = await Databases.insertRows(docId, table.table_id, [{}]);
      onRowsMutated();
      // Under a sort, filter or grouping the empty row may not belong where it would be appended,
      // and a re-window that hides it would look like nothing happened.
      if (!isEmptyShape({ ...effShape, hidden_columns: [] })) {
        win.refetch();
        toast({
          body: filtered ? "Row added. The current filter may not include it." : "Row added. The sort or grouping decides where it lands.",
          type: "info",
        });
        return;
      }
      const id = r.row_ids[0];
      if (!id) return win.refetch();
      win.appendRow(id);
      const first = columns.find((c) => c.type !== "checkbox");
      if (first) setEditing({ rowId: id, columnId: first.column_id });
    } catch (e) {
      surfaceError(e, "Couldn't add a row.");
    }
  }

  async function deleteSelected() {
    setBulkBusy(true);
    try {
      const r = await Databases.deleteRows(docId, table.table_id, [...selected]);
      onRowsMutated();
      setConfirmDelete(false);
      win.removeRows(selected, r.deleted);
      setSelected(new Set());
    } catch (e) {
      surfaceError(e, "Couldn't delete the rows.");
    } finally {
      setBulkBusy(false);
    }
  }

  async function submitColumn(spec: ColumnDialogSubmit) {
    if (!colDialog) return;
    setColBusy(true);
    try {
      if (colDialog.retypeOf) {
        const r = await Databases.setColumnType(docId, table.table_id, colDialog.retypeOf.column_id, spec.type, spec.choices);
        toast({
          body: r.coerced ? `Type changed — ${r.coerced} value${r.coerced === 1 ? "" : "s"} coerced.` : "Type changed.",
          type: "info",
        });
      } else {
        await Databases.addColumn(docId, table.table_id, spec);
      }
      setColDialog(null);
      onSchemaChange();
    } catch (e) {
      surfaceError(e, "Couldn't save the column.");
    } finally {
      setColBusy(false);
    }
  }

  async function renameColumn(display: string) {
    if (!renamingCol) return;
    try {
      await Databases.renameColumn(docId, table.table_id, renamingCol.column_id, display);
      onSchemaChange();
    } catch (e) {
      surfaceError(e, "Couldn't rename the column.");
    }
  }

  async function deleteColumn() {
    if (!deletingCol) return;
    setDeleteColBusy(true);
    try {
      await Databases.deleteColumn(docId, table.table_id, deletingCol.column_id);
      setDeletingCol(null);
      onSchemaChange();
    } catch (e) {
      surfaceError(e, "Couldn't delete the column.");
    } finally {
      setDeleteColBusy(false);
    }
  }

  function saveView() {
    if (activeView) void updateViewShape(activeView);
    else setNewViewOpen(true);
  }

  async function updateViewShape(view: ViewSpec) {
    try {
      await Databases.updateView(docId, table.table_id, view.view_id, effShape);
      onSchemaChange();
    } catch (e) {
      surfaceError(e, "Couldn't save the view.");
    }
  }

  async function createView(name: string) {
    try {
      const r = await Databases.createView(docId, table.table_id, { name, ...effShape });
      onSchemaChange();
      onSelectView(r.view.view_id);
    } catch (e) {
      surfaceError(e, "Couldn't create the view.");
    }
  }

  async function renameView(name: string) {
    if (!renamingView) return;
    try {
      await Databases.updateView(docId, table.table_id, renamingView.view_id, { name });
      onSchemaChange();
    } catch (e) {
      surfaceError(e, "Couldn't rename the view.");
    }
  }

  async function deleteView() {
    if (!deletingView) return;
    setDeleteViewBusy(true);
    try {
      await Databases.deleteView(docId, table.table_id, deletingView.view_id);
      if (deletingView.view_id === activeViewId) onSelectView(null);
      setDeletingView(null);
      onSchemaChange();
    } catch (e) {
      surfaceError(e, "Couldn't delete the view.");
    } finally {
      setDeleteViewBusy(false);
    }
  }

  const renderRow = (row: RowRecord) => (
    <GridRow
      key={row._id}
      row={row}
      columns={visibleColumns}
      ghostCols={overlay.ghostCols}
      proposed={overlay.updates.get(row._id)}
      proposedDelete={overlay.deletes.has(row._id)}
      selected={selected.has(row._id)}
      onSelect={(on) =>
        setSelected((s) => {
          const next = new Set(s);
          if (on) next.add(row._id);
          else next.delete(row._id);
          return next;
        })
      }
      isOpen={openRowId === row._id}
      onOpenRow={onOpenRow}
      readOnly={readOnly}
      editingColumnId={editing?.rowId === row._id ? editing.columnId : null}
      onEdit={(columnId) => setEditing(columnId === null ? null : { rowId: row._id, columnId })}
      onCommit={(col, input) => commitCell(row._id, col, input)}
    />
  );

  // Pending inserts paint rows of their own, so a grid awaiting review isn't empty.
  const isEmpty = !win.loading && !win.loadError && rows.length === 0 && overlay.inserts.length === 0;
  const allSelected = rows.length > 0 && selected.size === rows.length;
  const headerCheck: boolean | "indeterminate" = allSelected ? true : selected.size > 0 ? "indeterminate" : false;

  return (
    <div className="db-grid-shell">
      {/* The table's views on the left; on the right, what shapes the current view, or what acts on the selected rows. */}
      <div className="db-viewbar" ref={barRef}>
        <ViewTabs
          views={views}
          activeId={activeView?.view_id ?? null}
          readOnly={readOnly}
          onSelect={onSelectView}
          onCreate={() => setNewViewOpen(true)}
          onRename={setRenamingView}
          onDelete={setDeletingView}
        />
        <span className="db-viewbar__spacer" />
        {selected.size > 0 && !readOnly ? (
          <HStack gap={1} vAlign="center" wrap="nowrap">
            <Text type="supporting" color="secondary">
              {selected.size} selected
            </Text>
            <Button label="Delete" variant="secondary" size="sm" icon={<Trash2 size={15} />} onClick={() => setConfirmDelete(true)} />
            <IconButton label="Clear selection" variant="ghost" size="sm" icon={<X size={15} />} onClick={() => setSelected(new Set())} />
          </HStack>
        ) : (
          columns.length > 0 && (
            <ViewToolbar
              columns={columns}
              shape={effShape}
              onShape={setShape}
              dirty={dirty}
              hasView={activeView !== null}
              readOnly={readOnly}
              onSave={saveView}
              onReset={() => setShape(savedShape)}
              compact={compact}
            />
          )
        )}
      </div>

      <div className="db-grid-wrap">
        {columns.length === 0 && overlay.ghostCols.length === 0 && overlay.inserts.length === 0 ? (
          <div className="db-grid-center">
            <EmptyState
              isCompact
              title="No columns yet"
              description="Add a column to start entering data."
              icon={<Columns3 size={22} />}
              actions={
                !readOnly ? (
                  <Button label="Add column" variant="primary" size="sm" onClick={() => setColDialog({ retypeOf: null })} />
                ) : undefined
              }
            />
          </div>
        ) : (
          <>
            <table className="db-grid">
              <thead>
                <tr>
                  <th className="db-grid__check">
                    <CheckboxInput
                      label="Select all loaded rows"
                      isLabelHidden
                      size="sm"
                      value={headerCheck}
                      isDisabled={rows.length === 0}
                      onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r._id)))}
                    />
                  </th>
                  {visibleColumns.map((c) => (
                    <th key={c.column_id}>
                      <ColumnMenu
                        column={c}
                        sortDir={sortDirOf(effShape.sorts, c.column_id)}
                        readOnly={readOnly}
                        onSortCycle={() => setShape((sh) => ({ ...sh, sorts: cycleHeaderSort(sh.sorts, c.column_id) }))}
                        onHide={() =>
                          setShape((sh) =>
                            sh.hidden_columns.includes(c.column_id) ? sh : { ...sh, hidden_columns: [...sh.hidden_columns, c.column_id] },
                          )
                        }
                        onRename={() => setRenamingCol(c)}
                        onChangeType={() => setColDialog({ retypeOf: c })}
                        onDescribe={() => setDescribingCol(c)}
                        onDelete={() => setDeletingCol(c)}
                      />
                    </th>
                  ))}
                  {overlay.ghostCols.map((g) => (
                    <th key={g.columnId} className="db-th--ghost" title={`Proposed by ${g.agent} — accept it in the banner above`}>
                      <span className="db-col-head__label">{g.display}</span>
                      <span className="db-ghost-tag">proposed</span>
                    </th>
                  ))}
                  {!readOnly && (
                    <th className="db-grid__addcol">
                      <IconButton label="Add column" variant="ghost" size="sm" icon={<Plus size={15} />} onClick={() => setColDialog({ retypeOf: null })} />
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {groupCol && win.groups !== null
                  ? segmentGroups(rows, win.groups, (row) => row[groupCol.column_id] ?? null).map((seg) => {
                      const key = groupKey(seg.value);
                      const isCollapsed = collapsed.has(key);
                      return (
                        <GroupSection
                          key={key}
                          label={groupLabel(seg.value, groupCol)}
                          count={seg.count}
                          loaded={seg.rows.length}
                          span={gridSpan}
                          collapsed={isCollapsed}
                          onToggle={() =>
                            setCollapsed((c) => {
                              const next = new Set(c);
                              if (next.has(key)) next.delete(key);
                              else next.add(key);
                              return next;
                            })
                          }
                        >
                          {isCollapsed ? null : seg.rows.map(renderRow)}
                        </GroupSection>
                      );
                    })
                  : rows.map(renderRow)}
                {overlay.inserts.map((g) => {
                  const key = itemKey(g.runId, g.opId);
                  return (
                    <GhostInsertRows
                      key={key}
                      columns={visibleColumns}
                      ghostCols={overlay.ghostCols}
                      span={gridSpan}
                      agent={g.agent}
                      payload={g.payload}
                      busy={runs.inFlight.has(key)}
                      readOnly={readOnly}
                      onDecide={(d) => void runs.decide(g.runId, d, [g.opId])}
                    />
                  );
                })}
              </tbody>
            </table>
            {win.loading && (
              <div className="db-grid-center">
                <Spinner label="Loading rows…" />
              </div>
            )}
            {!win.loading && win.loadError && (
              <div className="db-grid-center">
                <EmptyState isCompact title="Couldn't load rows" description="Please try again." />
                <Button label="Retry" variant="secondary" size="sm" onClick={win.refetch} />
              </div>
            )}
            {/* An empty grid offers New row as its primary action; the appender strip waits for a first row. */}
            {isEmpty ? (
              <div className="db-grid-center">
                <EmptyState
                  title={filtered ? "No rows match this filter" : "No rows yet"}
                  description={
                    filtered
                      ? "Try a different filter, or clear it to see every row."
                      : readOnly
                        ? "Rows added by an editor show up here."
                        : "Add your first row — it opens with the cursor in the first cell, ready to type."
                  }
                  icon={filtered ? <FilterIcon size={26} /> : <Rows3 size={26} />}
                  actions={
                    filtered ? (
                      <Button label="Clear filter" variant="secondary" size="sm" onClick={() => setShape((sh) => ({ ...sh, filter: null }))} />
                    ) : readOnly ? undefined : (
                      <Button label="New row" variant="primary" size="sm" icon={<Plus size={15} />} onClick={addRow} />
                    )
                  }
                />
              </div>
            ) : (
              !win.loading && (
                <div className="db-foot">
                  {!readOnly && (
                    <button className="db-newrow" onClick={addRow}>
                      <Plus size={14} /> New row
                    </button>
                  )}
                  {!win.loadError && (
                    <span className="db-foot__count">
                      {rows.length < total ? `${rows.length} of ${total} rows` : `${total} row${total === 1 ? "" : "s"}`}
                    </span>
                  )}
                </div>
              )
            )}
            {win.groupsTruncated && (
              <div className="db-grid-center">
                <Text type="supporting" color="secondary">
                  Only the first {win.groups?.length ?? 0} groups are listed; narrow the filter to see the rest.
                </Text>
              </div>
            )}
            {!win.loading && rows.length < total && (
              <div className="db-loadmore">
                <Button
                  label={win.loadingMore ? "Loading…" : "Load more"}
                  variant="secondary"
                  size="sm"
                  isDisabled={win.loadingMore}
                  onClick={win.loadMore}
                />
              </div>
            )}
          </>
        )}
      </div>

      <ColumnDialog
        isOpen={colDialog !== null}
        retypeOf={colDialog?.retypeOf ?? null}
        busy={colBusy}
        onSubmit={submitColumn}
        onClose={() => setColDialog(null)}
      />
      <ColumnDescriptionDialog
        isOpen={describingCol !== null}
        docId={docId}
        tableId={table.table_id}
        column={describingCol}
        onSaved={onSchemaChange}
        onError={surfaceError}
        onClose={() => setDescribingCol(null)}
      />
      <PromptDialog
        isOpen={renamingCol !== null}
        title="Rename column"
        label="Column name"
        initialValue={renamingCol?.display ?? ""}
        submitLabel="Rename"
        onSubmit={renameColumn}
        onClose={() => setRenamingCol(null)}
      />
      <AlertDialog
        isOpen={deletingCol !== null}
        onOpenChange={(o) => !o && !deleteColBusy && setDeletingCol(null)}
        title={`Delete column “${deletingCol?.display ?? ""}”?`}
        description="Every value in this column is deleted permanently."
        actionLabel="Delete column"
        isActionLoading={deleteColBusy}
        onAction={deleteColumn}
      />
      <PromptDialog
        isOpen={newViewOpen}
        title="Save as view"
        label="View name"
        submitLabel="Save"
        onSubmit={createView}
        onClose={() => setNewViewOpen(false)}
      />
      <PromptDialog
        isOpen={renamingView !== null}
        title="Rename view"
        label="View name"
        initialValue={renamingView?.name ?? ""}
        submitLabel="Rename"
        onSubmit={renameView}
        onClose={() => setRenamingView(null)}
      />
      <AlertDialog
        isOpen={deletingView !== null}
        onOpenChange={(o) => !o && !deleteViewBusy && setDeletingView(null)}
        title={`Delete view “${deletingView?.name ?? ""}”?`}
        description="The view's filter, sort and grouping are removed for everyone. Rows are not affected."
        actionLabel="Delete view"
        isActionLoading={deleteViewBusy}
        onAction={deleteView}
      />
      <AlertDialog
        isOpen={confirmDelete}
        onOpenChange={(o) => !o && !bulkBusy && setConfirmDelete(false)}
        title={`Delete ${selected.size} row${selected.size === 1 ? "" : "s"}?`}
        description="The selected rows are deleted permanently."
        actionLabel="Delete rows"
        isActionLoading={bulkBusy}
        onAction={deleteSelected}
      />
    </div>
  );
}
