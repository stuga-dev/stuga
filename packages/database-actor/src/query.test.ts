import { describe, expect, it } from "vitest";
import { DATABASE_QUERIES_PER_MINUTE, DATABASE_QUERY_MAX_ROWS } from "@stuga/protocol/databases/limits";
import { runReadOnly, DATABASE_QUERY_MAX_VALUE_BYTES } from "./query/sql-guard.js";
import { AGENT, HUMAN, doFetch, doJson, initStarter, makeActor } from "../test/harness.js";

describe("/query", () => {
  it("runs a JOIN across two tables in the same database", async () => {
    const { actor } = makeActor();
    await initStarter(actor);
    const people = await doJson<{ table: { table_id: string } }>(actor, "/tables/create", { display: "People", actor: HUMAN });
    await doJson(actor, "/columns/add", { table_id: people.table.table_id, display: "Who", type: "text", actor: HUMAN });
    const pets = await doJson<{ table: { table_id: string } }>(actor, "/tables/create", { display: "Pets", actor: HUMAN });
    await doJson(actor, "/columns/add", { table_id: pets.table.table_id, display: "Owner", type: "text", actor: HUMAN });
    await doJson(actor, "/columns/add", { table_id: pets.table.table_id, display: "Pet", type: "text", actor: HUMAN });
    await doJson(actor, "/rows/insert", { table_id: people.table.table_id, rows: [{ Who: "liv" }, { Who: "sam" }], actor: HUMAN });
    await doJson(actor, "/rows/insert", {
      table_id: pets.table.table_id,
      rows: [
        { Owner: "liv", Pet: "cat" },
        { Owner: "sam", Pet: "dog" },
        { Owner: "liv", Pet: "eel" },
      ],
      actor: HUMAN,
    });
    const out = await doJson<{ columns: string[]; rows: Array<Record<string, unknown>>; truncated: boolean }>(actor, "/query", {
      sql: `SELECT p.who AS person, x.pet AS pet FROM "people" p JOIN "pets" x ON x.owner = p.who ORDER BY x.pet`,
      actor: AGENT,
    });
    expect(out.columns).toEqual(["person", "pet"]);
    expect(out.rows).toEqual([
      { person: "liv", pet: "cat" },
      { person: "sam", pet: "dog" },
      { person: "liv", pet: "eel" },
    ]);
    expect(out.truncated).toBe(false);
  });

  it("binds ? params and allows meta-table self-inspection", async () => {
    const { actor } = makeActor();
    const starter = await initStarter(actor);
    await doJson(actor, "/rows/insert", { table_id: starter.table_id, rows: [{ Name: "a" }, { Name: "b" }], actor: HUMAN });
    const out = await doJson<{ rows: Array<Record<string, unknown>> }>(actor, "/query", {
      sql: `SELECT name FROM "table_1" WHERE name = ?`,
      params: ["b"],
      actor: AGENT,
    });
    expect(out.rows).toEqual([{ name: "b" }]);
    const meta = await doJson<{ rows: Array<Record<string, unknown>> }>(actor, "/query", {
      sql: `SELECT name, display FROM _tables`,
      actor: AGENT,
    });
    expect(meta.rows).toEqual([{ name: "table_1", display: "Table 1" }]);
  });

  it("rejects writes with the shared guard's message", async () => {
    const { actor } = makeActor();
    await initStarter(actor);
    for (const sql of [`UPDATE "table_1" SET name = 'x'`, `WITH x AS (SELECT 1) INSERT INTO "table_1" (_id) VALUES ('y')`]) {
      const res = await doFetch(actor, "/query", { sql, actor: AGENT });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("select_only");
    }
  });

  it("rolls back a write that reaches the reader past the guard", async () => {
    const { actor, h } = makeActor();
    const starter = await initStarter(actor);
    await doJson(actor, "/rows/insert", { table_id: starter.table_id, rows: [{ Name: "sacred" }], actor: HUMAN });
    const out = runReadOnly(h.state.storage, `UPDATE "table_1" SET name = 'clobbered'`, []);
    expect(out.rows).toEqual([]);
    const after = await doJson<{ rows: Array<Record<string, unknown>> }>(actor, "/rows/list", { table_id: starter.table_id });
    expect(after.rows[0]![starter.columns[0]!.column_id]).toBe("sacred");
  });

  it("truncates at DATABASE_QUERY_MAX_ROWS with the flag set", async () => {
    const { actor, h } = makeActor();
    await initStarter(actor);
    // Seeded directly: the batch cap is below the row cap.
    const { storage } = h.state;
    storage.transactionSync(() => {
      for (let i = 0; i < DATABASE_QUERY_MAX_ROWS + 1; i++) {
        storage.sql.exec(`INSERT INTO "table_1" (_id, _created_at, _updated_at) VALUES (?, 0, 0)`, `row_seed${i}`);
      }
    });
    const out = await doJson<{ rows: unknown[]; truncated: boolean }>(actor, "/query", {
      sql: `SELECT _id FROM "table_1"`,
      actor: AGENT,
    });
    expect(out.rows).toHaveLength(DATABASE_QUERY_MAX_ROWS);
    expect(out.truncated).toBe(true);
  });

  it("honors a lowered row cap", async () => {
    const { actor, h } = makeActor();
    const starter = await initStarter(actor);
    await doJson(actor, "/rows/insert", {
      table_id: starter.table_id,
      rows: Array.from({ length: 7 }, (_, i) => ({ Name: `r${i}` })),
      actor: HUMAN,
    });
    const out = runReadOnly(h.state.storage, `SELECT name FROM "table_1"`, [], { maxRows: 5 });
    expect(out.rows).toHaveLength(5);
    expect(out.truncated).toBe(true);
  });

  // Actors share one event loop and node:sqlite is synchronous, so a query that never finishes stalls the whole node.
  describe("what a query may spend", () => {
    it("stops a query that keeps producing rows past the deadline", async () => {
      const { actor, h } = makeActor();
      const starter = await initStarter(actor);
      await doJson(actor, "/rows/insert", {
        table_id: starter.table_id,
        rows: Array.from({ length: 40 }, (_, i) => ({ Name: `r${i}` })),
        actor: HUMAN,
      });
      // A clock that jumps a second per reading.
      let t = 0;
      const now = () => (t += 1000);
      expect(() =>
        runReadOnly(h.state.storage, `SELECT name FROM "table_1"`, [], {
          maxRows: 10_000,
          deadlineMs: 3000,
          now,
        }),
      ).toThrow(/longer than 3s/);
    });

    it("refuses a single value larger than the per-value ceiling", () => {
      const { h } = makeActor();
      // One row, so no row cap can see it.
      expect(() =>
        runReadOnly(h.state.storage, `SELECT hex(randomblob(2000)) AS big`, [], {
          maxValueBytes: 100,
        }),
      ).toThrow(/column "big" is \d+ bytes, over the 100-byte limit/);
    });

    it("truncates at the aggregate ceiling, which the per-value cap cannot see", () => {
      const { h } = makeActor();
      const out = runReadOnly(
        h.state.storage,
        `SELECT hex(randomblob(400)) AS a, hex(randomblob(400)) AS b
         FROM (SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3)`,
        [],
        { maxValueBytes: 10_000, maxTotalBytes: 3_300 },
      );
      // hex() doubles the blob: 1,600 bytes a row, so two rows fit and the third does not.
      expect(out.rows).toHaveLength(2);
      expect(out.truncated).toBe(true);
    });

    it("lets a value at the ceiling through", () => {
      const { h } = makeActor();
      const out = runReadOnly(h.state.storage, `SELECT 'abc' AS s`, [], { maxValueBytes: 3 });
      expect(out.rows).toEqual([{ s: "abc" }]);
    });

    it("caps a cartesian product without building it", async () => {
      const { actor, h } = makeActor();
      const starter = await initStarter(actor);
      await doJson(actor, "/rows/insert", {
        table_id: starter.table_id,
        rows: Array.from({ length: 300 }, (_, i) => ({ Name: `r${i}` })),
        actor: HUMAN,
      });
      // 27 million rows if materialised.
      const started = Date.now();
      const out = runReadOnly(
        h.state.storage,
        `SELECT a.name FROM "table_1" a, "table_1" b, "table_1" c`,
        [],
        { maxRows: 50 },
      );
      expect(out.rows).toHaveLength(50);
      expect(out.truncated).toBe(true);
      expect(Date.now() - started).toBeLessThan(2000);
    });

    it("ships a per-value ceiling well under what one response may carry", () => {
      expect(DATABASE_QUERY_MAX_VALUE_BYTES).toBeLessThanOrEqual(1_000_000);
    });
  });

  it("maps SQLite errors to 400 sql_error", async () => {
    const { actor } = makeActor();
    await initStarter(actor);
    const res = await doFetch(actor, "/query", { sql: `SELECT * FROM "no_such_table"`, actor: AGENT });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("sql_error");
    expect(body.message).toMatch(/no_such_table/);
  });

  it("rate-limits the query budget per actor alias", async () => {
    const { actor } = makeActor();
    await initStarter(actor);
    for (let i = 0; i < DATABASE_QUERIES_PER_MINUTE; i++) {
      await doJson(actor, "/query", { sql: "SELECT 1 AS one", actor: AGENT });
    }
    const res = await doFetch(actor, "/query", { sql: "SELECT 1 AS one", actor: AGENT });
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: string }).error).toBe("rate_limited");
    const other = await doFetch(actor, "/query", { sql: "SELECT 1 AS one", actor: { alias: "agent:other", is_agent: true } });
    expect(other.status).toBe(200);
  });
});
