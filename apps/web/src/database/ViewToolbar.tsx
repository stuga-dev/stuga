/**
 * Search, then Filter, Sort, Group and Columns for the grid's working shape:
 * each a button that becomes a chip while active, plus Save and Reset once the
 * shape differs from its saved view. A search is never part of a view.
 * Popovers use native controls so no further layers stack. `compact` drops the
 * button labels when the bar is too narrow for them.
 */
import { useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { IconButton } from "@astryxdesign/core/IconButton";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Popover } from "@astryxdesign/core/Popover";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { ArrowDownUp, Columns3, Filter as FilterIcon, Layers, Plus, RotateCcw, Save, Search, X } from "lucide-react";
import { filterOpNeedsValue } from "@stuga/protocol/databases/filters";
import type { ColumnSpec, RowFilter, RowFilterOp, RowSort } from "@stuga/protocol/databases/types";
import { buildFilter, conditionCount, flattenFilter, type FlatFilter, type ViewShape } from "./model/view-shape";
import { isComposingKey } from "../lib/ime";
import { formatLocale, t, type MessageKey } from "../i18n/i18n";
import { DATE_MAX, DATE_MIN } from "./model/field-input";
import { numberForEditing, parseNumberText } from "./model/numbers";

const FILTER_OP_LABELS: Record<RowFilterOp, MessageKey> = {
  contains: "database.filter.op.contains",
  not_contains: "database.filter.op.notContains",
  eq: "database.filter.op.eq",
  ne: "database.filter.op.ne",
  gt: "database.filter.op.gt",
  gte: "database.filter.op.gte",
  lt: "database.filter.op.lt",
  lte: "database.filter.op.lte",
  empty: "database.filter.op.empty",
  not_empty: "database.filter.op.notEmpty",
};
const FILTER_OPS = Object.keys(FILTER_OP_LABELS) as RowFilterOp[];

/** A files cell is matched by the names of its files, or by having any; it has no order. */
const FILES_OPS: ReadonlySet<RowFilterOp> = new Set(["contains", "not_contains", "empty", "not_empty"]);
const opsFor = (col: ColumnSpec | undefined) => (col?.type === "files" ? FILTER_OPS.filter((o) => FILES_OPS.has(o)) : FILTER_OPS);

interface ViewToolbarProps {
  columns: ColumnSpec[];
  /** Words to find in the table's rows, as typed. */
  search: string;
  onSearch: (search: string) => void;
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

export function ViewToolbar({ columns, search, onSearch, shape, onShape, dirty, hasView, readOnly, onSave, onReset, compact }: ViewToolbarProps) {
  const [open, setOpen] = useState<"filter" | "sort" | "group" | "columns" | null>(null);
  const nConditions = conditionCount(shape.filter);
  const groupCol = columns.find((c) => c.column_id === shape.group_by);
  const hidden = shape.hidden_columns.filter((id) => columns.some((c) => c.column_id === id));

  const chip = (label: string, icon: React.ReactNode, onClear: () => void, title: string, clearLabel: string) => (
    <span className="db-chip" title={title}>
      {icon}
      <span className="db-chip__label">{label}</span>
      <button
        className="db-chip__x"
        aria-label={clearLabel}
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
      <div className={`db-search${compact ? " db-search--compact" : ""}`}>
        <TextInput
          label={t("database.search.label")}
          isLabelHidden
          size="sm"
          value={search}
          onChange={onSearch}
          onKeyDown={(e) => {
            if (e.key !== "Escape" || search === "") return;
            e.stopPropagation();
            onSearch("");
          }}
          placeholder={compact ? t("database.search.placeholderShort") : t("database.search.placeholder")}
          startIcon={<Search size={14} />}
          hasClear
        />
      </div>
      <Popover
        isOpen={open === "filter"}
        onOpenChange={(o) => setOpen(o ? "filter" : null)}
        placement="below"
        alignment="end"
        width={420}
        label={t("database.filter.rows")}
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
              t("database.filter.chip", { count: nConditions }),
              <FilterIcon size={13} />,
              () => onShape({ ...shape, filter: null }),
              t("database.filter.button"),
              t("database.filter.clear"),
            )
          ) : (
            <Button label={t("database.filter.button")} variant="ghost" size="sm" icon={<FilterIcon size={15} />} isIconOnly={compact} />
          )}
        </span>
      </Popover>

      <Popover
        isOpen={open === "sort"}
        onOpenChange={(o) => setOpen(o ? "sort" : null)}
        placement="below"
        alignment="end"
        width={360}
        label={t("database.sort.rows")}
        content={<SortEditor columns={columns} sorts={shape.sorts} onChange={(sorts) => onShape({ ...shape, sorts })} />}
      >
        <span className="db-toolbar__ctl">
          {shape.sorts.length > 0 ? (
            chip(
              shape.sorts.length === 1
                ? `${columns.find((c) => c.column_id === shape.sorts[0]!.column_id)?.display ?? "?"} ${shape.sorts[0]!.dir === "desc" ? "↓" : "↑"}`
                : t("database.sort.chip", { count: shape.sorts.length }),
              <ArrowDownUp size={13} />,
              () => onShape({ ...shape, sorts: [] }),
              t("database.sort.button"),
              t("database.sort.clear"),
            )
          ) : (
            <Button label={t("database.sort.button")} variant="ghost" size="sm" icon={<ArrowDownUp size={15} />} isIconOnly={compact} />
          )}
        </span>
      </Popover>

      <Popover
        isOpen={open === "group"}
        onOpenChange={(o) => setOpen(o ? "group" : null)}
        placement="below"
        alignment="end"
        width={280}
        label={t("database.group.rows")}
        content={
          <div className="db-filter">
            <label className="db-filter__row">
              <span className="db-filter__label">{t("database.group.by")}</span>
              <select
                className="db-select"
                value={shape.group_by ?? ""}
                onChange={(e) => {
                  onShape({ ...shape, group_by: e.target.value === "" ? null : e.target.value });
                  setOpen(null);
                }}
              >
                <option value="">{t("database.group.none")}</option>
                {columns
                  .filter((c) => c.type !== "files" || c.column_id === shape.group_by)
                  .map((c) => (
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
            chip(
              t("database.group.chip", { name: groupCol.display }),
              <Layers size={13} />,
              () => onShape({ ...shape, group_by: null }),
              t("database.group.button"),
              t("database.group.clear"),
            )
          ) : (
            <Button label={t("database.group.button")} variant="ghost" size="sm" icon={<Layers size={15} />} isIconOnly={compact} />
          )}
        </span>
      </Popover>

      <Popover
        isOpen={open === "columns"}
        onOpenChange={(o) => setOpen(o ? "columns" : null)}
        placement="below"
        alignment="end"
        width={280}
        label={t("database.columns.showHide")}
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
                <Button label={t("database.columns.showAll")} variant="ghost" size="sm" onClick={() => onShape({ ...shape, hidden_columns: [] })} />
              </HStack>
            )}
          </div>
        }
      >
        <span className="db-toolbar__ctl">
          {hidden.length > 0 ? (
            chip(
              t("database.columns.hiddenChip", { count: hidden.length }),
              <Columns3 size={13} />,
              () => onShape({ ...shape, hidden_columns: [] }),
              t("database.columns.hidden"),
              t("database.columns.clearHidden"),
            )
          ) : (
            <Button label={t("database.columns.button")} variant="ghost" size="sm" icon={<Columns3 size={15} />} isIconOnly={compact} />
          )}
        </span>
      </Popover>

      {dirty && (
        <HStack gap={1} vAlign="center">
          {!readOnly && (
            <Button
              label={hasView ? t("database.views.save") : t("database.views.saveAs")}
              variant="secondary"
              size="sm"
              icon={<Save size={14} />}
              isIconOnly={compact}
              onClick={onSave}
            />
          )}
          <IconButton label={t("database.views.reset")} variant="ghost" size="sm" icon={<RotateCcw size={14} />} onClick={onReset} />
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

/** A saved number reads back in the reader's own decimal sign, as Apply parses it again. */
function toDraft(columns: ColumnSpec[], leaf: RowFilter): DraftLeaf {
  const { value } = leaf;
  const number = typeof value === "number" && columns.find((c) => c.column_id === leaf.column_id)?.type === "number";
  const text = value === null || value === undefined ? "" : number ? numberForEditing(value, formatLocale()) : String(value);
  return { column_id: leaf.column_id, op: leaf.op, value: text };
}

/** A wire leaf, or why the draft cannot be one yet. */
function leafFromDraft(columns: ColumnSpec[], d: DraftLeaf): RowFilter | { error: string } {
  const col = columns.find((c) => c.column_id === d.column_id);
  if (!col) return { error: t("database.filter.pickColumn") };
  if (!filterOpNeedsValue(d.op)) return { column_id: col.column_id, op: d.op };
  if (col.type === "checkbox") {
    if (d.value !== "0" && d.value !== "1") return { error: t("database.filter.enterValue", { name: col.display }) };
    return { column_id: col.column_id, op: d.op, value: Number(d.value) };
  }
  if (col.type === "number") {
    // Read as a cell reads it, so "4,50" filters on four and a half.
    const n = parseNumberText(d.value, formatLocale());
    if (!n.ok) return { error: t("database.filter.enterNumber", { name: col.display }) };
    return { column_id: col.column_id, op: d.op, value: n.value };
  }
  if (d.value === "") return { error: t("database.filter.enterValue", { name: col.display }) };
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
  const [leaves, setLeaves] = useState<DraftLeaf[]>(flat !== null && flat !== "nested" ? flat.leaves.map((l) => toDraft(columns, l)) : []);
  const [error, setError] = useState<string | null>(null);

  if (flat === "nested") {
    return (
      <div className="db-filter">
        <Text type="supporting" color="secondary">
          {t("database.filter.nested", { count: conditionCount(filter) })}
        </Text>
        <HStack gap={2} justify="end">
          <Button label={t("database.filter.clear")} variant="secondary" size="sm" onClick={() => onChange(null)} />
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
          <span className="db-filter__label">{t("database.filter.match")}</span>
          <select className="db-select" value={op} onChange={(e) => setOp(e.target.value as "and" | "or")}>
            <option value="and">{t("database.filter.matchAll")}</option>
            <option value="or">{t("database.filter.matchAny")}</option>
          </select>
        </label>
      )}
      {leaves.map((d, i) => {
        const col = columns.find((c) => c.column_id === d.column_id);
        const needsValue = filterOpNeedsValue(d.op);
        const set = (patch: Partial<DraftLeaf>) => setLeaves((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
        return (
          <div key={i} className="db-filter__cond">
            <select
              className="db-select"
              value={d.column_id}
              onChange={(e) => {
                const next = columns.find((c) => c.column_id === e.target.value);
                set({ column_id: e.target.value, value: "", ...(next?.type === "files" && !FILES_OPS.has(d.op) ? { op: "contains" } : {}) });
              }}
              aria-label={t("database.column.label")}
            >
              {columns.map((c) => (
                <option key={c.column_id} value={c.column_id}>
                  {c.display}
                </option>
              ))}
            </select>
            <select className="db-select" value={d.op} onChange={(e) => set({ op: e.target.value as RowFilterOp })} aria-label={t("database.filter.condition")}>
              {opsFor(col).map((o) => (
                <option key={o} value={o}>
                  {t(FILTER_OP_LABELS[o])}
                </option>
              ))}
            </select>
            {needsValue &&
              (col?.type === "checkbox" ? (
                <select className="db-select" value={d.value} onChange={(e) => set({ value: e.target.value })} aria-label={t("database.value.label")}>
                  <option value="">—</option>
                  <option value="1">{t("database.value.checked")}</option>
                  <option value="0">{t("database.value.unchecked")}</option>
                </select>
              ) : col?.type === "single_select" ? (
                <select className="db-select" value={d.value} onChange={(e) => set({ value: e.target.value })} aria-label={t("database.value.label")}>
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
                  aria-label={t("database.value.label")}
                  type={col?.type === "date" ? "date" : "text"}
                  inputMode={col?.type === "number" ? "decimal" : undefined}
                  min={col?.type === "date" ? DATE_MIN : undefined}
                  max={col?.type === "date" ? DATE_MAX : undefined}
                  value={d.value}
                  onChange={(e) => set({ value: e.target.value })}
                  onKeyDown={(e) => e.key === "Enter" && !isComposingKey(e) && apply()}
                />
              ))}
            <IconButton
              label={t("database.filter.removeCondition")}
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
        <Button label={t("database.filter.addCondition")} variant="ghost" size="sm" icon={<Plus size={14} />} onClick={addLeaf} />
        <HStack gap={2}>
          {filter !== null && (
            <Button
              label={t("database.toolbar.clear")}
              variant="ghost"
              size="sm"
              onClick={() => {
                setLeaves([]);
                setError(null);
                onChange(null);
              }}
            />
          )}
          {/* Nothing to apply until there is a condition, or one to take away. */}
          <Button label={t("database.filter.apply")} variant="primary" size="sm" isDisabled={leaves.length === 0 && filter === null} onClick={apply} />
        </HStack>
      </HStack>
    </div>
  );
}

function SortEditor({ columns: all, sorts, onChange }: { columns: ColumnSpec[]; sorts: RowSort[]; onChange: (next: RowSort[]) => void }) {
  // Files have no order; a sort saved on one before still shows, to be removed.
  const columns = all.filter((c) => c.type !== "files" || sorts.some((s) => s.column_id === c.column_id));
  const unused = columns.filter((c) => !sorts.some((s) => s.column_id === c.column_id));
  return (
    <div className="db-filter">
      {sorts.length === 0 && (
        <Text type="supporting" color="secondary">
          {t("database.sort.unsorted")}
        </Text>
      )}
      {sorts.map((s, i) => (
        <div key={s.column_id} className="db-filter__cond">
          <select
            className="db-select"
            value={s.column_id}
            aria-label={t("database.column.label")}
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
            aria-label={t("database.sort.direction")}
            onChange={(e) => onChange(sorts.map((x, j) => (j === i ? { ...x, dir: e.target.value as "asc" | "desc" } : x)))}
          >
            <option value="asc">{t("database.sort.ascending")}</option>
            <option value="desc">{t("database.sort.descending")}</option>
          </select>
          <IconButton label={t("database.sort.remove")} variant="ghost" size="sm" icon={<X size={14} />} onClick={() => onChange(sorts.filter((_, j) => j !== i))} />
        </div>
      ))}
      <HStack gap={2} justify="between">
        <Button
          label={t("database.sort.add")}
          variant="ghost"
          size="sm"
          icon={<Plus size={14} />}
          isDisabled={unused.length === 0 || sorts.length >= 4}
          onClick={() => unused[0] && onChange([...sorts, { column_id: unused[0].column_id, dir: "asc" }])}
        />
        {sorts.length > 0 && <Button label={t("database.toolbar.clear")} variant="ghost" size="sm" onClick={() => onChange([])} />}
      </HStack>
    </div>
  );
}
