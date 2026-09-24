/**
 * Who may decide an agent run, at the request layer: the node identifies the caller to the actor
 * and says whether they manage the document; the actor compares against the run's reviewer.
 * Also the audit row each decision leaves.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@stuga/db", () => ({ getDoc: vi.fn(), resolveDocInstructions: vi.fn(async () => []) }));
vi.mock("../agents/edits.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/edits.js")>()),
  proposeDocEdit: vi.fn(),
}));

const { getDoc } = await import("@stuga/db");
const { proposeDocEdit } = await import("../agents/edits.js");
const { routeWorkspaceRequest } = await import("../http/dispatch.js");
import type { Ctx } from "../auth/context.js";

const mockGetDoc = getDoc as unknown as ReturnType<typeof vi.fn>;
const mockProposeDocEdit = proposeDocEdit as unknown as ReturnType<typeof vi.fn>;

const DOC = {
  doc_id: "d1",
  workspace_id: "ws1",
  owner: "user:owner-1",
  title: "Roadmap",
  doc_type: "prose",
  trashed: false,
  locked: false,
  acl_principals: ["user:owner-1", "user:alice", "user:bob", "agent:agent-1", "org:ws1"],
  acl_writers: ["user:owner-1", "user:alice", "user:bob", "agent:agent-1", "org:ws1"],
};

/** What the actor answered, and the bodies it was called with. */
let actorStatus: number;
let actorBody: unknown;
const actorCalls: Array<{ url: string; body: Record<string, unknown> }> = [];

const actorFetch = vi.fn(async (url: string, init?: RequestInit) => {
  actorCalls.push({
    url,
    body: init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {},
  });
  return new Response(JSON.stringify(actorBody), {
    status: actorStatus,
    headers: { "content-type": "application/json" },
  });
});

/** A human collaborator with full write access to the doc. */
function userCtx(overrides: Partial<Ctx> = {}): Ctx {
  return {
    sql: {},
    alias: "bob",
    displayName: "Bob",
    isAgent: false,
    principals: ["user:bob"],
    workspaceId: "ws1",
    role: "member",
    env: { docs: { get: () => ({ fetch: actorFetch }) } },
    ...overrides,
  } as unknown as Ctx;
}

async function call(ctx: Ctx, method: string, path: string, body?: unknown): Promise<Response> {
  const req = new Request(`https://node.test${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  return routeWorkspaceRequest(ctx, req);
}

beforeEach(() => {
  actorCalls.length = 0;
  actorFetch.mockClear();
  actorStatus = 200;
  actorBody = { run: { id: "run_x", agent_alias: "agent-1" }, applied: 1, conflicts: 0 };
  mockGetDoc.mockReset();
  mockGetDoc.mockResolvedValue({ ...DOC });
});

/** A ctx whose job queue is captured, so the audit rows can be read back. */
function auditedCtx(overrides: Partial<Ctx> = {}): { ctx: Ctx; rows: Array<Record<string, unknown>> } {
  const sent: Array<Record<string, unknown>> = [];
  const ctx = userCtx(overrides);
  (ctx.env as { jobs?: unknown }).jobs = { send: async (m: Record<string, unknown>) => void sent.push(m) };
  return { ctx, rows: sent };
}

describe("the ledger row a decision leaves", () => {
  it("records who accepted a run, on which document, and what it did", async () => {
    const { ctx, rows } = auditedCtx();
    await call(ctx, "POST", "/api/docs/d1/runs/run_x/decision", { decision: "accept" });
    expect(rows).toContainEqual(
      expect.objectContaining({
        kind: "audit",
        action: "run.decide",
        actor: "bob",
        targetKind: "doc",
        targetId: "d1",
        targetLabel: "Roadmap",
        detail: expect.objectContaining({ run_id: "run_x", decision: "accept", applied: 1 }),
      }),
    );
  });

  it("distinguishes a rejection, which changes nothing and so has no other trace", async () => {
    const { ctx, rows } = auditedCtx();
    await call(ctx, "POST", "/api/docs/d1/runs/run_x/decision", { decision: "reject" });
    expect(rows[0]).toMatchObject({ action: "run.decide", detail: expect.objectContaining({ decision: "reject" }) });
  });

  it("records a revert and a dismissal too", async () => {
    const revert = auditedCtx();
    actorBody = { run: { id: "run_x", agent: "bot" }, reverted: 2, rejected: 0 };
    await call(revert.ctx, "POST", "/api/docs/d1/runs/run_x/revert", {});
    expect(revert.rows[0]).toMatchObject({ action: "run.revert", detail: expect.objectContaining({ run_id: "run_x", hunks: 2 }) });

    const ack = auditedCtx();
    actorBody = { run: { id: "run_x", agent: "bot" } };
    await call(ack.ctx, "POST", "/api/docs/d1/runs/run_x/ack", {});
    expect(ack.rows[0]).toMatchObject({ action: "run.ack", detail: expect.objectContaining({ run_id: "run_x" }) });
  });

  it("writes nothing when the actor refused the decision", async () => {
    const { ctx, rows } = auditedCtx();
    actorStatus = 403;
    actorBody = { error: "not_reviewer" };
    await call(ctx, "POST", "/api/docs/d1/runs/run_x/decision", { decision: "accept" });
    expect(rows).toEqual([]);
  });
});

describe("forwarding the decider's identity", () => {
  it.each([
    ["decision", "/api/docs/d1/runs/run_x/decision", { decision: "accept" }, "decided_by"],
    ["revert", "/api/docs/d1/runs/run_x/revert", {}, "requested_by"],
    ["ack", "/api/docs/d1/runs/run_x/ack", {}, "acked_by"],
  ])("names the caller on /%s so the actor can compare them to the reviewer", async (_leaf, path, body, field) => {
    const res = await call(userCtx(), "POST", path, body);
    expect(res.status).toBe(200);
    expect(actorCalls).toHaveLength(1);
    expect(actorCalls[0]!.body[field]).toBe("bob");
  });

  it.each([
    ["decision", "/api/docs/d1/runs/run_x/decision", { decision: "accept" }],
    ["revert", "/api/docs/d1/runs/run_x/revert", {}],
    ["ack", "/api/docs/d1/runs/run_x/ack", {}],
  ])("claims no manager override on /%s for a plain co-writer", async (_leaf, path, body) => {
    await call(userCtx(), "POST", path, body);
    expect(actorCalls[0]!.body.manager_override).toBe(false);
  });

  it.each([
    ["the document's owner", { alias: "owner-1", principals: ["user:owner-1"] }],
    ["a workspace admin", { alias: "carol", principals: ["user:carol", "org:ws1"], role: "admin" as const }],
    ["a workspace owner", { alias: "dana", principals: ["user:dana", "org:ws1"], role: "owner" as const }],
  ])("vouches for %s, who may clear a run its reviewer never will", async (_who, overrides) => {
    await call(userCtx(overrides), "POST", "/api/docs/d1/runs/run_x/decision", { decision: "accept" });
    expect(actorCalls[0]!.body.manager_override).toBe(true);
  });

  it("does not let an agent inherit its owner's manager rights through the ledger", async () => {
    const agent = userCtx({ alias: "agent-1", isAgent: true, onBehalfOf: "owner-1", principals: ["agent:agent-1"] });
    for (const [path, body] of [
      ["/api/docs/d1/runs/run_x/decision", { decision: "accept" }],
      ["/api/docs/d1/runs/run_x/revert", {}],
      ["/api/docs/d1/runs/run_x/ack", {}],
    ] as const) {
      expect((await call(agent, "POST", path, body)).status).toBe(403);
    }
    expect(actorCalls).toEqual([]);
  });
});

describe("surfacing the actor's refusal", () => {
  it.each([
    ["decision", "/api/docs/d1/runs/run_x/decision", { decision: "accept" }],
    ["revert", "/api/docs/d1/runs/run_x/revert", {}],
    ["ack", "/api/docs/d1/runs/run_x/ack", {}],
  ])("passes a 403 from /%s through as a 403 with a reason", async (_leaf, path, body) => {
    // A permanent refusal, so a client does not retry it as a server fault.
    actorStatus = 403;
    actorBody = { error: "not_reviewer" };
    const res = await call(userCtx(), "POST", path, body);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/reviewer/);
  });

  it("reports a missing run as 404 and a broken actor as 502", async () => {
    actorStatus = 404;
    actorBody = { error: "not_found" };
    expect((await call(userCtx(), "POST", "/api/docs/d1/runs/run_x/decision", { decision: "accept" })).status).toBe(404);
    actorStatus = 500;
    actorBody = { error: "boom" };
    expect((await call(userCtx(), "POST", "/api/docs/d1/runs/run_x/decision", { decision: "accept" })).status).toBe(502);
  });
});

describe("the gates around the review routes", () => {
  it("refuses a viewer with no write access on decision and revert", async () => {
    mockGetDoc.mockResolvedValue({ ...DOC, acl_writers: ["user:owner-1"] });
    const viewer = userCtx({ alias: "alice", principals: ["user:alice"] });
    expect((await call(viewer, "POST", "/api/docs/d1/runs/run_x/decision", { decision: "accept" })).status).toBe(403);
    expect((await call(viewer, "POST", "/api/docs/d1/runs/run_x/revert", {})).status).toBe(403);
    expect(actorCalls).toEqual([]);
  });

  it("lets a reviewer dismiss their own catch-up card after losing write access", async () => {
    mockGetDoc.mockResolvedValue({ ...DOC, acl_writers: ["user:owner-1"], locked: true });
    const res = await call(userCtx({ alias: "alice", principals: ["user:alice"] }), "POST", "/api/docs/d1/runs/run_x/ack", {});
    expect(res.status).toBe(200);
    expect(actorCalls[0]!.body.acked_by).toBe("alice");
  });

  it("refuses everything on a doc the caller cannot even read", async () => {
    mockGetDoc.mockResolvedValue({ ...DOC, acl_principals: ["user:owner-1"], acl_writers: ["user:owner-1"] });
    const stranger = userCtx({ alias: "mallory", principals: ["user:mallory"] });
    for (const [path, body] of [
      ["/api/docs/d1/runs/run_x/decision", { decision: "accept" }],
      ["/api/docs/d1/runs/run_x/revert", {}],
      ["/api/docs/d1/runs/run_x/ack", {}],
      ["/api/docs/d1/runs/run_x", undefined],
    ] as const) {
      expect((await call(stranger, path === "/api/docs/d1/runs/run_x" ? "GET" : "POST", path, body)).status).toBe(404);
    }
    expect(actorCalls).toEqual([]);
  });

  it("refuses a decision on a locked document before touching the actor", async () => {
    mockGetDoc.mockResolvedValue({ ...DOC, locked: true });
    expect((await call(userCtx(), "POST", "/api/docs/d1/runs/run_x/decision", { decision: "accept" })).status).toBe(423);
    expect(actorCalls).toEqual([]);
  });
});

describe("agent isolation on the run reads", () => {
  const agent = () =>
    userCtx({ alias: "agent-1", isAgent: true, onBehalfOf: "owner-1", principals: ["agent:agent-1"] });

  it("hides another agent's run detail behind the same 404 as a missing one", async () => {
    actorBody = { run: { id: "run_x", agent_alias: "agent-2" }, hunks: [{ old_string: "a", new_string: "b" }] };
    const res = await call(agent(), "GET", "/api/docs/d1/runs/run_x?full=1");
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("agent-2");
  });

  it("returns an agent its own run", async () => {
    actorBody = { run: { id: "run_x", agent_alias: "agent-1" } };
    const res = await call(agent(), "GET", "/api/docs/d1/runs/run_x");
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toMatchObject({ run: { id: "run_x" } });
  });

  it("shows a human every run on a document they can read", async () => {
    actorBody = { run: { id: "run_x", agent_alias: "agent-2" } };
    expect((await call(userCtx(), "GET", "/api/docs/d1/runs/run_x")).status).toBe(200);
  });

  it("filters the run list for an agent and leaves it whole for a human", async () => {
    actorBody = { runs: [{ id: "run_a", agent_alias: "agent-1" }, { id: "run_b", agent_alias: "agent-2" }] };
    const mine = (await (await call(agent(), "GET", "/api/docs/d1/runs")).json()) as { runs: unknown[] };
    expect(mine.runs).toEqual([{ id: "run_a", agent_alias: "agent-1" }]);
    const all = (await (await call(userCtx(), "GET", "/api/docs/d1/runs")).json()) as { runs: unknown[] };
    expect(all.runs).toHaveLength(2);
  });
});

describe("the REST propose answer", () => {
  const agent = () =>
    userCtx({
      alias: "agent-1",
      isAgent: true,
      onBehalfOf: "owner-1",
      principals: ["agent:agent-1"],
      env: { docs: { get: () => ({ fetch: actorFetch }) }, publicOrigin: "https://stuga.test" } as unknown as Ctx["env"],
    });
  const run = { id: "run_x", agent_alias: "agent-1" };

  it("carries the media note on a proposal", async () => {
    mockProposeDocEdit.mockResolvedValueOnce({
      kind: "proposed",
      run,
      pending: 2,
      mediaNote: "hosted 1 image",
      review: "review",
      reason: "the document asks for review",
      doc: { doc_id: "d1" },
    });
    const res = await call(agent(), "POST", "/api/docs/d1/propose", { action: "append", text: "![x](https://x.test/a.png)" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      mode: "proposed",
      run,
      pending: 2,
      review: "review",
      reason: "the document asks for review",
      media_note: "hosted 1 image",
    });
    expect(mockProposeDocEdit.mock.calls[0]![1]).toMatchObject({ docId: "d1", action: "append", source: "stdio" });
  });

  it("carries the media note and the review link on an applied change", async () => {
    mockProposeDocEdit.mockResolvedValueOnce({
      kind: "auto_applied",
      run,
      seq: 7,
      mediaNote: "hosted 1 image",
      review: "auto",
      reason: "the document applies agent changes at once",
      doc: { doc_id: "d1" },
    });
    const res = await call(agent(), "POST", "/api/docs/d1/propose", { action: "write", text: "hi" });
    expect(await res.json()).toMatchObject({
      mode: "auto_applied",
      seq: 7,
      review_url: "https://stuga.test/doc/d1",
      media_note: "hosted 1 image",
    });
  });

  it("answers a retryable refusal with 409", async () => {
    mockProposeDocEdit.mockResolvedValueOnce({ kind: "error", retryable: true, message: "the document changed" });
    const res = await call(agent(), "POST", "/api/docs/d1/propose", { action: "write", text: "hi" });
    expect(res.status).toBe(409);
  });
});
