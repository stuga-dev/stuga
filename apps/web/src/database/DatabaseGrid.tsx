/**
 * The editable grid for one table. A bespoke <table>: sorting, filtering and
 * paging are server-side over a window of a large table, which a client-data
 * table component can't express. Cells are keyed by column_id and travel
 * stored-normalized (checkbox 0/1, date "YYYY-MM-DD"). The active saved view
 * seeds a working shape that stays local until "Save view". Pending agent
 * proposals for this table paint over the rows.
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "@astryxdesign/core/Button";
import { IconButton } from "@astryxdesign/core/IconButton";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Spinner } from "@astryxdesign/core/Spinner";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Text } from "@astryxdesign/core/Text";
import { HStack } from "@astryxdesign/core/HStack";
import { useToast } from "../ui/use-toast";
import { Columns3, Filter as FilterIcon, Plus, Rows3, Search, Trash2, X } from "lucide-react";
import { DATABASE_MAX_ROWS_PER_WRITE, DATABASE_ROW_SEARCH_MAX_CHARS } from "@stuga/protocol/databases/limits";
import type { ColumnSpec, RowRecord, RowValue, TableSchema, ViewSpec } from "@stuga/protocol/databases/types";
import { Databases } from "../api";
import type { RowListing } from "../api/databases";
import { itemKey } from "../review/run-ledger";
import { useDbRuns } from "../review/db-runs-context";
import { PromptDialog } from "../ui/PromptDialog";
import { ColumnMenu } from "./ColumnMenu";
import { ColumnDialog, type ColumnDialogSubmit } from "./ColumnDialog";
import { ColumnDescriptionDialog } from "./ColumnDescriptionDialog";
import { NumberFormatDialog } from "./NumberFormatDialog";
import type { CommitVia } from "./CellEditor";
import { ViewTabs } from "./ViewTabs";
import { ViewToolbar } from "./ViewToolbar";
import { cellDisplay, GhostInsertRows, GridRow, GroupSection, type CellHandlers } from "./grid/GridRow";
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
import { errorMessage, type ApiError } from "../lib/http/client";
import { useElementWidth } from "../lib/use-element-width";
import { isComposingKey } from "../lib/ime";
import { t } from "../i18n/i18n";
import { checkCell, type FieldInput } from "./model/field-input";
import { copiedText, parseClipboard, pastedInput, planPaste } from "./model/clipboard";
import { isNumberSeed } from "./model/numbers";

/** Below this the view bar's buttons drop their labels, as when the dock takes half the page. */
const COMPACT_BAR_WIDTH = 640;
/** Quiet time after the last key before a search of the table goes to the node. */
const SEARCH_DELAY_MS = 250;

/** What the grid shows of its table: the rows a listing selects, and the columns on screen in their order. */
export interface GridListing {
  tableId: string;
  listing: RowListing;
  columns: string[];
}

/** A key that types one character: no shortcut modifier (AltGr's Ctrl+Alt still types), and no input method mid-word. */
function isPrintableKey(e: KeyboardEvent): boolean {
  return [...e.key].length === 1 && !e.metaKey && !(e.ctrlKey && !e.altKey) && !isComposingKey(e);
}

/** A write that named a column deleted since, as the node refuses it. */
function columnGone(e: ApiError): boolean {
  return (
    (e.code ?? "").startsWith("unknown column reference ") ||
    e.code === "a column this change writes no longer exists — the schema changed after the change was made"
  );
}

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
  onListing,
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
  /** Told what the grid shows whenever that changes, so a download can write the same. */
  onListing?: (listing: GridListing) => void;
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

  // What the search box holds, and what the grid was last asked for once typing paused.
  const [searchText, setSearchText] = useState("");
  const [search, setSearch] = useState("");
  useEffect(() => {
    // Cut to what the node takes, so a long paste searches its start rather than failing the listing.
    const next = searchText.trim().slice(0, DATABASE_ROW_SEARCH_MAX_CHARS).trim();
    if (next === search) return;
    const timer = setTimeout(() => setSearch(next), next === "" ? 0 : SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [searchText, search]);
  const searching = search !== "";

  const win = useRowWindow(docId, table.table_id, effShape, search, rowsKey);
  const listingKey = JSON.stringify([effShape.sorts, effShape.filter, effShape.group_by, search, visibleColumns.map((c) => c.column_id)]);
  useEffect(() => {
    onListing?.({
      tableId: table.table_id,
      listing: { sort: effShape.sorts, filter: effShape.filter, group_by: effShape.group_by, ...(searching ? { search } : {}) },
      columns: visibleColumns.map((c) => c.column_id),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- listingKey stands for every input
  }, [table.table_id, listingKey]);
  const { rows, total } = win;
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const { ref: barRef, width: barWidth } = useElementWidth();
  const compact = barWidth > 0 && barWidth < COMPACT_BAR_WIDTH;

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<{ rowId: string; columnId: string; seed?: string } | null>(null);
  useEffect(() => {
    setSelected(new Set());
    setEditing(null);
  }, [win.windowKey]);

  const [colDialog, setColDialog] = useState<{ retypeOf: ColumnSpec | null } | null>(null);
  const [colBusy, setColBusy] = useState(false);
  const [renamingCol, setRenamingCol] = useState<ColumnSpec | null>(null);
  const [describingCol, setDescribingCol] = useState<ColumnSpec | null>(null);
  const [formattingCol, setFormattingCol] = useState<ColumnSpec | null>(null);
  const [deletingCol, setDeletingCol] = useState<ColumnSpec | null>(null);
  const [deleteColBusy, setDeleteColBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [newViewOpen, setNewViewOpen] = useState(false);
  const [renamingView, setRenamingView] = useState<ViewSpec | null>(null);
  const [deletingView, setDeletingView] = useState<ViewSpec | null>(null);
  const [deleteViewBusy, setDeleteViewBusy] = useState(false);

  // The rows in the order they are on screen: what the arrow keys walk and a paste fills.
  const groupedRows =
    groupCol && win.groups !== null ? segmentGroups(rows, win.groups, (row) => row[groupCol.column_id] ?? null) : null;
  const shownRows = groupedRows ? groupedRows.flatMap((seg) => (collapsed.has(groupKey(seg.value)) ? [] : seg.rows)) : rows;

  // A cell to focus once the render that closes an editor lands, as Enter and Escape hand focus back to the grid.
  const tableRef = useRef<HTMLTableElement>(null);
  const pendingFocus = useRef<{ rowId: string; columnId: string } | null>(null);
  useLayoutEffect(() => {
    const p = pendingFocus.current;
    if (!p || editing !== null) return;
    pendingFocus.current = null;
    focusCell(p.rowId, p.columnId);
  });

  function focusCell(rowId: string, columnId: string) {
    const td = tableRef.current?.querySelector<HTMLElement>(`tr[data-row="${rowId}"] > td[data-col="${columnId}"]`);
    const target = td?.querySelector<HTMLElement>("button.db-cell, input[type=checkbox], .db-files a, .db-files button") ?? td;
    target?.focus();
  }

  /** The cell `dRow` rows and `dCol` columns away, held at the grid's edges. */
  function moveFocus(rowId: string, columnId: string, dRow: number, dCol: number) {
    const r = shownRows.findIndex((row) => row._id === rowId);
    const c = visibleColumns.findIndex((col) => col.column_id === columnId);
    if (r === -1 || c === -1) return;
    const row = shownRows[Math.min(shownRows.length - 1, Math.max(0, r + dRow))]!;
    const col = visibleColumns[Math.min(visibleColumns.length - 1, Math.max(0, c + dCol))]!;
    focusCell(row._id, col.column_id);
  }

  function surfaceError(e: unknown, fallback: string) {
    if ((e as { status?: number }).status === 403) onWriteDenied();
    toast({ body: errorMessage(e, fallback), type: "error" });
  }

  /** One toast for whatever a cell refused last; a second refusal replaces it rather than stacking. */
  function cellProblemToast(problem: string) {
    if (problem) toast({ body: problem, type: "error", uniqueID: "db-cell-problem" });
  }

  /** False when the input is invalid, so the editor stays open for a fix. */
  function commitCell(rowId: string, col: ColumnSpec, input: FieldInput, via: CommitVia): boolean {
    const v = checkCell(col, input);
    if (!v.ok) {
      cellProblemToast(v.problem);
      return false;
    }
    setEditing(null);
    // The rows as they are now: a commit can come from a closure older than the last change, such as an Undo.
    const row = rowsRef.current.find((r) => r._id === rowId);
    if (via === "enter") {
      const below = shownRows[shownRows.findIndex((r) => r._id === rowId) + 1];
      pendingFocus.current = { rowId: below?._id ?? rowId, columnId: col.column_id };
    } else if (via === "pick" && col.type === "single_select") {
      pendingFocus.current = { rowId, columnId: col.column_id };
    }
    const before = row ? (row[col.column_id] ?? null) : null;
    if (!row || before === v.value) return true;
    // An edit says what it started from, so someone else's newer value is never overwritten unseen. A toggle or
    // a file list is built on the value as it is, so it needs no such check.
    const expected = col.type === "checkbox" || col.type === "files" ? undefined : before;
    writeCell(rowId, col, v.value, expected);
    return true;
  }

  function writeCell(rowId: string, col: ColumnSpec, value: RowValue, expected: RowValue | undefined) {
    win.patchCell(rowId, col.column_id, value);
    const update = { _id: rowId, values: { [col.column_id]: value }, ...(expected === undefined ? {} : { expect: { [col.column_id]: expected } }) };
    Databases.updateRows(docId, table.table_id, [update])
      .then((r) => {
        onRowsMutated();
        if (r.missing.length > 0) {
          toast({ body: t("database.row.deletedElsewhere"), type: "error" });
          win.refetch();
        }
        const conflict = r.conflicts?.find((c) => c._id === rowId);
        if (conflict) {
          const theirs = conflict.values[col.column_id] ?? null;
          win.patchCell(rowId, col.column_id, theirs);
          const useMine = () => {
            dismiss();
            writeCell(rowId, col, value, theirs);
          };
          const dismiss = toast({
            body:
              theirs === null
                ? t("database.row.clearedWhileEditing")
                : t("database.row.changedWhileEditing", { value: cellDisplay(col, theirs) }),
            type: "error",
            uniqueID: `db-cell-conflict:${rowId}:${col.column_id}`,
            endContent: <Button label={t("database.row.useMine")} variant="ghost" size="sm" onClick={useMine} />,
          });
        }
      })
      .catch((e: ApiError) => {
        // Refetch instead of restoring the old value, which could clobber a newer save that raced this one.
        win.refetch();
        if (columnGone(e)) {
          // The typed text goes nowhere now, so the message carries it for the person to copy.
          const typed = value === null ? "" : cellDisplay(col, value);
          toast({
            body: typed === "" ? t("database.row.columnDeletedWhileEditing") : t("database.row.columnDeletedTyped", { text: typed }),
            type: "error",
            uniqueID: `db-column-gone:${col.column_id}`,
          });
          onSchemaChange();
          return;
        }
        surfaceError(e, t("database.row.saveFailed"));
      });
  }

  const cells: CellHandlers = {
    edit: (rowId, columnId, seed) => setEditing({ rowId, columnId, ...(seed === undefined ? {} : { seed }) }),
    commit: commitCell,
    cancel(rowId, columnId, via) {
      setEditing(null);
      if (via === "escape") pendingFocus.current = { rowId, columnId };
    },
    key: onCellKey,
    copy(e, rowId, col) {
      // A selection of page text is the reader's to copy.
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && selection.toString() !== "") return;
      const row = rows.find((r) => r._id === rowId);
      e.preventDefault();
      e.clipboardData.setData("text/plain", copiedText(col, row?.[col.column_id]));
    },
    paste: (text, rowId, col) => void pasteAt(text, rowId, col),
  };

  /** Keys on a cell that is not being edited, spreadsheet style. */
  function onCellKey(e: KeyboardEvent, rowId: string, col: ColumnSpec) {
    if (e.defaultPrevented || (e.altKey && e.key.startsWith("Arrow"))) return;
    const step = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[e.key];
    if (step && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
      e.preventDefault();
      moveFocus(rowId, col.column_id, step[0]!, step[1]!);
      return;
    }
    // The rest acts on a text-like cell's own button; a checkbox or a file link keeps its keys.
    const target = e.target as HTMLElement;
    if (!target.classList.contains("db-cell") || target.getAttribute("aria-disabled") === "true") return;
    if (e.key === "F2") {
      e.preventDefault();
      cells.edit(rowId, col.column_id);
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      commitCell(rowId, col, { ok: true, value: null }, "pick");
    } else if (isPrintableKey(e)) {
      // A date picker cannot start from a typed character, and a number only from one that can begin a number.
      if (col.type === "date" || (col.type === "number" && !isNumberSeed(e.key))) return;
      e.preventDefault();
      cells.edit(rowId, col.column_id, col.type === "single_select" ? undefined : e.key);
    }
  }

  /**
   * Pasted text from `rowId`/`col` on: one value goes through the cell like a typed one, a block
   * fills cells right and down, adding rows past the last, as one update and one insert.
   */
  async function pasteAt(text: string, rowId: string, col: ColumnSpec) {
    setEditing(null);
    if (readOnly) return;
    const block = parseClipboard(text);
    if (block.length === 1 && block[0]!.length === 1) {
      if (col.type !== "files") commitCell(rowId, col, pastedInput(col, block[0]![0]!), "pick");
      return;
    }
    if (block.length > DATABASE_MAX_ROWS_PER_WRITE) {
      toast({ body: t("database.grid.pasteTooLarge", { max: DATABASE_MAX_ROWS_PER_WRITE }), type: "error" });
      return;
    }
    const plan = planPaste({ block, rows: shownRows, columns: visibleColumns, rowId, columnId: col.column_id, canAddRows: rows.length >= total });
    try {
      if (plan.updates.length > 0) await Databases.updateRows(docId, table.table_id, plan.updates);
      if (plan.inserts.length > 0) await Databases.insertRows(docId, table.table_id, plan.inserts);
      onRowsMutated();
      win.refetch();
      toast({
        body:
          plan.skipped > 0
            ? t("database.grid.pastedSkipped", { rows: plan.rows, columns: plan.columns, skipped: plan.skipped })
            : t("database.grid.pasted", { rows: plan.rows, columns: plan.columns }),
        type: plan.skipped > 0 ? "error" : "info",
      });
    } catch (e) {
      surfaceError(e, t("database.grid.pasteFailed"));
      win.refetch();
    }
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
          body: filtered ? t("database.grid.rowAddedFiltered") : t("database.grid.rowAddedSorted"),
          type: "info",
        });
        return;
      }
      const id = r.row_ids[0];
      if (!id) return win.refetch();
      win.appendRow(id);
      const first = columns.find((c) => c.type !== "checkbox" && c.type !== "files");
      if (first) setEditing({ rowId: id, columnId: first.column_id });
    } catch (e) {
      surfaceError(e, t("database.grid.addRowFailed"));
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
      surfaceError(e, t("database.grid.deleteRowsFailed"));
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
          body: r.coerced ? t("database.grid.typeChangedCoerced", { count: r.coerced }) : t("database.grid.typeChanged"),
          type: "info",
        });
      } else {
        await Databases.addColumn(docId, table.table_id, spec);
      }
      setColDialog(null);
      onSchemaChange();
    } catch (e) {
      surfaceError(e, t("database.grid.saveColumnFailed"));
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
      surfaceError(e, t("database.grid.renameColumnFailed"));
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
      surfaceError(e, t("database.grid.deleteColumnFailed"));
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
      surfaceError(e, t("database.grid.saveViewFailed"));
    }
  }

  async function createView(name: string) {
    try {
      const r = await Databases.createView(docId, table.table_id, { name, ...effShape });
      onSchemaChange();
      onSelectView(r.view.view_id);
    } catch (e) {
      surfaceError(e, t("database.grid.createViewFailed"));
    }
  }

  async function renameView(name: string) {
    if (!renamingView) return;
    try {
      await Databases.updateView(docId, table.table_id, renamingView.view_id, { name });
      onSchemaChange();
    } catch (e) {
      surfaceError(e, t("database.grid.renameViewFailed"));
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
      surfaceError(e, t("database.grid.deleteViewFailed"));
    } finally {
      setDeleteViewBusy(false);
    }
  }

  const renderRow = (row: RowRecord) => (
    <GridRow
      key={row._id}
      databaseId={docId}
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
      editing={editing?.rowId === row._id ? editing : null}
      cells={cells}
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
              {t("database.grid.selected", { count: selected.size })}
            </Text>
            <Button label={t("common.delete")} variant="secondary" size="sm" icon={<Trash2 size={15} />} onClick={() => setConfirmDelete(true)} />
            <IconButton label={t("database.grid.clearSelection")} variant="ghost" size="sm" icon={<X size={15} />} onClick={() => setSelected(new Set())} />
          </HStack>
        ) : (
          columns.length > 0 && (
            <ViewToolbar
              columns={columns}
              search={searchText}
              onSearch={setSearchText}
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
              title={t("database.grid.noColumns")}
              description={t("database.grid.noColumnsHelp")}
              icon={<Columns3 size={22} />}
              actions={
                !readOnly ? (
                  <Button label={t("database.column.add")} variant="primary" size="sm" onClick={() => setColDialog({ retypeOf: null })} />
                ) : undefined
              }
            />
          </div>
        ) : (
          <>
            <table className={`db-grid${selected.size > 0 ? " db-grid--selecting" : ""}`} ref={tableRef}>
              <thead>
                <tr>
                  <th className="db-grid__check">
                    <span className="db-row__check">
                      <CheckboxInput
                        label={t("database.grid.selectAll")}
                        isLabelHidden
                        size="sm"
                        value={headerCheck}
                        isDisabled={rows.length === 0}
                        onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r._id)))}
                      />
                    </span>
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
                        onNumberFormat={() => setFormattingCol(c)}
                        onDescribe={() => setDescribingCol(c)}
                        onDelete={() => setDeletingCol(c)}
                      />
                    </th>
                  ))}
                  {overlay.ghostCols.map((g) => (
                    <th key={g.columnId} className="db-th--ghost" title={t("database.grid.proposedColumn", { agent: g.agent })}>
                      <span className="db-col-head__label">{g.display}</span>
                      <span className="db-ghost-tag">{t("database.grid.proposedTag")}</span>
                    </th>
                  ))}
                  {!readOnly && (
                    <th className="db-grid__addcol">
                      <IconButton label={t("database.column.add")} variant="ghost" size="sm" icon={<Plus size={15} />} onClick={() => setColDialog({ retypeOf: null })} />
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {groupedRows
                  ? groupedRows.map((seg) => {
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
                <Spinner label={t("database.grid.loadingRows")} />
              </div>
            )}
            {!win.loading && win.loadError && (
              <div className="db-grid-center">
                <EmptyState isCompact title={t("database.grid.loadFailedTitle")} description={t("database.grid.tryAgain")} />
                <Button label={t("common.retry")} variant="secondary" size="sm" onClick={win.refetch} />
              </div>
            )}
            {/* An empty grid offers New row as its primary action; the appender strip waits for a first row. */}
            {isEmpty ? (
              <div className="db-grid-center">
                <EmptyState
                  title={
                    searching ? t("database.grid.noSearchMatches", { query: search }) : filtered ? t("database.grid.noMatches") : t("database.grid.noRows")
                  }
                  description={
                    searching
                      ? t("database.grid.noSearchMatchesHelp")
                      : filtered
                        ? t("database.grid.noMatchesHelp")
                        : readOnly
                          ? t("database.grid.noRowsReader")
                          : t("database.grid.noRowsWriter")
                  }
                  icon={searching ? <Search size={26} /> : filtered ? <FilterIcon size={26} /> : <Rows3 size={26} />}
                  actions={
                    searching ? (
                      <Button label={t("database.search.clear")} variant="secondary" size="sm" onClick={() => setSearchText("")} />
                    ) : filtered ? (
                      <Button label={t("database.filter.clear")} variant="secondary" size="sm" onClick={() => setShape((sh) => ({ ...sh, filter: null }))} />
                    ) : readOnly ? undefined : (
                      <Button label={t("database.grid.newRow")} variant="primary" size="sm" icon={<Plus size={15} />} onClick={addRow} />
                    )
                  }
                />
              </div>
            ) : (
              !win.loading && (
                <div className="db-foot">
                  {!readOnly && (
                    <button className="db-newrow" onClick={addRow}>
                      <Plus size={14} /> {t("database.grid.newRow")}
                    </button>
                  )}
                  {!win.loadError && (
                    <span className="db-foot__count">
                      {rows.length < total ? t("database.grid.someRows", { loaded: rows.length, total }) : t("database.grid.rows", { count: total })}
                    </span>
                  )}
                </div>
              )
            )}
            {win.groupsTruncated && (
              <div className="db-grid-center">
                <Text type="supporting" color="secondary">
                  {t("database.grid.groupsTruncated", { count: win.groups?.length ?? 0 })}
                </Text>
              </div>
            )}
            {!win.loading && rows.length < total && (
              <div className="db-loadmore">
                <Button
                  label={win.loadingMore ? t("common.loading") : t("database.grid.loadMore")}
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
      <NumberFormatDialog
        isOpen={formattingCol !== null}
        docId={docId}
        tableId={table.table_id}
        column={formattingCol}
        onSaved={onSchemaChange}
        onError={surfaceError}
        onClose={() => setFormattingCol(null)}
      />
      <PromptDialog
        isOpen={renamingCol !== null}
        title={t("database.column.rename")}
        label={t("database.column.name")}
        initialValue={renamingCol?.display ?? ""}
        submitLabel={t("common.rename")}
        onSubmit={renameColumn}
        onClose={() => setRenamingCol(null)}
      />
      <AlertDialog
        isOpen={deletingCol !== null}
        onOpenChange={(o) => !o && !deleteColBusy && setDeletingCol(null)}
        title={t("database.column.deleteTitle", { name: deletingCol?.display ?? "" })}
        description={t("database.column.deleteBody")}
        actionLabel={t("database.column.delete")}
        isActionLoading={deleteColBusy}
        onAction={deleteColumn}
      />
      <PromptDialog
        isOpen={newViewOpen}
        title={t("database.views.saveAs")}
        label={t("database.views.name")}
        submitLabel={t("common.save")}
        onSubmit={createView}
        onClose={() => setNewViewOpen(false)}
      />
      <PromptDialog
        isOpen={renamingView !== null}
        title={t("database.views.rename")}
        label={t("database.views.name")}
        initialValue={renamingView?.name ?? ""}
        submitLabel={t("common.rename")}
        onSubmit={renameView}
        onClose={() => setRenamingView(null)}
      />
      <AlertDialog
        isOpen={deletingView !== null}
        onOpenChange={(o) => !o && !deleteViewBusy && setDeletingView(null)}
        title={t("database.views.deleteTitle", { name: deletingView?.name ?? "" })}
        description={t("database.views.deleteBody")}
        actionLabel={t("database.views.deleteAction")}
        isActionLoading={deleteViewBusy}
        onAction={deleteView}
      />
      <AlertDialog
        isOpen={confirmDelete}
        onOpenChange={(o) => !o && !bulkBusy && setConfirmDelete(false)}
        title={t("database.grid.deleteRowsTitle", { count: selected.size })}
        description={t("database.grid.deleteRowsBody")}
        actionLabel={t("database.grid.deleteRows")}
        isActionLoading={bulkBusy}
        onAction={deleteSelected}
      />
    </div>
  );
}
