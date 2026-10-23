/** Rows as text for the node's agents, its Log and its check: what /rows/read gives, and the rows a run's entry says it touched. */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RowsReadResponse } from "@stuga/protocol/databases/rows-read";
import type { DatabaseRunSummary } from "@stuga/protocol/databases/types";
import type { RunIndexEntry } from "@stuga/protocol/internal/jobs";
import { AGENT, HUMAN, colId, doFetch, doJson, makeActor, proposeBody } from "../test/harness.js";
import type { DatabaseActor } from "./database-actor.js";

type Table = { table_id: string; columns: Array<{ column_id: string; display: string }> };

/** A Customers table: Name, Contact, Refund window, Plan (Free, Pro, Team), Active; Initech and Globex in it. */
async function customers() {
  const made = makeActor();
  const init = await doJson<{ schema: { tables: Table[] } }>(made.actor, "/schema/init", {
    display: "Customers",
    columns: [
      { display: "Name", type: "text" },
      { display: "Contact", type: "text" },
      { display: "Refund window", type: "text" },
      { display: "Plan", type: "single_select", choices: ["Free", "Pro", "Team"] },
      { display: "Active", type: "checkbox" },
    ],
    actor: HUMAN,
  });
  const table = init.schema.tables[0]!;
  const { row_ids } = await doJson<{ row_ids: string[] }>(made.actor, "/rows/insert", {
    table_id: table.table_id,
    rows: [
      { Name: "Initech", Contact: "Bo Chen", "Refund window": "30 days", Plan: "Pro", Active: true },
      { Name: "Globex", Contact: "Ana Ruiz\nfinance", Plan: "Team" },
      { Contact: "nameless" },
    ],
    actor: HUMAN,
  });
  return { ...made, table, rowIds: row_ids };
}

const read = (actor: DatabaseActor, body: Record<string, unknown> = {}) => doJson<RowsReadResponse>(actor, "/rows/read", body);

describe("rows read as text", () => {
  it("gives every row's cells as a person reads them, its title, and who last wrote it", async () => {
    const { actor, table, rowIds } = await customers();
    const out = await read(actor);
    expect(out.tables).toHaveLength(1);
    const t = out.tables[0]!;
    expect(t).toMatchObject({ table_id: table.table_id, name: "customers", display: "Customers", row_count: 3, partial: false });
    expect(t.columns.map((c) => [c.display, c.type, c.choices ?? null])).toEqual([
      ["Name", "text", null],
      ["Contact", "text", null],
      ["Refund window", "text", null],
      ["Plan", "single_select", ["Free", "Pro", "Team"]],
      ["Active", "checkbox", null],
    ]);
    const [initech, globex, nameless] = t.rows;
    expect(initech!.row_id).toBe(rowIds[0]);
    expect(initech!.title).toBe("Initech");
    expect(initech!.cells).toEqual({
      [colId(table, "Name")]: "Initech",
      [colId(table, "Contact")]: "Bo Chen",
      [colId(table, "Refund window")]: "30 days",
      [colId(table, "Plan")]: "Pro",
      [colId(table, "Active")]: "TRUE",
    });
    // A line break reads as a space; an empty cell is left out.
    expect(globex!.cells[colId(table, "Contact")]).toBe("Ana Ruiz finance");
    expect(globex!.cells[colId(table, "Refund window")]).toBeUndefined();
    // No name: its first non-empty text cell titles it.
    expect(nameless!.title).toBe("nameless");
    expect(initech!.updated_by).toEqual({ alias: HUMAN.alias, is_agent: false, on_behalf_of: null });
  });

  it("names the agent whose accepted change last wrote a row", async () => {
    const { actor, table, rowIds } = await customers();
    const proposed = await doJson<{ run: DatabaseRunSummary }>(
      actor,
      "/runs/propose",
      proposeBody({ kind: "rows.update", table: table.table_id, updates: [{ _id: rowIds[1], values: { Contact: "Dana Wu" } }] }),
    );
    // Waiting, the row still reads as it was, written by the person.
    const before = (await read(actor, { rows: [{ table_id: table.table_id, row_id: rowIds[1] }] })).tables[0]!.rows[0]!;
    expect(before.cells[colId(table, "Contact")]).toBe("Ana Ruiz finance");
    expect(before.updated_by?.alias).toBe(HUMAN.alias);
    await doJson(actor, "/runs/decide", { actor: HUMAN, run_id: proposed.run.id, decision: "accept", decided_by: HUMAN.alias });
    const after = (await read(actor, { rows: [{ table_id: table.table_id, row_id: rowIds[1] }] })).tables[0]!.rows[0]!;
    expect(after.cells[colId(table, "Contact")]).toBe("Dana Wu");
    expect(after.updated_by).toEqual({ alias: AGENT.alias, is_agent: true, on_behalf_of: AGENT.on_behalf_of });
  });

  afterEach(() => vi.restoreAllMocks());

  it("names, of two writes in the same instant, the one that wrote each row", async () => {
    const { actor, table, rowIds } = await customers();
    const SAM = { alias: "user:sam", is_agent: false };
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    await doJson(actor, "/rows/update", { table_id: table.table_id, updates: [{ _id: rowIds[0], values: { Contact: "Ana Ruiz" } }], actor: HUMAN });
    await doJson(actor, "/rows/update", { table_id: table.table_id, updates: [{ _id: rowIds[1], values: { Contact: "Dana Wu" } }], actor: SAM });
    vi.restoreAllMocks();
    const rows = (await read(actor)).tables[0]!.rows;
    expect(rows[0]!.updated_by?.alias).toBe(HUMAN.alias);
    expect(rows[1]!.updated_by?.alias).toBe(SAM.alias);
  });

  it("names the later of two writes to one row in one instant", async () => {
    const { actor, table, rowIds } = await customers();
    const SAM = { alias: "user:sam", is_agent: false };
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    await doJson(actor, "/rows/update", { table_id: table.table_id, updates: [{ _id: rowIds[0], values: { Contact: "Ana Ruiz" } }], actor: HUMAN });
    await doJson(actor, "/rows/update", { table_id: table.table_id, updates: [{ _id: rowIds[0], values: { Contact: "Dana Wu" } }], actor: SAM });
    vi.restoreAllMocks();
    expect((await read(actor)).tables[0]!.rows[0]!.updated_by?.alias).toBe(SAM.alias);
  });

  it("dates the database's last change by what it holds, never by a view, its revert, or a row's page", async () => {
    const { actor, table } = await customers();
    const before = await doJson<{ changed_at: number; changed_by: string }>(actor, "/search-text");
    const SAM = { alias: "user:sam", is_agent: false };
    await doJson(actor, "/views/create", { table_id: table.table_id, name: "Pro only", actor: SAM });
    const ops = await doJson<{ ops: Array<{ op_id: string; kind: string }> }>(actor, "/ops?limit=5");
    await doJson(actor, "/ops/revert", { op_id: ops.ops.find((o) => o.kind === "views.create")!.op_id, actor: SAM });
    const after = await doJson<{ changed_at: number; changed_by: string }>(actor, "/search-text");
    expect(after).toMatchObject({ changed_at: before.changed_at, changed_by: HUMAN.alias });
  });

  it("reads rows by id, only those there, and titles alone when asked", async () => {
    const { actor, table, rowIds } = await customers();
    await doJson(actor, "/rows/delete", { table_id: table.table_id, row_ids: [rowIds[1]], actor: HUMAN });
    const out = await read(actor, {
      rows: [rowIds[0], rowIds[1], "row_gone"].map((row_id) => ({ table_id: table.table_id, row_id })),
      titles_only: true,
    });
    expect(out.tables).toHaveLength(1);
    expect(out.tables[0]!.columns).toEqual([]);
    expect(out.tables[0]!.rows.map((r) => [r.row_id, r.title, r.cells])).toEqual([[rowIds[0], "Initech", {}]]);
    // A table no id names is left out.
    expect((await read(actor, { rows: [{ table_id: "tbl_other", row_id: rowIds[0] }] })).tables).toEqual([]);
  });

  it("keeps, of a table larger than the read has left, the rows holding a word, and says it read part", async () => {
    const { actor } = await customers();
    const all = await read(actor, { max_rows: 2 });
    expect(all.tables[0]!.partial).toBe(true);
    expect(all.tables[0]!.rows.map((r) => r.title)).toEqual(["Initech", "Globex"]);
    // Case aside, and LIKE's wildcards as written.
    const some = await read(actor, { max_rows: 2, needles: ["GLOBEX", "100%"] });
    expect(some.tables[0]!.partial).toBe(true);
    expect(some.tables[0]!.rows.map((r) => r.title)).toEqual(["Globex"]);
    expect((await read(actor, { max_rows: 2, needles: ["team"] })).tables[0]!.rows.map((r) => r.title)).toEqual(["Globex"]);
  });

  it("refuses a malformed read", async () => {
    const { actor } = await customers();
    for (const body of [{ rows: "x" }, { rows: [{ table_id: "t" }] }, { needles: [1] }, { max_rows: 0 }]) {
      expect((await doFetch(actor, "/rows/read", body)).status).toBe(400);
    }
  });
});

describe("the rows a run's entry says it touched", () => {
  it("names the rows its landed changes wrote, inserted or deleted, by table, never a declined one's", async () => {
    const { actor, table, rowIds, h } = await customers();
    const update = await doJson<{ run: DatabaseRunSummary }>(
      actor,
      "/runs/propose",
      proposeBody({ kind: "rows.update", table: table.table_id, updates: [{ _id: rowIds[0], values: { Contact: "Ana Ruiz" } }] }),
    );
    const insert = await doJson<{ run: DatabaseRunSummary; minted: { row_ids: string[] } }>(
      actor,
      "/runs/propose",
      proposeBody({ kind: "rows.insert", table: table.table_id, rows: [{ Name: "Hooli", Plan: "Pro" }] }),
    );
    const [updateOp, insertOp] = insert.run.ops;
    expect(update.run.id).toBe(insert.run.id);
    await doJson(actor, "/runs/decide", { actor: HUMAN, run_id: insert.run.id, decision: "accept", op_ids: [updateOp!.id], decided_by: HUMAN.alias });
    await doJson(actor, "/runs/decide", { actor: HUMAN, run_id: insert.run.id, decision: "reject", op_ids: [insertOp!.id], decided_by: HUMAN.alias });
    const entries = h.jobs.sent.flatMap((m) => (m.kind === "run_index" ? [m.run as RunIndexEntry] : []));
    expect(entries.at(-1)!.touched).toEqual([{ table_id: table.table_id, row_ids: [rowIds[0]], rows: 1 }]);
  });
});
