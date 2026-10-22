/**
 * Changes in the database actor: a run belongs to one change, and the same agent's proposal for
 * another change starts a run queued behind the one still waiting. A queued run is rejected at any
 * time and accepted once the run ahead is decided; an op may name what the run ahead mints.
 */
import { describe, expect, it } from "vitest";
import type { DatabaseRunSummary } from "@stuga/protocol/databases/types";
import { HUMAN, doFetch, doJson, initStarter, makeActor, makeState, proposeBody } from "../test/harness.js";
import type { DatabaseActor } from "./database-actor.js";

interface ProposeOut {
  mode: "proposed" | "applied";
  run: DatabaseRunSummary;
  minted?: { table_id?: string; column_id?: string; row_ids?: string[] };
  queued_behind?: { run_id: string; change_id: string | null };
}

const propose = (actor: DatabaseActor, op: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  doJson<ProposeOut>(actor, "/runs/propose", proposeBody(op, extra));

const decide = (actor: DatabaseActor, runId: string, decision: "accept" | "reject") =>
  doFetch(actor, "/runs/decide", { actor: HUMAN, run_id: runId, decision, decided_by: HUMAN.alias });

const detail = async (actor: DatabaseActor, runId: string) =>
  (await doJson<{ run: DatabaseRunSummary }>(actor, `/runs/detail?runId=${runId}`)).run;

describe("an agent's changes on one database", () => {
  it("adds a proposal for the same change to its run, and queues another change's behind it", async () => {
    const { actor, h } = makeActor(makeState());
    const starter = await initStarter(actor);
    const a = await propose(actor, { kind: "rows.insert", table: starter.table_id, rows: [{ Name: "Acme" }] }, { change_id: "chg_00000000000a" });
    const a2 = await propose(actor, { kind: "rows.insert", table: starter.table_id, rows: [{ Name: "Globex" }] }, { change_id: "chg_00000000000a" });
    expect(a2.run.id).toBe(a.run.id);
    expect(a.run.change_id).toBe("chg_00000000000a");
    const b = await propose(actor, { kind: "rows.insert", table: starter.table_id, rows: [{ Name: "Initech" }] }, { change_id: "chg_00000000000b" });
    expect(b.run.id).not.toBe(a.run.id);
    expect(b.run).toMatchObject({ change_id: "chg_00000000000b", queued_behind: a.run.id, stacked_on: [a.run.id] });
    expect(b.queued_behind).toEqual({ run_id: a.run.id, change_id: "chg_00000000000a" });
    const jobs = h.jobs.sent;
    expect(jobs.filter((m) => m.kind === "notify_approvers" || m.kind === "notify").every((m) => "changeId" in m && m.changeId)).toBe(true);
  });

  it("refuses to accept a queued run until the run ahead is decided, then moves it up", async () => {
    const { actor } = makeActor(makeState());
    const starter = await initStarter(actor);
    const a = await propose(actor, { kind: "rows.insert", table: starter.table_id, rows: [{ Name: "Acme" }] }, { change_id: "chg_00000000000a" });
    const b = await propose(actor, { kind: "rows.insert", table: starter.table_id, rows: [{ Name: "Initech" }] }, { change_id: "chg_00000000000b" });
    const early = await decide(actor, b.run.id, "accept");
    expect(early.status).toBe(409);
    expect(((await early.json()) as { error: string }).error).toBe("queued");
    expect((await decide(actor, a.run.id, "accept")).status).toBe(200);
    expect((await detail(actor, b.run.id)).queued_behind).toBeUndefined();
    expect((await decide(actor, b.run.id, "accept")).status).toBe(200);
    expect((await detail(actor, b.run.id)).status).toBe("applied");
  });

  it("rejects a queued run without waiting", async () => {
    const { actor } = makeActor(makeState());
    const starter = await initStarter(actor);
    const a = await propose(actor, { kind: "rows.insert", table: starter.table_id, rows: [{ Name: "Acme" }] }, { change_id: "chg_00000000000a" });
    const b = await propose(actor, { kind: "rows.insert", table: starter.table_id, rows: [{ Name: "Initech" }] }, { change_id: "chg_00000000000b" });
    expect((await decide(actor, b.run.id, "reject")).status).toBe(200);
    expect((await detail(actor, b.run.id)).status).toBe("rejected");
    expect((await detail(actor, a.run.id)).status).toBe("open");
  });

  it("lets a queued op name a table the run ahead mints", async () => {
    const { actor } = makeActor(makeState());
    await initStarter(actor);
    const a = await propose(actor, { kind: "tables.create", display: "Customers" }, { change_id: "chg_00000000000a" });
    const tableId = a.minted!.table_id!;
    const b = await propose(actor, { kind: "columns.add", table: tableId, display: "Tier", type: "text" }, { change_id: "chg_00000000000b" });
    expect(b.mode).toBe("proposed");
    expect(b.run.queued_behind).toBe(a.run.id);
    // The agent's schema read shows both, the table and the column on it.
    const schema = await doJson<{ tables: Array<{ table_id: string; columns: Array<{ display: string }> }> }>(actor, "/schema?agent=agent:claude");
    expect(schema.tables.find((t) => t.table_id === tableId)?.columns.map((c) => c.display)).toContain("Tier");
  });
});
