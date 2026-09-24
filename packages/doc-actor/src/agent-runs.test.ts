/**
 * The agent-run review ledger. An agent's write never touches the Y.Doc
 * directly: it becomes a pending hunk a reviewer decides, whoever is connected,
 * and only a proposal resolved to `auto` commits at once.
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { applyStrEditsStrict, docToMarkdown, getStugaSchema, markdownToDoc } from "@stuga/crdt-ops";
import type { AgentRunSummary, RunDecidedPayload, RunUpdatedPayload } from "@stuga/protocol/wire/doc-socket";
import { encodeBinary, encodeJson, decodeJson } from "@stuga/protocol/wire/frame";
import { Opcode } from "@stuga/protocol/wire/opcodes";
import { DocActor } from "./doc-actor.js";
import { RUN_IDLE_MS } from "@stuga/protocol/domain/limits";
import {
  RUN_LIST_DEFAULT_LIMIT,
  RUN_ORDER_KEY,
  RUN_ORDER_MAX,
  PENDING_RUN_MAX,
  runStorageKey,
  type StoredRun,
} from "./ledger/run-store.js";
import { proposeRunEdit } from "./ledger/propose.js";
import {
  harness,
  makeActor,
  connect,
  type Harness,
  type MemorySocket,
  frameBuffer,
} from "../test/harness.js";

const DOC = "doc1";
const MD = "# Notes\n\nAlpha paragraph.\n\nBravo paragraph.\n";

/** Seed the document body through the existing headless write path. */
async function seed(dobj: DocActor, markdown = MD): Promise<void> {
  await dobj.fetch(
    new Request(`http://actor/apply-edits?docId=${DOC}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ str_edits: [{ old_string: "", new_string: markdown }], agent: "seed" }),
    }),
  );
}

/** A human edit landing directly on the doc (what makes an agent hunk conflict). */
async function humanEdit(dobj: DocActor, from: string, to: string): Promise<void> {
  await dobj.fetch(
    new Request(`http://actor/apply-edits?docId=${DOC}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ str_edits: [{ old_string: from, new_string: to }], agent: "alice" }),
    }),
  );
}

interface ProposeBody {
  action: "write" | "str_replace" | "append" | "cited_edits";
  /** The body for `write`, and the text to add for `append`. */
  text?: string;
  /** `append` only: the heading whose section to add to. */
  heading?: string;
  find?: string;
  replace?: string;
  replace_all?: boolean;
  edits?: { old_string: string; new_string: string }[];
  citations?: { n: number; doc_id: string; title: string; heading_path?: string | null; content?: string }[];
  source?: "connector" | "stdio" | "panel";
  agent?: string;
  agent_alias?: string;
  reviewer?: string;
  /** The word the node's review policy resolved. Omitted = the `review` default. */
  review?: string;
}

async function propose(dobj: DocActor, body: ProposeBody): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await dobj.fetch(
    new Request(`http://actor/runs/propose?docId=${DOC}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "stdio",
        agent: "Claude (Connector)",
        agent_alias: "agent1",
        reviewer: "alice",
        workspace_id: "ws1",
        doc_title: "Notes",
        ...body,
      }),
    }),
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

/** Propose under an `auto` rule — the only way an agent's edit lands unreviewed. */
async function proposeAuto(dobj: DocActor, body: ProposeBody): Promise<{ status: number; json: Record<string, unknown> }> {
  return propose(dobj, { ...body, review: "auto" });
}

async function post(dobj: DocActor, path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await dobj.fetch(
    new Request(`http://actor/runs/${path}?docId=${DOC}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function readMarkdown(dobj: DocActor, agentAlias?: string): Promise<Record<string, unknown>> {
  const url = new URL(`http://actor/markdown?docId=${DOC}`);
  if (agentAlias) url.searchParams.set("agent", agentAlias);
  const res = await dobj.fetch(new Request(url.toString()));
  return (await res.json()) as Record<string, unknown>;
}

async function listRuns(dobj: DocActor, limit?: number): Promise<AgentRunSummary[]> {
  const url = new URL(`http://actor/runs?docId=${DOC}`);
  if (limit !== undefined) url.searchParams.set("limit", String(limit));
  const res = await dobj.fetch(new Request(url.toString()));
  return ((await res.json()) as { runs: AgentRunSummary[] }).runs;
}

function runOf(json: Record<string, unknown>): AgentRunSummary {
  return json.run as AgentRunSummary;
}

/** Every payload of `opcode` this socket received, decoded. */
function payloads<T>(ws: MemorySocket, opcode: number): T[] {
  return ws
    .frames()
    .filter((f) => f.opcode === opcode)
    .map((f) => decodeJson<T>(f.payload));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function sendFrame(dobj: any, ws: MemorySocket, frame: Uint8Array): Promise<void> {
  await dobj.webSocketMessage(ws, frameBuffer(frame));
}

describe("propose under the default `review` policy", () => {
  it("stages hunks without touching the document, and tells only the reviewer", async () => {
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);
    const reviewer = await connect(dobj, h, { docId: DOC, alias: "alice" });
    const agentWs = await connect(dobj, h, { docId: DOC, alias: "alice", agent: "claude", agentAuth: "1" });
    const other = await connect(dobj, h, { docId: DOC, alias: "bob" });

    const { status, json } = await propose(dobj, {
      action: "str_replace",
      find: "Alpha paragraph.",
      replace: "Alpha revised.",
    });

    expect(status).toBe(200);
    expect(json.mode).toBe("proposed");
    expect(json.pending).toBe(1);
    const run = runOf(json);
    expect(run.status).toBe("open");
    expect(run.hunks).toHaveLength(1);
    expect(run.hunks[0]).toMatchObject({ id: "h1", old_string: "Alpha paragraph.", status: "pending" });

    // The real document is untouched.
    expect(await readMarkdown(dobj)).toMatchObject({ markdown: expect.stringContaining("Alpha paragraph.") });

    // Audience: the reviewer's human socket ONLY.
    const seen = payloads<RunUpdatedPayload>(reviewer, Opcode.RUN_UPDATED);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.run.id).toBe(run.id);
    expect(agentWs.has(Opcode.RUN_UPDATED)).toBe(false);
    expect(other.has(Opcode.RUN_UPDATED)).toBe(false);
  });

  it("parks for a reviewer who has never been here, and notifies them", async () => {
    // THE CENTRAL PROPERTY. Nobody has ever held a socket on this document, which
    // under a presence-based rule would be exactly the case that committed unreviewed.
    // The outcome is identical to the watched case, and the reviewer is TOLD —
    // without that, "it waits for a human" degrades into "it waits".
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);

    const { status, json } = await propose(dobj, {
      action: "str_replace",
      find: "Alpha paragraph.",
      replace: "Alpha revised.",
    });

    expect(status).toBe(200);
    expect(json.mode).toBe("proposed");
    expect(await readMarkdown(dobj)).toMatchObject({
      markdown: expect.stringContaining("Alpha paragraph."),
    });
    expect(h.queued.find((m) => (m as { kind?: string }).kind === "notify")).toMatchObject({
      kind: "notify",
      recipient: "alice",
      eventType: "AGENT_EDITS_PROPOSED",
      docId: DOC,
      body: "Claude (Connector) proposed 1 change — waiting for your review",
    });
  });

  it("parks a reviewer's own reconnect window identically (no timing edge to exploit)", async () => {
    // A reviewer mid-reload, a reviewer who closed their last tab a second ago and
    // a reviewer on holiday are all the same case now, so there is no window in
    // which an agent's edit behaves differently from any other moment.
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);
    const reviewer = await connect(dobj, h, { docId: DOC, alias: "alice" });
    reviewer.close();
    await dobj.webSocketClose(reviewer, 1001, "", true);

    const { json } = await propose(dobj, { action: "str_replace", find: "Alpha paragraph.", replace: "Alpha revised." });
    expect(json.mode).toBe("proposed");
    expect(await readMarkdown(dobj)).toMatchObject({ markdown: expect.stringContaining("Alpha paragraph.") });
  });

  it("extends the same run across calls and feeds the agent's own reads", async () => {
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);
    await connect(dobj, h, { docId: DOC, alias: "alice" });

    const first = await propose(dobj, { action: "str_replace", find: "Alpha paragraph.", replace: "Alpha revised." });
    // The second find only exists in the PROJECTION if the first hunk is visible.
    const second = await propose(dobj, { action: "str_replace", find: "Bravo paragraph.", replace: "Bravo revised." });
    expect(runOf(second.json).id).toBe(runOf(first.json).id);
    expect(second.json.pending).toBe(2);
    expect(runOf(second.json).hunks.map((x) => x.id)).toEqual(["h1", "h2"]);

    const projected = await readMarkdown(dobj, "agent1");
    expect(projected.markdown).toContain("Alpha revised.");
    expect(projected.markdown).toContain("Bravo revised.");
    expect(projected.pending).toBe(2);
    expect(projected.run_id).toBe(runOf(first.json).id);

    // Humans (and other agents) still read the untouched document.
    expect(await readMarkdown(dobj)).toMatchObject({ markdown: expect.stringContaining("Alpha paragraph.") });
    expect(await readMarkdown(dobj, "agent2")).not.toHaveProperty("run_id");
  });

  it("reports the MCP occurrence semantics for a find that is missing or ambiguous", async () => {
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj, "# Notes\n\nSame line.\n\nSame line.\n");
    await connect(dobj, h, { docId: DOC, alias: "alice" });

    expect(await propose(dobj, { action: "str_replace", find: "nope", replace: "x" })).toMatchObject({
      status: 409,
      json: { error: "not_found" },
    });
    expect(await propose(dobj, { action: "str_replace", find: "Same line.", replace: "x" })).toMatchObject({
      status: 409,
      json: { error: "ambiguous", count: 2 },
    });
  });

  it("reports a no-op instead of opening an empty run", async () => {
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);
    await connect(dobj, h, { docId: DOC, alias: "alice" });
    const res = await propose(dobj, { action: "str_replace", find: "Alpha paragraph.", replace: "Alpha paragraph." });
    expect(res.json).toEqual({ mode: "noop" });
    expect(await listRuns(dobj)).toHaveLength(0);
  });
});

describe("propose under an `auto` rule", () => {
  it("applies immediately, notifies, and records the run as a receipt", async () => {
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);
    await connect(dobj, h, { docId: DOC, alias: "alice", agent: "claude", agentAuth: "1" });

    const { status, json } = await proposeAuto(dobj, {
      action: "str_replace",
      find: "Alpha paragraph.",
      replace: "Alpha revised.",
    });
    expect(status).toBe(200);
    expect(json.mode).toBe("auto_applied");

    expect(await readMarkdown(dobj)).toMatchObject({ markdown: expect.stringContaining("Alpha revised.") });

    const run = runOf(json);
    expect(run.auto_applied).toBe(true);
    expect(run.status).toBe("open"); // stays open so one session = one card
    expect(run.hunks[0]!.status).toBe("auto_applied");

    const notify = h.queued.find((m) => (m as { kind?: string }).kind === "notify");
    expect(notify).toMatchObject({
      kind: "notify",
      recipient: "alice",
      workspaceId: "ws1",
      eventType: "AGENT_EDITS_APPLIED",
      docId: DOC,
      title: "Notes",
      body: "Claude (Connector) edited this document — applied at once by policy",
      actor: "Claude (Connector)",
    });

    const runs = await listRuns(dobj);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.id).toBe(run.id);
  });

  it("leaves an earlier parked hunk alone, and joins it rather than landing past it", async () => {
    // The run is shared and so is the wait: while a hunk proposed under `review`
    // is undecided, later `auto` proposals queue behind it instead of landing,
    // and the human edit that invalidated the first one stands untouched.
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);
    await propose(dobj, { action: "str_replace", find: "Alpha paragraph.", replace: "Alpha revised." });
    await humanEdit(dobj, "Alpha paragraph.", "Rewritten by a human.");
    const dobj2 = makeActor(h);

    const res = await proposeAuto(dobj2, { action: "str_replace", find: "Bravo paragraph.", replace: "Bravo revised." });
    expect(res.json.mode).toBe("proposed");
    const run = runOf(res.json);
    expect(run.hunks.map((x) => x.status)).toEqual(["pending", "pending"]);
    const md = (await readMarkdown(dobj2)).markdown as string;
    expect(md).toContain("Rewritten by a human.");
    expect(md).not.toContain("Bravo revised.");
  });

  it("cannot launder an `auto` edit through text that only a PARKED hunk created", async () => {
    // The agent's own projection shows "Alpha revised." because its earlier
    // proposal is pending. Landing an edit to that text under `auto` would put a
    // document state no human approved into the document — half-applying the
    // parked change. So it parks instead, and the reviewer decides the chain as one.
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);
    const parked = await propose(dobj, { action: "str_replace", find: "Alpha paragraph.", replace: "Alpha revised." });
    expect(parked.json.mode).toBe("proposed");

    const res = await proposeAuto(dobj, { action: "str_replace", find: "Alpha revised.", replace: "Alpha revised twice." });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ mode: "proposed", parked_behind_pending: true });

    const md = (await readMarkdown(dobj)).markdown as string;
    expect(md).toContain("Alpha paragraph.");
    expect(md).not.toContain("Alpha revised");
    expect((await listRuns(dobj))[0]!.hunks.map((x) => x.status)).toEqual(["pending", "pending"]);
  });

  it("commits a whole-document write as one run", async () => {
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);
    const res = await proposeAuto(dobj, { action: "write", text: "# Rewritten\n\nOnly this paragraph now." });
    expect(res.json.mode).toBe("auto_applied");
    expect(runOf(res.json).hunks.every((x) => x.status === "auto_applied")).toBe(true);
    const md = (await readMarkdown(dobj)).markdown as string;
    expect(md).toContain("Only this paragraph now.");
    expect(md).not.toContain("Alpha paragraph.");
  });

  it("treats a write of the current body as a no-op and mints no ledger row", async () => {
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);
    const current = (await readMarkdown(dobj)).markdown as string;
    const res = await proposeAuto(dobj, { action: "write", text: current });
    expect(res.json).toEqual({ mode: "noop" });
    expect(await listRuns(dobj)).toHaveLength(0);
  });
});

describe("decisions", () => {
  it("accept applies the hunks, broadcasts the update, and reports RUN_DECIDED", async () => {
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);
    const reviewer = await connect(dobj, h, { docId: DOC, alias: "alice" });
    const proposed = await propose(dobj, { action: "str_replace", find: "Alpha paragraph.", replace: "Alpha revised." });
    const runId = runOf(proposed.json).id;

    const before = reviewer.frames().filter((f) => f.opcode === Opcode.UPDATE).length;
    const res = await post(dobj, "decide", { run_id: runId, decision: "accept", decided_by: "alice" });

    expect(res.json.applied).toBe(1);
    expect(res.json.conflicts).toBe(0);
    expect(await readMarkdown(dobj)).toMatchObject({ markdown: expect.stringContaining("Alpha revised.") });

    const run = runOf(res.json);
    expect(run.status).toBe("applied");
    expect(run.hunks[0]!.status).toBe("accepted");
    expect(run.seq_at_commit).toBeTypeOf("number");

    expect(reviewer.frames().filter((f) => f.opcode === Opcode.UPDATE).length).toBe(before + 1);
    const decided = payloads<RunDecidedPayload>(reviewer, Opcode.RUN_DECIDED);
    expect(decided).toHaveLength(1);
    expect(decided[0]).toMatchObject({ run_id: runId, decision: "accept", hunk_ids: ["h1"], decided_by: "alice" });

    // The agent's slot is released, so its next write opens a fresh run.
    const next = await propose(dobj, { action: "str_replace", find: "Bravo paragraph.", replace: "Bravo revised." });
    expect(runOf(next.json).id).not.toBe(runId);
  });

  it("accepts a single hunk and leaves the rest of the run open", async () => {
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);
    await connect(dobj, h, { docId: DOC, alias: "alice" });
    await propose(dobj, { action: "str_replace", find: "Alpha paragraph.", replace: "Alpha revised." });
    const both = await propose(dobj, { action: "str_replace", find: "Bravo paragraph.", replace: "Bravo revised." });
    const runId = runOf(both.json).id;

    const res = await post(dobj, "decide", {
      run_id: runId,
      decision: "accept",
      hunk_ids: ["h1"],
      decided_by: "alice",
    });
    const run = runOf(res.json);
    expect(run.status).toBe("open");
    expect(run.hunks.map((x) => x.status)).toEqual(["accepted", "pending"]);
    const md = (await readMarkdown(dobj)).markdown as string;
    expect(md).toContain("Alpha revised.");
    expect(md).toContain("Bravo paragraph.");
  });

  it("applies a later hunk accepted on its own to the paragraph it came from", async () => {
    // A reviewer decides hunks one at a time, in any order (one inline ghost's
    // Accept, or "Accept all" after rejecting an earlier hunk), so the server
    // applies a SINGLE hunk to the untouched document. computeStrEdits therefore
    // anchors every hunk in the baseline as well as in the working text: here the
    // second paragraph's edit ships with enough context to tell the two identical
    // "Alpha" paragraphs apart. The FIRST "Alpha" must never become "Gamma" —
    // whether that shows up as a rewrite of the wrong paragraph or (before the
    // hunks were baseline-anchored) as a spurious conflict on a perfectly valid
    // hunk, the reviewer was let down.
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj, "Alpha\n\nMid\n\nAlpha");
    await connect(dobj, h, { docId: DOC, alias: "alice" });
    const proposed = await propose(dobj, { action: "write", text: "Beta\n\nMid\n\nGamma" });
    const run = runOf(proposed.json);
    expect(run.hunks).toHaveLength(2);

    const res = await post(dobj, "decide", {
      run_id: run.id,
      decision: "accept",
      hunk_ids: [run.hunks[1]!.id],
      decided_by: "alice",
    });
    expect(res.json).toMatchObject({ applied: 1, conflicts: 0 });
    expect(runOf(res.json).hunks.map((x) => x.status)).toEqual(["pending", "accepted"]);
    expect(await readMarkdown(dobj)).toMatchObject({ markdown: "Alpha\n\nMid\n\nGamma" });
  });

  it("reject marks the hunks and leaves the document alone", async () => {
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);
    const reviewer = await connect(dobj, h, { docId: DOC, alias: "alice" });
    const proposed = await propose(dobj, { action: "str_replace", find: "Alpha paragraph.", replace: "Alpha revised." });

    const res = await post(dobj, "decide", { run_id: runOf(proposed.json).id, decision: "reject", decided_by: "alice" });
    const run = runOf(res.json);
    expect(run.status).toBe("rejected");
    expect(run.hunks[0]!.status).toBe("rejected");
    expect(res.json.applied).toBe(0);
    expect(await readMarkdown(dobj)).toMatchObject({ markdown: expect.stringContaining("Alpha paragraph.") });
    expect(payloads<RunDecidedPayload>(reviewer, Opcode.RUN_DECIDED)[0]!.decision).toBe("reject");
  });

  it("marks a hunk conflict when the human rewrote the same text first", async () => {
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);
    await connect(dobj, h, { docId: DOC, alias: "alice" });
    const proposed = await propose(dobj, { action: "str_replace", find: "Alpha paragraph.", replace: "Alpha revised." });

    await humanEdit(dobj, "Alpha paragraph.", "Something else entirely.");

    const res = await post(dobj, "decide", { run_id: runOf(proposed.json).id, decision: "accept", decided_by: "alice" });
    expect(res.json.applied).toBe(0);
    expect(res.json.conflicts).toBe(1);
    const run = runOf(res.json);
    expect(run.hunks[0]!.status).toBe("conflict");
    expect(run.status).toBe("rejected"); // nothing landed
    expect(await readMarkdown(dobj)).toMatchObject({ markdown: expect.stringContaining("Something else entirely.") });
  });

  it("keeps a hunk that needs an EARLIER one pending instead of destroying it", async () => {
    // An agent editing twice in one turn validates each call against `working`
    // (the document plus its own pending hunks), so h2 here quotes text only h1
    // produces: "Gamma paragraph." exists nowhere in the live document. Accepting
    // h2 alone therefore cannot apply — correct — but stamping it `conflict` used
    // to LOSE the agent's intent outright: the hunk left the pending set forever,
    // accepting h1 afterwards closed the run as "applied", and the document ended
    // on "Gamma paragraph." with "Delta" gone and nobody told.
    //
    // The review UI pointed straight at that click, too: the overlay cannot paint
    // a hunk whose old_string isn't in the document, so the change list rendered
    // h2 as "can't be shown inline — decide it here" with a working Accept button.
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);
    const reviewer = await connect(dobj, h, { docId: DOC, alias: "alice" });
    await propose(dobj, { action: "str_replace", find: "Alpha paragraph.", replace: "Gamma paragraph." });
    const chained = await propose(dobj, { action: "str_replace", find: "Gamma paragraph.", replace: "Delta paragraph." });
    const runId = runOf(chained.json).id;
    expect(runOf(chained.json).hunks.map((x) => x.old_string)).toEqual(["Alpha paragraph.", "Gamma paragraph."]);

    // Accept the dependent one FIRST — the click the change list invites.
    const early = await post(dobj, "decide", {
      run_id: runId,
      decision: "accept",
      hunk_ids: ["h2"],
      decided_by: "alice",
    });
    expect(early.json).toMatchObject({ applied: 0, conflicts: 0, blocked: 1 });
    expect(runOf(early.json).hunks.map((x) => x.status)).toEqual(["pending", "pending"]);
    expect(runOf(early.json).status).toBe("open");
    // Nothing was announced as decided, so no ghost disappears on the strength of it.
    expect(payloads<RunDecidedPayload>(reviewer, Opcode.RUN_DECIDED).flatMap((p) => p.hunk_ids)).toEqual([]);

    // Its predecessor lands, and the same click now succeeds.
    await post(dobj, "decide", { run_id: runId, decision: "accept", hunk_ids: ["h1"], decided_by: "alice" });
    const late = await post(dobj, "decide", {
      run_id: runId,
      decision: "accept",
      hunk_ids: ["h2"],
      decided_by: "alice",
    });
    expect(late.json).toMatchObject({ applied: 1, conflicts: 0, blocked: 0 });
    expect(runOf(late.json).hunks.map((x) => x.status)).toEqual(["accepted", "accepted"]);
    expect(runOf(late.json).status).toBe("applied");
    expect(await readMarkdown(dobj)).toMatchObject({
      markdown: expect.stringContaining("Delta paragraph."),
    });
  });

  it("still calls it a conflict when nothing pending could ever unblock it", async () => {
    // The other edge: "blocked" must not become a state a run can never leave.
    // With its predecessor REJECTED, h2's text will never exist, so the same
    // click is terminal and the run closes.
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);
    await connect(dobj, h, { docId: DOC, alias: "alice" });
    await propose(dobj, { action: "str_replace", find: "Alpha paragraph.", replace: "Gamma paragraph." });
    const chained = await propose(dobj, { action: "str_replace", find: "Gamma paragraph.", replace: "Delta paragraph." });
    const runId = runOf(chained.json).id;

    await post(dobj, "decide", { run_id: runId, decision: "reject", hunk_ids: ["h1"], decided_by: "alice" });
    const res = await post(dobj, "decide", { run_id: runId, decision: "accept", hunk_ids: ["h2"], decided_by: "alice" });
    expect(res.json).toMatchObject({ applied: 0, conflicts: 1, blocked: 0 });
    expect(runOf(res.json).hunks.map((x) => x.status)).toEqual(["rejected", "conflict"]);
    expect(runOf(res.json).status).not.toBe("open");
  });

  it("accepts a chained run whole, in one click", async () => {
    // "Accept all" replays the hunks in the order they were generated, so the
    // dependency resolves itself — nothing is ever blocked by a predecessor that
    // is part of the same decision.
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);
    await connect(dobj, h, { docId: DOC, alias: "alice" });
    await propose(dobj, { action: "str_replace", find: "Alpha paragraph.", replace: "Gamma paragraph." });
    const chained = await propose(dobj, { action: "str_replace", find: "Gamma paragraph.", replace: "Delta paragraph." });

    const res = await post(dobj, "decide", { run_id: runOf(chained.json).id, decision: "accept", decided_by: "alice" });
    expect(res.json).toMatchObject({ applied: 2, conflicts: 0, blocked: 0 });
    expect(await readMarkdown(dobj)).toMatchObject({
      markdown: expect.stringContaining("Delta paragraph."),
    });
  });
});

describe("who may decide a run", () => {
  // The run's reviewer is the accountable human — the agent proposed FOR them —
  // so deciding is narrower than writing. A colleague with full write access to
  // the document is NOT automatically entitled to accept, reject, revert or
  // dismiss another person's agent run: it launders the accountability the
  // ledger exists to record, and it yanks the ghosts out from under a review in
  // progress. The HTTP route vouches for the one exception (a doc owner or
  // workspace admin clearing a stuck run) with `manager_override`, because only
  // it can see the database that decides who manages the document.
  it("refuses a co-writer who is not the reviewer, and changes nothing", async () => {
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);
    const reviewer = await connect(dobj, h, { docId: DOC, alias: "alice" });
    const proposed = await propose(dobj, { action: "str_replace", find: "Alpha paragraph.", replace: "Alpha revised." });
    const runId = runOf(proposed.json).id;

    const res = await post(dobj, "decide", { run_id: runId, decision: "accept", decided_by: "bob" });
    expect(res.status).toBe(403);
    expect(res.json).toMatchObject({ error: "not_reviewer" });

    // The document is untouched, the hunk is still awaiting Alice, and nothing
    // told her a decision had been made on her behalf.
    expect(await readMarkdown(dobj)).toMatchObject({ markdown: expect.stringContaining("Alpha paragraph.") });
    const run = (await listRuns(dobj))[0]!;
    expect(run.status).toBe("open");
    expect(run.hunks[0]!.status).toBe("pending");
    expect(payloads<RunDecidedPayload>(reviewer, Opcode.RUN_DECIDED)).toHaveLength(0);
  });

  it("refuses a reject from a non-reviewer too (a refusal is a decision)", async () => {
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);
    await connect(dobj, h, { docId: DOC, alias: "alice" });
    const proposed = await propose(dobj, { action: "str_replace", find: "Alpha paragraph.", replace: "Alpha revised." });

    const res = await post(dobj, "decide", { run_id: runOf(proposed.json).id, decision: "reject", decided_by: "bob" });
    expect(res.status).toBe(403);
    expect((await listRuns(dobj))[0]!.hunks[0]!.status).toBe("pending");
  });

  it("fails closed when the caller is not identified at all", async () => {
    // This is the shape of the hole: were `decided_by` defaulted to "unknown"
    // and let through, any caller that simply omitted the field would decide
    // everyone's runs.
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);
    await connect(dobj, h, { docId: DOC, alias: "alice" });
    const proposed = await propose(dobj, { action: "str_replace", find: "Alpha paragraph.", replace: "Alpha revised." });
    const runId = runOf(proposed.json).id;

    expect((await post(dobj, "decide", { run_id: runId, decision: "accept" })).status).toBe(403);
    expect((await post(dobj, "revert", { run_id: runId })).status).toBe(403);
    expect((await post(dobj, "ack", { run_id: runId })).status).toBe(403);
    expect((await listRuns(dobj))[0]!.hunks[0]!.status).toBe("pending");
  });

  it("lets a vouched-for document manager clear a run its reviewer never will", async () => {
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);
    await connect(dobj, h, { docId: DOC, alias: "alice" });
    const proposed = await propose(dobj, { action: "str_replace", find: "Alpha paragraph.", replace: "Alpha revised." });

    const res = await post(dobj, "decide", {
      run_id: runOf(proposed.json).id,
      decision: "accept",
      decided_by: "carol",
      manager_override: true,
    });
    expect(res.status).toBe(200);
    expect(res.json.applied).toBe(1);
    // Credit follows the person who actually decided, not the run's reviewer.
    expect(runOf(res.json).hunks[0]!.status).toBe("accepted");
  });

  it("refuses a revert from a non-reviewer, leaving the applied edit in place", async () => {
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);
    const applied = await proposeAuto(dobj, { action: "str_replace", find: "Alpha paragraph.", replace: "Alpha revised." });
    const runId = runOf(applied.json).id;

    const res = await post(dobj, "revert", { run_id: runId, requested_by: "bob" });
    expect(res.status).toBe(403);
    expect(await readMarkdown(dobj)).toMatchObject({ markdown: expect.stringContaining("Alpha revised.") });
    expect((await listRuns(dobj))[0]!.status).toBe("open");

    // …and the reviewer herself still can.
    expect((await post(dobj, "revert", { run_id: runId, requested_by: "alice" })).status).toBe(200);
  });

  it("refuses a dismiss from a non-reviewer (their unread marker is theirs)", async () => {
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);
    const applied = await propose(dobj, { action: "str_replace", find: "Alpha paragraph.", replace: "Alpha revised." });
    const runId = runOf(applied.json).id;

    expect((await post(dobj, "ack", { run_id: runId, acked_by: "bob" })).status).toBe(403);
    expect((await listRuns(dobj))[0]!.acknowledged).toBe(false);
    expect((await post(dobj, "ack", { run_id: runId, acked_by: "alice" })).status).toBe(200);
    expect((await listRuns(dobj))[0]!.acknowledged).toBe(true);
  });

  it("checks the gate before reading the run body, so a refusal costs no blob read", async () => {
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);
    await connect(dobj, h, { docId: DOC, alias: "alice" });
    const proposed = await propose(dobj, { action: "str_replace", find: "Alpha paragraph.", replace: "Alpha revised." });
    const runId = runOf(proposed.json).id;
    const stored = (await h.state.storage.get<StoredRun>(runStorageKey(runId)))!;

    // A missing body would answer 503 ("try again"); the gate answers first,
    // because "you may not" is true regardless of whether the text loads.
    h.snapshots.objects.delete(stored.blob_key);
    const revived = makeActor(h);
    expect((await post(revived, "decide", { run_id: runId, decision: "accept", decided_by: "bob" })).status).toBe(403);
  });
});

describe("revert", () => {
  it("unwinds an auto-applied run and marks it expired", async () => {
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);
    const applied = await proposeAuto(dobj, { action: "str_replace", find: "Alpha paragraph.", replace: "Alpha revised." });
    const runId = runOf(applied.json).id;

    const res = await post(dobj, "revert", { run_id: runId, requested_by: "alice" });
    expect(res.status).toBe(200);
    expect(runOf(res.json).status).toBe("expired");
    expect(runOf(res.json).reverted).toBe(true);
    expect(await readMarkdown(dobj)).toMatchObject({ markdown: expect.stringContaining("Alpha paragraph.") });

    const again = await post(dobj, "revert", { run_id: runId, requested_by: "alice" });
    expect(again.status).toBe(409);
    expect(again.json).toMatchObject({ error: "already_reverted" });
  });

  it("refuses (409) when the inverse edits are ambiguous rather than transposing text", async () => {
    // Two hunks that produced the SAME new_string make the reversed inverse list
    // ambiguous: first-match would put each original back in the OTHER's place
    // and report a clean revert.
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj, "X\n\nMid\n\nZ");
    const applied = await proposeAuto(dobj, { action: "write", text: "Y\n\nMid\n\nY" });
    expect(applied.json.mode).toBe("auto_applied");

    const res = await post(dobj, "revert", { run_id: runOf(applied.json).id, requested_by: "alice" });
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ error: "conflict" });
    expect(await readMarkdown(dobj)).toMatchObject({ markdown: "Y\n\nMid\n\nY" });
  });

  it("rejects the hunks still pending on the run it reverts, instead of stranding them", async () => {
    // A run under an `auto` rule stays open, so the same run can hold auto-applied
    // hunks (the catch-up card) AND hunks parked under `review`. Revert makes the
    // run terminal, so anything left pending would be undecidable.
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);
    const landed = await proposeAuto(dobj, { action: "str_replace", find: "Alpha paragraph.", replace: "Alpha revised." });
    const runId = runOf(landed.json).id;
    // A later proposal under `review` joins the SAME open run and stays pending.
    await connect(dobj, h, { docId: DOC, alias: "alice" });
    const live = await propose(dobj, { action: "str_replace", find: "Bravo paragraph.", replace: "Bravo revised." });
    expect(runOf(live.json).id).toBe(runId);

    const res = await post(dobj, "revert", { run_id: runId, requested_by: "alice" });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ reverted: 1, rejected: 1 });
    const run = runOf(res.json);
    expect(run.status).toBe("expired");
    expect(run.hunks.map((x) => x.status)).toEqual(["auto_applied", "rejected"]);
    expect(await readMarkdown(dobj)).toMatchObject({ markdown: expect.stringContaining("Alpha paragraph.") });
    // The agent's projection no longer claims work is pending.
    expect(await readMarkdown(dobj, "agent1")).not.toHaveProperty("run_id");
  });

  it("refuses (409, all-or-nothing) when the document moved on", async () => {
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);
    const applied = await proposeAuto(dobj, { action: "str_replace", find: "Alpha paragraph.", replace: "Alpha revised." });
    await humanEdit(dobj, "Alpha revised.", "Human took it from here.");

    const res = await post(dobj, "revert", { run_id: runOf(applied.json).id, requested_by: "alice" });
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ error: "conflict" });
    expect(await readMarkdown(dobj)).toMatchObject({ markdown: expect.stringContaining("Human took it from here.") });
  });
});

describe("ack, close and reconnect replay", () => {
  it("acknowledges a catch-up card", async () => {
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);
    const applied = await proposeAuto(dobj, { action: "str_replace", find: "Alpha paragraph.", replace: "Alpha revised." });
    expect(await post(dobj, "ack", { run_id: runOf(applied.json).id, acked_by: "alice" })).toMatchObject({
      json: { ok: true },
    });
    expect((await listRuns(dobj))[0]!.acknowledged).toBe(true);
  });

  it("replays outstanding runs to a reviewer who reconnects", async () => {
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);
    // Landed under an `auto` rule, never acknowledged.
    await proposeAuto(dobj, { action: "str_replace", find: "Alpha paragraph.", replace: "Alpha revised." });

    const reviewer = await connect(dobj, h, { docId: DOC, alias: "alice" });
    await sendFrame(dobj, reviewer, encodeBinary(Opcode.SYNC_STEP_1, Y.encodeStateVector(new Y.Doc())));
    const seen = payloads<RunUpdatedPayload>(reviewer, Opcode.RUN_UPDATED);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.run.auto_applied).toBe(true);

    // Agents get no run frames on their handshake.
    const agentWs = await connect(dobj, h, { docId: DOC, alias: "alice", agent: "claude", agentAuth: "1" });
    await sendFrame(dobj, agentWs, encodeBinary(Opcode.SYNC_STEP_1, Y.encodeStateVector(new Y.Doc())));
    expect(agentWs.has(Opcode.RUN_UPDATED)).toBe(false);
  });
});

describe("nothing lands a parked hunk but a person", () => {
  it("a reviewer who leaves and never returns still has their hunks waiting", async () => {
    // Walking away is not consent.
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);
    const reviewer = await connect(dobj, h, { docId: DOC, alias: "alice" });
    const proposed = await propose(dobj, { action: "str_replace", find: "Alpha paragraph.", replace: "Alpha revised." });

    reviewer.close();
    await dobj.webSocketClose(reviewer, 1000, "", true);
    // No deadline exists to fast-forward: the only alarm is the flush backstop.
    await dobj.alarm();
    // …and again, from a cold instance, in case anything durable was left behind.
    await makeActor(h).alarm();

    expect(await readMarkdown(dobj)).toMatchObject({ markdown: expect.stringContaining("Alpha paragraph.") });
    const run = (await listRuns(dobj))[0]!;
    expect(run.id).toBe(runOf(proposed.json).id);
    expect(run.status).toBe("open");
    expect(run.auto_applied).toBe(false);
    expect(run.hunks[0]!.status).toBe("pending");
  });

  it("a locked document refuses new proposals and keeps the parked ones decidable", async () => {
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);
    await connect(dobj, h, { docId: DOC, alias: "alice" });
    await propose(dobj, { action: "str_replace", find: "Alpha paragraph.", replace: "Alpha revised." });

    await dobj.fetch(new Request(`http://actor/set-locked?docId=${DOC}&locked=1`, { method: "POST" }));
    await dobj.alarm();

    expect(await readMarkdown(dobj)).toMatchObject({ markdown: expect.stringContaining("Alpha paragraph.") });
    const run = (await listRuns(dobj))[0]!;
    expect(run.status).toBe("open");
    expect(run.hunks[0]!.status).toBe("pending"); // still theirs to decide once unlocked
    expect((await propose(dobj, { action: "str_replace", find: "Bravo paragraph.", replace: "x" })).status).toBe(423);
    // An `auto` rule does not route around a lock either.
    expect((await proposeAuto(dobj, { action: "str_replace", find: "Bravo paragraph.", replace: "x" })).status).toBe(423);
  });

  it("a chatty agent cannot bury a parked hunk: the run keeps it and the inbox sees it", async () => {
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj, "# Notes\n\nOne.\n\nTwo.\n\nThree.\n");
    const first = await propose(dobj, { action: "str_replace", find: "One.", replace: "One!" });
    await propose(dobj, { action: "str_replace", find: "Two.", replace: "Two!" });
    const third = await propose(dobj, { action: "str_replace", find: "Three.", replace: "Three!" });

    expect(runOf(third.json).id).toBe(runOf(first.json).id);
    expect(runOf(third.json).hunks.map((x) => x.status)).toEqual(["pending", "pending", "pending"]);
    expect((await readMarkdown(dobj)).markdown).toContain("One.");
    // One notification for the session, not one per proposal (hour-bucketed
    // dedupe lives in the job worker; the actor's job is to keep enqueuing).
    expect(h.queued.filter((m) => (m as { kind?: string }).kind === "notify")).toHaveLength(3);
  });
});

describe("idle rollover", () => {
  /** Rewind a run's last-touched time so the idle window has elapsed. */
  async function ageRun(h: Harness, runId: string): Promise<void> {
    const stored = (await h.state.storage.get<StoredRun>(runStorageKey(runId)))!;
    stored.updated_at = Date.now() - RUN_IDLE_MS - 1;
    await h.state.storage.put(runStorageKey(runId), stored);
  }

  it("an agent READ never closes the run it is reading its own edits out of", async () => {
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);
    await connect(dobj, h, { docId: DOC, alias: "alice" });
    const proposed = await propose(dobj, { action: "str_replace", find: "Alpha paragraph.", replace: "Alpha revised." });
    const runId = runOf(proposed.json).id;
    await ageRun(h, runId);

    // The reviewer is simply taking their time; the agent polls its projection.
    const projected = await readMarkdown(dobj, "agent1");
    expect(projected.run_id).toBe(runId);
    expect(projected.pending).toBe(1);
    expect((await listRuns(dobj))[0]).toMatchObject({ id: runId, status: "open" });
  });

  it("keeps an idle run open on propose while its hunks are still undecided", async () => {
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);
    await connect(dobj, h, { docId: DOC, alias: "alice" });
    const first = await propose(dobj, { action: "str_replace", find: "Alpha paragraph.", replace: "Alpha revised." });
    await ageRun(h, runOf(first.json).id);

    const second = await propose(dobj, { action: "str_replace", find: "Bravo paragraph.", replace: "Bravo revised." });
    // Same run, both hunks still awaiting the reviewer — nothing was stamped
    // "rejected" behind their back.
    expect(runOf(second.json).id).toBe(runOf(first.json).id);
    expect(runOf(second.json).hunks.map((x) => x.status)).toEqual(["pending", "pending"]);
  });

  it("rolls a settled idle run over on the next propose", async () => {
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);
    // An `auto` rule lands the hunk, so nothing is left to decide.
    const first = await proposeAuto(dobj, { action: "str_replace", find: "Alpha paragraph.", replace: "Alpha revised." });
    await ageRun(h, runOf(first.json).id);

    const second = await proposeAuto(dobj, { action: "str_replace", find: "Bravo paragraph.", replace: "Bravo revised." });
    expect(runOf(second.json).id).not.toBe(runOf(first.json).id);
    const runs = await listRuns(dobj);
    expect(runs.find((r) => r.id === runOf(first.json).id)!.status).toBe("applied");
  });
});

describe("a run whose blob body is unreadable", () => {
  /** Lose the run's blob on a fresh instance (empty in-memory mirror). */
  async function loseBody(h: Harness, runId: string): Promise<DocActor> {
    const stored = (await h.state.storage.get<StoredRun>(runStorageKey(runId)))!;
    h.snapshots.objects.delete(stored.blob_key);
    return makeActor(h);
  }

  it("refuses to decide or dismiss it, and never writes the empty body back", async () => {
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);
    await connect(dobj, h, { docId: DOC, alias: "alice" });
    const proposed = await propose(dobj, { action: "str_replace", find: "Alpha paragraph.", replace: "Alpha revised." });
    const runId = runOf(proposed.json).id;

    const revived = await loseBody(h, runId);
    // A dismiss click is the cheapest path to destruction: saving the degraded
    // body unconditionally here would wipe the run.
    expect((await post(revived, "ack", { run_id: runId, acked_by: "alice" })).status).toBe(503);
    expect((await post(revived, "decide", { run_id: runId, decision: "accept", decided_by: "alice" })).status).toBe(503);
    expect((await post(revived, "revert", { run_id: runId, requested_by: "alice" })).status).toBe(503);

    // The actor-storage mirror still knows the run's real shape…
    const stored = (await h.state.storage.get<StoredRun>(runStorageKey(runId)))!;
    expect(stored.hunk_meta).toHaveLength(1);
    expect(stored.status).toBe("open");
    // …and the summary says "can't itemize", not "nothing here".
    expect((await listRuns(revived))[0]).toMatchObject({ id: runId, hunks_truncated: true });
  });

  it("recovers as soon as the blob store answers again (the degraded body is not cached)", async () => {
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);
    await connect(dobj, h, { docId: DOC, alias: "alice" });
    const proposed = await propose(dobj, { action: "str_replace", find: "Alpha paragraph.", replace: "Alpha revised." });
    const runId = runOf(proposed.json).id;
    const stored = (await h.state.storage.get<StoredRun>(runStorageKey(runId)))!;
    const bytes = h.snapshots.bytesOf(stored.blob_key)!;

    const revived = await loseBody(h, runId);
    expect((await post(revived, "ack", { run_id: runId, acked_by: "alice" })).status).toBe(503);

    await h.snapshots.put(stored.blob_key, bytes); // the blip passes
    const res = await post(revived, "decide", { run_id: runId, decision: "accept", decided_by: "alice" });
    expect(res.status).toBe(200);
    expect(res.json.applied).toBe(1);
  });
});

describe("the flush alarm", () => {
  // The alarm slot has ONE purpose now: the index-flush backstop. The review
  // ledger schedules nothing, because a parked hunk has no deadline to reach.
  it("a fully-drained flush clears the alarm — nothing else is waiting on it", async () => {
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj); // leaves the object dirty with a flush alarm armed

    await dobj.alarm();

    expect(h.state.storage.map.has("pending")).toBe(false);
    expect(h.state.storage.alarm).toBeNull();
  });

  it("arms the flush backstop while dirty and never pushes an existing one later", async () => {
    const h = harness();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = (makeActor(h) as any).store;
    store.docId = DOC;
    store.dirty = true;

    await store.armAlarms();
    const flushAt = h.state.storage.alarm!;
    expect(flushAt).toBeGreaterThan(Date.now() + 25_000);

    // An alarm already set SOONER is left where it is.
    const sooner = Date.now() + 5_000;
    await h.state.storage.setAlarm(sooner);
    await store.armAlarms();
    expect(h.state.storage.alarm).toBe(sooner);
  });

  it("arms nothing when there is nothing to flush", async () => {
    const h = harness();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = (makeActor(h) as any).store;
    store.docId = DOC;
    store.dirty = false;
    await store.armAlarms();
    expect(h.state.storage.alarm).toBeNull();
  });

  it("keeps the no-docId self-wake guard: schedules nothing and heals the slot", async () => {
    const h = harness();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = (makeActor(h) as any).store;
    store.docId = "";
    store.dirty = true;
    await h.state.storage.setAlarm(Date.now() + 1_000);

    await store.armAlarms();

    expect(h.state.storage.alarm).toBeNull();
  });

  it("a proposal parks without arming anything at all", async () => {
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);
    await dobj.alarm(); // drain the seed's flush so the slot starts clear
    expect(h.state.storage.alarm).toBeNull();

    await propose(dobj, { action: "str_replace", find: "Alpha paragraph.", replace: "Alpha revised." });
    expect(h.state.storage.alarm).toBeNull();
  });
});

describe("agent direct writes", () => {
  it("refuses a raw UPDATE frame from an agent with approval_required", async () => {
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);
    const agentWs = await connect(dobj, h, { docId: DOC, alias: "alice", agent: "claude", agentAuth: "1" });

    const client = new Y.Doc();
    const p = new Y.XmlElement("paragraph");
    p.insert(0, [new Y.XmlText("agent wrote this directly")]);
    client.getXmlFragment("default").insert(0, [p]);
    await sendFrame(dobj, agentWs, encodeBinary(Opcode.UPDATE, Y.encodeStateAsUpdate(client)));

    const rejected = payloads<{ kind: string; message: string }>(agentWs, Opcode.WRITE_REJECTED);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.kind).toBe("approval_required");
    expect(rejected[0]!.message).toBe(
      "Agent edits must use the propose API; direct document writes from agents are disabled.",
    );
    expect(agentWs.has(Opcode.UPDATE_ACK)).toBe(false);
    expect(await readMarkdown(dobj)).toMatchObject({ markdown: expect.not.stringContaining("agent wrote this") });
  });

  it("refuses an agent's SYNC_STEP_2 too, so the gate can't be relabelled around", async () => {
    // SYNC_STEP_2 is the client half of the handshake, but it is still a write:
    // it carries whatever the client has that the server doesn't. Exempting it
    // would make the whole review gate bypassable by changing one opcode byte.
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);
    const agentWs = await connect(dobj, h, { docId: DOC, alias: "alice", agent: "claude", agentAuth: "1" });

    const replica = new Y.Doc();
    const p = new Y.XmlElement("paragraph");
    p.insert(0, [new Y.XmlText("smuggled through the handshake")]);
    replica.getXmlFragment("default").insert(0, [p]);
    await sendFrame(dobj, agentWs, encodeBinary(Opcode.SYNC_STEP_2, Y.encodeStateAsUpdate(replica)));

    expect(payloads<{ kind: string }>(agentWs, Opcode.WRITE_REJECTED)[0]!.kind).toBe("approval_required");
    expect(await readMarkdown(dobj)).toMatchObject({ markdown: expect.not.stringContaining("smuggled") });
  });

  it("still lets an agent socket RECEIVE the document (read replicas keep working)", async () => {
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);
    const agentWs = await connect(dobj, h, { docId: DOC, alias: "alice", agent: "claude", agentAuth: "1" });

    // Server → client sync is untouched: the agent asks with its state vector and
    // gets the document back.
    await sendFrame(dobj, agentWs, encodeBinary(Opcode.SYNC_STEP_1, Y.encodeStateVector(new Y.Doc())));
    const replica = new Y.Doc();
    Y.applyUpdate(replica, agentWs.frames().filter((f) => f.opcode === Opcode.SYNC_STEP_2).at(-1)!.payload);
    expect(replica.getXmlFragment("default").toString()).toContain("Alpha paragraph");
    expect(agentWs.has(Opcode.SYNC_DONE)).toBe(true);
    expect(agentWs.has(Opcode.WRITE_REJECTED)).toBe(false);
  });

  it("a self-declared agent label does not hide a human from the reviewer check", async () => {
    // The `?agent=` connect param is a cosmetic label a human token can set too.
    // If presence keyed on it, a reviewer could make themselves invisible and
    // every proposal would auto-apply unreviewed.
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);
    const reviewer = await connect(dobj, h, { docId: DOC, alias: "alice", agent: "pretending" });

    const res = await propose(dobj, { action: "str_replace", find: "Alpha paragraph.", replace: "Alpha revised." });
    expect(res.json.mode).toBe("proposed");
    expect(await readMarkdown(dobj)).toMatchObject({ markdown: expect.stringContaining("Alpha paragraph.") });
    // …and a human socket may still write raw Yjs, label or no label.
    expect(reviewer.has(Opcode.WRITE_REJECTED)).toBe(false);
  });

  it("still refuses a human viewer's write with the ACL reason", async () => {
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);
    const viewer = await connect(dobj, h, { docId: DOC, alias: "bob", write: "0" });
    await sendFrame(dobj, viewer, encodeBinary(Opcode.UPDATE, Y.encodeStateAsUpdate(new Y.Doc())));
    expect(payloads<{ kind: string }>(viewer, Opcode.WRITE_REJECTED)[0]!.kind).toBe("acl");
  });
});

describe("ledger retention", () => {
  /** Accept every hunk in a run, so it is history rather than outstanding work. */
  async function decide(dobj: DocActor, runId: string): Promise<void> {
    await dobj.fetch(
      new Request(`http://actor/runs/decide?docId=${DOC}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ run_id: runId, decision: "accept", decided_by: "alice" }),
      }),
    );
  }

  it(`reclaims DECIDED runs past ${RUN_ORDER_MAX}, metadata and blob body together`, async () => {
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);

    // Every run is decided as it is made, so the ledger is pure history and the
    // cap may reclaim freely.
    const ids: string[] = [];
    for (let i = 0; i < RUN_ORDER_MAX + 1; i++) {
      const res = await propose(dobj, {
        action: "str_replace",
        find: i === 0 ? "Alpha paragraph." : `Alpha ${i - 1}.`,
        replace: `Alpha ${i}.`,
        agent_alias: `agent${i}`,
      });
      const id = runOf(res.json).id;
      ids.push(id);
      await decide(dobj, id);
    }

    const order = h.state.storage.map.get(RUN_ORDER_KEY) as string[];
    expect(order).toHaveLength(RUN_ORDER_MAX);
    expect(order).not.toContain(ids[0]);
    expect(h.state.storage.map.has(runStorageKey(ids[0]!))).toBe(false);
    expect([...h.snapshots.objects.keys()].some((k) => k.includes(ids[0]!))).toBe(false);
    // …and the survivor next to it is intact, body and all.
    const survivor = (await h.state.storage.get<StoredRun>(runStorageKey(ids[1]!)))!;
    expect(h.snapshots.objects.has(survivor.blob_key)).toBe(true);
  });

  it("never reclaims a run whose hunks are still awaiting a decision", async () => {
    // The promise the ledger exists to keep: a proposal waits for a person
    // however long that takes. Retention may bound HISTORY; it may not spend
    // somebody's undecided work to do it. Here the OLDEST run is the pending one
    // — exactly the entry a positional cap eats first.
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);

    const waiting = runOf(
      (await propose(dobj, { action: "str_replace", find: "Alpha paragraph.", replace: "Alpha, revised.", agent_alias: "patient" })).json,
    ).id;

    // Fill the ledger past the cap with decided runs, chaining each edit onto the
    // last so every `find` still matches once the previous one has landed.
    for (let i = 0; i < RUN_ORDER_MAX + 2; i++) {
      const res = await propose(dobj, {
        action: "str_replace",
        find: i === 0 ? "Bravo paragraph." : `Bravo ${i - 1}.`,
        replace: `Bravo ${i}.`,
        agent_alias: `agent${i}`,
      });
      await decide(dobj, runOf(res.json).id);
    }

    const order = h.state.storage.map.get(RUN_ORDER_KEY) as string[];
    expect(order.length).toBeLessThanOrEqual(RUN_ORDER_MAX);
    // Decided history was reclaimed to stay under the cap...
    expect(order.length).toBeGreaterThan(1);
    // ...and the undecided run is still here, oldest of them all, body and all.
    expect(order).toContain(waiting);
    const first = (await h.state.storage.get<StoredRun>(runStorageKey(waiting)))!;
    expect(first.hunk_meta.some((m) => m.status === "pending")).toBe(true);
    expect(h.snapshots.objects.has(first.blob_key)).toBe(true);
  });

  it("refuses a NEW proposal once the review backlog is full, and says so", async () => {
    // Backpressure is what replaces deletion: the agent is told, and can report
    // it, instead of a silent drop nobody sees.
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);

    for (let i = 0; i < PENDING_RUN_MAX; i++) {
      await propose(dobj, {
        action: "str_replace",
        find: "Alpha paragraph.",
        replace: `Alpha ${i}.`,
        agent_alias: `agent${i}`,
      });
    }
    const res = await propose(dobj, {
      action: "str_replace",
      find: "Alpha paragraph.",
      replace: "one too many",
      agent_alias: "agent-latecomer",
    });
    expect(res.status).toBe(429);
    expect(res.json.error).toBe("review_backlog");
    expect(String(res.json.message)).toMatch(/waiting for review/);

    // Deciding one frees exactly one slot. The follow-up appends rather than
    // replaces, so it does not depend on text the accepted run just rewrote.
    const order = h.state.storage.map.get(RUN_ORDER_KEY) as string[];
    await decide(dobj, order[0]!);
    const after = await propose(dobj, {
      action: "append",
      text: "Now there is room.",
      agent_alias: "agent-latecomer",
    });
    expect(after.status).toBe(200);
  });

  it("lets an agent keep working in a run it already has open at the ceiling", async () => {
    // The ceiling counts RUNS, so adding a hunk to an open one moves nothing —
    // refusing there would strand an agent mid-session for no gain.
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);

    for (let i = 0; i < PENDING_RUN_MAX; i++) {
      await propose(dobj, {
        action: "str_replace",
        find: "Alpha paragraph.",
        replace: `Alpha ${i}.`,
        agent_alias: `agent${i}`,
      });
    }
    const again = await propose(dobj, {
      action: "str_replace",
      find: "Alpha 0.",
      replace: "Alpha 0 revised.",
      agent_alias: "agent0",
    });
    expect(again.status).toBe(200);
  });

  it("bounds a list call: default window, explicit limit, and a clamp on both ends", async () => {
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);

    const ids: string[] = [];
    for (let i = 0; i < RUN_LIST_DEFAULT_LIMIT + 5; i++) {
      const res = await propose(dobj, {
        action: "str_replace",
        find: "Alpha paragraph.",
        replace: `Alpha ${i}.`,
        agent_alias: `agent${i}`,
      });
      ids.push(runOf(res.json).id);
    }

    // No limit → the default window, and it's the NEWEST runs that make the cut.
    const byDefault = await listRuns(dobj);
    expect(byDefault).toHaveLength(RUN_LIST_DEFAULT_LIMIT);
    expect(byDefault.map((r) => r.id)).toContain(ids.at(-1));
    expect(byDefault.map((r) => r.id)).not.toContain(ids[0]);

    expect(await listRuns(dobj, 3)).toHaveLength(3);
    // Nonsense and out-of-range values fall back / clamp rather than erroring.
    expect(await listRuns(dobj, 0)).toHaveLength(1);
    expect(await listRuns(dobj, 999)).toHaveLength(ids.length);
  });
});


describe("propose normalizes block-tearing agent edits", () => {
  // A find that covers a table row
  // PLUS the head of the following blockquote, with replace: "". Stored
  // verbatim, that hunk's net change restructures the whole table (the orphaned
  // blockquote tail merges into it), so the inline overlay could never paint it
  // and accepting it tore the blockquote apart.
  const TABLE_MD = [
    "Alpha paragraph.",
    "",
    "| A | B |",
    "| --- | --- |",
    "| one | two |",
    "| three | four |",
    "",
    "> **Rule:** keep it simple.",
    "",
  ].join("\n");

  it("re-diffs a mid-block find into line-aligned hunks instead of storing it verbatim", async () => {
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj, TABLE_MD);
    const canonical = (await readMarkdown(dobj)).markdown as string;
    await connect(dobj, h, { docId: DOC, alias: "alice" });

    const find = "| three | four |\n\n> **Rule:**";
    const res = await propose(dobj, { action: "str_replace", find, replace: "" });
    expect(res.status).toBe(200);
    const hunks = runOf(res.json).hunks;
    // Never the raw find: a stored old_string that stops mid-line would delete
    // the head of the blockquote when accepted.
    expect(hunks.some((x) => x.old_string === find)).toBe(false);
    expect(hunks.some((x) => x.old_string.endsWith("**Rule:**"))).toBe(false);
    // The normalized hunks still add up to the SAME net change the agent asked
    // for (canonicalized), so nothing about the edit's meaning was lost.
    const applied = applyStrEditsStrict(
      canonical,
      hunks.map((x) => ({ old_string: x.old_string, new_string: x.new_string })),
    );
    expect(applied.conflicts).toEqual([]);
    const target = docToMarkdown(markdownToDoc(canonical.replace(find, ""), getStugaSchema()));
    expect(applied.markdown).toBe(target);
  });

  it("keeps a single-line reword verbatim (the agent's own phrasing)", async () => {
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj, TABLE_MD);
    await connect(dobj, h, { docId: DOC, alias: "alice" });

    const res = await propose(dobj, { action: "str_replace", find: "keep it simple", replace: "keep it very simple" });
    expect(runOf(res.json).hunks).toHaveLength(1);
    expect(runOf(res.json).hunks[0]).toMatchObject({
      old_string: "keep it simple",
      new_string: "keep it very simple",
    });
  });

  it("diffs a whole-doc write into per-block hunks even when the text is not serializer-canonical", async () => {
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj, TABLE_MD);
    const canonical = (await readMarkdown(dobj)).markdown as string;
    await connect(dobj, h, { docId: DOC, alias: "alice" });

    // Same document with one paragraph reworded, but spelled non-canonically
    // (extra blank lines + trailing spaces). Diffing against the RAW text used
    // to fail computeStrEdits' byte-for-byte round-trip check and collapse the
    // whole write into a single document-sized hunk.
    const text = canonical.replace("Alpha paragraph.", "Alpha rewritten.  ") + "\n\n\n";
    const res = await propose(dobj, { action: "write", text });
    const hunks = runOf(res.json).hunks;
    expect(hunks.length).toBeGreaterThanOrEqual(1);
    // Per-block, not the whole document in one hunk.
    for (const x of hunks) expect(x.old_string.length).toBeLessThan(canonical.length / 2);
    expect(hunks.some((x) => x.new_string.includes("Alpha rewritten."))).toBe(true);
  });
});

describe("propose edge cases", () => {
  it("keeps $-patterns in a multi-line replace literal (split/join, not String.replace)", async () => {
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);
    // Under an `auto` rule the edit commits, so the mangling would land in the DOC.
    const res = await proposeAuto(dobj, {
      action: "str_replace",
      find: "Alpha paragraph.\n\nBravo paragraph.",
      replace: "Cost is $$50 and the match was $& — literally.",
    });
    expect(res.status).toBe(200);
    const md = (await readMarkdown(dobj)).markdown as string;
    // String.replace would have halved "$$" to "$" and expanded "$&" to the find.
    expect(md).toContain("$$50");
    expect(md).toContain("$& — literally.");
  });

  it("routes a FULL-LINE single-line deletion through the diff (blank line would split the table)", async () => {
    const h = harness();
    const dobj = makeActor(h);
    const TABLE = "| A | B |\n| --- | --- |\n| one | two |\n| three | four |\n";
    await seed(dobj, TABLE);
    await connect(dobj, h, { docId: DOC, alias: "alice" });
    // No "\n" in the find, unique — the verbatim gate's OLD conditions all hold.
    // But deleting the whole line leaves a blank line INSIDE the table, so the
    // result is not canonical and the edit must be re-diffed, not kept verbatim.
    const res = await propose(dobj, { action: "str_replace", find: "| one | two |", replace: "" });
    expect(res.status).toBe(200);
    const hunks = runOf(res.json).hunks;
    expect(hunks.some((x) => x.old_string === "| one | two |" && x.new_string === "")).toBe(false);
  });

  it("refuses to revert a landed deletion instead of appending the text to the end", async () => {
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);
    // An `auto` rule lands it as a normalized deletion hunk {old: "…\n\n", new: ""}.
    const res = await proposeAuto(dobj, { action: "str_replace", find: "# Notes\n\nAlpha paragraph.", replace: "# Notes" });
    expect(res.status).toBe(200);
    const afterPropose = (await readMarkdown(dobj)).markdown as string;
    expect(afterPropose).not.toContain("Alpha paragraph.");

    const runId = runOf(res.json).id;
    const revert = await post(dobj, "revert", { run_id: runId, requested_by: "alice" });
    // The inverse of a deletion has an empty old_string — append semantics — so
    // the revert must refuse toward version history, not glue "Alpha paragraph."
    // onto the end of the document and report success.
    expect(revert.status).toBe(409);
    const afterRevert = (await readMarkdown(dobj)).markdown as string;
    expect(afterRevert).toBe(afterPropose);
  });
});

/**
 * The in-app AI co-author writes through this SAME ledger (source "panel"), so
 * its edits get the identical ghosts, per-hunk Accept/Reject and run bar an MCP
 * agent's do — and, since the ledger parks by default, the identical outcome.
 * What is still special-cased is that a panel run parks even when the resolved
 * policy says `auto`: the turn was staged in front of the person who asked for
 * it, and a rule written for a background connector must not decide it.
 */
describe("panel runs (the in-app co-author)", () => {
  /** Propose as the co-author would, on behalf of `alice`. */
  function panel(dobj: DocActor, body: Omit<ProposeBody, "source" | "agent" | "agent_alias">) {
    return propose(dobj, { source: "panel", agent: "AI co-author", agent_alias: "panel:alice", ...body });
  }

  it("parks even when the resolved policy says `auto`", async () => {
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);
    // A connector under the same `auto` rule commits outright…
    const landed = await proposeAuto(dobj, { action: "str_replace", find: "Bravo paragraph.", replace: "Bravo committed." });
    expect(landed.json.mode).toBe("auto_applied");

    // …and the co-author, carrying the same word, still parks.
    const res = await panel(dobj, { action: "str_replace", find: "Alpha paragraph.", replace: "Alpha proposed.", review: "auto" });
    expect(res.status).toBe(200);
    expect(res.json.mode).toBe("proposed");
    expect(runOf(res.json).source).toBe("panel");
    expect(runOf(res.json).agent).toBe("AI co-author");
    // Nothing landed.
    expect(await readMarkdown(dobj)).toMatchObject({ markdown: expect.stringContaining("Alpha paragraph.") });
  });

  it("skips the notification only for the turn staged on the document in front of them", async () => {
    // The reviewer asked for this turn and is watching it stage, so mailing them
    // about it is noise. The exemption is the CALLER's to claim, not something
    // read off `source` — see the cross-document test below for why.
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);
    await connect(dobj, h, { docId: DOC, alias: "alice" });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await proposeRunEdit((dobj as any).ledger, {
      op: { action: "str_replace", find: "Alpha paragraph.", replace: "Alpha proposed.", replaceAll: false },
      source: "panel",
      review: "review",
      notifyReviewer: false,
      agent: "AI co-author",
      agentAlias: "panel:alice",
      reviewer: "alice",
      workspaceId: "ws1",
      docTitle: "",
    });
    expect(res.mode).toBe("proposed");
    expect(h.queued.filter((m) => (m as { kind?: string }).kind === "notify")).toHaveLength(0);
  });

  it("DOES notify for a cross-document proposal, which the reviewer cannot see", async () => {
    // "All documents in this workspace" lets the co-author park hunks in
    // documents the reviewer has no tab on. Those arrive over the HTTP route —
    // source "panel" all the same — and get no run bar, because the reviewer is
    // not on this document. The panel's own turn output links to them, but that
    // scrolls away with the chat. The notification is the durable half.
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);

    const res = await panel(dobj, { action: "str_replace", find: "Alpha paragraph.", replace: "Alpha proposed." });
    expect(res.json.mode).toBe("proposed");
    expect(h.queued.filter((m) => (m as { kind?: string }).kind === "notify")).toMatchObject([
      { recipient: "alice", eventType: "AGENT_EDITS_PROPOSED", body: "AI co-author proposed 1 change — waiting for your review" },
    ]);
  });

  it("keeps its run separate from a connector's under the same `auto` rule", async () => {
    // The panel exemption is per-RUN: an `auto` rule still lands the connector's
    // work at once, and only the co-author's turn is held back for its human.
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);
    await connect(dobj, h, { docId: DOC, alias: "alice" });
    const panelRun = await panel(dobj, { action: "str_replace", find: "Alpha paragraph.", replace: "Alpha proposed.", review: "auto" });
    const mcpRun = await proposeAuto(dobj, { action: "str_replace", find: "Bravo paragraph.", replace: "Bravo proposed." });
    expect(mcpRun.json.mode).toBe("auto_applied");

    const md = (await readMarkdown(dobj)).markdown as string;
    expect(md).toContain("Bravo proposed."); // the connector's landed…
    expect(md).toContain("Alpha paragraph."); // …the co-author's did not
    const runs = await listRuns(dobj);
    expect(runs.find((r) => r.id === runOf(panelRun.json).id)!.hunks[0]!.status).toBe("pending");
  });

  it("keeps its own run separate from a connector's, so Accept all is never ambiguous", async () => {
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);
    await connect(dobj, h, { docId: DOC, alias: "alice" });
    const panelRun = await panel(dobj, { action: "str_replace", find: "Alpha paragraph.", replace: "Alpha proposed." });
    const mcpRun = await propose(dobj, { action: "str_replace", find: "Bravo paragraph.", replace: "Bravo proposed." });
    expect(runOf(panelRun.json).id).not.toBe(runOf(mcpRun.json).id);
    expect(runOf(panelRun.json).agent_alias).toBe("panel:alice");
    expect(runOf(mcpRun.json).agent_alias).toBe("agent1");
  });

  it("cited_edits applies to the LIVE working copy, not a baseline read mid-turn", async () => {
    // The model read the document, then a collaborator edited a DIFFERENT part
    // while it was thinking. The staged hunks must describe the change against
    // what the document says NOW, and must not carry the human's text back.
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);
    await connect(dobj, h, { docId: DOC, alias: "alice" });
    await humanEdit(dobj, "Bravo paragraph.", "Bravo edited by a human.");

    const res = await panel(dobj, {
      action: "cited_edits",
      edits: [{ old_string: "Alpha paragraph.", new_string: "Alpha rewritten." }],
      citations: [],
    });
    expect(res.json.mode).toBe("proposed");
    const hunks = runOf(res.json).hunks;
    expect(hunks.some((x) => x.new_string.includes("Bravo edited by a human."))).toBe(false);
    expect(hunks.some((x) => x.new_string.includes("Alpha rewritten."))).toBe(true);
  });

  it("a second turn sees the first turn's pending hunks and appends to the same run", async () => {
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);
    await connect(dobj, h, { docId: DOC, alias: "alice" });
    const first = await panel(dobj, {
      action: "cited_edits",
      edits: [{ old_string: "Alpha paragraph.", new_string: "Alpha rewritten." }],
    });

    // The projection the next turn reads shows the un-accepted rewrite…
    const view = await readMarkdown(dobj, "panel:alice");
    expect(view.markdown).toContain("Alpha rewritten.");
    expect(view.run_id).toBe(runOf(first.json).id);

    // …so turn two can edit text turn one produced, into the SAME run.
    const second = await panel(dobj, {
      action: "cited_edits",
      edits: [{ old_string: "Alpha rewritten.", new_string: "Alpha rewritten twice." }],
    });
    expect(second.json.mode).toBe("proposed");
    expect(runOf(second.json).id).toBe(runOf(first.json).id);
    expect(runOf(second.json).hunks.length).toBeGreaterThan(1);
  });
});

/**
 * A cited turn stages only the BODY of its edit. The trailing footnote-definition
 * block is a single append, so staging it would make it its own reviewable hunk —
 * and accepting the prose while rejecting that hunk would leave a `[^1]` chip
 * pointing at nothing. It is rebuilt at COMMIT time from the markers that landed.
 */
describe("panel run footnotes", () => {
  const CITE = { n: 1, doc_id: "src1", title: "Source One", heading_path: "Intro", content: "Cited excerpt." };

  function citedTurn(dobj: DocActor, edits: { old_string: string; new_string: string }[]) {
    return propose(dobj, {
      source: "panel",
      agent: "AI co-author",
      agent_alias: "panel:alice",
      action: "cited_edits",
      edits,
      citations: [CITE],
    });
  }

  it("stages no definitions hunk, and materializes one when the marker is accepted", async () => {
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);
    await connect(dobj, h, { docId: DOC, alias: "alice" });
    const res = await citedTurn(dobj, [{ old_string: "Alpha paragraph.", new_string: "Alpha claim [^1]." }]);

    // Nothing staged is a bare definition line the reviewer could reject on its own.
    const hunks = runOf(res.json).hunks;
    expect(hunks.some((x) => /^\[\^1\]:/m.test(x.new_string))).toBe(false);

    const runId = runOf(res.json).id;
    const decided = await post(dobj, "decide", { run_id: runId, decision: "accept", decided_by: "alice" });
    expect(decided.status).toBe(200);
    const md = (await readMarkdown(dobj)).markdown as string;
    expect(md).toContain("Alpha claim [^1].");
    expect(md).toContain("[^1]: [Source One — Intro](/doc/src1)");
  });

  it("leaves no orphan definition when the citing hunk is REJECTED", async () => {
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);
    await connect(dobj, h, { docId: DOC, alias: "alice" });
    const res = await citedTurn(dobj, [{ old_string: "Alpha paragraph.", new_string: "Alpha claim [^1]." }]);

    const runId = runOf(res.json).id;
    await post(dobj, "decide", { run_id: runId, decision: "reject", decided_by: "alice" });
    const md = (await readMarkdown(dobj)).markdown as string;
    expect(md).not.toContain("[^1]");
    expect(md).toContain("Alpha paragraph.");
  });

  it("keeps only the definitions whose markers survived a PARTIAL accept", async () => {
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);
    await connect(dobj, h, { docId: DOC, alias: "alice" });
    const res = await propose(dobj, {
      source: "panel",
      agent: "AI co-author",
      agent_alias: "panel:alice",
      action: "cited_edits",
      edits: [
        { old_string: "Alpha paragraph.", new_string: "Alpha claim [^1]." },
        { old_string: "Bravo paragraph.", new_string: "Bravo claim [^2]." },
      ],
      citations: [CITE, { n: 2, doc_id: "src2", title: "Source Two", heading_path: null, content: "Second excerpt." }],
    });
    const run = runOf(res.json);
    // Accept ONLY the hunk carrying the first marker.
    const alphaHunk = run.hunks.find((x) => x.new_string.includes("[^1]"))!;
    const accepted = await post(dobj, "decide", {
      run_id: run.id,
      decision: "accept",
      hunk_ids: [alphaHunk.id],
      decided_by: "alice",
    });
    expect(accepted.status).toBe(200);

    const md = (await readMarkdown(dobj)).markdown as string;
    expect(md).toContain("[^1]: [Source One — Intro](/doc/src1)");
    // THE POINT: source two's definition must not appear while its marker is
    // still an un-accepted proposal.
    expect(md).not.toContain("Source Two");
  });
});

/**
 * The co-author is a HUMAN surface. Its proposals are minted under a server-side
 * panel identity on the requester's behalf, so an agent socket driving a turn
 * would mint a run whose reviewer is the agent itself — self-review, through the
 * one door the raw-write AGENT GATE does not cover (this is an AI_REQUEST frame,
 * not a Yjs update).
 */
describe("the in-app co-author refuses agent sockets", () => {
  async function askAi(dobj: DocActor, ws: MemorySocket): Promise<void> {
    await sendFrame(
      dobj,
      ws,
      encodeJson(Opcode.AI_REQUEST, {
        prompt: "rewrite the intro",
        selected_text: null,
        model: "auto",
        history: [],
        collection_id: null,
      }),
    );
  }

  it("refuses an agent-authenticated socket and mints no run", async () => {
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);
    const agentWs = await connect(dobj, h, { docId: DOC, alias: "alice", agent: "claude", agentAuth: "1" });

    await askAi(dobj, agentWs);

    const replies = payloads<{ done: boolean; error?: string }>(agentWs, Opcode.AI_RESPONSE);
    expect(replies.at(-1)?.error).toMatch(/MCP tools/);
    expect(await listRuns(dobj)).toHaveLength(0);
  });

  it("lets a human socket through to the ordinary turn gates", async () => {
    // Same frame, non-agent socket: it gets the ai.enabled verdict, proving the
    // refusal above is about agent-ness and not about the request itself.
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);
    const human = await connect(dobj, h, { docId: DOC, alias: "alice" });

    await askAi(dobj, human);

    const replies = payloads<{ done: boolean; error?: string }>(human, Opcode.AI_RESPONSE);
    expect(replies.at(-1)?.error).toBe("AI chat is disabled on this node");
  });

  it("ends the turn with an AI_EDITS frame even when it fails", async () => {
    // The client clears its in-flight turn off AI_EDITS, so an error path that
    // sent only AI_RESPONSE would pin `aiTurn` for the life of the page.
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);
    const human = await connect(dobj, h, { docId: DOC, alias: "alice" });

    await askAi(dobj, human);

    const edits = payloads<{ staged: number; run_id: string | null; error: string | null }>(human, Opcode.AI_EDITS);
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({ staged: 0, run_id: null, error: "AI chat is disabled on this node" });
  });
});
