import { describe, expect, it } from "vitest";
import { AGENT, HUMAN, doJson, initStarter, makeActor, makeState, proposeBody } from "../test/harness.js";
import type { DatabaseActor } from "./database-actor.js";
import type { DatabaseRunSummary } from "@stuga/protocol/databases/types";
import type { IndexMessage } from "@stuga/protocol/internal/jobs";

interface ProposeOut {
  mode: "proposed" | "applied";
  run: DatabaseRunSummary;
  pending?: number;
  parked_behind_pending?: boolean;
  minted?: { table_id?: string };
}

function eventTypes(sent: IndexMessage[]): string[] {
  return sent.flatMap((m) => (m.kind === "event" ? [m.type] : []));
}

function propose(actor: DatabaseActor, op: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return doJson<ProposeOut>(actor, "/runs/propose", proposeBody(op, extra));
}

async function total(actor: DatabaseActor, tableId: string): Promise<number> {
  return (await doJson<{ total: number }>(actor, "/rows/list", { table_id: tableId })).total;
}

describe("review policy in the database actor", () => {
  it("`review` parks, and nothing but a person can land it", async () => {
    const h = makeState();
    const sent = h.jobs.sent;
    const { actor } = makeActor(h);
    const starter = await initStarter(actor);

    const out = await propose(actor, { kind: "rows.insert", table: starter.table_id, rows: [{ Name: "held" }] }, { review: "review" });
    expect(out.mode).toBe("proposed");
    expect(out.run.review_mode).toBe("review");
    expect(out.run.ops[0]!.review).toBe("review");
    expect(await total(actor, starter.table_id)).toBe(0);

    // A parked op has no deadline.
    expect((actor as { alarm?: unknown }).alarm).toBeUndefined();
    const run = (await doJson<{ run: DatabaseRunSummary }>(actor, `/runs/detail?runId=${out.run.id}`, undefined)).run;
    expect(run.status).toBe("open");
    expect(run.ops[0]!.status).toBe("pending");

    expect(sent.map((m) => m.kind)).toContain("run_index");
    expect(eventTypes(sent)).toContain("run.proposed");
    expect(eventTypes(sent)).not.toContain("run.applied");
    expect(sent.filter((m) => m.kind === "notify")).toMatchObject([
      { eventType: "DATABASE_AGENT_PROPOSED", recipient: HUMAN.alias },
    ]);
  });

  it("`auto` commits, and says the policy decided it", async () => {
    const h = makeState();
    const sent = h.jobs.sent;
    const { actor } = makeActor(h);
    const starter = await initStarter(actor);

    const out = await propose(actor, { kind: "rows.insert", table: starter.table_id, rows: [{ Name: "landed" }] }, { review: "auto" });
    expect(out.mode).toBe("applied");
    expect(out.run.ops[0]!.status).toBe("auto_applied");
    expect(await total(actor, starter.table_id)).toBe(1);
    const applied = sent.find((m) => m.kind === "event" && m.type === "run.applied");
    expect(applied).toMatchObject({ payload: { decided_by: "policy:auto", review: "auto" } });
  });

  it("an unrecognised verdict is `review`, never a silent auto", async () => {
    const h = makeState();
    const { actor } = makeActor(h);
    const starter = await initStarter(actor);
    const out = await propose(actor, { kind: "rows.insert", table: starter.table_id, rows: [{ Name: "x" }] }, { review: "whatever" });
    expect(out.mode).toBe("proposed");
    expect(out.run.review_mode).toBe("review");
    expect(await total(actor, starter.table_id)).toBe(0);
  });

  it("parks a later `auto` proposal while the run still holds an undecided op", async () => {
    const h = makeState();
    const { actor } = makeActor(h);
    const starter = await initStarter(actor);

    const held = await propose(actor, { kind: "rows.insert", table: starter.table_id, rows: [{ Name: "held" }] }, { review: "review" });
    expect(held.mode).toBe("proposed");
    const later = await propose(actor, { kind: "rows.insert", table: starter.table_id, rows: [{ Name: "free" }] }, { review: "auto" });

    expect(later.mode).toBe("proposed");
    expect(later.parked_behind_pending).toBe(true);
    expect(later.run.id).toBe(held.run.id);
    expect(later.run.review_mode).toBe("review");
    const statuses = later.run.ops.map((o) => [o.review, o.status]);
    expect(statuses).toEqual([
      ["review", "pending"],
      ["auto", "pending"],
    ]);
    expect(await total(actor, starter.table_id)).toBe(0);

    await doJson(actor, "/runs/decide", { actor: HUMAN, run_id: held.run.id, decision: "accept", decided_by: HUMAN.alias });
    const after = await propose(actor, { kind: "rows.insert", table: starter.table_id, rows: [{ Name: "later" }] }, { review: "auto" });
    expect(after.mode).toBe("applied");
    expect(after.parked_behind_pending).toBeUndefined();
    expect(await total(actor, starter.table_id)).toBe(3);
  });

  it("an op that names a table a pending op will create parks instead of conflicting", async () => {
    const h = makeState();
    const { actor } = makeActor(h);
    await initStarter(actor);

    const created = await propose(actor, { kind: "tables.create", display: "Tasks" }, { review: "review" });
    expect(created.mode).toBe("proposed");
    const tableId = created.minted!.table_id!;
    expect(tableId).toMatch(/^tbl_/);

    const column = await propose(actor, { kind: "columns.add", table: tableId, display: "Owner", type: "text" }, { review: "auto" });
    expect(column.mode).toBe("proposed");
    expect(column.run.ops.map((o) => o.status)).toEqual(["pending", "pending"]);
  });

  it("the inbox mirror carries counts by status and is refreshed on decide", async () => {
    const h = makeState();
    const sent = h.jobs.sent;
    const { actor } = makeActor(h);
    const starter = await initStarter(actor);
    const out = await propose(actor, { kind: "rows.insert", table: starter.table_id, rows: [{ Name: "a" }] });
    await doJson(actor, "/runs/decide", { actor: HUMAN, run_id: out.run.id, decision: "accept", decided_by: HUMAN.alias });
    const mirrors = sent.flatMap((m) => (m.kind === "run_index" ? [m.run] : []));
    expect(mirrors.length).toBeGreaterThanOrEqual(2);
    const last = mirrors[mirrors.length - 1];
    expect(last).toMatchObject({
      runId: out.run.id,
      workspaceId: "ws_test",
      docKind: "database",
      status: "applied",
      pending: 0,
      accepted: 1,
      agentAlias: AGENT.alias,
      reviewer: HUMAN.alias,
    });
    const decided = sent.find((m) => m.kind === "event" && m.type === "run.decided");
    expect(decided).toMatchObject({ actor: `user:${HUMAN.alias}`, payload: { decision: "accept", applied: 1 } });
  });
});
