/**
 * The grid's working view shape: filter tree, sorts, grouping and hidden
 * columns. A saved view seeds it, local changes leave the view alone until
 * saved, and "All rows" is the empty shape.
 */
import type { ColumnSpec, RowFilter, RowFilterNode, RowGroup, RowRecord, RowSort, RowValue, ViewSpec } from "@stuga/protocol/databases/types";
import { filterGroupParts, isFilterGroup, makeFilterGroup } from "@stuga/protocol/databases/filters";

export interface ViewShape {
  filter: RowFilterNode | null;
  sorts: RowSort[];
  group_by: string | null;
  hidden_columns: string[];
}

export const EMPTY_SHAPE: ViewShape = { filter: null, sorts: [], group_by: null, hidden_columns: [] };

export function shapeOf(view: ViewSpec | null): ViewShape {
  if (!view) return EMPTY_SHAPE;
  return { filter: view.filter, sorts: view.sorts, group_by: view.group_by, hidden_columns: view.hidden_columns };
}

/** Key order fixed and hidden columns sorted, so equal shapes serialize equally. */
function canon(shape: ViewShape): string {
  return JSON.stringify({
    filter: shape.filter,
    sorts: shape.sorts.map((s) => [s.column_id, s.dir]),
    group_by: shape.group_by,
    hidden_columns: [...shape.hidden_columns].sort(),
  });
}

export function sameShape(a: ViewShape, b: ViewShape): boolean {
  return canon(a) === canon(b);
}

export function isEmptyShape(shape: ViewShape): boolean {
  return shape.filter === null && shape.sorts.length === 0 && shape.group_by === null && shape.hidden_columns.length === 0;
}

/** Drop references to columns that no longer exist; a filter group left empty goes too. Same object when nothing drops. */
export function pruneShape(shape: ViewShape, live: ReadonlySet<string>): ViewShape {
  const keep = (id: string) => id.startsWith("_") || live.has(id);
  const pruneNode = (node: RowFilterNode): RowFilterNode | null => {
    if (isFilterGroup(node)) {
      const { op, children } = filterGroupParts(node);
      const kept = children.map(pruneNode).filter((c): c is RowFilterNode => c !== null);
      return kept.length === 0 ? null : makeFilterGroup(op, kept);
    }
    return keep(node.column_id) ? node : null;
  };
  const next: ViewShape = {
    filter: shape.filter === null ? null : pruneNode(shape.filter),
    sorts: shape.sorts.filter((s) => keep(s.column_id)),
    group_by: shape.group_by !== null && keep(shape.group_by) ? shape.group_by : null,
    hidden_columns: shape.hidden_columns.filter(keep),
  };
  return sameShape(next, shape) ? shape : next;
}

/** The one level the filter editor can show. A deeper tree is kept as saved and reported as "nested". */
export interface FlatFilter {
  op: "and" | "or";
  leaves: RowFilter[];
}

export function flattenFilter(filter: RowFilterNode | null): FlatFilter | null | "nested" {
  if (filter === null) return null;
  if (!isFilterGroup(filter)) return { op: "and", leaves: [filter] };
  const { op, children } = filterGroupParts(filter);
  if (children.some(isFilterGroup)) return "nested";
  return { op, leaves: children as RowFilter[] };
}

export function buildFilter(flat: FlatFilter): RowFilterNode | null {
  if (flat.leaves.length === 0) return null;
  if (flat.leaves.length === 1) return flat.leaves[0]!;
  return makeFilterGroup(flat.op, flat.leaves);
}

/** How many conditions a filter holds, whatever its shape. */
export function conditionCount(filter: RowFilterNode | null): number {
  if (filter === null) return 0;
  if (!isFilterGroup(filter)) return 1;
  return filterGroupParts(filter).children.reduce((n, c) => n + conditionCount(c), 0);
}

/** A header click cycles none → asc → desc → none, with that column as the only sort key. */
export function cycleHeaderSort(sorts: RowSort[], columnId: string): RowSort[] {
  const only = sorts.length === 1 && sorts[0]!.column_id === columnId ? sorts[0]! : null;
  if (!only) return [{ column_id: columnId, dir: "asc" }];
  if (only.dir === "asc") return [{ column_id: columnId, dir: "desc" }];
  return [];
}

export function sortDirOf(sorts: RowSort[], columnId: string): "asc" | "desc" | null {
  return sorts.find((s) => s.column_id === columnId)?.dir ?? null;
}

interface RowGroupSegment {
  /** The group key's value; null is the "(empty)" group. */
  value: RowValue;
  /** Rows of this group present in the fetched window. */
  rows: RowRecord[];
  /** Rows of this group in the whole filtered set. */
  count: number;
}

/** Identity of a group value; the type is part of it, so 1 and "1" differ. */
export function groupKey(value: RowValue): string {
  return value === null ? "\u0000null" : `${typeof value}:${String(value)}`;
}

/**
 * Cut a fetched window into the server's groups. Groups the window has not
 * reached are listed empty, so every group shows with its size.
 */
export function segmentGroups(rows: RowRecord[], groups: RowGroup[], keyOf: (row: RowRecord) => RowValue): RowGroupSegment[] {
  const byKey = new Map<string, RowGroupSegment>();
  const key = groupKey;
  const out: RowGroupSegment[] = [];
  for (const g of groups) {
    const seg: RowGroupSegment = { value: g.value, rows: [], count: g.count };
    byKey.set(key(g.value), seg);
    out.push(seg);
  }
  for (const row of rows) {
    const v = keyOf(row);
    let seg = byKey.get(key(v));
    if (!seg) {
      // The group list may be truncated.
      seg = { value: v, rows: [], count: 0 };
      byKey.set(key(v), seg);
      out.push(seg);
    }
    seg.rows.push(row);
  }
  return out;
}

export function groupLabel(value: RowValue, column: ColumnSpec | undefined): string {
  if (value === null || value === undefined) return "(empty)";
  if (column?.type === "checkbox") return value === 1 ? "Checked" : "Unchecked";
  return String(value);
}
