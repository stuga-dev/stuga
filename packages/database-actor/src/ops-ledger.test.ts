import { describe, expect, it } from "vitest";
import {
  DATABASE_OPS_KEEP,
  DATABASE_OP_INLINE_MAX_BYTES,
  DATABASE_REVERT_MAX_ROWS,
} from "@stuga/protocol/databases/limits";
import { AGENT, DB_ID, HUMAN, blobKeys, clearBlobs, colId, doFetch, doJson, hasBlob, initStarter, makeActor } from "../test/harness.js";

type Op = {
  op_id: string;
  seq: number;
  actor: string;
  is_agent: boolean;
  on_behalf_of: string | null;
  kind: string;
  summary: string;
  reverted_by: string | null;
  reverts: string | null;
  revertible: boolean;
};
type OpsOut = { ops: Op[] };
type ListOut = { rows: Array<Record<string, unknown> & { _id: string }>; total: number };

const ops = async (actor: ReturnType<typeof makeActor>["actor"]) => (await doJson<OpsOut>(actor, "/ops")).ops;

describe("what gets ledgered", () => {
  it("every actor's mutation is an op: humans as is_agent false, agents with on_behalf_of", async () => {
    const { actor } = makeActor();
    const starter = await initStarter(actor);
    expect((await ops(actor)).map((o) => [o.kind, o.is_agent])).toEqual([["tables.create", false]]);
    await doJson(actor, "/rows/insert", { table_id: starter.table_id, rows: [{ Name: "h" }], actor: HUMAN });
    const human = (await ops(actor))[0]!;
    expect(human).toMatchObject({
      kind: "rows.insert",
      summary: 'Inserted 1 row into "Table 1"',
      actor: "user:liv",
      is_agent: false,
      on_behalf_of: null,
      revertible: true,
    });
    const list = await doJson<ListOut>(actor, "/rows/list", { table_id: starter.table_id });
    await doJson(actor, "/rows/update", { table_id: starter.table_id, updates: [{ _id: list.rows[0]!._id, values: { Name: "H" } }], actor: HUMAN });
    expect((await ops(actor))[0]!.summary).toBe('Updated 1 row in "Table 1" (Name)');

    await doJson(actor, "/rows/insert", { table_id: starter.table_id, rows: [{ Name: "a" }, { Name: "b" }], actor: AGENT });
    const after = await ops(actor);
    expect(after).toHaveLength(4);
    expect(after[0]).toMatchObject({
      kind: "rows.insert",
      summary: 'Inserted 2 rows into "Table 1"',
      actor: "agent:claude",
      is_agent: true,
      on_behalf_of: "user:liv",
      reverted_by: null,
      revertible: true,
    });
    expect(after[0]!.op_id.startsWith("op_")).toBe(true);
  });

  it("records no op when the mutation fails mid-transaction", async () => {
    const { actor, h } = makeActor();
    const starter = await initStarter(actor);
    await doJson(actor, "/rows/insert", { table_id: starter.table_id, rows: [{ Name: "before" }], actor: AGENT });
    expect(await ops(actor)).toHaveLength(2);

    // A physical column the meta still advertises is gone: row 1 inserts, row 2
    // throws inside the transaction, and both the op row and row 1 roll back.
    h.state.storage.sql.exec(`ALTER TABLE "table_1" DROP COLUMN "notes"`);
    const res = await doFetch(actor, "/rows/insert", {
      table_id: starter.table_id,
      rows: [{ Name: "phantom" }, { Notes: "boom" }],
      actor: AGENT,
    });
    expect(res.status).toBe(500);
    expect(await ops(actor)).toHaveLength(2);
    const list = await doJson<ListOut>(actor, "/rows/list", { table_id: starter.table_id });
    expect(list.rows.map((r) => r[colId(starter, "Name")])).toEqual(["before"]);
  });
});

describe("revert flows", () => {
  it("reverts rows.insert by deleting the rows, and marks the original", async () => {
    const { actor } = makeActor();
    const starter = await initStarter(actor);
    await doJson(actor, "/rows/insert", { table_id: starter.table_id, rows: [{ Name: "a" }, { Name: "b" }], actor: AGENT });
    const [op] = await ops(actor);
    const out = await doJson<{ reverted: boolean; restored: number; missing: number }>(actor, "/ops/revert", {
      op_id: op!.op_id,
      actor: HUMAN,
    });
    expect(out).toEqual({ reverted: true, restored: 2, missing: 0 });
    expect((await doJson<ListOut>(actor, "/rows/list", { table_id: starter.table_id })).total).toBe(0);

    const after = await ops(actor);
    expect(after).toHaveLength(3);
    expect(after[0]).toMatchObject({ kind: "revert", reverts: op!.op_id, revertible: false, actor: "user:liv", is_agent: false });
    expect(after[1]).toMatchObject({ op_id: op!.op_id, reverted_by: after[0]!.op_id, revertible: false, is_agent: true });
  });

  it("reverts rows.update tolerantly, counting rows deleted since as missing", async () => {
    const { actor } = makeActor();
    const starter = await initStarter(actor);
    const ins = await doJson<{ row_ids: string[] }>(actor, "/rows/insert", {
      table_id: starter.table_id,
      rows: [{ Name: "one" }, { Name: "two" }],
      actor: HUMAN,
    });
    await doJson(actor, "/rows/update", {
      table_id: starter.table_id,
      updates: [
        { _id: ins.row_ids[0], values: { Name: "ONE" } },
        { _id: ins.row_ids[1], values: { Name: "TWO" } },
      ],
      actor: AGENT,
    });
    await doJson(actor, "/rows/delete", { table_id: starter.table_id, row_ids: [ins.row_ids[1]], actor: HUMAN });
    const op = (await ops(actor)).find((o) => o.kind === "rows.update");
    const out = await doJson<{ restored: number; missing: number }>(actor, "/ops/revert", { op_id: op!.op_id, actor: HUMAN });
    expect(out.restored).toBe(1);
    expect(out.missing).toBe(1);
    const list = await doJson<ListOut>(actor, "/rows/list", { table_id: starter.table_id });
    expect(list.rows.map((r) => r[colId(starter, "Name")])).toEqual(["one"]);
  });

  it("reverts rows.delete by re-inserting full rows, ids and timestamps intact", async () => {
    const { actor } = makeActor();
    const starter = await initStarter(actor);
    const ins = await doJson<{ row_ids: string[] }>(actor, "/rows/insert", {
      table_id: starter.table_id,
      rows: [{ Name: "keep", Done: true }],
      actor: HUMAN,
    });
    const before = (await doJson<ListOut>(actor, "/rows/list", { table_id: starter.table_id })).rows[0]!;
    await doJson(actor, "/rows/delete", { table_id: starter.table_id, row_ids: ins.row_ids, actor: AGENT });
    const [op] = await ops(actor);
    await doJson(actor, "/ops/revert", { op_id: op!.op_id, actor: HUMAN });
    const after = (await doJson<ListOut>(actor, "/rows/list", { table_id: starter.table_id })).rows[0]!;
    expect(after).toEqual(before);
  });

  it("reverts columns.delete by recreating the column with its values", async () => {
    const { actor } = makeActor();
    const starter = await initStarter(actor);
    const notes = starter.columns.find((c) => c.display === "Notes")!;
    await doJson(actor, "/rows/insert", {
      table_id: starter.table_id,
      rows: [{ Name: "a", Notes: "remember me" }, { Name: "b" }],
      actor: HUMAN,
    });
    await doJson(actor, "/columns/set-description", {
      table_id: starter.table_id,
      column_id: notes.column_id,
      description: "Whatever the handler wrote down",
      actor: HUMAN,
    });
    await doJson(actor, "/columns/delete", { table_id: starter.table_id, column_id: notes.column_id, actor: AGENT });
    const [op] = await ops(actor);
    const out = await doJson<{ restored: number; missing: number }>(actor, "/ops/revert", { op_id: op!.op_id, actor: HUMAN });
    expect(out).toMatchObject({ restored: 1, missing: 0 });
    const schema = await doJson<{ tables: Array<{ columns: Array<{ column_id: string; name: string; description?: string }> }> }>(actor, "/schema");
    const restored = schema.tables[0]!.columns.find((c) => c.column_id === notes.column_id);
    expect(restored?.name).toBe("notes");
    // The column comes back described, not just re-typed.
    expect(restored?.description).toBe("Whatever the handler wrote down");
    const list = await doJson<ListOut>(actor, "/rows/list", { table_id: starter.table_id });
    expect(list.rows.map((r) => r[notes.column_id])).toEqual(["remember me", null]);
  });

  it("reverts tables.delete from the blob spill, uniquifying a retaken physical name", async () => {
    const { actor, h } = makeActor();
    const starter = await initStarter(actor);
    const name = starter.columns.find((c) => c.display === "Name")!;
    await doJson(actor, "/columns/set-description", {
      table_id: starter.table_id,
      column_id: name.column_id,
      description: "Legal name, as on the passport",
      actor: HUMAN,
    });
    await doJson(actor, "/rows/insert", { table_id: starter.table_id, rows: [{ Name: "x" }, { Name: "y" }], actor: HUMAN });
    await doJson(actor, "/tables/delete", { table_id: starter.table_id, actor: AGENT });

    // tables.delete spills whatever its size.
    const [op] = await ops(actor);
    const spillKey = `${DB_ID}/db-ops/${op!.op_id}.json`;
    expect(await hasBlob(h.snapshots, spillKey)).toBe(true);
    expect(op!.revertible).toBe(true);

    await doJson(actor, "/tables/create", { display: "Table 1", actor: HUMAN });

    const out = await doJson<{ restored: number; missing: number }>(actor, "/ops/revert", { op_id: op!.op_id, actor: HUMAN });
    expect(out).toMatchObject({ restored: 2, missing: 0 });
    const schema = await doJson<{
      tables: Array<{ table_id: string; name: string; display: string; row_count: number; columns: Array<{ column_id: string; description?: string }> }>;
    }>(actor, "/schema");
    const revived = schema.tables.find((t) => t.table_id === starter.table_id)!;
    expect(revived.display).toBe("Table 1");
    expect(revived.name).toBe("table_1_2");
    expect(revived.row_count).toBe(2);
    expect(revived.columns.find((c) => c.column_id === name.column_id)?.description).toBe("Legal name, as on the passport");
  });

  it("reverting tables.delete re-links the rows' pages and asks the node for them back", async () => {
    const { actor } = makeActor();
    const starter = await initStarter(actor);
    const ins = await doJson<{ row_ids: string[] }>(actor, "/rows/insert", { table_id: starter.table_id, rows: [{ Name: "x" }, { Name: "y" }], actor: HUMAN });
    const rowX = ins.row_ids[0]!;
    await doJson(actor, "/rows/link-doc", { table_id: starter.table_id, row_id: rowX, doc_id: "page-x", actor: HUMAN });
    await doJson(actor, "/tables/delete", { table_id: starter.table_id, actor: AGENT });
    const link = { doc_id: "page-x", row_id: rowX, table_id: starter.table_id };
    expect(await doJson(actor, "/doc-links/take", {})).toEqual({ trash: [link], restore: [] });

    const op = (await ops(actor)).find((o) => o.kind === "tables.delete")!;
    const out = await doJson<{ restored: number; missing: number }>(actor, "/ops/revert", { op_id: op.op_id, actor: HUMAN });
    expect(out).toMatchObject({ restored: 2, missing: 0 });
    const list = await doJson<ListOut>(actor, "/rows/list", { table_id: starter.table_id });
    expect(list.rows.find((r) => r._id === rowX)!._doc_id).toBe("page-x");
    expect(list.rows.find((r) => r._id !== rowX)!._doc_id).toBeNull();
    expect(await doJson(actor, "/doc-links/take", {})).toEqual({ trash: [], restore: [link] });
  });

  it("spills oversized row inverses to the blob store and reverts from there", async () => {
    const { actor, h } = makeActor();
    const starter = await initStarter(actor);
    const big = "x".repeat(16_000);
    const ins = await doJson<{ row_ids: string[] }>(actor, "/rows/insert", {
      table_id: starter.table_id,
      rows: Array.from({ length: Math.ceil(DATABASE_OP_INLINE_MAX_BYTES / 16_000) + 1 }, () => ({ Notes: big })),
      actor: HUMAN,
    });
    await doJson(actor, "/rows/delete", { table_id: starter.table_id, row_ids: ins.row_ids, actor: AGENT });
    const [op] = await ops(actor);
    expect(await hasBlob(h.snapshots, `${DB_ID}/db-ops/${op!.op_id}.json`)).toBe(true);
    const out = await doJson<{ restored: number }>(actor, "/ops/revert", { op_id: op!.op_id, actor: HUMAN });
    expect(out.restored).toBe(ins.row_ids.length);
    expect((await doJson<ListOut>(actor, "/rows/list", { table_id: starter.table_id })).total).toBe(ins.row_ids.length);
  });

  it("never restores an update into a same-name column recreated after a delete", async () => {
    const { actor } = makeActor();
    const starter = await initStarter(actor);
    const notes = starter.columns.find((c) => c.display === "Notes")!;
    const ins = await doJson<{ row_ids: string[] }>(actor, "/rows/insert", {
      table_id: starter.table_id,
      rows: [{ Name: "r", Notes: "old-notes" }],
      actor: HUMAN,
    });
    await doJson(actor, "/rows/update", {
      table_id: starter.table_id,
      updates: [{ _id: ins.row_ids[0], values: { Notes: "agent-note" } }],
      actor: AGENT,
    });
    // A new "Notes" column inherits the dead one's physical name.
    await doJson(actor, "/columns/delete", { table_id: starter.table_id, column_id: notes.column_id, actor: HUMAN });
    const impostor = await doJson<{ column: { name: string; column_id: string } }>(actor, "/columns/add", {
      table_id: starter.table_id,
      display: "Notes",
      type: "text",
      actor: HUMAN,
    });
    expect(impostor.column.name).toBe("notes");
    expect(impostor.column.column_id).not.toBe(notes.column_id);
    await doJson(actor, "/rows/update", {
      table_id: starter.table_id,
      updates: [{ _id: ins.row_ids[0], values: { Notes: "new-col-value" } }],
      actor: HUMAN,
    });

    // The inverse is keyed by the dead column_id, so nothing lands in the successor.
    const op = (await ops(actor)).find((o) => o.kind === "rows.update" && o.is_agent)!;
    const out = await doJson<{ restored: number; missing: number }>(actor, "/ops/revert", { op_id: op.op_id, actor: HUMAN });
    expect(out).toMatchObject({ restored: 0, missing: 1 });
    const list = await doJson<ListOut>(actor, "/rows/list", { table_id: starter.table_id });
    expect(list.rows[0]![impostor.column.column_id]).toBe("new-col-value");
  });

  it("re-inserted rows drop cells whose column vanished instead of filling a same-name successor", async () => {
    const { actor } = makeActor();
    const starter = await initStarter(actor);
    const notes = starter.columns.find((c) => c.display === "Notes")!;
    const ins = await doJson<{ row_ids: string[] }>(actor, "/rows/insert", {
      table_id: starter.table_id,
      rows: [{ Name: "victim", Notes: "old-notes" }],
      actor: HUMAN,
    });
    await doJson(actor, "/rows/delete", { table_id: starter.table_id, row_ids: ins.row_ids, actor: AGENT });
    await doJson(actor, "/columns/delete", { table_id: starter.table_id, column_id: notes.column_id, actor: HUMAN });
    const successor = await doJson<{ column: { column_id: string } }>(actor, "/columns/add", { table_id: starter.table_id, display: "Notes", type: "text", actor: HUMAN });

    const op = (await ops(actor)).find((o) => o.kind === "rows.delete")!;
    const out = await doJson<{ restored: number; missing: number }>(actor, "/ops/revert", { op_id: op.op_id, actor: HUMAN });
    expect(out).toMatchObject({ restored: 1, missing: 0 });
    const list = await doJson<ListOut>(actor, "/rows/list", { table_id: starter.table_id });
    expect(list.rows[0]![colId(starter, "Name")]).toBe("victim");
    expect(list.rows[0]![successor.column.column_id]).toBeNull();
  });

  it("records a too-large tables.delete without an inverse: non-revertible, labeled, nothing spilled", async () => {
    const { actor, h } = makeActor();
    const starter = await initStarter(actor);
    const { storage } = h.state;
    storage.transactionSync(() => {
      for (let i = 0; i < DATABASE_REVERT_MAX_ROWS + 1; i++) {
        storage.sql.exec(`INSERT INTO "table_1" (_id, _created_at, _updated_at) VALUES (?, 0, 0)`, `row_seed${i}`);
      }
    });

    await doJson(actor, "/tables/delete", { table_id: starter.table_id, actor: AGENT });
    const [op] = await ops(actor);
    expect(op!.kind).toBe("tables.delete");
    expect(op!.revertible).toBe(false);
    expect(op!.summary).toBe(`Deleted table "Table 1" (${DATABASE_REVERT_MAX_ROWS + 1} rows) — too large to capture for revert`);
    expect(await blobKeys(h.snapshots)).toEqual([]);

    const res = await doFetch(actor, "/ops/revert", { op_id: op!.op_id, actor: HUMAN });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("not_revertible");
  });

  it("409s a rows.update whose blob-spill await raced a set-type (stale validation)", async () => {
    const { actor, h } = makeActor();
    const starter = await initStarter(actor);
    const notes = starter.columns.find((c) => c.display === "Notes")!;
    // Under the cell cap, and five of them make the inverse spill.
    const big = "x".repeat(16_000);
    const ins = await doJson<{ row_ids: string[] }>(actor, "/rows/insert", {
      table_id: starter.table_id,
      rows: Array.from({ length: 5 }, () => ({ Notes: big })),
      actor: HUMAN,
    });

    // A set-type commits while the inverse spills.
    const origPut = h.snapshots.put.bind(h.snapshots);
    let fired = false;
    h.snapshots.put = async (key, value) => {
      await origPut(key, value);
      if (!fired) {
        fired = true;
        h.state.storage.sql.exec(`UPDATE _columns SET type = 'number', options = NULL WHERE column_id = ?`, notes.column_id);
      }
    };

    const res = await doFetch(actor, "/rows/update", {
      table_id: starter.table_id,
      updates: ins.row_ids.map((id) => ({ _id: id, values: { Notes: big } })),
      actor: AGENT,
    });
    expect(fired).toBe(true);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("conflict");

    const list = await doJson<ListOut>(actor, "/rows/list", { table_id: starter.table_id });
    expect(list.rows.every((r) => r[notes.column_id] === big)).toBe(true);
    expect((await ops(actor)).some((o) => o.kind === "rows.update")).toBe(false);
  });

  it("409s an insert whose column is deleted while its inverse spills", async () => {
    const { actor, h } = makeActor();
    const starter = await initStarter(actor);
    const notes = starter.columns.find((c) => c.display === "Notes")!;
    const origPut = h.snapshots.put.bind(h.snapshots);
    let fired = false;
    h.snapshots.put = async (key, value) => {
      await origPut(key, value);
      if (!fired) {
        fired = true;
        await doJson(actor, "/columns/delete", { table_id: starter.table_id, column_id: notes.column_id, actor: HUMAN });
      }
    };

    // Enough row ids that the inverse spills.
    const res = await doFetch(actor, "/rows/insert", {
      table_id: starter.table_id,
      rows: Array.from({ length: 4_000 }, (_, i) => ({ Name: `r${i}`, Notes: "n" })),
      import: true,
      actor: HUMAN,
    });
    expect(fired).toBe(true);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("conflict");
    expect((await doJson<ListOut>(actor, "/rows/list", { table_id: starter.table_id })).total).toBe(0);
    expect((await ops(actor)).some((o) => o.kind === "rows.insert")).toBe(false);
  });

  it("409s: double revert, revert-of-revert, pruned spill payload, unknown op 404", async () => {
    const { actor, h } = makeActor();
    const starter = await initStarter(actor);
    await doJson(actor, "/rows/insert", { table_id: starter.table_id, rows: [{ Name: "a" }], actor: AGENT });
    const [op] = await ops(actor);
    await doJson(actor, "/ops/revert", { op_id: op!.op_id, actor: HUMAN });

    const again = await doFetch(actor, "/ops/revert", { op_id: op!.op_id, actor: HUMAN });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toBe("already_reverted");

    const revertOp = (await ops(actor))[0]!;
    expect(revertOp.kind).toBe("revert");
    const meta = await doFetch(actor, "/ops/revert", { op_id: revertOp.op_id, actor: HUMAN });
    expect(meta.status).toBe(409);
    expect(((await meta.json()) as { error: string }).error).toBe("not_revertible");

    expect((await doFetch(actor, "/ops/revert", { op_id: "op_ghost", actor: HUMAN })).status).toBe(404);

    // A spilled inverse whose blob is gone.
    await doJson(actor, "/tables/delete", { table_id: starter.table_id, actor: AGENT });
    const [del] = await ops(actor);
    await clearBlobs(h.snapshots);
    const gone = await doFetch(actor, "/ops/revert", { op_id: del!.op_id, actor: HUMAN });
    expect(gone.status).toBe(409);
    expect(((await gone.json()) as { error: string }).error).toBe("inverse_missing");
  });
});

describe("retention", () => {
  it("prunes to the ops_keep the request carries; 0 never prunes", async () => {
    const { actor } = makeActor();
    const starter = await initStarter(actor);
    for (const name of ["a", "b", "c", "d"]) {
      await doJson(actor, "/rows/insert", { table_id: starter.table_id, rows: [{ Name: name }], actor: HUMAN, ops_keep: 3 });
    }
    expect((await ops(actor)).map((o) => o.summary)).toEqual([
      'Inserted 1 row into "Table 1"',
      'Inserted 1 row into "Table 1"',
      'Inserted 1 row into "Table 1"',
    ]);
    await doJson(actor, "/rows/insert", { table_id: starter.table_id, rows: [{ Name: "e" }], actor: HUMAN, ops_keep: 0 });
    expect(await ops(actor)).toHaveLength(4);
    await doJson(actor, "/rows/insert", { table_id: starter.table_id, rows: [{ Name: "f" }], actor: HUMAN });
    expect(await ops(actor)).toHaveLength(5);
    expect((await doFetch(actor, "/rows/insert", { table_id: starter.table_id, rows: [{ Name: "g" }], actor: HUMAN, ops_keep: -1 })).status).toBe(400);
  });

  it("prunes ops beyond DATABASE_OPS_KEEP and deletes their blob spills best-effort", async () => {
    const { actor, h } = makeActor();
    const starter = await initStarter(actor);
    // Seeded directly: that many real mutations would hit the rate limit. Two doomed rows carry spills.
    const { storage } = h.state;
    const insert = `INSERT INTO _ops (op_id, seq, ts, actor, is_agent, on_behalf_of, kind, table_id, summary, inverse, blob_key, reverted_by, reverts)
       VALUES (?, ?, 0, 'agent:x', 1, NULL, 'rows.insert', NULL, 's', ?, ?, NULL, NULL)`;
    const seeded = DATABASE_OPS_KEEP + 100;
    const spilledKeys: string[] = [];
    storage.transactionSync(() => {
      for (let i = 1; i <= seeded; i++) {
        const spilled = i <= 2;
        const key = spilled ? `${DB_ID}/db-ops/op_seed${i}.json` : null;
        storage.sql.exec(insert, `op_seed${i}`, i, spilled ? null : "{}", key);
        if (key) spilledKeys.push(key);
      }
    });
    for (const key of spilledKeys) await h.snapshots.put(key, "{}");

    await doJson(actor, "/rows/insert", { table_id: starter.table_id, rows: [{ Name: "tip" }], actor: AGENT });
    await new Promise((r) => setTimeout(r, 0));

    const count = storage.sql.exec(`SELECT COUNT(*) AS n, MIN(seq) AS lo, MAX(seq) AS hi FROM _ops`).one() as {
      n: number;
      lo: number;
      hi: number;
    };
    expect(count.n).toBe(DATABASE_OPS_KEEP);
    expect(count.hi).toBe(seeded + 1);
    expect(count.lo).toBe(seeded + 1 - DATABASE_OPS_KEEP + 1);
    expect(await hasBlob(h.snapshots, `${DB_ID}/db-ops/op_seed1.json`)).toBe(false);
    expect(await hasBlob(h.snapshots, `${DB_ID}/db-ops/op_seed2.json`)).toBe(false);
  });
});
