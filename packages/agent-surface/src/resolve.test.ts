import { describe, expect, it } from "vitest";
import type { DatabaseSchema, TableSchema, ViewSpec } from "@stuga/protocol/databases/types";
import { normalizeQueryParams, resolveTable, resolveView } from "./resolve.js";

function table(over: Partial<TableSchema> = {}): TableSchema {
  return { table_id: "t1", name: "tasks", display: "Tasks", position: 0, row_count: 3, columns: [], views: [], ...over };
}

const schema = (...tables: TableSchema[]): DatabaseSchema => ({ database_id: "db1", tables });

const view = (view_id: string, name: string): ViewSpec => ({
  view_id,
  table_id: "t1",
  kind: "table",
  name,
  position: 0,
  filter: null,
  sorts: [],
  group_by: null,
  hidden_columns: [],
  config: {},
});

describe("resolveTable", () => {
  it("accepts a table_id, the physical name, or the display name", () => {
    const s = schema(table());
    for (const ref of ["t1", "tasks", "Tasks"]) expect(resolveTable(s, ref)).toEqual({ table: s.tables[0] });
  });

  it("names the requirement when no table was given", () => {
    expect(resolveTable(schema(table()), undefined)).toEqual({ error: "this action requires `table`" });
  });

  it("lists the candidates for an ambiguous reference", () => {
    const s = schema(table(), table({ table_id: "t2", name: "tasks_2" }));
    expect(resolveTable(s, "Tasks")).toEqual({ error: '"Tasks" is ambiguous — use a table_id: t1 (Tasks), t2 (Tasks)' });
  });

  it("lists the real tables when a reference misses", () => {
    const s = schema(table(), table({ table_id: "t2", name: "notes", display: "Notes" }));
    expect(resolveTable(s, "people")).toEqual({ error: 'no table "people" — tables here: tasks (t1), notes (t2)' });
    expect(resolveTable(schema(), "tasks")).toEqual({ error: 'no table "tasks" — tables here: none' });
  });
});

describe("resolveView", () => {
  it("resolves by id or unique name and lists the real views otherwise", () => {
    const t = table({ views: [view("view_1", "Open"), view("view_2", "Done"), view("view_3", "Done")] });
    expect(resolveView(t, "view_1")).toEqual({ view: view("view_1", "Open") });
    expect(resolveView(t, "Open")).toEqual({ view: view("view_1", "Open") });
    expect(resolveView(t, "Done")).toMatchObject({ error: expect.stringContaining("ambiguous") });
    expect(resolveView(t, "Nope")).toMatchObject({ error: expect.stringContaining("view_1") });
    expect(resolveView(t, undefined)).toMatchObject({ error: expect.stringContaining("requires `view`") });
  });
});

describe("normalizeQueryParams", () => {
  it("binds booleans as the 0/1 SQLite stores", () => {
    expect(normalizeQueryParams(["a", 2, true, false, null])).toEqual(["a", 2, 1, 0, null]);
    expect(normalizeQueryParams(undefined)).toEqual([]);
  });
});
