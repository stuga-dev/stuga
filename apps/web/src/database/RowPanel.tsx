/**
 * One row opened in the dock: every field, hidden columns included, and the
 * way to its page. The panel fetches the row itself so a `?row=` link works
 * when the grid's window does not hold it. Fields are standing inputs rather
 * than CellEditor, which unmounts after one commit.
 */
import { useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { HStack } from "@astryxdesign/core/HStack";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { useToast } from "@astryxdesign/core/Toast";
import { FileText, FilePlus2, RotateCcw } from "lucide-react";
import { validateCellValue } from "@stuga/protocol/databases/cells";
import { Databases } from "../api";
import type { ColumnSpec, RowInputValue, RowRecord, RowValue, TableSchema } from "@stuga/protocol/databases/types";
import { absoluteTime } from "../lib/format";
import { pageHref, pageStateOf, rowTitle } from "./model/row-ref";
import { parseFieldInput } from "./model/field-input";
import { errorMessage } from "../lib/http/client";

/** What a page button does; the one in flight labels its button. */
type PageAction = "open" | "create" | "restore";

interface RowPanelProps {
  docId: string;
  table: TableSchema;
  rowId: string;
  /** Bumped by the page after data changes; the row is re-read. */
  refreshKey: number;
  readOnly: boolean;
  /** A field was saved; the page refetches the grid. */
  onSaved: () => void;
  /** A write was refused with 403; the page turns read-only. */
  onWriteDenied: () => void;
}

export function RowPanel({ docId, table, rowId, refreshKey, readOnly, onSaved, onWriteDenied }: RowPanelProps) {
  const nav = useNavigate();
  const toast = useToast();
  const columns = [...table.columns].sort((a, b) => a.position - b.position);
  const [row, setRow] = useState<RowRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [pageBusy, setPageBusy] = useState<PageAction | null>(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setMissing(false);
    Databases.listRows(docId, table.table_id, { filter: { column_id: "_id", op: "eq", value: rowId }, limit: 1 })
      .then((r) => {
        if (!live) return;
        const found = r.rows[0] ?? null;
        setRow(found);
        setMissing(found === null);
        setLoading(false);
      })
      .catch((e) => {
        if (!live) return;
        setLoading(false);
        toast({ body: errorMessage(e, "Couldn't load the row."), type: "error" });
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, table.table_id, rowId, refreshKey, reloadKey]);

  function surfaceError(e: unknown, fallback: string) {
    if ((e as { status?: number }).status === 403) onWriteDenied();
    toast({ body: errorMessage(e, fallback), type: "error" });
  }

  /** False when the input was rejected, so the field keeps the draft for a fix. */
  function commitField(col: ColumnSpec, input: RowInputValue): boolean {
    const v = validateCellValue(col.type, col.options, input);
    if (!v.ok) {
      toast({ body: v.reason, type: "error" });
      return false;
    }
    if (!row || (row[col.column_id] ?? null) === v.value) return true;
    setRow({ ...row, [col.column_id]: v.value });
    Databases.updateRows(docId, table.table_id, [{ _id: rowId, values: { [col.column_id]: v.value } }])
      .then((r) => {
        if (r.missing.length > 0) {
          toast({ body: "That row was deleted by someone else.", type: "error" });
          setMissing(true);
        }
        onSaved();
      })
      .catch((e) => {
        // Re-read rather than restore the captured value, which a racing save may have superseded.
        surfaceError(e, "Couldn't save the change.");
        setReloadKey((k) => k + 1);
      });
    return true;
  }

  const pageState = pageStateOf(row);
  const ref = { database_id: docId, table_id: table.table_id, row_id: rowId };

  /**
   * Go to the row's page. A writer asks the node, which restores a trashed page
   * or creates a missing one; "create" makes a new page even when the row's is
   * in the Trash, and leaves that one there.
   */
  async function goToPage(action: PageAction) {
    if (readOnly) {
      if (pageState.kind === "live") nav(pageHref(pageState.doc_id, ref));
      return;
    }
    setPageBusy(action);
    try {
      const r = await Databases.openRowPage(docId, table.table_id, rowId, { replaceTrashed: action === "create" });
      if (r.created || r.restored) onSaved();
      nav(pageHref(r.doc_id, ref));
    } catch (e) {
      surfaceError(e, `Couldn't ${action} the page.`);
    } finally {
      setPageBusy(null);
    }
  }

  const pageButton = (action: PageAction, label: string, busyLabel: string, icon: ReactNode, isPrimary = false) => (
    <Button
      label={pageBusy === action ? busyLabel : label}
      variant={isPrimary ? "primary" : "secondary"}
      size="sm"
      icon={icon}
      isDisabled={pageBusy !== null}
      onClick={() => void goToPage(action)}
    />
  );

  if (loading && !row) {
    return (
      <div className="dock-panel row-panel">
        <div className="db-grid-center">
          <Spinner label="Loading row…" />
        </div>
      </div>
    );
  }
  if (missing || !row) {
    return (
      <div className="dock-panel row-panel">
        <div className="row-panel__body">
          <Text type="supporting" color="secondary">
            This row was deleted.
          </Text>
        </div>
      </div>
    );
  }

  return (
    <div className="dock-panel row-panel" aria-label="Row">
      <div className="row-panel__head">
        <Text type="large" weight="semibold" maxLines={2}>
          {rowTitle(columns, row)}
        </Text>
        <Text type="supporting" color="secondary">
          Created {absoluteTime(new Date(row._created_at).toISOString())} · Edited {absoluteTime(new Date(row._updated_at).toISOString())}
        </Text>
      </div>
      <div className="row-panel__body">
        <dl className="row-panel__fields">
          {columns.map((col) => {
            const value = row[col.column_id] ?? null;
            const about = col.description?.trim();
            return (
              <div key={col.column_id} className="row-panel__field">
                <dt className="row-panel__label" title={about ? `${col.type}\n\n${about}` : col.type}>
                  {col.display}
                </dt>
                <dd className="row-panel__value">
                  {col.type === "checkbox" ? (
                    <CheckboxInput
                      label={col.display}
                      isLabelHidden
                      size="sm"
                      value={value === 1}
                      isDisabled={readOnly}
                      onChange={(v) => commitField(col, v === true)}
                    />
                  ) : (
                    <FieldEditor
                      // Keyed on the applied value, so a save or a refetch re-seeds the draft.
                      key={`${col.column_id}:${value === null ? "" : String(value)}`}
                      column={col}
                      value={value}
                      disabled={readOnly}
                      onCommit={(input) => commitField(col, input)}
                    />
                  )}
                </dd>
              </div>
            );
          })}
        </dl>
      </div>
      <div className="row-panel__foot">
        {readOnly && pageState.kind !== "live" ? (
          <Text type="supporting" color="secondary">
            {pageState.kind === "trashed" ? "This row's page is in the Trash." : "This row has no page."}
          </Text>
        ) : (
          <>
            <HStack gap={2} vAlign="center" wrap="wrap">
              {pageState.kind === "live"
                ? pageButton("open", "Open page", "Opening…", <FileText size={15} />)
                : pageButton("create", "Create page", "Creating…", <FilePlus2 size={15} />, true)}
              {pageState.kind === "trashed" && pageButton("restore", "Restore page", "Restoring…", <RotateCcw size={15} />)}
            </HStack>
            <Text type="supporting" color="secondary">
              {pageState.kind === "live"
                ? "Notes, comments and versions for this row."
                : pageState.kind === "trashed"
                  ? "Restore the trashed page or create a new one."
                  : "Add notes, comments and versions to this row."}
            </Text>
          </>
        )}
      </div>
    </div>
  );
}

interface FieldEditorProps {
  column: ColumnSpec;
  value: RowValue;
  disabled: boolean;
  /** False keeps the draft: the input was rejected. */
  onCommit: (input: RowInputValue) => boolean;
}

/** A non-checkbox field. Saves on blur or Enter (⌘/Ctrl+Enter in a text area); Escape drops the draft. */
function FieldEditor({ column, value, disabled, onCommit }: FieldEditorProps) {
  const applied = value === null ? "" : String(value);
  const [raw, setRaw] = useState(applied);

  function commit() {
    if (raw !== applied) onCommit(parseFieldInput(column.type, raw));
  }

  if (column.type === "single_select") {
    const choices = column.options?.choices ?? [];
    return (
      <select
        className="db-select row-panel__select"
        aria-label={column.display}
        value={applied}
        disabled={disabled}
        onChange={(e) => onCommit(e.target.value === "" ? null : e.target.value)}
      >
        <option value="">—</option>
        {choices.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
    );
  }

  if (column.type === "text") {
    const lines = raw.split("\n").length;
    return (
      <textarea
        className="row-panel__textarea"
        aria-label={column.display}
        rows={Math.min(8, Math.max(2, lines))}
        value={raw}
        disabled={disabled}
        onChange={(e) => setRaw(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.stopPropagation();
            setRaw(applied);
          }
        }}
      />
    );
  }

  return (
    <input
      className="row-panel__input"
      aria-label={column.display}
      type={column.type === "number" ? "number" : "date"}
      step={column.type === "number" ? "any" : undefined}
      value={raw}
      disabled={disabled}
      onChange={(e) => setRaw(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.stopPropagation();
          setRaw(applied);
        }
      }}
    />
  );
}
