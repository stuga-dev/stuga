/**
 * Filter, Sort, Group and Columns for the grid's working shape: each a button
 * that becomes a chip while active, plus Save and Reset once the shape differs
 * from its saved view. Popovers use native controls so no further layers stack.
 * `compact` drops the button labels when the bar is too narrow for them.
 */
import { useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { IconButton } from "@astryxdesign/core/IconButton";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Popover } from "@astryxdesign/core/Popover";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { ArrowDownUp, Columns3, Filter as FilterIcon, Layers, Plus, RotateCcw, Save, X } from "lucide-react";
import { filterOpNeedsValue } from "@stuga/protocol/databases/filters";
import type { ColumnSpec, RowFilter, RowFilterOp, RowSort } from "@stuga/protocol/databases/types";
import { buildFilter, conditionCount, flattenFilter, type FlatFilter, type ViewShape } from "./model/view-shape";

const FILTER_OPS: Array<{ value: RowFilterOp; label: string }> = [
  { value: "contains", label: "contains" },
  { value: "not_contains", label: "does not contain" },
  { value: "eq", label: "is" },
  { value: "ne", label: "is not" },
  { value: "gt", label: "is greater than" },
  { value: "gte", label: "is at least" },
  { value: "lt", label: "is less than" },
  { value: "lte", label: "is at most" },
  { value: "empty", label: "is empty" },
  { value: "not_empty", label: "is not empty" },
];

interface ViewToolbarProps {
  columns: ColumnSpec[];
  shape: ViewShape;
  onShape: (next: ViewShape) => void;
  /** The working shape differs from the saved view, or from "All rows". */
  dirty: boolean;
  /** Save writes back to a view rather than creating one. */
  hasView: boolean;
  readOnly: boolean;
  onSave: () => void;
  onReset: () => void;
  compact: boolean;
}

export function ViewToolbar({ columns, shape, onShape, dirty, hasView, readOnly, onSave, onReset, compact }: ViewToolbarProps) {
  const [open, setOpen] = useState<"filter" | "sort" | "group" | "columns" | null>(null);
  const nConditions = conditionCount(shape.filter);
  const groupCol = columns.find((c) => c.column_id === shape.group_by);
  const hidden = shape.hidden_columns.filter((id) => columns.some((c) => c.column_id === id));

  const chip = (label: string, icon: React.ReactNode, onClear: () => void, title: string) => (
    <span className="db-chip" title={title}>
      {icon}
      <span className="db-chip__label">{label}</span>
      <button
        className="db-chip__x"
        aria-label={`Clear ${title.toLowerCase()}`}
        onClick={(e) => {
          e.stopPropagation();
          onClear();
        }}
      >
        <X size={13} />
      </button>
    </span>
  );

  return (
    <HStack gap={1} vAlign="center" wrap="nowrap">
      <Popover
        isOpen={open === "filter"}
        onOpenChange={(o) => setOpen(o ? "filter" : null)}
        placement="below"
        alignment="end"
        width={420}
        label="Filter rows"
        content={
          <FilterEditor
            // Re-seeds the draft whenever the applied filter changes under it.
            key={JSON.stringify(shape.filter)}
            columns={columns}
            filter={shape.filter}
            onChange={(filter) => {
              onShape({ ...shape, filter });
              setOpen(null);
            }}
          />
        }
      >
        <span className="db-toolbar__ctl">
          {nConditions > 0 ? (
            chip(
              `${nConditions} filter${nConditions === 1 ? "" : "s"}`,
              <FilterIcon size={13} />,
              () => onShape({ ...shape, filter: null }),
              "Filter",
            )
          ) : (
            <Button label="Filter" variant="ghost" size="sm" icon={<FilterIcon size={15} />} isIconOnly={compact} />
          )}
        </span>
      </Popover>

      <Popover
        isOpen={open === "sort"}
        onOpenChange={(o) => setOpen(o ? "sort" : null)}
        placement="below"
        alignment="end"
        width={360}
        label="Sort rows"
        content={<SortEditor columns={columns} sorts={shape.sorts} onChange={(sorts) => onShape({ ...shape, sorts })} />}
      >
        <span className="db-toolbar__ctl">
          {shape.sorts.length > 0 ? (
            chip(
              shape.sorts.length === 1
                ? `${columns.find((c) => c.column_id === shape.sorts[0]!.column_id)?.display ?? "?"} ${shape.sorts[0]!.dir === "desc" ? "↓" : "↑"}`
                : `${shape.sorts.length} sorts`,
              <ArrowDownUp size={13} />,
              () => onShape({ ...shape, sorts: [] }),
              "Sort",
            )
          ) : (
            <Button label="Sort" variant="ghost" size="sm" icon={<ArrowDownUp size={15} />} isIconOnly={compact} />
          )}
        </span>
      </Popover>

      <Popover
        isOpen={open === "group"}
        onOpenChange={(o) => setOpen(o ? "group" : null)}
        placement="below"
        alignment="end"
        width={280}
        label="Group rows"
        content={
          <div className="db-filter">
            <label className="db-filter__row">
              <span className="db-filter__label">Group by</span>
              <select
                className="db-select"
                value={shape.group_by ?? ""}
                onChange={(e) => {
                  onShape({ ...shape, group_by: e.target.value === "" ? null : e.target.value });
                  setOpen(null);
                }}
              >
                <option value="">None</option>
                {columns.map((c) => (
                  <option key={c.column_id} value={c.column_id}>
                    {c.display}
                  </option>
                ))}
              </select>
            </label>
          </div>
        }
      >
        <span className="db-toolbar__ctl">
          {groupCol ? (
            chip(`Group: ${groupCol.display}`, <Layers size={13} />, () => onShape({ ...shape, group_by: null }), "Group")
          ) : (
            <Button label="Group" variant="ghost" size="sm" icon={<Layers size={15} />} isIconOnly={compact} />
          )}
        </span>
      </Popover>

      <Popover
        isOpen={open === "columns"}
        onOpenChange={(o) => setOpen(o ? "columns" : null)}
        placement="below"
        alignment="end"
        width={280}
        label="Show or hide columns"
        content={
          <div className="db-filter">
            {columns.map((c) => {
              const shown = !shape.hidden_columns.includes(c.column_id);
              return (
                <CheckboxInput
                  key={c.column_id}
                  label={c.display}
                  size="sm"
                  value={shown}
                  onChange={(v) =>
                    onShape({
                      ...shape,
                      hidden_columns: v === true ? shape.hidden_columns.filter((id) => id !== c.column_id) : [...shape.hidden_columns, c.column_id],
                    })
                  }
                />
              );
            })}
            {hidden.length > 0 && (
              <HStack gap={2} justify="end">
                <Button label="Show all" variant="ghost" size="sm" onClick={() => onShape({ ...shape, hidden_columns: [] })} />
              </HStack>
            )}
          </div>
        }
      >
        <span className="db-toolbar__ctl">
          {hidden.length > 0 ? (
            chip(`${hidden.length} hidden`, <Columns3 size={13} />, () => onShape({ ...shape, hidden_columns: [] }), "Hidden columns")
          ) : (
            <Button label="Columns" variant="ghost" size="sm" icon={<Columns3 size={15} />} isIconOnly={compact} />
          )}
        </span>
      </Popover>

      {dirty && (
        <HStack gap={1} vAlign="center">
          {!readOnly && (
            <Button
              label={hasView ? "Save view" : "Save as view"}
              variant="secondary"
              size="sm"
              icon={<Save size={14} />}
              isIconOnly={compact}
              onClick={onSave}
            />
          )}
          <IconButton label="Reset to the saved view" variant="ghost" size="sm" icon={<RotateCcw size={14} />} onClick={onReset} />
        </HStack>
      )}
    </HStack>
  );
}

/** A leaf as the editor holds it: the value stays text until it is applied. */
interface DraftLeaf {
  column_id: string;
  op: RowFilterOp;
  value: string;
}

function toDraft(leaf: RowFilter): DraftLeaf {
  return { column_id: leaf.column_id, op: leaf.op, value: leaf.value === null || leaf.value === undefined ? "" : String(leaf.value) };
}

/** A wire leaf, or why the draft cannot be one yet. */
function leafFromDraft(columns: ColumnSpec[], d: DraftLeaf): RowFilter | { error: string } {
  const col = columns.find((c) => c.column_id === d.column_id);
  if (!col) return { error: "Pick a column." };
  if (!filterOpNeedsValue(d.op)) return { column_id: col.column_id, op: d.op };
  if (col.type === "number" || col.type === "checkbox") {
    const n = parseFloat(d.value);
    if (!Number.isFinite(n)) return { error: `Enter a number for “${col.display}”.` };
    return { column_id: col.column_id, op: d.op, value: n };
  }
  if (d.value === "") return { error: `Enter a value for “${col.display}”.` };
  return { column_id: col.column_id, op: d.op, value: d.value };
}

function FilterEditor({
  columns,
  filter,
  onChange,
}: {
  columns: ColumnSpec[];
  filter: ViewShape["filter"];
  onChange: (next: ViewShape["filter"]) => void;
}) {
  const flat = flattenFilter(filter);
  const [op, setOp] = useState<"and" | "or">(flat !== null && flat !== "nested" ? flat.op : "and");
  const [leaves, setLeaves] = useState<DraftLeaf[]>(flat !== null && flat !== "nested" ? flat.leaves.map(toDraft) : []);
  const [error, setError] = useState<string | null>(null);

  if (flat === "nested") {
    return (
      <div className="db-filter">
        <Text type="supporting" color="secondary">
          This API-created nested filter has {conditionCount(filter)} conditions. Clear it to build a new one here.
        </Text>
        <HStack gap={2} justify="end">
          <Button label="Clear filter" variant="secondary" size="sm" onClick={() => onChange(null)} />
        </HStack>
      </div>
    );
  }

  const addLeaf = () => {
    const first = columns[0];
    if (!first) return;
    setLeaves((ls) => [...ls, { column_id: first.column_id, op: "contains", value: "" }]);
  };
  const apply = () => {
    const out: RowFilter[] = [];
    for (const d of leaves) {
      const leaf = leafFromDraft(columns, d);
      if ("error" in leaf) {
        setError(leaf.error);
        return;
      }
      out.push(leaf);
    }
    setError(null);
    const flatOut: FlatFilter = { op, leaves: out };
    onChange(buildFilter(flatOut));
  };

  return (
    <div className="db-filter">
      {leaves.length > 1 && (
        <label className="db-filter__row db-filter__row--inline">
          <span className="db-filter__label">Match</span>
          <select className="db-select" value={op} onChange={(e) => setOp(e.target.value as "and" | "or")}>
            <option value="and">all conditions</option>
            <option value="or">any condition</option>
          </select>
        </label>
      )}
      {leaves.map((d, i) => {
        const col = columns.find((c) => c.column_id === d.column_id);
        const needsValue = filterOpNeedsValue(d.op);
        const set = (patch: Partial<DraftLeaf>) => setLeaves((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
        return (
          <div key={i} className="db-filter__cond">
            <select className="db-select" value={d.column_id} onChange={(e) => set({ column_id: e.target.value, value: "" })} aria-label="Column">
              {columns.map((c) => (
                <option key={c.column_id} value={c.column_id}>
                  {c.display}
                </option>
              ))}
            </select>
            <select className="db-select" value={d.op} onChange={(e) => set({ op: e.target.value as RowFilterOp })} aria-label="Condition">
              {FILTER_OPS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            {needsValue &&
              (col?.type === "checkbox" ? (
                <select className="db-select" value={d.value} onChange={(e) => set({ value: e.target.value })} aria-label="Value">
                  <option value="">—</option>
                  <option value="1">Checked</option>
                  <option value="0">Unchecked</option>
                </select>
              ) : col?.type === "single_select" ? (
                <select className="db-select" value={d.value} onChange={(e) => set({ value: e.target.value })} aria-label="Value">
                  <option value="">—</option>
                  {(col.options?.choices ?? []).map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  className="db-select"
                  aria-label="Value"
                  type={col?.type === "number" ? "number" : col?.type === "date" ? "date" : "text"}
                  step={col?.type === "number" ? "any" : undefined}
                  value={d.value}
                  onChange={(e) => set({ value: e.target.value })}
                  onKeyDown={(e) => e.key === "Enter" && apply()}
                />
              ))}
            <IconButton
              label="Remove condition"
              variant="ghost"
              size="sm"
              icon={<X size={14} />}
              onClick={() => setLeaves((ls) => ls.filter((_, j) => j !== i))}
            />
          </div>
        );
      })}
      {error && (
        <Text type="supporting" color="accent">
          {error}
        </Text>
      )}
      <HStack gap={2} justify="between" vAlign="center">
        <Button label="Add condition" variant="ghost" size="sm" icon={<Plus size={14} />} onClick={addLeaf} />
        <HStack gap={2}>
          {filter !== null && (
            <Button
              label="Clear"
              variant="ghost"
              size="sm"
              onClick={() => {
                setLeaves([]);
                setError(null);
                onChange(null);
              }}
            />
          )}
          <Button label="Apply" variant="primary" size="sm" onClick={apply} />
        </HStack>
      </HStack>
    </div>
  );
}

function SortEditor({ columns, sorts, onChange }: { columns: ColumnSpec[]; sorts: RowSort[]; onChange: (next: RowSort[]) => void }) {
  const unused = columns.filter((c) => !sorts.some((s) => s.column_id === c.column_id));
  return (
    <div className="db-filter">
      {sorts.length === 0 && (
        <Text type="supporting" color="secondary">
          Rows are in the order they were added.
        </Text>
      )}
      {sorts.map((s, i) => (
        <div key={s.column_id} className="db-filter__cond">
          <select
            className="db-select"
            value={s.column_id}
            aria-label="Column"
            onChange={(e) => onChange(sorts.map((x, j) => (j === i ? { ...x, column_id: e.target.value } : x)))}
          >
            {columns
              .filter((c) => c.column_id === s.column_id || !sorts.some((x) => x.column_id === c.column_id))
              .map((c) => (
                <option key={c.column_id} value={c.column_id}>
                  {c.display}
                </option>
              ))}
          </select>
          <select
            className="db-select"
            value={s.dir}
            aria-label="Direction"
            onChange={(e) => onChange(sorts.map((x, j) => (j === i ? { ...x, dir: e.target.value as "asc" | "desc" } : x)))}
          >
            <option value="asc">ascending</option>
            <option value="desc">descending</option>
          </select>
          <IconButton label="Remove sort" variant="ghost" size="sm" icon={<X size={14} />} onClick={() => onChange(sorts.filter((_, j) => j !== i))} />
        </div>
      ))}
      <HStack gap={2} justify="between">
        <Button
          label="Add sort"
          variant="ghost"
          size="sm"
          icon={<Plus size={14} />}
          isDisabled={unused.length === 0 || sorts.length >= 4}
          onClick={() => unused[0] && onChange([...sorts, { column_id: unused[0].column_id, dir: "asc" }])}
        />
        {sorts.length > 0 && <Button label="Clear" variant="ghost" size="sm" onClick={() => onChange([])} />}
      </HStack>
    </div>
  );
}
