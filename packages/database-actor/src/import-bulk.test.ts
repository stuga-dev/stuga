import { describe, expect, it } from "vitest";
import { DATABASE_MAX_ROWS_PER_WRITE } from "@stuga/protocol/databases/limits";
import type { DatabaseRunSummary, TableSchema } from "@stuga/protocol/databases/types";
import { AGENT, HUMAN, doFetch, doJson, initStarter, makeActor, proposeBody } from "../test/harness.js";

const manyRows = (n: number) => Array.from({ length: n }, (_, i) => ({ Name: `r${i}` }));

describe("rows/insert with import: true", () => {
  it("lifts the per-call batch cap for a human's direct import", async () => {
    const { actor } = makeActor();
    const starter = await initStarter(actor);
    const n = DATABASE_MAX_ROWS_PER_WRITE + 1;
    const refused = await doFetch(actor, "/rows/insert", { table_id: starter.table_id, rows: manyRows(n), actor: HUMAN });
    expect(refused.status).toBe(409);
    const out = await doJson<{ inserted: number }>(actor, "/rows/insert", {
      table_id: starter.table_id,
      rows: manyRows(n),
      import: true,
      actor: HUMAN,
    });
    expect(out.inserted).toBe(n);
    const list = await doJson<{ total: number }>(actor, "/rows/list", { table_id: starter.table_id, limit: 1 });
    expect(list.total).toBe(n);
  });

  it("proposes an agent's import as one op, worded as an import", async () => {
    const { actor } = makeActor();
    const starter = await initStarter(actor);
    const n = DATABASE_MAX_ROWS_PER_WRITE + 1;
    const out = await doJson<{ mode: string; run: DatabaseRunSummary; minted: { row_ids: string[] } }>(
      actor,
      "/runs/propose",
      proposeBody({ kind: "rows.insert", table: starter.table_id, rows: manyRows(n), import: true }, { source: "stdio" }),
    );
    expect(out.mode).toBe("proposed");
    expect(out.run.ops).toHaveLength(1);
    expect(out.run.ops[0]!.summary).toBe(`Import ${n} rows into "Table 1"`);
    expect(out.minted.row_ids).toHaveLength(n);
    const detail = await doJson<{ run: DatabaseRunSummary }>(actor, `/runs/detail?runId=${out.run.id}&sample=5`, undefined);
    const payload = detail.run.ops[0]!.payload;
    expect(payload?.kind).toBe("rows.insert");
    if (payload?.kind === "rows.insert") {
      expect(payload.rows).toHaveLength(5);
      expect(payload.row_ids).toHaveLength(5);
      expect(payload.rows_sampled_from).toBe(n);
    }
    const full = await doJson<{ run: DatabaseRunSummary }>(actor, `/runs/detail?runId=${out.run.id}&full=1`, undefined);
    expect(full.run.ops[0]!.payload?.kind === "rows.insert" && full.run.ops[0]!.payload.rows).toHaveLength(n);
    const refused = await doFetch(actor, "/runs/propose", proposeBody({ kind: "rows.insert", table: starter.table_id, rows: manyRows(n) }, { source: "stdio" }));
    expect(refused.status).toBe(409);
  });
});

describe("declarative columns", () => {
  it("schema/init takes the creator's columns instead of the starter trio", async () => {
    const { actor } = makeActor();
    const out = await doJson<{ schema: { tables: TableSchema[] } }>(actor, "/schema/init", {
      display: "Bookings",
      columns: [
        { name: "Booking Ref", type: "text" },
        { name: "Nightly Rate", type: "number" },
        { display: "Status", type: "single_select", choices: ["Confirmed", "Cancelled"] },
      ],
      actor: HUMAN,
    });
    const table = out.schema.tables[0]!;
    expect(table.display).toBe("Bookings");
    expect(table.columns.map((c) => [c.name, c.type])).toEqual([
      ["booking_ref", "text"],
      ["nightly_rate", "number"],
      ["status", "single_select"],
    ]);
    expect(table.columns[2]!.options).toEqual({ choices: ["Confirmed", "Cancelled"] });
  });

  it("schema/init with an empty list makes a table with no columns, not the starter ones", async () => {
    const { actor } = makeActor();
    const out = await doJson<{ schema: { tables: TableSchema[] } }>(actor, "/schema/init", { display: "Empty", columns: [], actor: HUMAN });
    expect(out.schema.tables[0]!.columns).toEqual([]);
  });

  it("tables/create lands the table and its columns in one mutation, and refuses a bad spec whole", async () => {
    const { actor } = makeActor();
    await initStarter(actor);
    const bad = await doFetch(actor, "/tables/create", {
      display: "Guests",
      columns: [{ name: "Name", type: "text" }, { name: "Tier", type: "single_select" }],
      actor: HUMAN,
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { message: string }).message).toContain("single_select");
    const dup = await doFetch(actor, "/tables/create", {
      display: "Guests",
      columns: [{ name: "Name", type: "text" }, { name: "name", type: "text" }],
      actor: HUMAN,
    });
    expect(dup.status).toBe(400);
    const before = await doJson<{ tables: TableSchema[] }>(actor, "/schema", undefined);
    expect(before.tables).toHaveLength(1);

    const out = await doJson<{ table: TableSchema }>(actor, "/tables/create", {
      display: "Guests",
      columns: [{ name: "Name", type: "text" }, { name: "VIP", type: "checkbox" }],
      actor: HUMAN,
    });
    expect(out.table.columns.map((c) => c.name)).toEqual(["name", "vip"]);
    const ops = await doJson<{ ops: Array<{ summary: string; is_agent: boolean }> }>(actor, "/ops", undefined);
    expect(ops.ops.find((o) => o.summary.includes("Guests"))).toMatchObject({ summary: 'Created table "Guests" with 2 columns', is_agent: false });
    const agentOut = await doJson<{ table: TableSchema }>(actor, "/tables/create", {
      display: "Rooms",
      columns: [{ name: "Number", type: "number" }],
      actor: AGENT,
    });
    expect(agentOut.table.columns).toHaveLength(1);
    const ops2 = await doJson<{ ops: Array<{ summary: string }> }>(actor, "/ops", undefined);
    expect(ops2.ops.some((o) => o.summary === 'Created table "Rooms" with 1 column')).toBe(true);
  });
});
