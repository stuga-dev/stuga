/**
 * The in-place editor for one grid cell (checkbox cells toggle instead). Enter
 * or blur commits and Escape cancels; a select commits on choose. It emits the
 * raw input and the grid validates it. Native controls, since a form field's
 * chrome doesn't fit a table cell.
 */
import { useEffect, useRef, useState } from "react";
import type { ColumnSpec, RowInputValue, RowValue } from "@stuga/protocol/databases/types";
import { parseFieldInput } from "./model/field-input";

interface CellEditorProps {
  column: ColumnSpec;
  initial: RowValue;
  /** False rejects the input and keeps the editor open. */
  onCommit: (input: RowInputValue) => boolean | void;
  onCancel: () => void;
}

export function CellEditor({ column, initial, onCommit, onCancel }: CellEditorProps) {
  const [raw, setRaw] = useState(initial === null ? "" : String(initial));
  const inputRef = useRef<HTMLInputElement>(null);
  const selectRef = useRef<HTMLSelectElement>(null);
  // A commit unmounts the editor, whose blur would otherwise commit a second time.
  const done = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
    const sel = selectRef.current;
    if (sel) {
      sel.focus();
      try {
        (sel as HTMLSelectElement & { showPicker?: () => void }).showPicker?.();
      } catch {
        // Some browsers require a user gesture; focus alone is enough.
      }
    }
  }, []);

  function finish(fn: () => void) {
    if (done.current) return;
    done.current = true;
    fn();
  }

  function commit(input: RowInputValue) {
    if (done.current) return;
    if (onCommit(input) !== false) done.current = true;
  }

  const parsed = () => parseFieldInput(column.type, raw);

  if (column.type === "single_select") {
    const choices = column.options?.choices ?? [];
    return (
      <select
        ref={selectRef}
        className="db-cell-select"
        aria-label={column.display}
        value={initial === null ? "" : String(initial)}
        onChange={(e) => commit(e.target.value === "" ? null : e.target.value)}
        onBlur={() => finish(onCancel)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            finish(onCancel);
          }
        }}
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

  const inputType = column.type === "number" ? "number" : column.type === "date" ? "date" : "text";
  return (
    <input
      ref={inputRef}
      className="db-cell-input"
      aria-label={column.display}
      type={inputType}
      step={column.type === "number" ? "any" : undefined}
      value={raw}
      onChange={(e) => setRaw(e.target.value)}
      onBlur={() => commit(parsed())}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit(parsed());
        } else if (e.key === "Escape") {
          e.stopPropagation();
          finish(onCancel);
        }
      }}
    />
  );
}
