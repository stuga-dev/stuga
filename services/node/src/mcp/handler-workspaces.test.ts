/**
 * Per-call workspace scoping and the audit row every /mcp tool call writes. A
 * `workspace_id` the caller cannot reach is refused with one wording and never
 * falls back to home, where a write would land in the wrong tenant.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@stuga/db", async (orig) => ({
  ...(await orig<typeof import("@stuga/db")>()),
  getDoc: vi.fn(),
  listDocs: vi.fn(async () => []),
  getMemberRole: vi.fn(),
  getGroupsForMember: vi.fn(async () => []),
  listWorkspacesForUser: vi.fn(async () => []),
}));

const { listDocs, getMemberRole, listWorkspacesForUser } = await import("@stuga/db");
const { handleMcpRequest, WORKSPACE_UNAVAILABLE_MESSAGE } = await import("./handler.js");
import type { Ctx } from "../auth/context.js";

const mockListDocs = listDocs as unknown as ReturnType<typeof vi.fn>;
const mockGetMemberRole = getMemberRole as unknown as ReturnType<typeof vi.fn>;
const mockListWorkspaces = listWorkspacesForUser as unknown as ReturnType<typeof vi.fn>;

const jobsSend = vi.fn(async () => {});

function connectorCtx(overrides: Partial<Ctx> = {}): Ctx {
  return {
    sql: {},
    alias: "agent-conn-abc",
    displayName: "Connector",
    surface: "mcp",
    isAgent: true,
    onBehalfOf: "human-1",
    principals: ["agent:agent-conn-abc", "user:human-1", "org:ws1"],
    workspaceId: "ws1",
    role: "member",
    env: {
      databases: { get: () => ({ fetch: vi.fn() }) },
      docs: { get: () => ({ fetch: vi.fn() }) },
      jobs: { send: jobsSend },
      aiSettings: { current: () => ({ enabled: false }) },
      publicOrigin: "https://stuga.test",
      nodeId: "ktbbpahhzxoldakw",
      settings: { current: () => ({ nodeLabel: "Studio" }) },
    },
    ...overrides,
  } as unknown as Ctx;
}

async function callTool(ctx: Ctx, name: string, args: Record<string, unknown> = {}) {
  const req = new Request("https://api.test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const res = await handleMcpRequest(ctx, req);
  const text = await res.text();
  const payload = text.startsWith("event:") || text.startsWith("data:")
    ? JSON.parse(/data: (.*)/.exec(text)![1]!)
    : JSON.parse(text);
  const result = payload.result ?? {};
  return { isError: result.isError === true, text: String(result.content?.[0]?.text ?? "") };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockListDocs.mockResolvedValue([]);
});

describe("workspace_id resolution", () => {
  it("runs in the home workspace, with its principals, when workspace_id is omitted", async () => {
    const r = await callTool(connectorCtx(), "docs", { action: "list" });
    expect(r.isError).toBe(false);
    expect(mockGetMemberRole).not.toHaveBeenCalled();
    expect(mockListDocs).toHaveBeenCalledWith(
      expect.anything(),
      ["agent:agent-conn-abc", "user:human-1", "org:ws1"],
      "ws1",
      expect.anything(),
    );
  });

  it("treats an empty workspace_id as omitted", async () => {
    const r = await callTool(connectorCtx(), "docs", { action: "list", workspace_id: "" });
    expect(r.isError).toBe(false);
    expect(mockListDocs).toHaveBeenCalledWith(expect.anything(), expect.anything(), "ws1", expect.anything());
  });

  it("runs in a workspace the authorizing human belongs to, with principals derived there", async () => {
    mockGetMemberRole.mockResolvedValue("member");
    const r = await callTool(connectorCtx(), "docs", { action: "list", workspace_id: "ws2" });
    expect(r.isError).toBe(false);
    expect(mockGetMemberRole).toHaveBeenCalledWith(expect.anything(), "ws2", "human-1");
    const [, principals, workspaceId] = mockListDocs.mock.calls[0]!;
    expect(workspaceId).toBe("ws2");
    expect(principals).toContain("agent:agent-conn-abc");
    expect(principals).toContain("org:ws2");
    expect(principals).not.toContain("org:ws1");
  });

  it("refuses an unreachable workspace with the fixed wording and never runs at home", async () => {
    mockGetMemberRole.mockResolvedValue(null);
    const r = await callTool(connectorCtx(), "docs", { action: "list", workspace_id: "ws-nope" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain(WORKSPACE_UNAVAILABLE_MESSAGE);
    expect(mockListDocs).not.toHaveBeenCalled();
  });

  it("resolves a human bearer against their own memberships", async () => {
    mockGetMemberRole.mockResolvedValue("admin");
    const human = connectorCtx({
      alias: "human-1",
      isAgent: false,
      onBehalfOf: undefined,
      principals: ["user:human-1", "org:ws1"],
    });
    const r = await callTool(human, "docs", { action: "list", workspace_id: "ws2" });
    expect(r.isError).toBe(false);
    expect(mockGetMemberRole).toHaveBeenCalledWith(expect.anything(), "ws2", "human-1");
    const [, principals] = mockListDocs.mock.calls[0]!;
    expect(principals).toContain("org:ws2");
    expect(principals).not.toContain("agent:agent-conn-abc");
  });
});

describe("workspaces tool", () => {
  it("lists the authorizing human's workspaces with ids, names and roles", async () => {
    mockListWorkspaces.mockResolvedValue([
      { workspace_id: "ws1", name: "Home", role: "member" },
      { workspace_id: "ws2", name: "Shared", role: "guest" },
    ]);
    const r = await callTool(connectorCtx(), "workspaces", { action: "list" });
    expect(r.isError).toBe(false);
    expect(mockListWorkspaces).toHaveBeenCalledWith(expect.anything(), "human-1");
    const body = JSON.parse(r.text) as { workspaces: unknown[]; home_workspace_id: string };
    const node = { id: "ktbbpahhzxoldakw", name: "Studio", origin: "https://stuga.test" };
    expect(body.workspaces).toEqual([
      { workspace_id: "ws1", name: "Home", role: "member", node },
      { workspace_id: "ws2", name: "Shared", role: "guest", node },
    ]);
    expect(body.home_workspace_id).toBe("ws1");
  });

  it("names the node on the connection and on every workspace, so a workspace_id says which node too", async () => {
    mockListWorkspaces.mockResolvedValue([{ workspace_id: "ws1", name: "Home", role: "member" }]);
    const body = JSON.parse((await callTool(connectorCtx(), "workspaces", { action: "list" })).text) as {
      node: unknown;
      workspaces: Array<{ node: unknown }>;
    };
    const node = { id: "ktbbpahhzxoldakw", name: "Studio", origin: "https://stuga.test" };
    expect(body.node).toEqual(node);
    expect(body.workspaces[0]!.node).toEqual(node);
  });
});

describe("audit trail", () => {
  it("records one attributed audit row for a read", async () => {
    await callTool(connectorCtx(), "docs", { action: "list" });
    expect(jobsSend).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "audit",
        source: "mcp",
        action: "mcp.docs.list",
        actor: "agent-conn-abc",
        actorKind: "agent",
        onBehalfOf: "human-1",
        workspaceId: "ws1",
      }),
    );
  });

  it("names the target when the input carries one", async () => {
    await callTool(connectorCtx(), "markdown", { doc_id: "d1", action: "read" });
    expect(jobsSend).toHaveBeenCalledWith(
      expect.objectContaining({ action: "mcp.markdown.read", targetKind: "doc", targetId: "d1" }),
    );
  });

  it("records the resolved workspace, and null when resolution refused", async () => {
    mockGetMemberRole.mockResolvedValue("member");
    await callTool(connectorCtx(), "docs", { action: "list", workspace_id: "ws2" });
    expect(jobsSend).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws2" }));

    jobsSend.mockClear();
    mockGetMemberRole.mockResolvedValue(null);
    await callTool(connectorCtx(), "docs", { action: "list", workspace_id: "ws-nope" });
    expect(jobsSend).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: null }));
  });

  it("marks a call refused at workspace resolution as denied", async () => {
    mockGetMemberRole.mockResolvedValue(null);
    const r = await callTool(connectorCtx(), "docs", { action: "list", workspace_id: "ws-nope" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain(WORKSPACE_UNAVAILABLE_MESSAGE);
    expect(jobsSend).toHaveBeenCalledWith(
      expect.objectContaining({ action: "mcp.docs.list", workspaceId: null, status: "denied" }),
    );
  });

  it("marks a read-only key's write as denied, on the action it attempted", async () => {
    const r = await callTool(connectorCtx({ scope: { readOnly: true } } as Partial<Ctx>), "docs", { action: "create", title: "x" });
    expect(r.isError).toBe(true);
    expect(jobsSend).toHaveBeenCalledWith(
      expect.objectContaining({ action: "mcp.docs.create", workspaceId: "ws1", status: "denied" }),
    );
  });

  it("records a human bearer's call as a human's, with no delegate", async () => {
    const human = connectorCtx({
      alias: "human-1",
      isAgent: false,
      onBehalfOf: undefined,
      principals: ["user:human-1", "org:ws1"],
    });
    await callTool(human, "docs", { action: "list" });
    expect(jobsSend).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "audit", action: "mcp.docs.list", actor: "human-1", actorKind: "human", onBehalfOf: null, source: "mcp" }),
    );
  });

  it("marks an allowed call ok", async () => {
    await callTool(connectorCtx(), "docs", { action: "list" });
    expect(jobsSend).toHaveBeenCalledWith(expect.objectContaining({ status: "ok" }));
  });

  it("answers the call even when the audit queue fails", async () => {
    jobsSend.mockRejectedValueOnce(new Error("queue offline"));
    const r = await callTool(connectorCtx(), "docs", { action: "list" });
    expect(r.isError).toBe(false);
  });
});
