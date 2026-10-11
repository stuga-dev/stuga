/**
 * The in-place editor for one grid cell (checkbox cells toggle instead). Enter
 * or blur commits and Escape cancels; a select commits on choose. It emits the
 * input read for its column and the grid validates it. A cell opened by typing
 * starts from that character, with the caret after it. Native controls, since a
 * form field's chrome doesn't fit a table cell.
 */
import { useEffect, useRef, useState } from "react";
import type { ColumnSpec, RowValue } from "@stuga/protocol/databases/types";
import { DATE_MAX, DATE_MIN, parseFieldInput, unreadableDate, type FieldInput } from "./model/field-input";
import { asOneLine, isRangePaste } from "./model/clipboard";
import { numberForEditing } from "./model/numbers";
import { isComposingKey } from "../lib/ime";
import { formatLocale } from "../i18n/i18n";

/** How an editor closed: Enter moves on down, a picked choice stays on the cell, blur leaves focus where it went. */
export type CommitVia = "enter" | "pick" | "blur";

interface CellEditorProps {
  column: ColumnSpec;
  initial: RowValue;
  /** What a keystroke on the cell started the edit with; it replaces the value. */
  seed?: string;
  /** False rejects the input: the editor stays open, unless it was leaving anyway. */
  onCommit: (input: FieldInput, via: CommitVia) => boolean | void;
  onCancel: (via: "escape" | "blur") => void;
  /** Text holding tabs or line breaks was pasted: it fills cells from this one, in place of the edit. */
  onPasteBlock: (text: string) => void;
}

function initialText(column: ColumnSpec, initial: RowValue): string {
  if (initial === null) return "";
  return column.type === "number" && typeof initial === "number" ? numberForEditing(initial, formatLocale()) : String(initial);
}

export function CellEditor({ column, initial, seed, onCommit, onCancel, onPasteBlock }: CellEditorProps) {
  const [raw, setRaw] = useState(seed ?? initialText(column, initial));
  const inputRef = useRef<HTMLInputElement>(null);
  const selectRef = useRef<HTMLSelectElement>(null);
  // A commit unmounts the editor, whose blur would otherwise commit a second time.
  const done = useRef(false);

  useEffect(() => {
    const input = inputRef.current;
    if (input) {
      input.focus();
      // Typing on the cell carries on after its first character; opening it selects the value to replace.
      if (seed !== undefined && input.type === "text") input.setSelectionRange(input.value.length, input.value.length);
      else input.select();
    }
    const sel = selectRef.current;
    if (sel) {
      sel.focus();
      try {
        (sel as HTMLSelectElement & { showPicker?: () => void }).showPicker?.();
      } catch {
        // Some browsers require a user gesture; focus alone is enough.
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the editor opens
  }, []);

  function finish(fn: () => void) {
    if (done.current) return;
    done.current = true;
    fn();
  }

  function commit(input: FieldInput, via: CommitVia) {
    if (done.current) return;
    if (onCommit(input, via) !== false) done.current = true;
    // A refused value on the way out is dropped, so the editor never stays open behind the person's back.
    else if (via === "blur") finish(() => onCancel("blur"));
  }

  const parsed = (): FieldInput =>
    // A half-typed date leaves the input empty and flags it, which must not read as clearing the cell.
    column.type === "date" && raw === "" && inputRef.current?.validity.badInput ? unreadableDate() : parseFieldInput(column.type, raw);

  if (column.type === "single_select") {
    const choices = column.options?.choices ?? [];
    return (
      <select
        ref={selectRef}
        className="db-cell-select"
        aria-label={column.display}
        value={initial === null ? "" : String(initial)}
        onChange={(e) => commit({ ok: true, value: e.target.value === "" ? null : e.target.value }, "pick")}
        onBlur={() => finish(() => onCancel("blur"))}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            finish(() => onCancel("escape"));
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

  const isDate = column.type === "date";
  return (
    <input
      ref={inputRef}
      className="db-cell-input"
      aria-label={column.display}
      // A number is typed as text: a number input drops "4,50" or "1.2.3" before anyone can say why.
      type={isDate ? "date" : "text"}
      inputMode={column.type === "number" ? "decimal" : undefined}
      min={isDate ? DATE_MIN : undefined}
      max={isDate ? DATE_MAX : undefined}
      value={raw}
      onChange={(e) => setRaw(e.target.value)}
      onBlur={() => commit(parsed(), "blur")}
      onPaste={(e) => {
        const text = e.clipboardData.getData("text/plain");
        if (isRangePaste(text)) {
          e.preventDefault();
          finish(() => onPasteBlock(text));
          return;
        }
        if (!/[\r\n]/.test(text)) return;
        // Lines stay in this cell, as a spreadsheet keeps a paste in the cell being edited.
        e.preventDefault();
        const el = e.currentTarget;
        const start = el.selectionStart ?? raw.length;
        const end = el.selectionEnd ?? raw.length;
        setRaw(raw.slice(0, start) + asOneLine(text) + raw.slice(end));
      }}
      onKeyDown={(e) => {
        if (isComposingKey(e)) return;
        if (e.key === "Enter") {
          e.preventDefault();
          commit(parsed(), "enter");
        } else if (e.key === "Escape") {
          e.stopPropagation();
          finish(() => onCancel("escape"));
        }
      }}
    />
  );
}
