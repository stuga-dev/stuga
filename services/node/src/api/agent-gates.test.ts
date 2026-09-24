/** API keys reach every /api route, so each direct-write or review route refuses an agent itself. */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@stuga/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@stuga/db")>()),
  getDoc: vi.fn(),
  updateDoc: vi.fn(),
}));

const { getDoc, updateDoc } = await import("@stuga/db");
const { routeWorkspaceRequest } = await import("../http/dispatch.js");
import type { Ctx } from "../auth/context.js";

const mockGetDoc = getDoc as unknown as ReturnType<typeof vi.fn>;
const mockUpdateDoc = updateDoc as unknown as ReturnType<typeof vi.fn>;

const DOC = {
  doc_id: "d1",
  workspace_id: "ws1",
  owner: "user:human-1",
  title: "Roadmap",
  doc_type: "prose",
  trashed: false,
  locked: false,
  acl_principals: ["agent:agent-1", "user:human-1"],
  acl_writers: ["agent:agent-1", "user:human-1"],
};

/** An agent with full write access. */
function agentCtx(overrides: Partial<Ctx> = {}): Ctx {
  return {
    sql: {},
    alias: "agent-1",
    displayName: "Scout (Connector)",
    isAgent: true,
    onBehalfOf: "human-1",
    principals: ["agent:agent-1"],
    workspaceId: "ws1",
    role: "member",
    env: { docs: { get: () => ({ fetch: actorFetch }) } },
    ...overrides,
  } as unknown as Ctx;
}

let actorCalls: string[];
const actorFetch = vi.fn(async (url: string) => {
  actorCalls.push(url);
  return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
});

function patch(path: string, body: unknown): Request {
  return new Request(`https://node.test${path}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function post(path: string, body: unknown): Request {
  return new Request(`https://node.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const route = (ctx: Ctx, req: Request): Promise<Response> => routeWorkspaceRequest(ctx, req);

beforeEach(() => {
  actorCalls = [];
  actorFetch.mockClear();
  mockGetDoc.mockReset();
  mockGetDoc.mockResolvedValue({ ...DOC });
  mockUpdateDoc.mockReset();
  mockUpdateDoc.mockResolvedValue({ ...DOC, title: "renamed by a human" });
});

describe("agent gates on the direct-write and review routes", () => {
  it("refuses PATCH (rename/move/trash) from an agent even with full write access", async () => {
    const req = patch("/api/docs/d1", { trashed: true });
    const res = await route(agentCtx(), req);
    expect(res.status).toBe(403);
    expect(mockUpdateDoc).not.toHaveBeenCalled();
    expect(actorCalls).toEqual([]);
  });

  it("refuses an agent PATCH that only renames", async () => {
    const req = patch("/api/docs/d1", { title: "renamed by an agent" });
    const res = await route(agentCtx(), req);
    expect(res.status).toBe(403);
    expect(mockUpdateDoc).not.toHaveBeenCalled();
  });

  it("lets a human PATCH the same document", async () => {
    const req = patch("/api/docs/d1", { title: "renamed by a human" });
    const res = await route(agentCtx({ isAgent: false, alias: "human-1", principals: ["user:human-1"] }), req);
    expect(res.status).not.toBe(403);
    expect(mockUpdateDoc).toHaveBeenCalled();
  });

  it.each([
    ["decision", { decision: "accept" }],
    ["revert", {}],
    ["ack", {}],
  ])("refuses /runs/:id/%s from an agent (agents never review their own work)", async (leaf, body) => {
    const path = `/api/docs/d1/runs/run_x/${leaf}`;
    const res = await route(agentCtx(), post(path, body));
    expect(res.status).toBe(403);
    expect(actorCalls).toEqual([]);
  });

  it("refuses /propose from a human", async () => {
    const path = "/api/docs/d1/propose";
    const res = await route(agentCtx({ isAgent: false, alias: "human-1" }), post(path, { action: "write", text: "hi" }));
    expect(res.status).toBe(403);
    expect(actorCalls).toEqual([]);
  });
});

describe("cited_edits at the REST front door", () => {
  it("refuses a malformed cited_edits body with 400 before touching the actor", async () => {
    const path = "/api/docs/d1/propose";
    const res = await route(agentCtx(), post(path, { action: "cited_edits", edits: [{ old_string: "", new_string: "b" }] }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("old_string");
    expect(actorCalls).toEqual([]);
  });

  it("names the accepted actions when the action is unknown", async () => {
    const path = "/api/docs/d1/propose";
    const res = await route(agentCtx(), post(path, { action: "delete" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("action must be write, str_replace, append or cited_edits");
    expect(actorCalls).toEqual([]);
  });
});
