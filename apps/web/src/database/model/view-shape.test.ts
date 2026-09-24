import { describe, expect, it } from "vitest";
import type { RowRecord } from "@stuga/protocol/databases/types";
import {
  EMPTY_SHAPE,
  buildFilter,
  conditionCount,
  cycleHeaderSort,
  flattenFilter,
  groupLabel,
  isEmptyShape,
  pruneShape,
  sameShape,
  segmentGroups,
  shapeOf,
  type ViewShape,
} from "./view-shape";

const shape: ViewShape = {
  filter: { and: [{ column_id: "c1", op: "eq", value: "x" }, { column_id: "c2", op: "gt", value: 3 }] },
  sorts: [{ column_id: "c2", dir: "desc" }, { column_id: "c1", dir: "asc" }],
  group_by: "c2",
  hidden_columns: ["c3", "c2"],
};

describe("shape identity", () => {
  it("compares by content, ignoring hidden-column order", () => {
    expect(sameShape(shape, { ...shape, hidden_columns: ["c2", "c3"] })).toBe(true);
    expect(sameShape(shape, { ...shape, sorts: [...shape.sorts].reverse() })).toBe(false);
    expect(isEmptyShape(EMPTY_SHAPE)).toBe(true);
    expect(isEmptyShape(shapeOf(null))).toBe(true);
    expect(shapeOf({ view_id: "v", table_id: "t", kind: "table", name: "n", position: 0, ...shape, config: {} })).toEqual(shape);
  });

  it("prunes a vanished column everywhere, and returns the same object when nothing is stale", () => {
    const pruned = pruneShape(shape, new Set(["c1", "c3"]));
    expect(pruned).toEqual({
      filter: { and: [{ column_id: "c1", op: "eq", value: "x" }] },
      sorts: [{ column_id: "c1", dir: "asc" }],
      group_by: null,
      hidden_columns: ["c3"],
    });
    expect(pruneShape(shape, new Set(["c1", "c2", "c3"]))).toBe(shape);
    expect(pruneShape({ ...shape, filter: { or: [{ column_id: "c2", op: "empty" }] } }, new Set(["c1"])).filter).toBeNull();
  });
});

describe("flat filters", () => {
  it("shows one level, keeps a deeper tree as advanced, and rebuilds without a needless group", () => {
    expect(flattenFilter(null)).toBeNull();
    expect(flattenFilter({ column_id: "c1", op: "empty" })).toEqual({ op: "and", leaves: [{ column_id: "c1", op: "empty" }] });
    expect(flattenFilter(shape.filter)).toEqual({ op: "and", leaves: (shape.filter as { and: unknown[] }).and });
    expect(flattenFilter({ or: [{ and: [{ column_id: "c1", op: "empty" }] }] })).toBe("nested");
    expect(buildFilter({ op: "or", leaves: [] })).toBeNull();
    expect(buildFilter({ op: "or", leaves: [{ column_id: "c1", op: "empty" }] })).toEqual({ column_id: "c1", op: "empty" });
    expect(buildFilter({ op: "or", leaves: [{ column_id: "c1", op: "empty" }, { column_id: "c2", op: "empty" }] })).toEqual({
      or: [{ column_id: "c1", op: "empty" }, { column_id: "c2", op: "empty" }],
    });
    expect(conditionCount({ or: [{ and: [{ column_id: "c1", op: "empty" }, { column_id: "c2", op: "empty" }] }, { column_id: "c3", op: "empty" }] })).toBe(3);
  });
});

describe("header sort cycle", () => {
  it("none → asc → desc → none on one column, replacing a multi-key order", () => {
    expect(cycleHeaderSort([], "c1")).toEqual([{ column_id: "c1", dir: "asc" }]);
    expect(cycleHeaderSort([{ column_id: "c1", dir: "asc" }], "c1")).toEqual([{ column_id: "c1", dir: "desc" }]);
    expect(cycleHeaderSort([{ column_id: "c1", dir: "desc" }], "c1")).toEqual([]);
    expect(cycleHeaderSort(shape.sorts, "c2")).toEqual([{ column_id: "c2", dir: "asc" }]);
  });
});

describe("grouping", () => {
  const row = (id: string, status: string | null): RowRecord => ({ _id: id, _created_at: 0, _updated_at: 0, status }) as RowRecord;
  it("cuts a page into the server's groups, keeps unreached groups with their size, and tolerates an unlisted value", () => {
    const rows = [row("a", null), row("b", "done"), row("c", "todo"), row("d", "weird")];
    const groups = [
      { value: null, count: 1 },
      { value: "done", count: 5 },
      { value: "todo", count: 2 },
      { value: "zzz", count: 1 },
    ];
    const segs = segmentGroups(rows, groups, (r) => (r.status as string | null) ?? null);
    expect(segs.map((s) => [s.value, s.rows.map((r) => r._id), s.count])).toEqual([
      [null, ["a"], 1],
      ["done", ["b"], 5],
      ["todo", ["c"], 2],
      ["zzz", [], 1],
      ["weird", ["d"], 0],
    ]);
    expect(groupLabel(null, undefined)).toBe("(empty)");
    expect(groupLabel(1, { column_id: "x", name: "x", display: "x", type: "checkbox", position: 0, options: null })).toBe("Checked");
    expect(groupLabel("todo", undefined)).toBe("todo");
  });
});
