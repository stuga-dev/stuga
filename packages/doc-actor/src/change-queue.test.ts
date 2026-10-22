/**
 * Changes in the document actor: a run belongs to one change; the same agent's proposal for another
 * change starts a run of its own, queued behind the one still waiting, so a hub page never refuses an
 * agent's later work. A queued run is rejected at any time and accepted once the run ahead is decided;
 * the agent reads its runs laid over each other; and the change rides along on what the run sends out.
 */
import { describe, expect, it } from "vitest";
import type { AgentRunSummary } from "@stuga/protocol/wire/doc-socket";
import type { IndexMessage } from "@stuga/protocol/internal/jobs";
import { DocActor } from "./doc-actor.js";
import { harness, makeActor, type Harness } from "../test/harness.js";

const DOC = "doc1";
const MD = "# Customers\n\n- Acme\n";

async function post(dobj: DocActor, path: string, body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await dobj.fetch(
    new Request(`http://actor${path}?docId=${DOC}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function seed(dobj: DocActor): Promise<void> {
  await post(dobj, "/apply-edits", { str_edits: [{ old_string: "", new_string: MD }], agent: "seed" });
}

function propose(dobj: DocActor, body: Record<string, unknown>) {
  return post(dobj, "/runs/propose", {
    source: "stdio",
    agent: "Scout",
    agent_alias: "agent-1",
    reviewer: "liv",
    workspace_id: "ws1",
    doc_title: "Customers",
    review: "colleague",
    action: "append",
    ...body,
  });
}

const decide = (dobj: DocActor, runId: string, decision: "accept" | "reject") =>
  post(dobj, "/runs/decide", { run_id: runId, decision, decided_by: "sam", level: "colleague", approver: true });

async function detail(dobj: DocActor, runId: string): Promise<AgentRunSummary> {
  const res = await dobj.fetch(new Request(`http://actor/runs/detail?docId=${DOC}&runId=${runId}`));
  return ((await res.json()) as { run: AgentRunSummary }).run;
}

async function live(dobj: DocActor): Promise<string> {
  const res = await dobj.fetch(new Request(`http://actor/markdown?docId=${DOC}`));
  return ((await res.json()) as { markdown: string }).markdown;
}

async function agentRead(dobj: DocActor): Promise<string> {
  const res = await dobj.fetch(new Request(`http://actor/markdown?docId=${DOC}&agent=agent-1`));
  return ((await res.json()) as { markdown: string }).markdown;
}

const runOf = (json: Record<string, unknown>) => json.run as AgentRunSummary;
const ofKind = <K extends IndexMessage["kind"]>(h: Harness, kind: K) => h.queued.filter((m): m is Extract<IndexMessage, { kind: K }> => m.kind === kind);

describe("an agent's changes on one document", () => {
  it("adds a proposal for the same change to its run, and stamps the change on everything the run sends", async () => {
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);
    const first = runOf((await propose(dobj, { text: "- Globex", change_id: "chg_000000000001" })).json);
    const second = runOf((await propose(dobj, { text: "- Initech", change_id: "chg_000000000001" })).json);
    expect(second.id).toBe(first.id);
    expect(second.change_id).toBe("chg_000000000001");
    expect(second.queued_behind).toBeUndefined();
    expect(ofKind(h, "notify").every((m) => m.changeId === "chg_000000000001")).toBe(true);
    expect(ofKind(h, "notify_approvers").every((m) => m.changeId === "chg_000000000001")).toBe(true);
    expect(ofKind(h, "event").every((m) => m.payload?.change_id === "chg_000000000001")).toBe(true);
    expect(ofKind(h, "run_index").at(-1)?.run).toMatchObject({ changeId: "chg_000000000001", queuedBehind: null });
  });

  it("queues another change's proposal behind the run still waiting, instead of refusing it or mixing them", async () => {
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);
    const a = runOf((await propose(dobj, { text: "- Globex", change_id: "chg_00000000000a" })).json);
    const out = await propose(dobj, { text: "- Initech", change_id: "chg_00000000000b" });
    expect(out.status).toBe(200);
    expect(out.json.mode).toBe("proposed");
    const b = runOf(out.json);
    expect(b.id).not.toBe(a.id);
    expect(b).toMatchObject({ change_id: "chg_00000000000b", queued_behind: a.id, stacked_on: [a.id] });
    expect(out.json.queued_behind).toEqual({ run_id: a.id, change_id: "chg_00000000000a" });
    // Each run holds only its own change's hunks.
    expect((await detail(dobj, a.id)).hunks.map((x) => x.new_string)).toEqual([expect.stringContaining("Globex")]);
    expect((await detail(dobj, b.id)).hunks.map((x) => x.new_string)).toEqual([expect.stringContaining("Initech")]);
    // The agent reads both laid over the text, in order; everyone else reads the text as it is.
    expect(await agentRead(dobj)).toMatch(/Acme[\s\S]*Globex[\s\S]*Initech/);
    expect(await live(dobj)).not.toContain("Globex");
    // The mirror says what it waits behind.
    expect(ofKind(h, "run_index").filter((m) => m.run.runId === b.id).at(-1)?.run.queuedBehind).toBe(a.id);
  });

  it("refuses to accept a queued run until the run ahead is decided, and lets it be rejected at any time", async () => {
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);
    const a = runOf((await propose(dobj, { text: "- Globex", change_id: "chg_00000000000a" })).json);
    const b = runOf((await propose(dobj, { text: "- Initech", change_id: "chg_00000000000b" })).json);
    const early = await decide(dobj, b.id, "accept");
    expect(early.status).toBe(409);
    expect(early.json).toMatchObject({ error: "queued", behind: { run_id: a.id, change_id: "chg_00000000000a" } });
    expect(await live(dobj)).not.toContain("Initech");

    expect((await decide(dobj, a.id, "accept")).status).toBe(200);
    // The run ahead closed: this one moves up and is no longer queued.
    expect((await detail(dobj, b.id)).queued_behind).toBeUndefined();
    expect((await decide(dobj, b.id, "accept")).status).toBe(200);
    expect(await live(dobj)).toMatch(/Acme[\s\S]*Globex[\s\S]*Initech/);
  });

  it("rejects a queued run without waiting, and leaves the run ahead as it was", async () => {
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);
    const a = runOf((await propose(dobj, { text: "- Globex", change_id: "chg_00000000000a" })).json);
    const b = runOf((await propose(dobj, { text: "- Initech", change_id: "chg_00000000000b" })).json);
    expect((await decide(dobj, b.id, "reject")).status).toBe(200);
    expect((await detail(dobj, b.id)).status).toBe("rejected");
    expect((await detail(dobj, a.id)).status).toBe("open");
    // The agent's pointer is back on the run that still waits: its next proposal for that change joins it.
    const again = runOf((await propose(dobj, { text: "- Hooli", change_id: "chg_00000000000a" })).json);
    expect(again.id).toBe(a.id);
  });

  it("moves a third change up behind the first when the second is decided", async () => {
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);
    const a = runOf((await propose(dobj, { text: "- Globex", change_id: "chg_00000000000a" })).json);
    const b = runOf((await propose(dobj, { text: "- Initech", change_id: "chg_00000000000b" })).json);
    const c = runOf((await propose(dobj, { text: "- Hooli", change_id: "chg_00000000000c" })).json);
    expect(c).toMatchObject({ queued_behind: b.id, stacked_on: [a.id, b.id] });
    expect((await decide(dobj, b.id, "reject")).status).toBe(200);
    expect((await detail(dobj, c.id)).queued_behind).toBe(a.id);
  });

  it("closes a finished run of another change and starts a fresh one, not queued", async () => {
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);
    const a = runOf((await propose(dobj, { text: "- Globex", change_id: "chg_00000000000a", review: "auto" })).json);
    expect(a.status).toBe("open");
    const b = runOf((await propose(dobj, { text: "- Initech", change_id: "chg_00000000000b", review: "auto" })).json);
    expect(b.id).not.toBe(a.id);
    expect(b.queued_behind).toBeUndefined();
    expect((await detail(dobj, a.id)).status).toBe("applied");
    expect(await live(dobj)).toMatch(/Acme[\s\S]*Globex[\s\S]*Initech/);
  });

  it("parks an `auto` proposal queued behind another change's waiting run, and says so", async () => {
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);
    const a = runOf((await propose(dobj, { text: "- Globex", change_id: "chg_00000000000a", review: "review" })).json);
    const out = await propose(dobj, { text: "- Initech", change_id: "chg_00000000000b", review: "auto" });
    expect(out.json).toMatchObject({ mode: "proposed", parked_behind_pending: true, queued_behind: { run_id: a.id } });
    expect(await live(dobj)).not.toContain("Initech");
  });

  it("keeps proposals without a change as they were: one run per agent", async () => {
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);
    const a = runOf((await propose(dobj, { text: "- Globex" })).json);
    const b = runOf((await propose(dobj, { text: "- Initech" })).json);
    expect(b.id).toBe(a.id);
    expect(b.change_id).toBeUndefined();
  });
});
