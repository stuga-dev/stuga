import { describe, expect, it } from "vitest";
import { DATABASE_MAX_VIEWS } from "@stuga/protocol/databases/limits";
import type { DatabaseRunSummary, DatabaseSchema, ViewSpec } from "@stuga/protocol/databases/types";
import { AGENT, HUMAN, doFetch, doJson, initStarter, makeActor, proposeBody } from "../test/harness.js";

type Row = Record<string, unknown> & { _id: string };
type ListOut = { rows: Row[]; total: number; groups?: Array<{ value: unknown; count: number }>; groups_truncated?: boolean; group_by?: string };

async function seeded() {
  const { actor } = makeActor();
  const starter = await initStarter(actor);
  await doJson(actor, "/columns/add", { table_id: starter.table_id, display: "Amount", type: "number", actor: HUMAN });
  await doJson(actor, "/columns/add", { table_id: starter.table_id, display: "Status", type: "single_select", choices: ["todo", "done"], actor: HUMAN });
  await doJson(actor, "/rows/insert", {
    table_id: starter.table_id,
    rows: [
      { Name: "banana", Amount: 2, Status: "todo" },
      { Name: "apple", Amount: 3, Status: "done", Notes: "100% real" },
      { Name: "cherry", Amount: 1, Status: "todo", Notes: "100 things" },
      { Name: "date", Amount: 3 },
    ],
    actor: HUMAN,
  });
  const cols = (await doJson<DatabaseSchema>(actor, "/schema")).tables[0]!.columns;
  const col = (display: string) => cols.find((c) => c.display === display)!;
  const name = col("Name").column_id;
  return { actor, starter, col, name };
}

const list = (actor: ReturnType<typeof makeActor>["actor"], body: Record<string, unknown>) => doJson<ListOut>(actor, "/rows/list", body);

describe("/rows/list: trees, multi-sort, grouping", () => {
  it("sorts by several keys, in order", async () => {
    const { actor, starter, name } = await seeded();
    const out = await list(actor, { table_id: starter.table_id, sort: [{ column_id: "Amount", dir: "desc" }, { column_id: "Name", dir: "asc" }] });
    expect(out.rows.map((r) => r[name])).toEqual(["apple", "date", "banana", "cherry"]);
    const one = await list(actor, { table_id: starter.table_id, sort: { column_id: "Name", dir: "desc" } });
    expect(one.rows.map((r) => r[name])).toEqual(["date", "cherry", "banana", "apple"]);
  });

  it("combines conditions with and / or, nested", async () => {
    const { actor, starter, name } = await seeded();
    const or = await list(actor, {
      table_id: starter.table_id,
      filter: { or: [{ column_id: "Name", op: "eq", value: "apple" }, { column_id: "Amount", op: "lt", value: 2 }] },
    });
    expect(or.rows.map((r) => r[name]).sort()).toEqual(["apple", "cherry"]);
    expect(or.total).toBe(2);
    const nested = await list(actor, {
      table_id: starter.table_id,
      filter: {
        and: [
          { column_id: "Amount", op: "gte", value: "2" },
          { or: [{ column_id: "Status", op: "empty" }, { column_id: "Notes", op: "not_contains", value: "%" }] },
        ],
      },
    });
    expect(nested.rows.map((r) => r[name]).sort()).toEqual(["banana", "date"]);
  });

  it("refuses an empty group, a too-deep tree, and an unknown op", async () => {
    const { actor, starter } = await seeded();
    expect((await doFetch(actor, "/rows/list", { table_id: starter.table_id, filter: { and: [] } })).status).toBe(400);
    const deep = { and: [{ or: [{ and: [{ or: [{ column_id: "Name", op: "empty" }] }] }] }] };
    expect((await doFetch(actor, "/rows/list", { table_id: starter.table_id, filter: deep })).status).toBe(400);
    expect((await doFetch(actor, "/rows/list", { table_id: starter.table_id, filter: { column_id: "Name", op: "regex", value: "x" } })).status).toBe(400);
    expect((await doFetch(actor, "/rows/list", { table_id: starter.table_id, sort: [{ column_id: "Name" }, { column_id: "Name" }] })).status).toBe(400);
  });

  it("groups: orders by the group key first and reports every group's size", async () => {
    const { actor, starter, col, name } = await seeded();
    const status = col("Status").column_id;
    const out = await list(actor, {
      table_id: starter.table_id,
      group_by: "Status",
      sort: [{ column_id: "Name", dir: "desc" }],
      limit: 3,
    });
    expect(out.group_by).toBe(status);
    // NULL sorts first in SQLite.
    expect(out.rows.map((r) => [r[status], r[name]])).toEqual([
      [null, "date"],
      ["done", "apple"],
      ["todo", "cherry"],
    ]);
    expect(out.total).toBe(4);
    expect(out.groups).toEqual([
      { value: null, count: 1 },
      { value: "done", count: 1 },
      { value: "todo", count: 2 },
    ]);
    expect(out.groups_truncated).toBeUndefined();
  });
});

describe("views: CRUD, seeding, hygiene", () => {
  it("creates a view keyed by column_id whatever the caller spelled, and seeds a listing", async () => {
    const { actor, starter, col, name } = await seeded();
    const { view } = await doJson<{ view: ViewSpec }>(actor, "/views/create", {
      table_id: starter.table_id,
      name: "Open",
      filter: { column_id: "Status", op: "eq", value: "todo" },
      sorts: [{ column_id: "amount", dir: "desc" }],
      hidden_columns: ["Notes"],
      actor: HUMAN,
    });
    expect(view.view_id).toMatch(/^view_/);
    expect(view.kind).toBe("table");
    expect(view.filter).toEqual({ column_id: col("Status").column_id, op: "eq", value: "todo" });
    expect(view.sorts).toEqual([{ column_id: col("Amount").column_id, dir: "desc" }]);
    expect(view.hidden_columns).toEqual([col("Notes").column_id]);
    expect(view.group_by).toBeNull();
    expect(view.config).toEqual({});

    // A listing by view_id applies it; a body field wins over it.
    const schema = await doJson<DatabaseSchema>(actor, "/schema");
    expect(schema.tables[0]!.views.map((v) => v.name)).toEqual(["Open"]);
    const seededList = await list(actor, { table_id: starter.table_id, view_id: view.view_id });
    expect(seededList.rows.map((r) => r[name])).toEqual(["banana", "cherry"]);
    const overridden = await list(actor, { table_id: starter.table_id, view_id: view.view_id, filter: null });
    expect(overridden.total).toBe(4);
    expect(overridden.rows.map((r) => r[name])).toEqual(["apple", "date", "banana", "cherry"]);
  });

  it("updates only the fields sent, renames, reorders, and deletes", async () => {
    const { actor, starter, col } = await seeded();
    const { view } = await doJson<{ view: ViewSpec }>(actor, "/views/create", {
      table_id: starter.table_id,
      name: "A",
      filter: { column_id: "Status", op: "not_empty" },
      actor: HUMAN,
    });
    const upd = await doJson<{ view: ViewSpec }>(actor, "/views/update", {
      table_id: starter.table_id,
      view_id: view.view_id,
      name: "B",
      group_by: "Status",
      actor: HUMAN,
    });
    expect(upd.view.name).toBe("B");
    expect(upd.view.group_by).toBe(col("Status").column_id);
    expect(upd.view.filter).toEqual({ column_id: col("Status").column_id, op: "not_empty" });
    expect((await doFetch(actor, "/views/update", { table_id: starter.table_id, view_id: view.view_id, actor: HUMAN })).status).toBe(400);
    expect((await doFetch(actor, "/views/update", { table_id: starter.table_id, view_id: view.view_id, filter: { and: [] }, actor: HUMAN })).status).toBe(400);
    await doJson(actor, "/views/delete", { table_id: starter.table_id, view_id: view.view_id, actor: HUMAN });
    expect((await doJson<DatabaseSchema>(actor, "/schema")).tables[0]!.views).toEqual([]);
    expect((await doFetch(actor, "/rows/list", { table_id: starter.table_id, view_id: view.view_id })).status).toBe(404);
  });

  it("refuses a nameless view, hidden bookkeeping columns, and the per-table cap", async () => {
    const { actor, starter } = await seeded();
    expect((await doFetch(actor, "/views/create", { table_id: starter.table_id, actor: HUMAN })).status).toBe(400);
    expect((await doFetch(actor, "/views/create", { table_id: starter.table_id, name: "x", hidden_columns: ["_id"], actor: HUMAN })).status).toBe(400);
    for (let i = 0; i < DATABASE_MAX_VIEWS; i++) await doJson(actor, "/views/create", { table_id: starter.table_id, name: `V${i}`, actor: HUMAN });
    const res = await doFetch(actor, "/views/create", { table_id: starter.table_id, name: "one too many", actor: HUMAN });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("view_cap");
  });

  it("a dropped column leaves views, minus every reference to it; a dropped table takes its views", async () => {
    const { actor, starter, col } = await seeded();
    const { view } = await doJson<{ view: ViewSpec }>(actor, "/views/create", {
      table_id: starter.table_id,
      name: "Mixed",
      filter: { and: [{ column_id: "Amount", op: "gt", value: 1 }, { column_id: "Status", op: "eq", value: "todo" }] },
      sorts: [{ column_id: "Amount", dir: "desc" }, { column_id: "Name", dir: "asc" }],
      group_by: "Amount",
      hidden_columns: ["Amount", "Notes"],
      actor: HUMAN,
    });
    await doJson(actor, "/columns/delete", { table_id: starter.table_id, column_id: col("Amount").column_id, actor: HUMAN });
    const after = (await doJson<DatabaseSchema>(actor, "/schema")).tables[0]!.views[0]!;
    expect(after.view_id).toBe(view.view_id);
    expect(after.filter).toEqual({ and: [{ column_id: col("Status").column_id, op: "eq", value: "todo" }] });
    expect(after.sorts).toEqual([{ column_id: col("Name").column_id, dir: "asc" }]);
    expect(after.group_by).toBeNull();
    expect(after.hidden_columns).toEqual([col("Notes").column_id]);
    expect((await list(actor, { table_id: starter.table_id, view_id: view.view_id })).total).toBe(2);

    const other = await doJson<{ table: { table_id: string } }>(actor, "/tables/create", { display: "Other", actor: HUMAN });
    await doJson(actor, "/views/create", { table_id: other.table.table_id, name: "Gone", actor: HUMAN });
    await doJson(actor, "/tables/delete", { table_id: other.table.table_id, actor: HUMAN });
    const views = await doJson<{ rows: unknown[] }>(actor, "/query", { sql: "SELECT view_id FROM _views", actor: HUMAN });
    expect(views.rows).toHaveLength(1);
  });
});

describe("views: agents propose, people decide, everything reverts", () => {
  function propose(actor: ReturnType<typeof makeActor>["actor"], op: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    return doJson<{ mode: string; run: DatabaseRunSummary; minted?: { view_id?: string } }>(actor, "/runs/propose", proposeBody(op, extra));
  }

  it("views.create parks, projects into the agent's schema, and lands on accept", async () => {
    const { actor, starter, col } = await seeded();
    const out = await propose(actor, {
      kind: "views.create",
      table: "Table 1",
      name: "Todo",
      filter: { column_id: "Status", op: "eq", value: "todo" },
      hidden_columns: ["Notes"],
    });
    expect(out.mode).toBe("proposed");
    expect(out.minted?.view_id).toMatch(/^view_/);
    expect(out.run.ops[0]!.summary).toContain('Create view "Todo"');
    expect((await doJson<DatabaseSchema>(actor, "/schema")).tables[0]!.views).toEqual([]);
    const projected = await doJson<DatabaseSchema>(actor, `/schema?agent=${encodeURIComponent(AGENT.alias)}`);
    expect(projected.tables[0]!.views.map((v) => [v.name, v.pending])).toEqual([["Todo", true]]);

    // A follow-up may name the pending view.
    const upd = await propose(actor, { kind: "views.update", table: starter.table_id, view: "Todo", sorts: [{ column_id: "Amount", dir: "desc" }] });
    expect(upd.mode).toBe("proposed");

    const decided = await doJson<{ applied: number }>(actor, "/runs/decide", {
      actor: HUMAN,
      run_id: out.run.id,
      decision: "accept",
      decided_by: HUMAN.alias,
    });
    expect(decided.applied).toBe(2);
    const live = (await doJson<DatabaseSchema>(actor, "/schema")).tables[0]!.views;
    expect(live).toHaveLength(1);
    expect(live[0]!.view_id).toBe(out.minted!.view_id);
    expect(live[0]!.filter).toEqual({ column_id: col("Status").column_id, op: "eq", value: "todo" });
    expect(live[0]!.sorts).toEqual([{ column_id: col("Amount").column_id, dir: "desc" }]);

    const ops = await doJson<{ ops: Array<{ op_id: string; kind: string; revertible: boolean; is_agent: boolean }> }>(actor, "/ops?limit=10", undefined);
    expect(ops.ops.slice(0, 2).map((o) => [o.kind, o.is_agent])).toEqual([["views.update", true], ["views.create", true]]);
    await doJson(actor, "/ops/revert", { op_id: ops.ops[0]!.op_id, actor: HUMAN });
    expect((await doJson<DatabaseSchema>(actor, "/schema")).tables[0]!.views[0]!.sorts).toEqual([]);
    await doJson(actor, "/ops/revert", { op_id: ops.ops[1]!.op_id, actor: HUMAN });
    expect((await doJson<DatabaseSchema>(actor, "/schema")).tables[0]!.views).toEqual([]);
  });

  it("a view proposed against a column that vanished conflicts instead of landing broken", async () => {
    const { actor, starter, col } = await seeded();
    const out = await propose(actor, { kind: "views.create", table: starter.table_id, name: "Amounts", group_by: "Amount" });
    await doJson(actor, "/columns/delete", { table_id: starter.table_id, column_id: col("Amount").column_id, actor: HUMAN });
    const decided = await doJson<{ applied: number; conflicts: number; run: DatabaseRunSummary }>(actor, "/runs/decide", {
      actor: HUMAN,
      run_id: out.run.id,
      decision: "accept",
      decided_by: HUMAN.alias,
    });
    expect(decided.applied).toBe(0);
    expect(decided.conflicts).toBe(1);
    expect(decided.run.ops[0]!.error).toContain("no longer exists");
  });

  it("refuses an agent's view naming an unknown column at propose, with the column named", async () => {
    const { actor, starter } = await seeded();
    const res = await doFetch(
      actor,
      "/runs/propose",
      proposeBody({ kind: "views.create", table: starter.table_id, name: "Bad", filter: { column_id: "Nope", op: "empty" } }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toContain("Nope");
  });
});
