/** The workspace list's active pick, default_doc_access on create and PATCH, and PATCH's validation of the other settings. */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@stuga/db", () => ({
  listWorkspacesForUser: vi.fn(async () => []),
  provisionWorkspace: vi.fn(async () => ({
    workspace_id: "ws-new",
    name: "Acme",
    default_doc_access: "private",
    created_at: "2026-01-01T00:00:00.000Z",
  })),
  getMemberRole: vi.fn(async () => "owner"),
  getWorkspace: vi.fn(),
  updateWorkspaceSettings: vi.fn(async () => ({
    workspace_id: "ws1",
    name: "Acme",
    default_doc_access: "workspace_view",
    created_at: "2026-01-01T00:00:00.000Z",
  })),
  redeemWorkspaceInvite: vi.fn(),
  redeemShareLink: vi.fn(),
}));

const { listWorkspacesForUser, provisionWorkspace, updateWorkspaceSettings, getWorkspace } = await import("@stuga/db");
import { MAX_AGENT_INSTRUCTIONS_CHARS } from "@stuga/protocol/domain/limits";
const { createWorkspace, listWorkspaces } = await import("./workspaces.js");
const { routeWorkspaceRequest } = await import("../http/dispatch.js");
import type { AccountCtx, Ctx } from "../auth/context.js";

const mockProvision = provisionWorkspace as unknown as ReturnType<typeof vi.fn>;
const mockUpdate = updateWorkspaceSettings as unknown as ReturnType<typeof vi.fn>;
const mockList = listWorkspacesForUser as unknown as ReturnType<typeof vi.fn>;

function accountCtx(): AccountCtx {
  return { sql: {}, alias: "owner-1", displayName: "Owner", email: "o@test", isAgent: false, env: {} } as unknown as AccountCtx;
}

async function create(body: unknown): Promise<Response> {
  const path = "/api/workspaces";
  const req = new Request(`https://node.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return createWorkspace({ ctx: accountCtx(), req, url: new URL(req.url), match: [path] });
}

const jobs: Array<Record<string, unknown>> = [];

async function patch(body: unknown, headerWorkspace = "ws1"): Promise<Response> {
  const path = "/api/workspaces/ws1";
  const req = new Request(`https://node.test${path}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const env = { jobs: { send: vi.fn(async (m: Record<string, unknown>) => void jobs.push(m)) } };
  const ctx = { ...accountCtx(), env, principals: ["user:owner-1"], workspaceId: headerWorkspace, role: "owner" } as unknown as Ctx;
  return routeWorkspaceRequest(ctx, req);
}

beforeEach(() => {
  vi.clearAllMocks();
  jobs.length = 0;
  vi.mocked(getWorkspace).mockResolvedValue({
    workspace_id: "ws1",
    name: "Acme",
    default_doc_access: "workspace_view",
    agent_instructions: "old rule",
    created_at: "2026-01-01T00:00:00.000Z",
  } as never);
  mockProvision.mockResolvedValue({
    workspace_id: "ws-new",
    name: "Acme",
    default_doc_access: "private",
    created_at: "2026-01-01T00:00:00.000Z",
  });
  mockUpdate.mockResolvedValue({
    workspace_id: "ws1",
    name: "Acme",
    default_doc_access: "workspace_view",
    created_at: "2026-01-01T00:00:00.000Z",
  });
});

describe("POST /api/workspaces", () => {
  it("passes a chosen mode through to the INSERT", async () => {
    const res = await create({ name: "Acme", default_doc_access: "private" });
    expect(res.status).toBe(201);
    expect(mockProvision.mock.calls[0]![1]).toMatchObject({ name: "Acme", defaultDocAccess: "private" });
    await expect(res.json()).resolves.toMatchObject({ default_doc_access: "private" });
  });

  it("leaves the column default to decide when the field is absent", async () => {
    const res = await create({ name: "Acme" });
    expect(res.status).toBe(201);
    expect(mockProvision.mock.calls[0]![1].defaultDocAccess).toBeUndefined();
  });

  it("refuses an unknown mode instead of coercing it", async () => {
    const res = await create({ name: "Acme", default_doc_access: "public" });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: "default_doc_access must be workspace_edit | workspace_view | private",
    });
    expect(mockProvision).not.toHaveBeenCalled();
  });

  it("refuses a non-string mode", async () => {
    const res = await create({ name: "Acme", default_doc_access: 1 });
    expect(res.status).toBe(400);
    expect(mockProvision).not.toHaveBeenCalled();
  });

  it("answers with the new workspace as its owner sees it, and nothing an import adds", async () => {
    mockProvision.mockResolvedValue({
      workspace_id: "ws-new",
      name: "Acme",
      default_doc_access: "private",
      agent_instructions: "",
      created_at: "2026-01-01T00:00:00.000Z",
    });
    const res = await create({ name: "Acme", default_doc_access: "private" });
    expect(await res.json()).toEqual({
      workspace_id: "ws-new",
      name: "Acme",
      role: "owner",
      default_doc_access: "private",
      agent_instructions: "",
      created_at: "2026-01-01T00:00:00.000Z",
    });
  });

  it("requires a name, checked first", async () => {
    const res = await create({ name: "   ", default_doc_access: "private" });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "workspace name is required" });
  });
});

describe("PATCH /api/workspaces/:id", () => {
  it("accepts a valid mode", async () => {
    const res = await patch({ default_doc_access: "workspace_view" });
    expect(res.status).toBe(200);
    expect(mockUpdate.mock.calls[0]![2]).toMatchObject({ defaultDocAccess: "workspace_view" });
  });

  it("refuses the same values create refuses, with the same message", async () => {
    const res = await patch({ default_doc_access: "public" });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: "default_doc_access must be workspace_edit | workspace_view | private",
    });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it.each([5, null, ["Acme"], { name: "Acme" }])("refuses a name of %o with 400", async (name) => {
    const res = await patch({ name });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "name must be text" });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("refuses a blank name", async () => {
    const res = await patch({ name: "   " });
    expect(res.status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("saves a trimmed name", async () => {
    const res = await patch({ name: "  Acme Labs " });
    expect(res.status).toBe(200);
    expect(mockUpdate.mock.calls[0]![2]).toEqual({ name: "Acme Labs" });
    expect(jobs).toEqual([]);
  });

  it("records a change to the instructions in the workspace's ledger, with sizes and never the text", async () => {
    // Filed under the workspace in the path, even when the request's header names another.
    const res = await patch({ agent_instructions: "a secret rule" }, "ws-other");
    expect(res.status).toBe(200);
    expect(mockUpdate.mock.calls[0]![2]).toEqual({ agentInstructions: "a secret rule" });
    const audits = jobs.filter((m) => m.kind === "audit");
    expect(audits).toEqual([
      expect.objectContaining({
        workspaceId: "ws1",
        action: "workspace.agent_instructions",
        targetKind: "workspace",
        targetId: "ws1",
        targetLabel: "Acme",
        detail: { chars: 13, from_chars: 8 },
      }),
    ]);
    expect(JSON.stringify(audits)).not.toContain("secret");
  });

  it("records nothing when the instructions are saved unchanged", async () => {
    const res = await patch({ name: "Acme", agent_instructions: "old rule" });
    expect(res.status).toBe(200);
    expect(jobs).toEqual([]);
  });

  it.each([
    ["over the limit", "x".repeat(MAX_AGENT_INSTRUCTIONS_CHARS + 1), `agent_instructions is too long (max ${MAX_AGENT_INSTRUCTIONS_CHARS} characters)`],
    ["not text", 42, "agent_instructions must be text"],
  ])("refuses instructions %s with 400, writing and recording nothing", async (_case, value, message) => {
    const res = await patch({ name: "Acme Labs", agent_instructions: value });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: message });
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(jobs).toEqual([]);
  });
});

describe("GET /api/workspaces", () => {
  async function active(url: string, header?: string): Promise<unknown> {
    mockList.mockResolvedValue([
      { workspace_id: "ws1", name: "One", role: "owner" },
      { workspace_id: "ws2", name: "Two", role: "member" },
    ]);
    const req = new Request(url, header === undefined ? {} : { headers: { "x-stuga-workspace": header } });
    const res = await listWorkspaces({ ctx: accountCtx(), req, url: new URL(req.url), match: ["/api/workspaces"] });
    return ((await res.json()) as { active: unknown }).active;
  }

  it("marks the workspace the header names as active, when the caller is a member", async () => {
    expect(await active("https://node.test/api/workspaces", "ws2")).toBe("ws2");
    expect(await active("https://node.test/api/workspaces", "ws-elsewhere")).toBe("ws1");
  });

  it("takes the active workspace from the header alone, never a ?ws= query parameter", async () => {
    expect(await active("https://node.test/api/workspaces?ws=ws2")).toBe("ws1");
    expect(await active("https://node.test/api/workspaces?ws=", "ws2")).toBe("ws2");
  });
});
