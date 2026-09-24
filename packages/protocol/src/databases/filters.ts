import type { RowFilter, RowFilterGroup, RowFilterNode, RowFilterOp } from "./types.js";

export function isFilterGroup(node: RowFilterNode): node is RowFilterGroup {
  return typeof node === "object" && node !== null && ("and" in node || "or" in node);
}

/** A group's operator and children, whichever key it uses. */
export function filterGroupParts(group: RowFilterGroup): { op: "and" | "or"; children: RowFilterNode[] } {
  return "and" in group ? { op: "and", children: group.and } : { op: "or", children: group.or };
}

export function makeFilterGroup(op: "and" | "or", children: RowFilterNode[]): RowFilterGroup {
  return op === "and" ? { and: children } : { or: children };
}

/** Every leaf in order and the deepest group nesting. Counts only; the actor validates shape. */
export function filterTreeStats(node: RowFilterNode): { leaves: RowFilter[]; depth: number } {
  const leaves: RowFilter[] = [];
  let depth = 0;
  const walk = (n: RowFilterNode, d: number): void => {
    if (isFilterGroup(n)) {
      depth = Math.max(depth, d + 1);
      const { children } = filterGroupParts(n);
      if (Array.isArray(children)) for (const c of children) walk(c, d + 1);
      return;
    }
    leaves.push(n);
  };
  walk(node, 0);
  return { leaves, depth };
}

/** Whether a filter op takes a value (`empty` / `not_empty` do not). */
export function filterOpNeedsValue(op: RowFilterOp): boolean {
  return op !== "empty" && op !== "not_empty";
}

const OP_TEXT: Record<RowFilterOp, string> = {
  contains: "contains",
  not_contains: "does not contain",
  eq: "=",
  ne: "≠",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  empty: "is empty",
  not_empty: "is not empty",
};

/**
 * A filter tree as one line of plain words, for telling a person or a model
 * what a saved view selects. `columnName` names a column from its id; an id it
 * does not know is shown as it is, so a stale filter still reads.
 */
export function describeFilter(node: RowFilterNode, columnName: (columnId: string) => string): string {
  if (isFilterGroup(node)) {
    const { op, children } = filterGroupParts(node);
    const parts = (Array.isArray(children) ? children : []).map((c) => describeFilter(c, columnName)).filter(Boolean);
    if (parts.length === 0) return "";
    if (parts.length === 1) return parts[0]!;
    return `(${parts.join(` ${op} `)})`;
  }
  const name = columnName(node.column_id);
  const text = OP_TEXT[node.op];
  if (node.op === "empty" || node.op === "not_empty") return `${name} ${text}`;
  const value = node.value === null || node.value === undefined ? "" : typeof node.value === "number" ? String(node.value) : `'${node.value}'`;
  return `${name} ${text} ${value}`.trim();
}
