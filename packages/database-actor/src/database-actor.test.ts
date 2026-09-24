import { describe, expect, it } from "vitest";
import { DATABASE_MUTATIONS_PER_MINUTE } from "@stuga/protocol/databases/limits";
import type { DatabaseSchema } from "@stuga/protocol/databases/types";
import { AGENT, DB_ID, HUMAN, blobKeys, doFetch, doJson, initStarter, makeActor, makeState } from "../test/harness.js";

describe("dispatch plumbing", () => {
  it("400s without a dbId query param", async () => {
    const { actor } = makeActor();
    const res = await actor.fetch(new Request("http://actor/schema"));
    expect(res.status).toBe(400);
  });

  it("404s unknown routes, and known paths under the wrong method", async () => {
    const { actor } = makeActor();
    expect((await doFetch(actor, "/nope", {})).status).toBe(404);
    expect((await doFetch(actor, "/rows/insert")).status).toBe(404);
    expect((await doFetch(actor, "/schema", {})).status).toBe(404);
    expect((await doFetch(actor, "/v1/rows/list", { table_id: "t" })).status).toBe(404);
  });

  it("400s bodies that are not JSON objects and actors with a bad shape", async () => {
    const { actor } = makeActor();
    await initStarter(actor);
    const url = `http://actor/tables/create?dbId=${DB_ID}`;
    expect((await actor.fetch(new Request(url, { method: "POST", body: "not json" }))).status).toBe(400);
    const badActor = await doFetch(actor, "/tables/create", { display: "X", actor: { alias: "", is_agent: false } });
    expect(badActor.status).toBe(400);
    expect(((await badActor.json()) as { error: string }).error).toBe("bad_actor");
  });

  it("answers an empty schema before init", async () => {
    const { actor } = makeActor();
    const schema = await doJson<DatabaseSchema>(actor, "/schema");
    expect(schema).toEqual({ database_id: DB_ID, tables: [] });
  });
});

describe("mutation rate limit", () => {
  it("429s the request past DATABASE_MUTATIONS_PER_MINUTE for one alias, not others", async () => {
    const { actor } = makeActor();
    const starter = await initStarter(actor);
    for (let i = 0; i < DATABASE_MUTATIONS_PER_MINUTE; i++) {
      await doJson(actor, "/tables/rename", { table_id: starter.table_id, display: `T${i}`, actor: AGENT });
    }
    const res = await doFetch(actor, "/tables/rename", { table_id: starter.table_id, display: "Blocked", actor: AGENT });
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: string }).error).toBe("rate_limited");

    // The budget is per alias: the human still gets through.
    const human = await doFetch(actor, "/tables/rename", { table_id: starter.table_id, display: "Fine", actor: HUMAN });
    expect(human.status).toBe(200);
  });

  it("caps the alias map so rotating aliases cannot grow memory", async () => {
    const { actor } = makeActor();
    const starter = await initStarter(actor);
    for (let i = 0; i < 250; i++) {
      await doJson(actor, "/tables/rename", { table_id: starter.table_id, display: `R${i}`, actor: { alias: `spin:${i}`, is_agent: false } });
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((actor as any).db.rate.size).toBeLessThanOrEqual(200);
  });
});

describe("/destroy", () => {
  it("wipes SQLite state and the blob spill prefix; the actor comes back fresh", async () => {
    const { actor, h } = makeActor();
    const starter = await initStarter(actor);
    await doJson(actor, "/rows/insert", { table_id: starter.table_id, rows: [{ Name: "doomed" }], actor: AGENT });
    await doJson(actor, "/tables/delete", { table_id: starter.table_id, actor: AGENT });
    expect((await blobKeys(h.snapshots, `${DB_ID}/db-ops/`)).length).toBeGreaterThan(0);

    const out = await doJson<{ destroyed: boolean }>(actor, "/destroy", {});
    expect(out.destroyed).toBe(true);
    expect(await blobKeys(h.snapshots)).toEqual([]);

    const schema = await doJson<DatabaseSchema>(actor, "/schema");
    expect(schema).toEqual({ database_id: DB_ID, tables: [] });
    const ops = await doJson<{ ops: unknown[] }>(actor, "/ops");
    expect(ops.ops).toEqual([]);

    const again = await doJson<{ initialized: boolean }>(actor, "/schema/init", { actor: HUMAN });
    expect(again.initialized).toBe(true);
  });
});

describe("harness fidelity tripwires", () => {
  it("rejects boolean and undefined bindings like the real runtime", () => {
    const { state } = makeState();
    expect(() => state.storage.sql.exec("SELECT ?", true)).toThrow(TypeError);
    expect(() => state.storage.sql.exec("SELECT ?", undefined)).toThrow(TypeError);
  });

  it("nests transactionSync and rolls back on throw", () => {
    const { state } = makeState();
    const s = state.storage;
    s.sql.exec("CREATE TABLE t (v)");
    s.transactionSync(() => {
      s.sql.exec("INSERT INTO t VALUES (1)");
      expect(() =>
        s.transactionSync(() => {
          s.sql.exec("INSERT INTO t VALUES (2)");
          throw new Error("inner");
        }),
      ).toThrow("inner");
    });
    const rows = s.sql.exec("SELECT v FROM t").toArray();
    expect(rows).toEqual([{ v: 1 }]);
  });
});
