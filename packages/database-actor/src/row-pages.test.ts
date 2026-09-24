import { describe, expect, it } from "vitest";
import type { DatabaseRunSummary } from "@stuga/protocol/databases/types";
import { AGENT, HUMAN, doFetch, doJson, initStarter, makeActor, proposeBody } from "../test/harness.js";

type Row = Record<string, unknown> & { _id: string; _doc_id?: string | null };
type ListOut = { rows: Row[]; total: number };
type Links = Array<{ doc_id: string; row_id: string; table_id: string }>;
type TakeOut = { trash: Links; restore: Links };
type OpsOut = { ops: Array<{ op_id: string; kind: string; summary: string; revertible: boolean; reverted_by: string | null; is_agent: boolean }> };

async function seeded() {
  const { actor } = makeActor();
  const starter = await initStarter(actor);
  const ins = await doJson<{ row_ids: string[] }>(actor, "/rows/insert", {
    table_id: starter.table_id,
    rows: [{ Name: "alpha" }, { Name: "beta" }, { Name: "gamma" }],
    actor: HUMAN,
  });
  const [a, b, c] = ins.row_ids as [string, string, string];
  return { actor, starter, a, b, c };
}

const list = (actor: ReturnType<typeof makeActor>["actor"], body: Record<string, unknown>) => doJson<ListOut>(actor, "/rows/list", body);
const take = (actor: ReturnType<typeof makeActor>["actor"], body: Record<string, unknown> = {}) => doJson<TakeOut>(actor, "/doc-links/take", body);
const link = (actor: ReturnType<typeof makeActor>["actor"], body: Record<string, unknown>) =>
  doJson<{ linked: boolean; doc_id: string; replaced: string | null }>(actor, "/rows/link-doc", { actor: HUMAN, ...body });

describe("linking a row to its page", () => {
  it("shows up as _doc_id on every listing, filters, and is idempotent for the same page", async () => {
    const { actor, starter, a } = await seeded();
    const before = await list(actor, { table_id: starter.table_id });
    expect(before.rows.map((r) => r._doc_id)).toEqual([null, null, null]);

    expect(await link(actor, { table_id: starter.table_id, row_id: a, doc_id: "doc_A" })).toEqual({ linked: true, doc_id: "doc_A", replaced: null });
    expect(await link(actor, { table_id: starter.table_id, row_id: a, doc_id: "doc_A" })).toEqual({ linked: false, doc_id: "doc_A", replaced: null });

    const after = await list(actor, { table_id: starter.table_id });
    expect(after.rows.find((r) => r._id === a)!._doc_id).toBe("doc_A");
    expect(after.rows.filter((r) => r._id !== a).every((r) => r._doc_id === null)).toBe(true);

    const withPage = await list(actor, { table_id: starter.table_id, filter: { column_id: "_doc_id", op: "not_empty" } });
    expect(withPage.rows.map((r) => r._id)).toEqual([a]);
    expect(withPage.total).toBe(1);
    const byId = await list(actor, { table_id: starter.table_id, filter: { column_id: "_doc_id", op: "eq", value: "doc_A" } });
    expect(byId.rows.map((r) => r[starter.columns[0]!.column_id])).toEqual(["alpha"]);
    const sorted = await list(actor, { table_id: starter.table_id, sort: [{ column_id: "_doc_id", dir: "desc" }] });
    expect(sorted.rows[0]!._id).toBe(a);
    // The idempotent repeat records nothing.
    const links = (await doJson<OpsOut>(actor, "/ops", undefined)).ops.filter((o) => o.kind === "rows.link_page");
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ is_agent: false, summary: 'Linked a page to a row of "Table 1"', revertible: true });
  });

  it("refuses a second page for a row, a second row for a page, and an unknown row", async () => {
    const { actor, starter, a, b } = await seeded();
    await link(actor, { table_id: starter.table_id, row_id: a, doc_id: "doc_A" });
    const again = await doFetch(actor, "/rows/link-doc", { table_id: starter.table_id, row_id: a, doc_id: "doc_B", actor: HUMAN });
    expect(again.status).toBe(409);
    expect((await again.json()) as Record<string, unknown>).toMatchObject({ error: "already_linked", doc_id: "doc_A" });
    const claimed = await doFetch(actor, "/rows/link-doc", { table_id: starter.table_id, row_id: b, doc_id: "doc_A", actor: HUMAN });
    expect(claimed.status).toBe(409);
    expect(((await claimed.json()) as { error: string }).error).toBe("doc_linked");
    expect((await doFetch(actor, "/rows/link-doc", { table_id: starter.table_id, row_id: "row_nope", doc_id: "doc_X", actor: HUMAN })).status).toBe(404);
    expect((await doFetch(actor, "/rows/link-doc", { table_id: starter.table_id, row_id: a, actor: HUMAN })).status).toBe(400);
    expect((await list(actor, { table_id: starter.table_id })).rows.find((r) => r._id === a)!._doc_id).toBe("doc_A");
  });

  it("replaces a link only when the caller names the page it replaces", async () => {
    const { actor, starter, a } = await seeded();
    await link(actor, { table_id: starter.table_id, row_id: a, doc_id: "doc_A" });
    const wrong = await doFetch(actor, "/rows/link-doc", { table_id: starter.table_id, row_id: a, doc_id: "doc_B", replaces: "doc_Z", actor: HUMAN });
    expect(wrong.status).toBe(409);
    expect(await link(actor, { table_id: starter.table_id, row_id: a, doc_id: "doc_B", replaces: "doc_A" })).toEqual({ linked: true, doc_id: "doc_B", replaced: "doc_A" });
    expect((await list(actor, { table_id: starter.table_id })).rows.find((r) => r._id === a)!._doc_id).toBe("doc_B");
    // The caller established the replaced page was gone, so nothing is queued for it.
    expect(await take(actor)).toEqual({ trash: [], restore: [] });
  });
});

describe("what a deleted row, table or revert leaves for the node", () => {
  it("deleting rows drops their links and queues the pages for the trash, once", async () => {
    const { actor, starter, a, b } = await seeded();
    await link(actor, { table_id: starter.table_id, row_id: a, doc_id: "doc_A" });
    await link(actor, { table_id: starter.table_id, row_id: b, doc_id: "doc_B" });
    const out = await doJson<{ deleted: number }>(actor, "/rows/delete", {
      table_id: starter.table_id,
      row_ids: [a, b, "row_missing"],
      actor: HUMAN,
    });
    expect(out).toEqual({ deleted: 2 });
    const taken = await take(actor);
    expect(taken.trash.map((l) => [l.doc_id, l.row_id, l.table_id]).sort()).toEqual([
      ["doc_A", a, starter.table_id],
      ["doc_B", b, starter.table_id],
    ]);
    expect(taken.restore).toEqual([]);
    expect(await take(actor)).toEqual({ trash: [], restore: [] });
    const fresh = await doJson<{ row_ids: string[] }>(actor, "/rows/insert", { table_id: starter.table_id, rows: [{ Name: "delta" }], actor: HUMAN });
    expect(await link(actor, { table_id: starter.table_id, row_id: fresh.row_ids[0]!, doc_id: "doc_A" })).toMatchObject({ linked: true });
  });

  it("reverting an agent's delete brings the row back with its page, and asks the node to restore it", async () => {
    const { actor, starter, a, b } = await seeded();
    await link(actor, { table_id: starter.table_id, row_id: a, doc_id: "doc_A" });
    await doJson(actor, "/rows/delete", { table_id: starter.table_id, row_ids: [a, b], actor: AGENT });
    expect((await take(actor)).trash.map((l) => l.doc_id)).toEqual(["doc_A"]);
    expect((await list(actor, { table_id: starter.table_id })).total).toBe(1);

    const ops = (await doJson<OpsOut>(actor, "/ops", undefined)).ops;
    expect(ops[0]).toMatchObject({ kind: "rows.delete", is_agent: true });
    const reverted = await doJson<{ restored: number; missing: number }>(actor, "/ops/revert", { op_id: ops[0]!.op_id, actor: HUMAN });
    expect(reverted).toMatchObject({ restored: 2, missing: 0 });
    const rows = await list(actor, { table_id: starter.table_id });
    expect(rows.rows.find((r) => r._id === a)!._doc_id).toBe("doc_A");
    expect(rows.rows.find((r) => r._id === b)!._doc_id).toBeNull();
    const taken = await take(actor);
    expect(taken.trash).toEqual([]);
    expect(taken.restore).toEqual([{ doc_id: "doc_A", row_id: a, table_id: starter.table_id }]);
  });

  it("a delete and its revert before the node looks collapse to one `restore`", async () => {
    const { actor, starter, a } = await seeded();
    await link(actor, { table_id: starter.table_id, row_id: a, doc_id: "doc_A" });
    await doJson(actor, "/rows/delete", { table_id: starter.table_id, row_ids: [a], actor: AGENT });
    const op = (await doJson<OpsOut>(actor, "/ops", undefined)).ops[0]!;
    await doJson(actor, "/ops/revert", { op_id: op.op_id, actor: HUMAN });
    const taken = await take(actor);
    expect(taken.trash).toEqual([]);
    expect(taken.restore.map((l) => l.doc_id)).toEqual(["doc_A"]);
  });

  it("an accepted proposal to delete rows behaves the same, and a run revert restores the page", async () => {
    const { actor, starter, a } = await seeded();
    await link(actor, { table_id: starter.table_id, row_id: a, doc_id: "doc_A" });
    const proposed = await doJson<{ mode: string; run: DatabaseRunSummary }>(
      actor,
      "/runs/propose",
      proposeBody({ kind: "rows.delete", table: starter.table_id, row_ids: [a] }),
    );
    expect(proposed.mode).toBe("proposed");
    expect(await take(actor)).toEqual({ trash: [], restore: [] });
    const decided = await doJson<{ applied: number }>(actor, "/runs/decide", {
      actor: HUMAN,
      run_id: proposed.run.id,
      decision: "accept",
      decided_by: HUMAN.alias,
    });
    expect(decided.applied).toBe(1);
    expect((await take(actor)).trash.map((l) => l.doc_id)).toEqual(["doc_A"]);

    const reverted = await doJson<{ reverted: number; restored: number }>(actor, "/runs/revert", {
      actor: HUMAN,
      run_id: proposed.run.id,
      requested_by: HUMAN.alias,
    });
    expect(reverted).toMatchObject({ reverted: 1, restored: 1 });
    expect((await take(actor)).restore.map((l) => l.doc_id)).toEqual(["doc_A"]);
    expect((await list(actor, { table_id: starter.table_id })).rows.find((r) => r._id === a)!._doc_id).toBe("doc_A");
  });

  it("dropping a table queues every page it had for the trash", async () => {
    const { actor, starter, a, b } = await seeded();
    const other = await doJson<{ table: { table_id: string } }>(actor, "/tables/create", { display: "Other", actor: HUMAN });
    const ins = await doJson<{ row_ids: string[] }>(actor, "/rows/insert", { table_id: other.table.table_id, rows: [{}], actor: HUMAN });
    await link(actor, { table_id: starter.table_id, row_id: a, doc_id: "doc_A" });
    await link(actor, { table_id: starter.table_id, row_id: b, doc_id: "doc_B" });
    await link(actor, { table_id: other.table.table_id, row_id: ins.row_ids[0]!, doc_id: "doc_O" });
    expect(await doJson(actor, "/tables/delete", { table_id: starter.table_id, actor: HUMAN })).toEqual({ deleted: true });
    expect((await take(actor)).trash.map((l) => l.doc_id).sort()).toEqual(["doc_A", "doc_B"]);
    expect((await list(actor, { table_id: other.table.table_id })).rows[0]!._doc_id).toBe("doc_O");
  });
});

describe("the ledger half", () => {
  it("an agent's link is a revertible rows.link_page op; the revert unlinks and leaves the page alone", async () => {
    const { actor, starter, a } = await seeded();
    const out = await doJson<{ linked: boolean }>(actor, "/rows/link-doc", { table_id: starter.table_id, row_id: a, doc_id: "doc_A", actor: AGENT });
    expect(out.linked).toBe(true);
    const ops = (await doJson<OpsOut>(actor, "/ops", undefined)).ops.filter((o) => o.is_agent);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ kind: "rows.link_page", summary: 'Linked a page to a row of "Table 1"', revertible: true });

    const reverted = await doJson<{ restored: number; missing: number }>(actor, "/ops/revert", { op_id: ops[0]!.op_id, actor: HUMAN });
    expect(reverted).toMatchObject({ restored: 1, missing: 0 });
    expect((await list(actor, { table_id: starter.table_id })).rows.find((r) => r._id === a)!._doc_id).toBeNull();
    expect(await take(actor)).toEqual({ trash: [], restore: [] });
    expect((await doFetch(actor, "/ops/revert", { op_id: ops[0]!.op_id, actor: HUMAN })).status).toBe(409);
  });

  it("reverting a replacing link points the row back at the page it had", async () => {
    const { actor, starter, a } = await seeded();
    await link(actor, { table_id: starter.table_id, row_id: a, doc_id: "doc_A" });
    await doJson(actor, "/rows/link-doc", { table_id: starter.table_id, row_id: a, doc_id: "doc_B", replaces: "doc_A", actor: AGENT });
    expect((await list(actor, { table_id: starter.table_id })).rows.find((r) => r._id === a)!._doc_id).toBe("doc_B");
    const op = (await doJson<OpsOut>(actor, "/ops", undefined)).ops[0]!;
    await doJson(actor, "/ops/revert", { op_id: op.op_id, actor: HUMAN });
    expect((await list(actor, { table_id: starter.table_id })).rows.find((r) => r._id === a)!._doc_id).toBe("doc_A");
  });

  it("a link revert is tolerant: a row re-linked elsewhere since keeps its newer page", async () => {
    const { actor, starter, a } = await seeded();
    await doJson(actor, "/rows/link-doc", { table_id: starter.table_id, row_id: a, doc_id: "doc_A", actor: AGENT });
    await link(actor, { table_id: starter.table_id, row_id: a, doc_id: "doc_B", replaces: "doc_A" });
    const op = (await doJson<OpsOut>(actor, "/ops", undefined)).ops.find((o) => o.is_agent)!;
    const reverted = await doJson<{ restored: number; missing: number }>(actor, "/ops/revert", { op_id: op.op_id, actor: HUMAN });
    expect(reverted).toMatchObject({ restored: 0, missing: 1 });
    expect((await list(actor, { table_id: starter.table_id })).rows.find((r) => r._id === a)!._doc_id).toBe("doc_B");
  });
});
