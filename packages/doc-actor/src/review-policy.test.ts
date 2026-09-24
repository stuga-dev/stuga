/**
 * The review policy as the actor obeys it: `review` parks whoever is connected
 * and no timer lands it; `auto` commits; a run holding an undecided hunk parks a
 * later `auto` proposal until the backlog is decided; an unrecognised word is
 * `review`. Also the append action and the inbox mirror with its event.
 */
import { describe, expect, it } from "vitest";
import type { AgentRunSummary } from "@stuga/protocol/wire/doc-socket";
import type { IndexMessage } from "@stuga/protocol/internal/jobs";
import { DocActor } from "./doc-actor.js";
import { harness, makeActor, connect, type Harness } from "../test/harness.js";

const DOC = "doc1";
const MD = "# Notes\n\nAlpha paragraph.\n\n## Log\n\n- first\n\n## Ideas\n\nBravo paragraph.\n";

async function seed(dobj: DocActor, markdown = MD): Promise<void> {
  await dobj.fetch(
    new Request(`http://actor/apply-edits?docId=${DOC}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ str_edits: [{ old_string: "", new_string: markdown }], agent: "seed" }),
    }),
  );
}

interface ProposeBody {
  action: "write" | "str_replace" | "append";
  text?: string;
  heading?: string | null;
  find?: string;
  replace?: string;
  review?: string;
  agent_alias?: string;
}

async function propose(dobj: DocActor, body: ProposeBody): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await dobj.fetch(
    new Request(`http://actor/runs/propose?docId=${DOC}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "stdio",
        agent: "Claude (Connector)",
        agent_alias: "agent-1",
        reviewer: "alice",
        workspace_id: "ws1",
        doc_title: "Notes",
        ...body,
      }),
    }),
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function markdownOf(dobj: DocActor): Promise<string> {
  const res = await dobj.fetch(new Request(`http://actor/markdown?docId=${DOC}`));
  return ((await res.json()) as { markdown: string }).markdown;
}

async function detail(dobj: DocActor, runId: string): Promise<AgentRunSummary> {
  const res = await dobj.fetch(new Request(`http://actor/runs/detail?docId=${DOC}&runId=${runId}`));
  return ((await res.json()) as { run: AgentRunSummary }).run;
}

const runOf = (json: Record<string, unknown>) => json.run as AgentRunSummary;
const ofKind = (h: Harness, kind: string) => h.queued.filter((m) => m.kind === kind);
const events = (h: Harness) => ofKind(h, "event") as Array<Extract<IndexMessage, { kind: "event" }>>;

describe("review verdicts in the document actor", () => {
  it("`review` parks with nobody watching, and no alarm can ever land it", async () => {
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);
    // The document as the serializer writes it, which is what "unchanged" means.
    const base = await markdownOf(dobj);
    const out = await propose(dobj, { action: "str_replace", find: "Alpha", replace: "Alpha!", review: "review" });
    expect(out.json.mode).toBe("proposed");
    const run = runOf(out.json);
    expect(run.review_mode).toBe("review");
    expect(run.hunks[0]).toMatchObject({ status: "pending", review: "review" });
    expect(await markdownOf(dobj)).toBe(base);
    // The reviewer is told it is waiting — that is what keeps this from being a
    // silent queue, since nobody has the document open.
    expect(ofKind(h, "notify")).toMatchObject([{ eventType: "AGENT_EDITS_PROPOSED", recipient: "alice" }]);

    // Firing the flush alarm is the only alarm there is, and it lands nothing.
    await dobj.alarm();
    expect((await detail(dobj, run.id)).hunks[0]!.status).toBe("pending");
    expect(await markdownOf(dobj)).toBe(base);
    expect(events(h).some((e) => e.type === "run.proposed" && e.payload?.review === "review")).toBe(true);
    expect(events(h).some((e) => e.type === "run.applied")).toBe(false);
  });

  it("`review` parks even with the reviewer sitting on a live socket", async () => {
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);
    await connect(dobj, h, { docId: DOC, alias: "alice" });
    const base = await markdownOf(dobj);
    const out = await propose(dobj, { action: "str_replace", find: "Alpha", replace: "Alpha!", review: "review" });
    expect(out.json.mode).toBe("proposed");
    expect(await markdownOf(dobj)).toBe(base);
  });

  it("`auto` commits while the reviewer is on a socket", async () => {
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);
    await connect(dobj, h, { docId: DOC, alias: "alice" });
    const out = await propose(dobj, { action: "str_replace", find: "Alpha", replace: "Alpha!", review: "auto" });
    expect(out.json.mode).toBe("auto_applied");
    expect(runOf(out.json).hunks[0]!.status).toBe("auto_applied");
    expect(await markdownOf(dobj)).toContain("Alpha!");
    const applied = events(h).find((e) => e.type === "run.applied");
    expect(applied?.payload).toMatchObject({ review: "auto", decided_by: "policy:auto" });
    expect(applied?.actor).toBe("agent:agent-1");
  });

  it("an unknown verdict is `review`, never a silent auto", async () => {
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);
    const base = await markdownOf(dobj);
    const out = await propose(dobj, { action: "str_replace", find: "Alpha", replace: "Alpha!", review: "banana" });
    expect(out.json.mode).toBe("proposed");
    expect(runOf(out.json).review_mode).toBe("review");
    expect(await markdownOf(dobj)).toBe(base);
  });

  it("parks a later `auto` proposal while the run still holds an undecided hunk", async () => {
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);
    const base = await markdownOf(dobj);
    const held = await propose(dobj, { action: "str_replace", find: "Alpha", replace: "Alpha!", review: "review" });
    const later = await propose(dobj, { action: "str_replace", find: "Bravo", replace: "Bravo!", review: "auto" });

    // Not auto_applied: the second hunk was diffed against a copy that already
    // contains the first, so landing it alone would apply an edit whose context
    // is not in the document. Both wait, and the reviewer decides the chain.
    expect(later.json.mode).toBe("proposed");
    // And the agent is told the document's own word did not decide this one,
    // so "waiting" cannot read as contradicting the verdict it just fetched.
    expect(later.json.parked_behind_pending).toBe(true);
    const run = runOf(later.json);
    expect(run.id).toBe(runOf(held.json).id);
    // The run remembers the STRICTER of the two, so the inbox reads as the safer word.
    expect(run.review_mode).toBe("review");
    expect(run.hunks.map((x) => [x.review, x.status])).toEqual([
      ["review", "pending"],
      ["auto", "pending"],
    ]);
    expect(await markdownOf(dobj)).toBe(base);

    // Once a person clears the backlog, `auto` lands again — the hold is the
    // pending work, not a mode the document has quietly acquired.
    await dobj.fetch(
      new Request(`http://actor/runs/decide?docId=${DOC}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ run_id: run.id, decision: "accept", decided_by: "alice" }),
      }),
    );
    const after = await propose(dobj, { action: "str_replace", find: "Notes", replace: "Notes!", review: "auto" });
    expect(after.json.mode).toBe("auto_applied");
    expect(after.json.parked_behind_pending).toBeUndefined();
    expect(await markdownOf(dobj)).toContain("Notes!");
  });

  it("an append behind a pending append parks instead of failing stale forever", async () => {
    // An append is computed against the agent's projected copy (document plus its
    // pending hunks), so committing it against the live document could never match.
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);
    const first = await propose(dobj, { action: "append", text: "line one", review: "review" });
    expect(first.json.mode).toBe("proposed");
    const second = await propose(dobj, { action: "append", text: "line two", review: "auto" });
    expect(second.status).toBe(200);
    expect(second.json.mode).toBe("proposed");
    expect(runOf(second.json).hunks.map((x) => x.status)).toEqual(["pending", "pending"]);
  });

  it("append lands at the end, or under a heading, and reports a heading it cannot find", async () => {
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);
    const tail = await propose(dobj, { action: "append", text: "Tail line.", review: "auto" });
    expect(tail.json.mode).toBe("auto_applied");
    const afterTail = await markdownOf(dobj);
    expect(afterTail).toContain("Bravo paragraph.\n\nTail line.");
    expect(afterTail.indexOf("Tail line.")).toBeGreaterThan(afterTail.indexOf("Bravo paragraph."));

    const under = await propose(dobj, { action: "append", text: "- second", heading: "log", review: "auto" });
    expect(under.json.mode).toBe("auto_applied");
    // The serializer picks its own bullet marker, so match the item text.
    const afterUnder = await markdownOf(dobj);
    const first = afterUnder.indexOf("first");
    const second = afterUnder.indexOf("second");
    const ideas = afterUnder.indexOf("## Ideas");
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
    expect(ideas).toBeGreaterThan(second);

    const missing = await propose(dobj, { action: "append", text: "x", heading: "Nope", review: "auto" });
    expect(missing.status).toBe(409);
    expect(missing.json.error).toBe("not_found");
  });

  it("every saved run is mirrored for the inbox, counts by status, latest state last", async () => {
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);
    await connect(dobj, h, { docId: DOC, alias: "alice" });
    const out = await propose(dobj, { action: "str_replace", find: "Alpha", replace: "Alpha!" });
    const run = runOf(out.json);
    await dobj.fetch(
      new Request(`http://actor/runs/decide?docId=${DOC}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ run_id: run.id, decision: "accept", decided_by: "alice" }),
      }),
    );
    const mirrors = ofKind(h, "run_index") as Array<Extract<IndexMessage, { kind: "run_index" }>>;
    expect(mirrors.length).toBeGreaterThanOrEqual(2);
    expect(mirrors[0]!.run).toMatchObject({ runId: run.id, workspaceId: "ws1", docId: DOC, docKind: "prose", pending: 1, accepted: 0, status: "open" });
    expect(mirrors[mirrors.length - 1]!.run).toMatchObject({ runId: run.id, pending: 0, accepted: 1, status: "applied", reviewer: "alice" });
    const decided = events(h).find((e) => e.type === "run.decided");
    expect(decided).toMatchObject({ actor: "user:alice", actorKind: "human", docId: DOC, workspaceId: "ws1" });
    expect(decided?.payload).toMatchObject({ decision: "accept", applied: 1, hunks: 1 });
  });

  it("a run outside any tenant is neither mirrored nor announced", async () => {
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);
    const res = await dobj.fetch(
      new Request(`http://actor/runs/propose?docId=${DOC}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "str_replace", find: "Alpha", replace: "A", agent_alias: "agent-1", reviewer: "alice", review: "auto" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(ofKind(h, "run_index")).toHaveLength(0);
    expect(ofKind(h, "event")).toHaveLength(0);
  });
});
