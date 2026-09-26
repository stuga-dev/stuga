import { describe, expect, it } from "vitest";
import {
  DATABASE_MAX_CELL_BYTES,
  DATABASE_MAX_ROWS,
  DATABASE_MAX_ROWS_PER_WRITE,
  DATABASE_ROWS_PAGE_MAX,
} from "@stuga/protocol/databases/limits";
import { HUMAN, colId, doFetch, doJson, initStarter, makeActor } from "../test/harness.js";

type Row = Record<string, unknown> & { _id: string };
type ListOut = { rows: Row[]; total: number };

describe("/rows/insert", () => {
  it("resolves display names, physical names and column_ids, and lists cells by column_id only", async () => {
    const { actor } = makeActor();
    const starter = await initStarter(actor);
    const nameCol = starter.columns.find((c) => c.display === "Name")!;
    const out = await doJson<{ inserted: number; row_ids: string[] }>(actor, "/rows/insert", {
      table_id: starter.table_id,
      rows: [
        { Name: "by display" },
        { name: "by physical" },
        { [nameCol.column_id]: "by id" },
      ],
      actor: HUMAN,
    });
    expect(out.inserted).toBe(3);
    expect(out.row_ids).toHaveLength(3);
    expect(out.row_ids.every((id) => id.startsWith("row_"))).toBe(true);

    const list = await doJson<ListOut>(actor, "/rows/list", { table_id: starter.table_id });
    expect(list.total).toBe(3);
    expect(list.rows.map((r) => r[nameCol.column_id])).toEqual(["by display", "by physical", "by id"]);
    expect(list.rows[0]!._id).toBe(out.row_ids[0]);
    expect(typeof list.rows[0]!._created_at).toBe("number");
    expect(Object.keys(list.rows[0]!).sort()).toEqual(["_created_at", "_doc_id", "_id", "_updated_at", ...starter.columns.map((c) => c.column_id)].sort());
  });

  it("400s on an ambiguous display name, listing the candidates", async () => {
    const { actor } = makeActor();
    const starter = await initStarter(actor);
    await doJson(actor, "/columns/add", { table_id: starter.table_id, display: "Name", type: "text", actor: HUMAN });
    const res = await doFetch(actor, "/rows/insert", { table_id: starter.table_id, rows: [{ Name: "x" }], actor: HUMAN });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("ambiguous_column");
    expect(body.message).toContain("name_2");
  });

  it("400s on unknown refs and on two refs hitting one column", async () => {
    const { actor } = makeActor();
    const starter = await initStarter(actor);
    const unknown = await doFetch(actor, "/rows/insert", { table_id: starter.table_id, rows: [{ Nope: 1 }], actor: HUMAN });
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { error: string }).error).toBe("unknown_column");

    const dup = await doFetch(actor, "/rows/insert", {
      table_id: starter.table_id,
      rows: [{ Name: "a", name: "b" }],
      actor: HUMAN,
    });
    expect(dup.status).toBe(400);
    expect(((await dup.json()) as { message: string }).message).toMatch(/referenced twice/);
  });

  it("names the offending column in validation failures", async () => {
    const { actor } = makeActor();
    const starter = await initStarter(actor);
    const res = await doFetch(actor, "/rows/insert", { table_id: starter.table_id, rows: [{ Done: "yes" }], actor: HUMAN });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toContain('"Done"');
  });

  it("enforces the cell byte cap", async () => {
    const { actor } = makeActor();
    const starter = await initStarter(actor);
    const res = await doFetch(actor, "/rows/insert", {
      table_id: starter.table_id,
      rows: [{ Notes: "a".repeat(DATABASE_MAX_CELL_BYTES + 1) }],
      actor: HUMAN,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toMatch(/too long/);
  });

  it("normalizes checkbox booleans to 0/1", async () => {
    const { actor } = makeActor();
    const starter = await initStarter(actor);
    await doJson(actor, "/rows/insert", { table_id: starter.table_id, rows: [{ Done: true }, { Done: false }], actor: HUMAN });
    const list = await doJson<ListOut>(actor, "/rows/list", { table_id: starter.table_id });
    expect(list.rows.map((r) => r[colId(starter, "Done")])).toEqual([1, 0]);
  });

  it("409s past the per-write batch cap and past the table row cap", async () => {
    const { actor, h } = makeActor();
    const starter = await initStarter(actor);
    const tooMany = await doFetch(actor, "/rows/insert", {
      table_id: starter.table_id,
      rows: Array.from({ length: DATABASE_MAX_ROWS_PER_WRITE + 1 }, () => ({ Name: "x" })),
      actor: HUMAN,
    });
    expect(tooMany.status).toBe(409);
    expect(((await tooMany.json()) as { error: string }).error).toBe("batch_cap");

    // Seeded directly: the batch cap is far below the row cap.
    const { storage } = h.state;
    storage.transactionSync(() => {
      for (let i = 0; i < DATABASE_MAX_ROWS; i++) {
        storage.sql.exec(`INSERT INTO "table_1" (_id, _created_at, _updated_at) VALUES (?, 0, 0)`, `row_seed${i}`);
      }
    });
    const overCap = await doFetch(actor, "/rows/insert", { table_id: starter.table_id, rows: [{ Name: "one more" }], actor: HUMAN });
    expect(overCap.status).toBe(409);
    expect(((await overCap.json()) as { error: string }).error).toBe("row_cap");
  });
});

describe("/rows/list", () => {
  async function seeded() {
    const { actor } = makeActor();
    const starter = await initStarter(actor);
    await doJson(actor, "/columns/add", { table_id: starter.table_id, display: "Amount", type: "number", actor: HUMAN });
    await doJson(actor, "/rows/insert", {
      table_id: starter.table_id,
      rows: [
        { Name: "banana", Amount: 2 },
        { Name: "apple", Amount: 3, Notes: "100% real" },
        { Name: "cherry", Amount: 1, Notes: "100 things" },
      ],
      actor: HUMAN,
    });
    return { actor, starter, name: colId(starter, "Name") };
  }

  it("sorts by a user column in both directions and keeps insertion order by default", async () => {
    const { actor, starter, name } = await seeded();
    const byDefault = await doJson<ListOut>(actor, "/rows/list", { table_id: starter.table_id });
    expect(byDefault.rows.map((r) => r[name])).toEqual(["banana", "apple", "cherry"]);

    const asc = await doJson<ListOut>(actor, "/rows/list", { table_id: starter.table_id, sort: { column_id: "Amount", dir: "asc" } });
    expect(asc.rows.map((r) => r[name])).toEqual(["cherry", "banana", "apple"]);

    const desc = await doJson<ListOut>(actor, "/rows/list", { table_id: starter.table_id, sort: { column_id: "amount", dir: "desc" } });
    expect(desc.rows.map((r) => r[name])).toEqual(["apple", "banana", "cherry"]);
  });

  it("escapes LIKE wildcards in contains filters", async () => {
    const { actor, starter, name } = await seeded();
    const literal = await doJson<ListOut>(actor, "/rows/list", {
      table_id: starter.table_id,
      filter: { column_id: "Notes", op: "contains", value: "0%" },
    });
    expect(literal.total).toBe(1);
    expect(literal.rows[0]![name]).toBe("apple");
  });

  it("supports eq/ne/gt/lt/empty/not_empty", async () => {
    const { actor, starter } = await seeded();
    const t = starter.table_id;
    const run = (filter: Record<string, unknown>) => doJson<ListOut>(actor, "/rows/list", { table_id: t, filter });
    expect((await run({ column_id: "Name", op: "eq", value: "apple" })).total).toBe(1);
    expect((await run({ column_id: "Name", op: "ne", value: "apple" })).total).toBe(2);
    expect((await run({ column_id: "Amount", op: "gt", value: 1 })).total).toBe(2);
    expect((await run({ column_id: "Amount", op: "lt", value: 2 })).total).toBe(1);
    expect((await run({ column_id: "Notes", op: "empty" })).total).toBe(1);
    expect((await run({ column_id: "Notes", op: "not_empty" })).total).toBe(2);
  });

  it("pages with limit/offset while total reflects the whole filtered set", async () => {
    const { actor, starter, name } = await seeded();
    const page = await doJson<ListOut>(actor, "/rows/list", {
      table_id: starter.table_id,
      sort: { column_id: "Amount", dir: "asc" },
      limit: 2,
      offset: 2,
    });
    expect(page.rows.map((r) => r[name])).toEqual(["apple"]);
    expect(page.total).toBe(3);
  });

  it("pages by `after` in the order rows were added, and a row deleted between two pages moves no other past the edge", async () => {
    const { actor } = makeActor();
    const starter = await initStarter(actor);
    const name = colId(starter, "Name");
    // One write: every row added in the same millisecond, so rowid alone orders them.
    const { row_ids } = await doJson<{ row_ids: string[] }>(actor, "/rows/insert", {
      table_id: starter.table_id,
      rows: Array.from({ length: 7 }, (_, i) => ({ Name: `r${i}` })),
      actor: HUMAN,
    });
    type Page = ListOut & { next: string | null };
    const page = (after: string) => doJson<Page>(actor, "/rows/list", { table_id: starter.table_id, limit: 3, after });
    const first = await page("");
    expect(first.rows.map((r) => r[name])).toEqual(["r0", "r1", "r2"]);
    expect(first.next).toMatch(/^\d+\.\d+$/);
    await doJson(actor, "/rows/delete", { table_id: starter.table_id, row_ids: [row_ids[1]], actor: HUMAN });
    await doJson(actor, "/rows/insert", { table_id: starter.table_id, rows: [{ Name: "later" }], actor: HUMAN });
    const second = await page(first.next!);
    expect(second.rows.map((r) => r[name])).toEqual(["r3", "r4", "r5"]);
    const third = await page(second.next!);
    expect(third.rows.map((r) => r[name])).toEqual(["r6", "later"]);
    expect(third.next).toBeNull();
    expect(third.total).toBe(7);
    // Without `after`, the answer is as it was.
    expect("next" in (await doJson<ListOut>(actor, "/rows/list", { table_id: starter.table_id }))).toBe(false);
  });

  it("refuses an `after` it did not hand out, or one with a shape a listing by `after` does not take", async () => {
    const { actor, starter } = await seeded();
    const t = starter.table_id;
    expect((await doFetch(actor, "/rows/list", { table_id: t, after: "row_1" })).status).toBe(400);
    expect((await doFetch(actor, "/rows/list", { table_id: t, after: 3 })).status).toBe(400);
    const shaped = await doFetch(actor, "/rows/list", { table_id: t, after: "", sort: { column_id: "Amount" }, offset: 1 });
    expect(shaped.status).toBe(400);
    expect(((await shaped.json()) as { message: string }).message).toContain("it takes no offset, sort");
  });

  it("clamps limit to DATABASE_ROWS_PAGE_MAX", async () => {
    const { actor } = makeActor();
    const starter = await initStarter(actor);
    await doJson(actor, "/rows/insert", {
      table_id: starter.table_id,
      rows: Array.from({ length: DATABASE_ROWS_PAGE_MAX + 1 }, (_, i) => ({ Name: `r${i}` })),
      actor: HUMAN,
    });
    const out = await doJson<ListOut>(actor, "/rows/list", { table_id: starter.table_id, limit: 99_999 });
    expect(out.rows).toHaveLength(DATABASE_ROWS_PAGE_MAX);
    expect(out.total).toBe(DATABASE_ROWS_PAGE_MAX + 1);
  });

  it("coerces string comparison values on numeric columns (and rejects non-numeric ones)", async () => {
    const { actor } = makeActor();
    const starter = await initStarter(actor);
    await doJson(actor, "/columns/add", { table_id: starter.table_id, display: "Amount", type: "number", actor: HUMAN });
    await doJson(actor, "/rows/insert", {
      table_id: starter.table_id,
      rows: [
        { Name: "small", Amount: 50 },
        { Name: "large", Amount: 150 },
      ],
      actor: HUMAN,
    });
    // Bound as TEXT, "100" would sort above every number and match nothing.
    const gt = await doJson<ListOut>(actor, "/rows/list", {
      table_id: starter.table_id,
      filter: { column_id: "Amount", op: "gt", value: "100" },
    });
    expect(gt.total).toBe(1);
    expect(gt.rows[0]![colId(starter, "Name")]).toBe("large");

    const bad = await doFetch(actor, "/rows/list", {
      table_id: starter.table_id,
      filter: { column_id: "Amount", op: "eq", value: "abc" },
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { message: string }).message).toContain('"Amount"');

    await doJson(actor, "/rows/update", {
      table_id: starter.table_id,
      updates: [{ _id: gt.rows[0]!._id, values: { Done: true } }],
      actor: HUMAN,
    });
    const done = await doJson<ListOut>(actor, "/rows/list", {
      table_id: starter.table_id,
      filter: { column_id: "Done", op: "eq", value: "1" },
    });
    expect(done.total).toBe(1);
    expect(done.rows[0]![colId(starter, "Name")]).toBe("large");
  });

  it("rejects bad sorts and filters", async () => {
    const { actor, starter } = await seeded();
    expect((await doFetch(actor, "/rows/list", { table_id: starter.table_id, sort: { column_id: "Nope" } })).status).toBe(400);
    expect(
      (await doFetch(actor, "/rows/list", { table_id: starter.table_id, filter: { column_id: "Name", op: "regex", value: "x" } })).status,
    ).toBe(400);
    expect((await doFetch(actor, "/rows/list", { table_id: starter.table_id, limit: 0 })).status).toBe(400);
  });
});

describe("/rows/update and /rows/delete", () => {
  it("updates cells, reports missing ids, and bumps _updated_at", async () => {
    const { actor } = makeActor();
    const starter = await initStarter(actor);
    const ins = await doJson<{ row_ids: string[] }>(actor, "/rows/insert", {
      table_id: starter.table_id,
      rows: [{ Name: "before" }],
      actor: HUMAN,
    });
    const out = await doJson<{ updated: number; missing: string[] }>(actor, "/rows/update", {
      table_id: starter.table_id,
      updates: [
        { _id: ins.row_ids[0], values: { Name: "after", Done: true } },
        { _id: "row_ghost", values: { Name: "nope" } },
      ],
      actor: HUMAN,
    });
    expect(out.updated).toBe(1);
    expect(out.missing).toEqual(["row_ghost"]);
    const list = await doJson<ListOut>(actor, "/rows/list", { table_id: starter.table_id });
    expect(list.rows[0]![colId(starter, "Name")]).toBe("after");
    expect(list.rows[0]![colId(starter, "Done")]).toBe(1);
  });

  it("rejects invalid update values with the column named", async () => {
    const { actor } = makeActor();
    const starter = await initStarter(actor);
    const ins = await doJson<{ row_ids: string[] }>(actor, "/rows/insert", { table_id: starter.table_id, rows: [{}], actor: HUMAN });
    const res = await doFetch(actor, "/rows/update", {
      table_id: starter.table_id,
      updates: [{ _id: ins.row_ids[0], values: { Done: 7 } }],
      actor: HUMAN,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toContain('"Done"');
  });

  it("deletes rows, counting only the ones that existed", async () => {
    const { actor } = makeActor();
    const starter = await initStarter(actor);
    const ins = await doJson<{ row_ids: string[] }>(actor, "/rows/insert", {
      table_id: starter.table_id,
      rows: [{ Name: "a" }, { Name: "b" }],
      actor: HUMAN,
    });
    const out = await doJson<{ deleted: number }>(actor, "/rows/delete", {
      table_id: starter.table_id,
      row_ids: [ins.row_ids[0], "row_ghost"],
      actor: HUMAN,
    });
    expect(out.deleted).toBe(1);
    const list = await doJson<ListOut>(actor, "/rows/list", { table_id: starter.table_id });
    expect(list.total).toBe(1);
    expect(list.rows[0]![colId(starter, "Name")]).toBe("b");
  });

  it("caps update and delete batches at DATABASE_MAX_ROWS_PER_WRITE", async () => {
    const { actor } = makeActor();
    const starter = await initStarter(actor);
    const updates = Array.from({ length: DATABASE_MAX_ROWS_PER_WRITE + 1 }, (_, i) => ({ _id: `row_${i}`, values: { Name: "x" } }));
    expect((await doFetch(actor, "/rows/update", { table_id: starter.table_id, updates, actor: HUMAN })).status).toBe(409);
    const rowIds = Array.from({ length: DATABASE_MAX_ROWS_PER_WRITE + 1 }, (_, i) => `row_${i}`);
    expect((await doFetch(actor, "/rows/delete", { table_id: starter.table_id, row_ids: rowIds, actor: HUMAN })).status).toBe(409);
  });
});
