import { describe, expect, it } from "vitest";
import { AGENT, HUMAN, blobKeys, colId, doFetch, doJson, initStarter, makeActor, makeState, proposeBody } from "../test/harness.js";
import type { DatabaseActor } from "./database-actor.js";
import type { DatabaseRunSummary } from "@stuga/protocol/databases/types";

interface ProposeOut {
  mode: "proposed" | "applied";
  run: DatabaseRunSummary;
  pending?: number;
  minted?: { table_id?: string; column_id?: string; row_ids?: string[] };
  result?: Record<string, unknown> | null;
}

function propose(actor: DatabaseActor, op: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return doJson<ProposeOut>(actor, "/runs/propose", proposeBody(op, extra));
}

function proposeAuto(actor: DatabaseActor, op: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return propose(actor, op, { review: "auto", ...extra });
}

function decide(actor: DatabaseActor, runId: string, decision: "accept" | "reject", opIds?: string[]) {
  return doJson<{ run: DatabaseRunSummary; applied: number; rejected: number; conflicts: number; blocked: number }>(
    actor,
    "/runs/decide",
    { actor: HUMAN, run_id: runId, decision, op_ids: opIds, decided_by: HUMAN.alias },
  );
}

async function listRows(actor: DatabaseActor, tableId: string, agentAlias?: string) {
  return doJson<{ rows: Array<Record<string, unknown>>; total: number; pending_ops?: number }>(actor, "/rows/list", {
    table_id: tableId,
    ...(agentAlias ? { agent_alias: agentAlias } : {}),
  });
}

describe("propose: park or apply", () => {
  it("`review` → parked, nothing written, decide-accept lands it", async () => {
    const h = makeState();
    const { actor } = makeActor(h);
    const starter = await initStarter(actor);

    const out = await propose(actor, { kind: "rows.insert", table: starter.table_id, rows: [{ Name: "Alpha" }, { Name: "Beta" }] });
    expect(out.mode).toBe("proposed");
    expect(out.pending).toBe(1);
    expect(out.minted?.row_ids).toHaveLength(2);
    expect(out.run.status).toBe("open");
    expect(out.run.ops[0]!.status).toBe("pending");
    expect(out.run.ops[0]!.summary).toContain("Insert 2 rows");

    expect((await listRows(actor, starter.table_id)).total).toBe(0);
    const ops = await doJson<{ ops: Array<{ is_agent: boolean }> }>(actor, "/ops?limit=50", undefined);
    expect(ops.ops.filter((o) => o.is_agent)).toHaveLength(0);

    const decided = await decide(actor, out.run.id, "accept");
    expect(decided.applied).toBe(1);
    expect(decided.run.status).toBe("applied");
    expect(decided.run.ops[0]!.status).toBe("accepted");
    expect(decided.run.ops[0]!.ledger_op_id).toBeTruthy();

    const rows = await listRows(actor, starter.table_id);
    expect(rows.total).toBe(2);
    expect(rows.rows.map((r) => r._id).sort()).toEqual([...out.minted!.row_ids!].sort());

    const after = await doJson<{ ops: Array<{ op_id: string; revertible: boolean; is_agent: boolean }> }>(actor, "/ops?limit=50", undefined);
    const agentOps = after.ops.filter((o) => o.is_agent);
    expect(agentOps).toHaveLength(1);
    expect(agentOps[0]!.op_id).toBe(decided.run.ops[0]!.ledger_op_id);
    expect(agentOps[0]!.revertible).toBe(true);
  });

  it("`auto` → applies immediately, run open + auto_applied as the receipt", async () => {
    const h = makeState();
    const { actor } = makeActor(h);
    const starter = await initStarter(actor);

    const out = await proposeAuto(actor, { kind: "rows.insert", table: starter.table_id, rows: [{ Name: "landed" }] });
    expect(out.mode).toBe("applied");
    expect(out.run.auto_applied).toBe(true);
    expect(out.run.status).toBe("open");
    expect(out.run.ops[0]!.status).toBe("auto_applied");
    expect(out.result).toMatchObject({ inserted: 1 });
    expect((await listRows(actor, starter.table_id)).total).toBe(1);
  });

  it("source panel parks even when the resolved policy says `auto`", async () => {
    const h = makeState();
    const { actor } = makeActor(h);
    const starter = await initStarter(actor);
    const out = await propose(
      actor,
      { kind: "rows.insert", table: starter.table_id, rows: [{ Name: "panel" }] },
      { source: "panel", agent: "AI co-author", review: "auto" },
    );
    expect(out.mode).toBe("proposed");
    expect((await listRows(actor, starter.table_id)).total).toBe(0);
  });

  it("reject applies nothing and closes the run rejected", async () => {
    const h = makeState();
    const { actor } = makeActor(h);
    const starter = await initStarter(actor);
    const out = await propose(actor, { kind: "rows.delete", table: starter.table_id, row_ids: ["nope"] }).catch(() => null);
    expect(out).toBeNull();

    const ins = await doJson<{ row_ids: string[] }>(actor, "/rows/insert", { actor: HUMAN, table_id: starter.table_id, rows: [{ Name: "keep" }] });
    const del = await propose(actor, { kind: "rows.delete", table: starter.table_id, row_ids: ins.row_ids });
    const decided = await decide(actor, del.run.id, "reject");
    expect(decided.rejected).toBe(1);
    expect(decided.run.status).toBe("rejected");
    expect((await listRows(actor, starter.table_id)).total).toBe(1);
  });
});

describe("pre-minted ids and dependencies", () => {
  it("create table → add column → insert rows, accepted in order", async () => {
    const h = makeState();
    const { actor } = makeActor(h);
    await initStarter(actor);

    const t = await propose(actor, { kind: "tables.create", display: "Projects" });
    const tableId = t.minted!.table_id!;
    const c = await propose(actor, { kind: "columns.add", table: tableId, display: "Title", type: "text" });
    const r = await propose(actor, {
      kind: "rows.insert",
      table: tableId,
      rows: [{ [c.minted!.column_id!]: "hello" }],
    });
    expect(r.mode).toBe("proposed");
    expect(r.run.ops).toHaveLength(3);

    const decided = await decide(actor, r.run.id, "accept");
    expect(decided.applied).toBe(3);
    expect(decided.conflicts).toBe(0);
    const schema = await doJson<{ tables: Array<{ table_id: string; row_count: number; columns: unknown[] }> }>(actor, "/schema", undefined);
    const created = schema.tables.find((x) => x.table_id === tableId)!;
    expect(created.row_count).toBe(1);
    expect(created.columns).toHaveLength(1);
  });

  it("accepting only a dependent op leaves it blocked; rejecting its parent conflicts it", async () => {
    const h = makeState();
    const { actor } = makeActor(h);
    const starter = await initStarter(actor);

    const ins = await propose(actor, { kind: "rows.insert", table: starter.table_id, rows: [{ Name: "draft" }] });
    const rowId = ins.minted!.row_ids![0]!;
    const upd = await propose(actor, {
      kind: "rows.update",
      table: starter.table_id,
      updates: [{ _id: rowId, values: { Notes: "annotated" } }],
    });
    const updOpId = upd.run.ops[1]!.id;

    const blocked = await decide(actor, upd.run.id, "accept", [updOpId]);
    expect(blocked.blocked).toBe(1);
    expect(blocked.run.ops[1]!.status).toBe("pending");

    const insOpId = upd.run.ops[0]!.id;
    await decide(actor, upd.run.id, "reject", [insOpId]);
    const after = await decide(actor, upd.run.id, "accept", [updOpId]);
    expect(after.conflicts).toBe(1);
    expect(after.run.status).toBe("rejected");
    expect((await listRows(actor, starter.table_id)).total).toBe(0);
  });

  it("update of a pending row applies once the whole run is accepted", async () => {
    const h = makeState();
    const { actor } = makeActor(h);
    const starter = await initStarter(actor);
    const ins = await propose(actor, { kind: "rows.insert", table: starter.table_id, rows: [{ Name: "draft" }] });
    const rowId = ins.minted!.row_ids![0]!;
    const upd = await propose(actor, {
      kind: "rows.update",
      table: starter.table_id,
      updates: [{ _id: rowId, values: { Notes: "annotated" } }],
    });
    const decided = await decide(actor, upd.run.id, "accept");
    expect(decided.applied).toBe(2);
    const rows = await listRows(actor, starter.table_id);
    expect(rows.rows[0]).toMatchObject({ [colId(starter, "Name")]: "draft", [colId(starter, "Notes")]: "annotated" });
  });
});

describe("agent read-back projection", () => {
  it("rows/list overlays pending inserts/updates/deletes for the proposing agent only", async () => {
    const h = makeState();
    const { actor } = makeActor(h);
    const starter = await initStarter(actor);
    const seeded = await doJson<{ row_ids: string[] }>(actor, "/rows/insert", {
      actor: HUMAN,
      table_id: starter.table_id,
      rows: [{ Name: "live-1" }, { Name: "live-2" }],
    });

    await propose(actor, { kind: "rows.insert", table: starter.table_id, rows: [{ Name: "ghost" }] });
    await propose(actor, {
      kind: "rows.update",
      table: starter.table_id,
      updates: [{ _id: seeded.row_ids[0]!, values: { Notes: "touched" } }],
    });
    await propose(actor, { kind: "rows.delete", table: starter.table_id, row_ids: [seeded.row_ids[1]!] });

    const name = colId(starter, "Name");
    const notes = colId(starter, "Notes");
    const human = await listRows(actor, starter.table_id);
    expect(human.total).toBe(2);
    expect(human.rows.every((r) => r[notes] === null)).toBe(true);

    const agent = await listRows(actor, starter.table_id, AGENT.alias);
    expect(agent.pending_ops).toBe(3);
    expect(agent.total).toBe(2);
    const names = agent.rows.map((r) => r[name]);
    expect(names).toContain("live-1");
    expect(names).toContain("ghost");
    expect(names).not.toContain("live-2");
    expect(agent.rows.find((r) => r[name] === "live-1")![notes]).toBe("touched");
    expect(agent.rows.find((r) => r[name] === "ghost")).toMatchObject({ [notes]: null, _doc_id: null });
  });

  it("schema projection shows pending tables/columns flagged pending", async () => {
    const h = makeState();
    const { actor } = makeActor(h);
    const starter = await initStarter(actor);
    await propose(actor, { kind: "tables.create", display: "Ideas" });
    await propose(actor, {
      kind: "columns.add",
      table: starter.table_id,
      display: "Owner",
      type: "text",
      description: "Who is on the hook, by alias",
    });

    const human = await doJson<{ tables: Array<{ display: string; pending?: boolean; columns: Array<{ pending?: boolean }> }> }>(
      actor,
      "/schema",
      undefined,
    );
    expect(human.tables.map((t) => t.display)).not.toContain("Ideas");

    const res = await doFetch(actor, `/schema?agent=${encodeURIComponent(AGENT.alias)}`, undefined);
    const agent = (await res.json()) as {
      tables: Array<{ display: string; pending?: boolean; columns: Array<{ display: string; pending?: boolean; description?: string }> }>;
    };
    const ideas = agent.tables.find((t) => t.display === "Ideas");
    expect(ideas?.pending).toBe(true);
    const ownerCol = agent.tables.find((t) => t.display === starter.display)!.columns.find((c) => c.display === "Owner");
    expect(ownerCol?.pending).toBe(true);
    // The projection rebuilds the spec by hand: the description an agent proposed must survive that.
    expect(ownerCol?.description).toBe("Who is on the hook, by alias");

    // Accepting the proposal lands the same description on the live column.
    const run = (await doJson<{ runs: DatabaseRunSummary[] }>(actor, "/runs")).runs[0]!;
    await decide(actor, run.id, "accept");
    const live = await doJson<{ tables: Array<{ display: string; columns: Array<{ display: string; description?: string }> }> }>(actor, "/schema");
    expect(live.tables.find((t) => t.display === starter.display)!.columns.find((c) => c.display === "Owner")?.description).toBe(
      "Who is on the hook, by alias",
    );
  });

  it("query results carry a pending note while proposals await review", async () => {
    const h = makeState();
    const { actor } = makeActor(h);
    const starter = await initStarter(actor);
    await propose(actor, { kind: "rows.insert", table: starter.table_id, rows: [{ Name: "ghost" }] });
    const out = await doJson<{ rows: unknown[]; pending_note?: string }>(actor, "/query", {
      actor: AGENT,
      sql: `SELECT * FROM ${starter.name}`,
    });
    expect(out.rows).toHaveLength(0);
    expect(out.pending_note).toContain("awaiting the user's review");
  });
});

describe("nothing lands a parked op but a person", () => {
  it("a parked op stays parked across a cold restart, and the reviewer is told once", async () => {
    const h = makeState();
    const notifications = h.jobs.sent;
    const { actor } = makeActor(h);
    const starter = await initStarter(actor);
    const out = await propose(actor, { kind: "rows.insert", table: starter.table_id, rows: [{ Name: "waiting" }] });
    expect(out.mode).toBe("proposed");

    expect((actor as { alarm?: unknown }).alarm).toBeUndefined();
    expect(await h.state.storage.getAlarm()).toBeNull();

    const cold = makeActor(h).actor;
    expect((await listRows(cold, starter.table_id)).total).toBe(0);
    const run = (await doJson<{ run: DatabaseRunSummary }>(cold, `/runs/detail?runId=${out.run.id}`, undefined)).run;
    expect(run.status).toBe("open");
    expect(run.auto_applied).toBe(false);
    expect(run.ops[0]!.status).toBe("pending");

    const notifies = notifications.filter((m) => (m as { kind?: string }).kind === "notify");
    expect(notifies).toHaveLength(1);
    expect(notifies[0]).toMatchObject({ kind: "notify", eventType: "DATABASE_AGENT_PROPOSED", recipient: HUMAN.alias });
  });

  it("a locked database refuses proposals and keeps the parked ones decidable", async () => {
    const h = makeState();
    const { actor } = makeActor(h);
    const starter = await initStarter(actor);
    const out = await propose(actor, { kind: "rows.insert", table: starter.table_id, rows: [{ Name: "waiting" }] });
    await doFetch(actor, "/set-locked?locked=1", {});
    const blocked = proposeBody({ kind: "rows.insert", table: starter.table_id, rows: [{ Name: "blocked" }] }, { review: "auto" });
    expect((await doFetch(actor, "/runs/propose", blocked)).status).toBe(423);
    expect((await listRows(actor, starter.table_id)).total).toBe(0);

    await doFetch(actor, "/set-locked?locked=0", {});
    expect((await decide(actor, out.run.id, "accept")).applied).toBe(1);
    expect((await listRows(actor, starter.table_id)).total).toBe(1);
  });
});

describe("run revert and ack", () => {
  it("revert undoes a run's applied ops newest-first and rejects the rest", async () => {
    const h = makeState();
    const { actor } = makeActor(h);
    const starter = await initStarter(actor);
    const a = await proposeAuto(actor, { kind: "rows.insert", table: starter.table_id, rows: [{ Name: "one" }, { Name: "two" }] });
    await proposeAuto(actor, {
      kind: "rows.update",
      table: starter.table_id,
      updates: [{ _id: a.minted!.row_ids![0]!, values: { Notes: "edited" } }],
    });
    expect((await listRows(actor, starter.table_id)).total).toBe(2);

    const out = await doJson<{ run: DatabaseRunSummary; reverted: number; restored: number }>(actor, "/runs/revert", {
      actor: HUMAN,
      run_id: a.run.id,
      requested_by: HUMAN.alias,
    });
    expect(out.reverted).toBe(2);
    expect(out.run.status).toBe("expired");
    expect(out.run.reverted).toBe(true);
    expect(out.run.acknowledged).toBe(true);
    expect((await listRows(actor, starter.table_id)).total).toBe(0);

    const again = await doFetch(actor, "/runs/revert", { actor: HUMAN, run_id: a.run.id, requested_by: HUMAN.alias });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: "already_reverted" });
  });

  it("refuses to revert a run with nothing applied, and leaves its pending ops decidable", async () => {
    const h = makeState();
    const { actor } = makeActor(h);
    const starter = await initStarter(actor);
    const out = await propose(actor, { kind: "rows.insert", table: starter.table_id, rows: [{ Name: "parked" }] });

    const res = await doFetch(actor, "/runs/revert", { actor: HUMAN, run_id: out.run.id, requested_by: HUMAN.alias });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "nothing_to_revert" });
    const run = (await doJson<{ run: DatabaseRunSummary }>(actor, `/runs/detail?runId=${out.run.id}`, undefined)).run;
    expect(run.status).toBe("open");
    expect(run.reverted).toBeFalsy();
    expect(run.ops[0]!.status).toBe("pending");
    expect((await decide(actor, out.run.id, "accept")).applied).toBe(1);
  });

  it("only the reviewer (or a manager override) may decide, ack, or revert", async () => {
    const h = makeState();
    const { actor } = makeActor(h);
    const starter = await initStarter(actor);
    const out = await propose(actor, { kind: "rows.insert", table: starter.table_id, rows: [{ Name: "x" }] });

    const stranger = await doFetch(actor, "/runs/decide", {
      actor: { alias: "user:mallory", is_agent: false },
      run_id: out.run.id,
      decision: "accept",
      decided_by: "user:mallory",
    });
    expect(stranger.status).toBe(403);

    const manager = await doFetch(actor, "/runs/decide", {
      actor: { alias: "user:mallory", is_agent: false },
      run_id: out.run.id,
      decision: "accept",
      decided_by: "user:mallory",
      manager_override: true,
    });
    expect(manager.status).toBe(200);

    const ack = await doJson<{ run: DatabaseRunSummary }>(actor, "/runs/ack", {
      actor: HUMAN,
      run_id: out.run.id,
      acked_by: HUMAN.alias,
    });
    expect(ack.run.acknowledged).toBe(true);
  });
});

describe("run bounds and ordering", () => {
  it("panel proposals never self-apply, even carrying an `auto` verdict", async () => {
    const h = makeState();
    const { actor } = makeActor(h);
    const starter = await initStarter(actor);
    const landed = await proposeAuto(actor, { kind: "rows.insert", table: starter.table_id, rows: [{ Name: "connector" }] });
    expect(landed.mode).toBe("applied");

    const out = await propose(
      actor,
      { kind: "rows.insert", table: starter.table_id, rows: [{ Name: "panel-parked" }] },
      { source: "panel", agent: "AI co-author", review: "auto", actor: { alias: `panel:${HUMAN.alias}`, is_agent: true, on_behalf_of: HUMAN.alias } },
    );
    expect(out.mode).toBe("proposed");
    expect((await listRows(actor, starter.table_id)).total).toBe(1);
    const run = (await doJson<{ run: DatabaseRunSummary }>(actor, `/runs/detail?runId=${out.run.id}`, undefined)).run;
    expect(run.status).toBe("open");
    expect(run.ops[0]!.status).toBe("pending");
  });

  it("an `auto` run at the total-op cap rolls over instead of growing forever", async () => {
    const h = makeState();
    const { actor } = makeActor(h);
    const starter = await initStarter(actor);
    const first = await proposeAuto(actor, { kind: "rows.insert", table: starter.table_id, rows: [{ Name: "r0" }] });
    expect(first.mode).toBe("applied");
    // A long `auto` session, padded to the cap behind the actor's back.
    const pad = (runId: string, opId: string, position: number, tableId: string) =>
      h.state.storage.sql.exec(
        `INSERT INTO _run_ops (run_id, op_id, position, kind, table_id, summary, status, payload, blob_key, bytes, decided_by, ledger_op_id, error, review)
         VALUES (?, ?, ?, 'rows.insert', ?, 'padding', 'auto_applied', '{}', NULL, 2, 'policy:auto', NULL, NULL, 'auto')`,
        runId,
        opId,
        position,
        tableId,
      );
    for (let i = 2; i <= 200; i++) pad(first.run.id, `o${i}`, i, starter.table_id);

    const next = await proposeAuto(actor, { kind: "rows.insert", table: starter.table_id, rows: [{ Name: "r-next" }] });
    expect(next.mode).toBe("applied");
    expect(next.run.id).not.toBe(first.run.id);
    const old = (await doJson<{ run: DatabaseRunSummary }>(actor, `/runs/detail?runId=${first.run.id}`, undefined)).run;
    expect(old.status).toBe("applied");

    // A run still holding pending ops refuses at the cap instead.
    const parked = await propose(actor, { kind: "rows.insert", table: starter.table_id, rows: [{ Name: "p1" }] });
    expect(parked.mode).toBe("proposed");
    const start =
      Number(
        (h.state.storage.sql.exec(`SELECT COALESCE(MAX(position), 0) AS p FROM _run_ops WHERE run_id = ?`, parked.run.id).one() as { p: number }).p,
      ) + 1;
    for (let i = start; i < start + 200; i++) pad(parked.run.id, `o${i}`, i, starter.table_id);
    h.state.storage.sql.exec(`UPDATE _run_ops SET status = 'pending' WHERE run_id = ?`, parked.run.id);
    const refused = await doFetch(actor, "/runs/propose", proposeBody({ kind: "rows.insert", table: starter.table_id, rows: [{ Name: "overflow" }] }));
    expect(refused.status).toBe(409);
  });

  it("pruning never discards an open run's pending proposals", async () => {
    const h = makeState();
    const { actor } = makeActor(h);
    const starter = await initStarter(actor);
    const parked = await propose(actor, { kind: "rows.insert", table: starter.table_id, rows: [{ Name: "keep me" }] });
    expect(parked.mode).toBe("proposed");
    // Older than 55 closed runs; a fresh run from another agent triggers the prune.
    h.state.storage.sql.exec(`UPDATE _runs SET created_at = created_at - 1000000 WHERE run_id = ?`, parked.run.id);
    const seed = (runId: string, reviewer: string, createdAt: number, updatedAt: number) =>
      h.state.storage.sql.exec(
        `INSERT INTO _runs (run_id, source, agent, agent_alias, reviewer, status, acknowledged, auto_applied, reverted, workspace_id, doc_title, review_mode, created_at, updated_at)
         VALUES (?, 'connector', 'Other', 'agent:other', ?, 'applied', 1, 0, 0, 'ws_test', 'Test DB', 'review', ?, ?)`,
        runId,
        reviewer,
        createdAt,
        updatedAt,
      );
    const base = Date.now();
    for (let i = 0; i < 55; i++) seed(`run_seed${String(i).padStart(8, "0")}`, HUMAN.alias, base + i, base + i);
    await propose(actor, { kind: "rows.insert", table: starter.table_id, rows: [{ Name: "trigger prune" }] }, {
      actor: { alias: "agent:third", is_agent: true, on_behalf_of: HUMAN.alias },
    });

    const kept = (await doJson<{ run: DatabaseRunSummary }>(actor, `/runs/detail?runId=${parked.run.id}`, undefined)).run;
    expect(kept.status).toBe("open");
    expect(kept.ops[0]!.status).toBe("pending");
  });

  it("run revert unwinds in reverse APPLY order, not position order", async () => {
    const h = makeState();
    const { actor } = makeActor(h);
    const starter = await initStarter(actor);
    const seeded = await doJson<{ row_ids: string[] }>(actor, "/rows/insert", {
      actor: HUMAN,
      table_id: starter.table_id,
      rows: [{ Name: "original" }],
    });
    const rowId = seeded.row_ids[0]!;
    // Two updates to one cell, accepted second-first.
    const a = await propose(actor, { kind: "rows.update", table: starter.table_id, updates: [{ _id: rowId, values: { Name: "v1" } }] });
    const b = await propose(actor, { kind: "rows.update", table: starter.table_id, updates: [{ _id: rowId, values: { Name: "v2" } }] });
    const o1 = b.run.ops[0]!.id;
    const o2 = b.run.ops[1]!.id;
    await decide(actor, b.run.id, "accept", [o2]);
    await decide(actor, b.run.id, "accept", [o1]);
    const name = colId(starter, "Name");
    expect((await listRows(actor, starter.table_id)).rows[0]![name]).toBe("v1");

    const out = await doJson<{ reverted: number }>(actor, "/runs/revert", {
      actor: HUMAN,
      run_id: a.run.id,
      requested_by: HUMAN.alias,
    });
    expect(out.reverted).toBe(2);
    expect((await listRows(actor, starter.table_id)).rows[0]![name]).toBe("original");
  });

  it("two deciders racing on one op apply and ledger it once", async () => {
    const h = makeState();
    const { actor } = makeActor(h);
    const starter = await initStarter(actor);
    const big = "x".repeat(16_000);
    const seeded = await doJson<{ row_ids: string[] }>(actor, "/rows/insert", {
      actor: HUMAN,
      table_id: starter.table_id,
      rows: Array.from({ length: 5 }, () => ({ Notes: big })),
    });
    const out = await propose(actor, {
      kind: "rows.update",
      table: starter.table_id,
      updates: seeded.row_ids.map((id) => ({ _id: id, values: { Notes: "short" } })),
    });

    // The old values make the inverse spill; the second decide runs inside the first one's put.
    const origPut = h.snapshots.put.bind(h.snapshots);
    let inner: Promise<{ applied: number }> | null = null;
    h.snapshots.put = async (key, value) => {
      await origPut(key, value);
      if (inner) return;
      inner = decide(actor, out.run.id, "accept");
      await inner;
    };
    const outer = await decide(actor, out.run.id, "accept");
    expect(outer.applied + (await inner!).applied).toBe(1);

    const ops = await doJson<{ ops: Array<{ op_id: string; kind: string; is_agent: boolean }> }>(actor, "/ops?limit=50", undefined);
    const updates = ops.ops.filter((o) => o.kind === "rows.update" && o.is_agent);
    expect(updates).toHaveLength(1);
    const run = (await doJson<{ run: DatabaseRunSummary }>(actor, `/runs/detail?runId=${out.run.id}`, undefined)).run;
    expect(run.ops[0]).toMatchObject({ status: "accepted", ledger_op_id: updates[0]!.op_id });
  });

  it("a spilled payload survives the propose round trip and applies on accept", async () => {
    const h = makeState();
    const { actor } = makeActor(h);
    const starter = await initStarter(actor);
    // Over the inline limit; the spill key is random, never the positional op id.
    const big = "x".repeat(9_000);
    const rows = Array.from({ length: 8 }, (_, i) => ({ Name: `r${i}`, Notes: big }));
    const out = await propose(actor, { kind: "rows.insert", table: starter.table_id, rows });
    expect(out.mode).toBe("proposed");
    const keys = await blobKeys(h.snapshots);
    expect(keys).toHaveLength(1);
    const [key] = keys;
    expect(key).toMatch(/db-runs\/run_[0-9a-f]{12}\/[0-9a-f]{18}\.json$/);

    const decided = await decide(actor, out.run.id, "accept");
    expect(decided.applied).toBe(1);
    expect((await listRows(actor, starter.table_id)).total).toBe(8);
  });
});

describe("run hygiene", () => {
  it("an idle run with nothing pending rolls over on the next propose", async () => {
    const h = makeState();
    const { actor } = makeActor(h);
    const starter = await initStarter(actor);
    const first = await propose(actor, { kind: "rows.insert", table: starter.table_id, rows: [{ Name: "a" }] });
    await decide(actor, first.run.id, "accept");
    h.state.storage.sql.exec(`UPDATE _runs SET updated_at = updated_at - 700000`);
    const second = await propose(actor, { kind: "rows.insert", table: starter.table_id, rows: [{ Name: "b" }] });
    expect(second.run.id).not.toBe(first.run.id);
  });

  it("refuses a proposal without its agent, workspace or title", async () => {
    const { actor } = makeActor();
    const starter = await initStarter(actor);
    const op = { kind: "rows.insert", table: starter.table_id, rows: [{ Name: "x" }] };
    for (const missing of ["agent", "workspace_id", "doc_title"]) {
      const res = await doFetch(actor, "/runs/propose", proposeBody(op, { [missing]: undefined }));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { message: string }).message).toContain(missing);
    }
  });

  it("locked database refuses proposals with 423", async () => {
    const h = makeState();
    const { actor } = makeActor(h);
    const starter = await initStarter(actor);
    await doFetch(actor, "/set-locked?locked=1", {});
    const res = await doFetch(actor, "/runs/propose", proposeBody({ kind: "rows.insert", table: starter.table_id, rows: [{ Name: "no" }] }));
    expect(res.status).toBe(423);
  });

  it("runs list orders open first then newest; ops list stays empty until accept", async () => {
    const h = makeState();
    const { actor } = makeActor(h);
    const starter = await initStarter(actor);
    const a = await propose(actor, { kind: "rows.insert", table: starter.table_id, rows: [{ Name: "a" }] });
    await decide(actor, a.run.id, "accept");
    const b = await propose(actor, { kind: "rows.insert", table: starter.table_id, rows: [{ Name: "b" }] });
    const list = await doJson<{ runs: DatabaseRunSummary[] }>(actor, "/runs?limit=10", undefined);
    expect(list.runs[0]!.id).toBe(b.run.id);
    expect(list.runs[0]!.status).toBe("open");
    expect(list.runs[1]!.id).toBe(a.run.id);
  });
});
