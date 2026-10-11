import type { ClipboardEvent, KeyboardEvent, ReactNode } from "react";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { ChevronDown, ChevronRight, FileText, Maximize2 } from "lucide-react";
import type { ColumnSpec, DbRunOpRowsInsert, RowRecord, RowValue } from "@stuga/protocol/databases/types";
import { fileLinks } from "@stuga/protocol/databases/cells";
import { CellEditor, type CommitVia } from "../CellEditor";
import { FilesCell } from "../FilesCell";
import { pageStateOf } from "../model/row-ref";
import type { FieldInput } from "../model/field-input";
import { formatNumber } from "../model/numbers";
import type { GhostColumn } from "./pending-overlay";
import { formatLocale, t } from "../../i18n/i18n";
import { calendarDay, fmtInt } from "../../lib/format";

/** Ghost rows painted for one pending insert before it collapses to a count. */
const GHOST_PREVIEW_MAX = 50;

/** A cell's value as the grid shows it: numbers in the column's format, dates as the reader writes them. */
export function cellDisplay(col: ColumnSpec | undefined, v: RowValue | undefined): string {
  if (v === null || v === undefined) return "";
  if (col?.type === "files") return fileLinks(v).map((f) => f.name).join(", ");
  if (col?.type === "checkbox") return v === 1 ? "✓" : "—";
  if (col?.type === "number" && typeof v === "number") return formatNumber(v, col.options?.format, formatLocale());
  if (col?.type === "date" && typeof v === "string") return calendarDay(v);
  return String(v);
}

/** What the grid does with a cell; the row says which. */
export interface CellHandlers {
  /** Open the editor; `seed` is the character that opened it by typing. */
  edit(rowId: string, columnId: string, seed?: string): void;
  /** False keeps the editor open: the input was invalid. */
  commit(rowId: string, col: ColumnSpec, input: FieldInput, via: CommitVia): boolean;
  cancel(rowId: string, columnId: string, via: "escape" | "blur"): void;
  /** A key on a cell that is not being edited: moving, opening, clearing. */
  key(e: KeyboardEvent, rowId: string, col: ColumnSpec): void;
  copy(e: ClipboardEvent, rowId: string, col: ColumnSpec): void;
  /** A paste on a cell, or a block pasted into its editor. */
  paste(text: string, rowId: string, col: ColumnSpec): void;
}

export function GridRow({
  databaseId,
  row,
  columns,
  ghostCols,
  proposed,
  proposedDelete,
  selected,
  onSelect,
  isOpen,
  onOpenRow,
  readOnly,
  editing,
  cells,
}: {
  databaseId: string;
  row: RowRecord;
  /** The visible columns, in order. */
  columns: ColumnSpec[];
  ghostCols: GhostColumn[];
  /** Values an agent proposes for this row, by column id. */
  proposed: { agent: string; values: Record<string, RowValue> } | undefined;
  proposedDelete: boolean;
  selected: boolean;
  onSelect: (selected: boolean) => void;
  /** The dock has this row open. */
  isOpen: boolean;
  onOpenRow: (rowId: string) => void;
  readOnly: boolean;
  /** The cell of this row being edited, and what typing opened it with. */
  editing: { columnId: string; seed?: string } | null;
  cells: CellHandlers;
}) {
  // A page in the trash is not shown as one.
  const hasPage = pageStateOf(row).kind === "live";
  const rowClass =
    [selected ? "db-row--selected" : "", proposedDelete ? "db-row--proposed-delete" : "", isOpen ? "db-row--open" : ""]
      .filter(Boolean)
      .join(" ") || undefined;
  const locked = readOnly || proposedDelete;

  return (
    <tr className={rowClass} data-row={row._id}>
      <td className="db-grid__check">
        <span className="db-row__start">
          <span className="db-row__check">
            <CheckboxInput label={t("database.row.select")} isLabelHidden size="sm" value={selected} onChange={(v) => onSelect(v === true)} />
          </span>
          {/* Stays visible on a row that has a page, so those rows can be told apart. */}
          <button
            className={`db-row__open${hasPage ? " db-row__open--page" : ""}`}
            title={hasPage ? t("database.row.openWithPage") : t("database.row.open")}
            aria-label={hasPage ? t("database.row.openHasPage") : t("database.row.open")}
            onClick={() => onOpenRow(row._id)}
          >
            {hasPage ? <FileText size={14} /> : <Maximize2 size={13} />}
          </button>
        </span>
      </td>
      {columns.map((col) => {
        const value = row[col.column_id] ?? null;
        const isEditing = editing?.columnId === col.column_id;
        const typeClass = col.type === "number" ? " db-td--number" : "";
        // Keys and the clipboard reach the grid from any control in the cell but its editor.
        const cellEvents = isEditing
          ? {}
          : {
              onKeyDown: (e: KeyboardEvent) => cells.key(e, row._id, col),
              onCopy: (e: ClipboardEvent) => cells.copy(e, row._id, col),
              onPaste: (e: ClipboardEvent) => {
                if (locked) return;
                e.preventDefault();
                cells.paste(e.clipboardData.getData("text/plain"), row._id, col);
              },
            };
        // A proposed value shows instead of the cell and is decided in the review banner.
        const proposedValue = proposed && col.column_id in proposed.values ? proposed.values[col.column_id] : undefined;
        if (proposedValue !== undefined) {
          return (
            <td
              key={col.column_id}
              className={`db-td db-td--proposed${typeClass}`}
              data-col={col.column_id}
              tabIndex={-1}
              onKeyDown={(e) => cells.key(e, row._id, col)}
              onCopy={(e) => cells.copy(e, row._id, col)}
            >
              <span
                className="db-cell db-cell--proposed"
                title={t("database.row.proposedCurrently", { agent: proposed!.agent, value: value === null ? t("database.value.empty") : cellDisplay(col, value) })}
              >
                {cellDisplay(col, proposedValue)}
              </span>
            </td>
          );
        }
        if (col.type === "checkbox") {
          return (
            <td key={col.column_id} className="db-td db-td--checkbox" data-col={col.column_id} {...cellEvents}>
              <CheckboxInput
                label={col.display}
                isLabelHidden
                size="sm"
                value={value === 1}
                isDisabled={locked}
                onChange={(v) => cells.commit(row._id, col, { ok: true, value: v === true }, "pick")}
              />
            </td>
          );
        }
        if (col.type === "files") {
          return (
            <td key={col.column_id} className="db-td" data-col={col.column_id} {...cellEvents}>
              <FilesCell
                databaseId={databaseId}
                label={col.display}
                value={value}
                readOnly={locked}
                onChange={(v) => cells.commit(row._id, col, { ok: true, value: v }, "pick")}
              />
            </td>
          );
        }
        return (
          <td key={col.column_id} className={`db-td${typeClass}${isEditing ? " db-td--editing" : ""}`} data-col={col.column_id} {...cellEvents}>
            {isEditing ? (
              <CellEditor
                column={col}
                initial={value}
                seed={editing?.seed}
                onCommit={(input, via) => cells.commit(row._id, col, input, via)}
                onCancel={(via) => cells.cancel(row._id, col.column_id, via)}
                onPasteBlock={(text) => cells.paste(text, row._id, col)}
              />
            ) : (
              // Focusable while locked too, so a reader can move through the cells and copy them.
              <button
                className="db-cell"
                aria-disabled={locked || undefined}
                onClick={() => !locked && cells.edit(row._id, col.column_id)}
                title={
                  proposedDelete
                    ? t("database.row.proposedDelete")
                    : readOnly
                      ? undefined
                      : col.type === "date"
                        ? t("database.row.enterToEdit")
                        : t("database.row.typeToEdit")
                }
              >
                {cellDisplay(col, value)}
              </button>
            )}
          </td>
        );
      })}
      {ghostCols.map((g) => {
        // An update may target a column that is itself still proposed.
        const proposedValue = proposed?.values[g.columnId];
        return (
          <td key={g.columnId} className="db-td db-td--ghostcol">
            {proposedValue !== undefined && (
              <span className="db-cell db-cell--proposed" title={t("database.row.proposedBy", { agent: proposed!.agent })}>
                {cellDisplay(undefined, proposedValue)}
              </span>
            )}
          </td>
        );
      })}
      {!readOnly && <td className="db-grid__addcol" />}
    </tr>
  );
}

/** One pending insert op: its ghost rows and one action row, since the op stands or falls together. */
export function GhostInsertRows({
  columns,
  ghostCols,
  span,
  agent,
  payload,
  busy,
  readOnly,
  onDecide,
}: {
  columns: ColumnSpec[];
  ghostCols: GhostColumn[];
  span: number;
  agent: string;
  payload: DbRunOpRowsInsert;
  busy: boolean;
  readOnly: boolean;
  onDecide: (decision: "accept" | "reject") => void;
}) {
  // A staged import can be one op of many thousands of rows; its detail arrives sampled.
  const n = payload.rows_sampled_from ?? payload.rows.length;
  const shownRows = payload.rows.slice(0, GHOST_PREVIEW_MAX);
  return (
    <>
      {shownRows.map((cells, i) => (
        <tr key={payload.row_ids[i] ?? i} className={`db-row--ghost${busy ? " db-row--ghost-busy" : ""}`}>
          <td className="db-grid__check" />
          {columns.map((col) => (
            <td key={col.column_id} className={`db-td${col.type === "number" ? " db-td--number" : ""}`}>
              <span className="db-cell db-cell--ghost">{cellDisplay(col, cells[col.column_id])}</span>
            </td>
          ))}
          {ghostCols.map((g) => (
            <td key={g.columnId} className="db-td db-td--ghostcol">
              <span className="db-cell db-cell--ghost">{cellDisplay(undefined, cells[g.columnId])}</span>
            </td>
          ))}
          {!readOnly && <td className="db-grid__addcol" />}
        </tr>
      ))}
      <tr className="db-ghost-actions">
        <td colSpan={span}>
          <span className="db-ghost-actions__label">
            {n > shownRows.length
              ? t("database.row.ghostProposesSome", { agent, count: n, shown: shownRows.length })
              : t("database.row.ghostProposes", { agent, count: n })}
          </span>
          {!readOnly && (
            <span className="db-ghost-actions__buttons">
              <Button label={t("common.accept")} variant="primary" size="sm" isDisabled={busy} onClick={() => onDecide("accept")} />
              <Button label={t("common.reject")} variant="ghost" size="sm" isDisabled={busy} onClick={() => onDecide("reject")} />
            </span>
          )}
        </td>
      </tr>
    </>
  );
}

/** A group header row and its rows. `count` covers the whole filtered set, `loaded` what the window holds. */
export function GroupSection({
  label,
  count,
  loaded,
  span,
  collapsed,
  onToggle,
  children,
}: {
  label: string;
  count: number;
  loaded: number;
  span: number;
  collapsed: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <>
      <tr className="db-group-row">
        <td colSpan={span}>
          <button className="db-group-row__btn" onClick={onToggle} aria-expanded={!collapsed}>
            {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
            <span className="db-group-row__label">{label}</span>
            <span className="db-group-row__count">{loaded < count && !collapsed ? t("database.grid.groupSomeRows", { loaded, count }) : fmtInt(count)}</span>
          </button>
        </td>
      </tr>
      {children}
    </>
  );
}
