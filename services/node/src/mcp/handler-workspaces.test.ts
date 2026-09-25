/**
 * Per-call workspace scoping and the audit row every /mcp tool call writes. A
 * call names its workspace; one the credential cannot reach, or whose person is
 * not a member there now, is refused with one wording and never runs anywhere else.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@stuga/db", async (orig) => ({
  ...(await orig<typeof import("@stuga/db")>()),
  getDoc: vi.fn(),
  getWorkspace: vi.fn(async () => null),
  listDocs: vi.fn(async () => []),
  getMemberRole: vi.fn(),
  getGroupsForMember: vi.fn(async () => []),
  listWorkspacesForUser: vi.fn(async () => []),
  getFolderSubtreeIds: vi.fn(async (_sql: unknown, root: string) => [root, `${root}-child`]),
}));

const { getWorkspace, listDocs, getMemberRole, listWorkspacesForUser } = await import("@stuga/db");
const { WORKSPACE_UNAVAILABLE_MESSAGE } = await import("./handler.js");
const { callToolAs, mcpRequest } = await import("./testing/call.js");
import type { AccountCtx, McpCaller } from "../auth/context.js";

const mockListDocs = vi.mocked(listDocs);
const mockGetMemberRole = vi.mocked(getMemberRole);
const mockListWorkspaces = vi.mocked(listWorkspacesForUser);

const jobsSend = vi.fn(async (_message: unknown) => {});
const NODE = { id: "ktbbpahhzxoldakw", name: "Studio", origin: "https://stuga.test" };

function account(over: Partial<AccountCtx> = {}): AccountCtx {
  return {
    sql: {},
    alias: "agent-conn-abc",
    displayName: "Connector",
    surface: "mcp",
    isAgent: true,
    onBehalfOf: "human-1",
    scope: { folders: null, readOnly: false, credentialId: "grt_1" },
    env: {
      databases: { get: () => ({ fetch: vi.fn() }) },
      docs: { get: () => ({ fetch: vi.fn() }) },
      jobs: { send: jobsSend },
      aiSettings: { current: () => ({ enabled: false }) },
      publicOrigin: "https://stuga.test",
      nodeId: NODE.id,
      settings: { current: () => ({ nodeLabel: "Studio", maxBodyBytes: 1_000_000 }) },
    },
    ...over,
  } as unknown as AccountCtx;
}

/** A grant over every workspace its person belongs to. */
const grant = (over: Partial<McpCaller> = {}): McpCaller => ({ account: account(), workspaces: null, readOnly: false, ...over });
const human = (): McpCaller => ({
  account: account({ alias: "human-1", isAgent: false, onBehalfOf: undefined, scope: undefined } as Partial<AccountCtx>),
  workspaces: null,
  readOnly: false,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockListDocs.mockResolvedValue([]);
  mockGetMemberRole.mockResolvedValue("member");
});

describe("workspace_id resolution", () => {
  it("runs a call in the workspace it names, with principals derived there", async () => {
    const r = await callToolAs(grant(), "docs", { action: "list", workspace_id: "ws2" });
    expect(r.isError).toBe(false);
    expect(mockGetMemberRole).toHaveBeenCalledWith(expect.anything(), "ws2", "human-1");
    const [, principals, workspaceId] = mockListDocs.mock.calls[0]!;
    expect(workspaceId).toBe("ws2");
    expect(principals).toContain("agent:agent-conn-abc");
    expect(principals).toContain("org:ws2");
  });

  it("refuses a call that names no workspace before anything runs", async () => {
    const r = await callToolAs(grant(), "docs", { action: "list" });
    expect(r.isError).toBe(true);
    expect(mockListDocs).not.toHaveBeenCalled();
    expect(mockGetMemberRole).not.toHaveBeenCalled();
  });

  it("refuses a workspace its person is not a member of, with the fixed wording", async () => {
    mockGetMemberRole.mockResolvedValue(null);
    const r = await callToolAs(grant(), "docs", { action: "list", workspace_id: "ws-nope" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain(WORKSPACE_UNAVAILABLE_MESSAGE);
    expect(mockListDocs).not.toHaveBeenCalled();
  });

  it("refuses a workspace outside the grant with the same wording, without asking about membership", async () => {
    const r = await callToolAs(grant({ workspaces: ["ws1"] }), "docs", { action: "list", workspace_id: "ws2" });
    expect(r.text).toContain(WORKSPACE_UNAVAILABLE_MESSAGE);
    expect(mockGetMemberRole).not.toHaveBeenCalled();
    expect((await callToolAs(grant({ workspaces: ["ws1"] }), "docs", { action: "list", workspace_id: "ws1" })).isError).toBe(false);
  });

  it("keeps a minted key's folders in its own workspace, and gives it only its access elsewhere", async () => {
    const key = grant({
      workspaces: null,
      key: { workspaceId: "ws1", scope: { folders: null, readOnly: false, credentialId: "k1" } },
    });
    await callToolAs(key, "docs", { action: "list", workspace_id: "ws2" });
    expect(mockListDocs.mock.calls[0]![3]).toMatchObject({ scopeFolderIds: null });

    const confined = grant({ workspaces: ["ws1"], key: { workspaceId: "ws1", scope: { folders: ["f1"], readOnly: false, credentialId: "k2" } } });
    await callToolAs(confined, "docs", { action: "list", workspace_id: "ws1" });
    expect(mockListDocs.mock.calls[1]![3]).toMatchObject({ scopeFolderIds: ["f1", "f1-child"] });
  });

  it("resolves a person's own session against their own memberships", async () => {
    mockGetMemberRole.mockResolvedValue("admin");
    const r = await callToolAs(human(), "docs", { action: "list", workspace_id: "ws2" });
    expect(r.isError).toBe(false);
    expect(mockGetMemberRole).toHaveBeenCalledWith(expect.anything(), "ws2", "human-1");
    const [, principals] = mockListDocs.mock.calls[0]!;
    expect(principals).toContain("org:ws2");
    expect(principals).not.toContain("agent:agent-conn-abc");
  });
});

describe("workspaces tool", () => {
  it("lists the person's workspaces the grant reaches, each naming its node, with the contract version", async () => {
    mockListWorkspaces.mockResolvedValue([
      { workspace_id: "ws1", name: "Home", role: "member" },
      { workspace_id: "ws2", name: "Shared", role: "guest" },
      { workspace_id: "ws3", name: "Elsewhere", role: "member" },
    ] as never);
    const r = await callToolAs(grant({ workspaces: ["ws1", "ws2"], readOnly: true }), "workspaces", { action: "list" });
    expect(r.isError).toBe(false);
    expect(mockListWorkspaces).toHaveBeenCalledWith(expect.anything(), "human-1");
    // ws2 is out: its person is only a guest there, and a guest brings no agent in.
    expect(JSON.parse(r.text)).toEqual({
      contract: 2,
      workspaces: [{ workspace_id: "ws1", name: "Home", role: "member", access: "read", node: NODE }],
      unavailable: [],
    });
    // A person's own session lists every membership.
    const own = JSON.parse((await callToolAs(human(), "workspaces", { action: "list" })).text);
    expect(own.workspaces.map((w: { workspace_id: string }) => w.workspace_id)).toEqual(["ws1", "ws2", "ws3"]);
  });

  it("refuses an agent in a workspace where its person is only a guest, even under a grant for every workspace", async () => {
    mockGetMemberRole.mockResolvedValue("guest");
    const r = await callToolAs(grant(), "docs", { action: "list", workspace_id: "ws2" });
    expect(r.text).toContain(WORKSPACE_UNAVAILABLE_MESSAGE);
    expect(mockListDocs).not.toHaveBeenCalled();
    expect((await callToolAs(human(), "docs", { action: "list", workspace_id: "ws2" })).isError).toBe(false);
  });

  it("serves one workspace's conventions to the workspace named", async () => {
    vi.mocked(getWorkspace).mockResolvedValue({ workspace_id: "ws2", name: "Shared", agent_instructions: "Notes go in Log/." } as never);
    const r = await callToolAs(grant(), "workspaces", { action: "instructions", workspace_id: "ws2" });
    expect(JSON.parse(r.text)).toEqual({ workspace_id: "ws2", name: "Shared", instructions: "Notes go in Log/." });
  });
});

describe("initialize", () => {
  it("names the node and the workspaces in the instructions, and inlines the only workspace's conventions", async () => {
    mockListWorkspaces.mockResolvedValue([{ workspace_id: "ws1", name: "Home", role: "member" }] as never);
    vi.mocked(getWorkspace).mockResolvedValue({ workspace_id: "ws1", name: "Home", agent_instructions: "Write in British English." } as never);
    const init = await mcpRequest(grant(), "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    const { instructions, serverInfo } = init.result as { instructions: string; serverInfo: { name: string; title: string } };
    expect(serverInfo).toMatchObject({ name: "stuga", title: "Stuga" });
    expect(instructions).toContain('node "Studio" at https://stuga.test and reaches 1 workspace');
    expect(instructions).toContain('- "Home": workspace_id ws1, node "Studio", member');
    expect(instructions).toContain("WORKSPACE CONVENTIONS (written by this workspace's people; follow them):\nWrite in British English.");
  });

  it("offers a read-only grant the reading tools only", async () => {
    const all = (await mcpRequest(grant(), "tools/list")).result as { tools: Array<{ name: string }> };
    const reads = (await mcpRequest(grant({ readOnly: true }), "tools/list")).result as { tools: Array<{ name: string }> };
    expect(all.tools.map((t) => t.name)).toContain("markdown_edit");
    expect(reads.tools.map((t) => t.name)).not.toContain("markdown_edit");
    expect(reads.tools.map((t) => t.name)).toContain("markdown");
  });
});

describe("audit trail", () => {
  it("records one attributed audit row for a read, in the workspace it ran in", async () => {
    await callToolAs(grant(), "docs", { action: "list", workspace_id: "ws1" });
    expect(jobsSend).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "audit",
        source: "mcp",
        action: "mcp.docs.list",
        actor: "agent-conn-abc",
        actorKind: "agent",
        onBehalfOf: "human-1",
        workspaceId: "ws1",
        status: "ok",
      }),
    );
  });

  it("names the target when the input carries one", async () => {
    await callToolAs(grant(), "markdown", { doc_id: "d1", action: "read", workspace_id: "ws1" });
    expect(jobsSend).toHaveBeenCalledWith(expect.objectContaining({ action: "mcp.markdown.read", targetKind: "doc", targetId: "d1" }));
  });

  it("marks a call refused at workspace resolution as denied, with no workspace", async () => {
    mockGetMemberRole.mockResolvedValue(null);
    await callToolAs(grant(), "docs", { action: "list", workspace_id: "ws-nope" });
    expect(jobsSend).toHaveBeenCalledWith(expect.objectContaining({ action: "mcp.docs.list", workspaceId: null, status: "denied" }));
  });

  it("records one row per workspace a search covered", async () => {
    await callToolAs(grant(), "search", { workspace_ids: ["ws1", "ws2"], q: "x" });
    const searched = jobsSend.mock.calls.map((c) => c[0] as unknown as { action: string; workspaceId: string }).filter((m) => m.action === "mcp.search.search");
    expect(searched.map((m) => m.workspaceId).sort()).toEqual(["ws1", "ws2"]);
  });

  it("records a person's own call as a human's, with no delegate", async () => {
    await callToolAs(human(), "docs", { action: "list", workspace_id: "ws1" });
    expect(jobsSend).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "audit", action: "mcp.docs.list", actor: "human-1", actorKind: "human", onBehalfOf: null, source: "mcp" }),
    );
  });

  it("answers the call even when the audit queue fails", async () => {
    jobsSend.mockRejectedValueOnce(new Error("queue offline"));
    expect((await callToolAs(grant(), "docs", { action: "list", workspace_id: "ws1" })).isError).toBe(false);
  });
});
