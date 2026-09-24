import type { ReactNode } from "react";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { ChevronDown, ChevronRight, FileText, Maximize2 } from "lucide-react";
import type { ColumnSpec, DbRunOpRowsInsert, RowInputValue, RowRecord, RowValue } from "@stuga/protocol/databases/types";
import { CellEditor } from "../CellEditor";
import { pageStateOf } from "../model/row-ref";
import type { GhostColumn } from "./pending-overlay";

/** Ghost rows painted for one pending insert before it collapses to a count. */
const GHOST_PREVIEW_MAX = 50;

function display(col: ColumnSpec | undefined, v: RowValue | undefined): string {
  if (v === null || v === undefined) return "";
  return col?.type === "checkbox" ? (v === 1 ? "✓" : "—") : String(v);
}

export function GridRow({
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
  editingColumnId,
  onEdit,
  onCommit,
}: {
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
  editingColumnId: string | null;
  onEdit: (columnId: string | null) => void;
  /** False keeps the editor open: the input was invalid. */
  onCommit: (col: ColumnSpec, input: RowInputValue) => boolean;
}) {
  // A page in the trash is not shown as one.
  const hasPage = pageStateOf(row).kind === "live";
  const rowClass =
    [selected ? "db-row--selected" : "", proposedDelete ? "db-row--proposed-delete" : "", isOpen ? "db-row--open" : ""]
      .filter(Boolean)
      .join(" ") || undefined;

  return (
    <tr className={rowClass}>
      <td className="db-grid__check">
        <span className="db-row__start">
          <CheckboxInput label="Select row" isLabelHidden size="sm" value={selected} onChange={(v) => onSelect(v === true)} />
          {/* Stays visible on a row that has a page, so those rows can be told apart. */}
          <button
            className={`db-row__open${hasPage ? " db-row__open--page" : ""}`}
            title={hasPage ? "Open row — it has a page" : "Open row"}
            aria-label={hasPage ? "Open row (has a page)" : "Open row"}
            onClick={() => onOpenRow(row._id)}
          >
            {hasPage ? <FileText size={14} /> : <Maximize2 size={13} />}
          </button>
        </span>
      </td>
      {columns.map((col) => {
        const value = row[col.column_id] ?? null;
        // A proposed value shows instead of the cell and is decided in the review banner.
        const proposedValue = proposed && col.column_id in proposed.values ? proposed.values[col.column_id] : undefined;
        if (proposedValue !== undefined) {
          return (
            <td key={col.column_id} className="db-td db-td--proposed">
              <span
                className="db-cell db-cell--proposed"
                title={`Proposed by ${proposed!.agent} — currently: ${value === null ? "(empty)" : String(value)}`}
              >
                {display(col, proposedValue)}
              </span>
            </td>
          );
        }
        if (col.type === "checkbox") {
          return (
            <td key={col.column_id} className="db-td db-td--checkbox">
              <CheckboxInput
                label={col.display}
                isLabelHidden
                size="sm"
                value={value === 1}
                isDisabled={readOnly || proposedDelete}
                onChange={(v) => onCommit(col, v === true)}
              />
            </td>
          );
        }
        const isEditing = editingColumnId === col.column_id;
        return (
          <td key={col.column_id} className={`db-td${isEditing ? " db-td--editing" : ""}`}>
            {isEditing ? (
              <CellEditor column={col} initial={value} onCommit={(input) => onCommit(col, input)} onCancel={() => onEdit(null)} />
            ) : (
              <button
                className="db-cell"
                disabled={readOnly || proposedDelete}
                onClick={() => onEdit(col.column_id)}
                title={
                  proposedDelete
                    ? "An agent proposed deleting this row — decide it in the banner above"
                    : readOnly
                      ? undefined
                      : "Click to edit"
                }
              >
                {value === null ? "" : String(value)}
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
              <span className="db-cell db-cell--proposed" title={`Proposed by ${proposed!.agent}`}>
                {display(undefined, proposedValue)}
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
            <td key={col.column_id} className="db-td">
              <span className="db-cell db-cell--ghost">{display(col, cells[col.column_id])}</span>
            </td>
          ))}
          {ghostCols.map((g) => (
            <td key={g.columnId} className="db-td db-td--ghostcol">
              <span className="db-cell db-cell--ghost">{display(undefined, cells[g.columnId])}</span>
            </td>
          ))}
          {!readOnly && <td className="db-grid__addcol" />}
        </tr>
      ))}
      <tr className="db-ghost-actions">
        <td colSpan={span}>
          <span className="db-ghost-actions__label">
            {agent} proposes {n === 1 ? "this row" : `these ${n} rows`}
            {n > shownRows.length ? ` (showing the first ${shownRows.length})` : ""}
          </span>
          {!readOnly && (
            <span className="db-ghost-actions__buttons">
              <Button label="Accept" variant="primary" size="sm" isDisabled={busy} onClick={() => onDecide("accept")} />
              <Button label="Reject" variant="ghost" size="sm" isDisabled={busy} onClick={() => onDecide("reject")} />
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
            <span className="db-group-row__count">{loaded < count && !collapsed ? `${loaded} of ${count}` : count}</span>
          </button>
        </td>
      </tr>
      {children}
    </>
  );
}
