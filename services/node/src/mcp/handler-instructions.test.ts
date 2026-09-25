/**
 * What a connector is handed at `initialize`, before any tool call: the node it
 * is connected to, the workspaces it reaches, and the conventions of its only
 * workspace. With several, `workspaces` action:instructions serves each.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@stuga/db", async (orig) => ({
  ...(await orig<typeof import("@stuga/db")>()),
  getWorkspace: vi.fn(),
  listWorkspacesForUser: vi.fn(),
}));
vi.mock("../auth/context.js", async (orig) => ({
  ...(await orig<typeof import("../auth/context.js")>()),
  workspaceContextFor: vi.fn(),
}));

const { getWorkspace, listWorkspacesForUser } = await import("@stuga/db");
const { workspaceContextFor } = await import("../auth/context.js");
const { callerFor, resolvingTo, callToolAs, mcpRequest } = await import("./testing/call.js");
import type { Ctx, McpCaller } from "../auth/context.js";

const mockGetWorkspace = vi.mocked(getWorkspace);
const mockListWorkspaces = vi.mocked(listWorkspacesForUser);

const CONVENTIONS = "always add 中文翻译在后面\nDaily notes go in Journal/.";
const USAGE = "Stuga lets you read and edit";
const IO = { workspace_id: "ws1", name: "io", role: "member" };
const SHARED = { workspace_id: "ws2", name: "Shared", role: "member" };

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
      jobs: { send: vi.fn(async () => {}) },
      aiSettings: { current: () => ({ enabled: false }) },
      publicOrigin: "https://stuga.test",
      nodeId: "ktbbpahhzxoldakw",
      settings: { current: () => ({ nodeLabel: "Studio", maxBodyBytes: 1_000_000 }) },
    },
    ...overrides,
  } as unknown as Ctx;
}

/** What the client is handed at handshake, before any tool exists to it. */
async function initialize(caller: McpCaller = callerFor(connectorCtx())): Promise<{ instructions: string; serverInfo: unknown }> {
  const { result } = await mcpRequest(caller, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test-client", version: "0" },
  });
  const { instructions, serverInfo } = result as { instructions?: string; serverInfo: unknown };
  return { instructions: String(instructions ?? ""), serverInfo };
}

const initializeInstructions = async (caller?: McpCaller): Promise<string> => (await initialize(caller)).instructions;

beforeEach(() => {
  vi.clearAllMocks();
  mockListWorkspaces.mockResolvedValue([IO] as never);
  mockGetWorkspace.mockResolvedValue({ workspace_id: "ws1", name: "io", agent_instructions: CONVENTIONS } as never);
});

describe("MCP initialize", () => {
  it("uses the product title, and opens with where to look before saying there is no access", async () => {
    const { serverInfo, instructions } = await initialize();
    expect(serverInfo).toMatchObject({ name: "stuga", title: "Stuga" });
    // Clients that show only the first 512 characters still show all of it, whatever the node is called.
    expect(instructions.startsWith("ROUTING: ")).toBe(true);
    expect(instructions.indexOf("\n\n")).toBeLessThan(512);
  });

  it("names each node's own name and origin, so the model knows which node a call lands on", async () => {
    const studio = connectorCtx();
    const liv = connectorCtx({
      env: {
        ...studio.env,
        publicOrigin: "http://localhost:8787",
        settings: { current: () => ({ nodeLabel: "Liv’s Mac", maxBodyBytes: 1_000_000 }) },
      } as unknown as Ctx["env"],
    });
    const [a, b] = [await initializeInstructions(callerFor(liv)), await initializeInstructions(callerFor(studio))];
    const tail = " and reaches 1 workspace; every tool names the `workspace_id` it acts in.";
    expect(a).toContain(`This connection is to the Stuga node "Liv’s Mac" at http://localhost:8787${tail}`);
    expect(b).toContain(`This connection is to the Stuga node "Studio" at https://stuga.test${tail}`);
    expect(b.indexOf("ROUTING:")).toBeLessThan(b.indexOf("This connection is to"));
  });

  it("lists every workspace the connection reaches, with its id, node and the person's role", async () => {
    mockListWorkspaces.mockResolvedValue([IO, SHARED] as never);
    const instructions = await initializeInstructions();
    expect(mockListWorkspaces).toHaveBeenCalledWith(expect.anything(), "human-1");
    expect(instructions).toContain("reaches 2 workspaces;");
    expect(instructions).toContain(
      'WORKSPACES (`workspaces` action:list refreshes this):\n- "io": workspace_id ws1, node "Studio", member\n' +
        '- "Shared": workspace_id ws2, node "Studio", member\n',
    );
  });

  it("leaves out the workspaces a grant was not given, and counts only the ones it was", async () => {
    mockListWorkspaces.mockResolvedValue([IO, SHARED] as never);
    mockGetWorkspace.mockResolvedValue({ workspace_id: "ws2", name: "Shared", agent_instructions: "Notes go in Log/." } as never);
    const instructions = await initializeInstructions(callerFor(connectorCtx(), { workspaces: ["ws2"] }));
    expect(instructions).toContain("reaches 1 workspace;");
    expect(instructions).toContain("workspace_id ws2");
    expect(instructions).not.toContain("workspace_id ws1");
    expect(instructions).toContain("WORKSPACE CONVENTIONS (written by this workspace's people; follow them):\nNotes go in Log/.");
    expect(mockGetWorkspace).toHaveBeenCalledWith(expect.anything(), "ws2");
  });

  it("says the connection reaches no workspace yet, rather than showing an empty table", async () => {
    mockListWorkspaces.mockResolvedValue([] as never);
    const instructions = await initializeInstructions();
    expect(instructions).toContain("reaches 0 workspaces;");
    expect(instructions).toContain("WORKSPACES: none yet");
    expect(instructions).not.toMatch(/WORKSPACE CONVENTIONS/);
    expect(mockGetWorkspace).not.toHaveBeenCalled();
  });

  it("hands the only workspace's conventions to the client at handshake", async () => {
    const instructions = await initializeInstructions();
    expect(instructions).toContain("always add 中文翻译在后面");
    expect(instructions).toContain("Daily notes go in Journal/.");
    expect(instructions).toMatch(/WORKSPACE CONVENTIONS/);
    expect(mockGetWorkspace).toHaveBeenCalledWith(expect.anything(), "ws1");
  });

  it("puts them after the workspace table and before the server's own usage guide", async () => {
    const instructions = await initializeInstructions();
    const conventions = instructions.indexOf("WORKSPACE CONVENTIONS");
    expect(instructions.indexOf("WORKSPACES (")).toBeLessThan(conventions);
    expect(conventions).toBeLessThan(instructions.indexOf(USAGE));
  });

  it("points at each workspace's conventions instead of inlining one, when the connection reaches several", async () => {
    mockListWorkspaces.mockResolvedValue([IO, SHARED] as never);
    const instructions = await initializeInstructions();
    expect(instructions).not.toMatch(/WORKSPACE CONVENTIONS/);
    expect(instructions).toContain("read them with `workspaces` action:instructions before writing there");
    expect(mockGetWorkspace).not.toHaveBeenCalled();
  });

  it("says nothing about conventions when the workspace wrote none", async () => {
    mockGetWorkspace.mockResolvedValue({ workspace_id: "ws1", name: "io", agent_instructions: "   " } as never);
    const instructions = await initializeInstructions();
    expect(instructions).not.toMatch(/WORKSPACE CONVENTIONS/);
    expect(instructions).not.toContain("`workspaces` action:instructions before writing there");
    expect(instructions).toContain(USAGE);
  });

  it("tells a read-only connection it may only read, after the conventions and before the usage guide", async () => {
    const instructions = await initializeInstructions(callerFor(connectorCtx(), { readOnly: true }));
    const lead = instructions.indexOf("READ-ONLY:");
    expect(lead).toBeGreaterThan(instructions.indexOf("WORKSPACE CONVENTIONS"));
    expect(lead).toBeLessThan(instructions.indexOf(USAGE));
    expect(instructions).toContain("may change nothing, so only reading tools are offered");
    expect(instructions).toContain('- "io": workspace_id ws1, node "Studio", member, read only');
  });

  it("says where the instructions set below the workspace come from, after the conventions", async () => {
    const itemLevels =
      "Folders, databases and documents can carry their own instructions for agents, which add to the workspace's: " +
      "`markdown` action:read, `docs` action:metadata, `docs_create` and `databases` action:schema return the stack " +
      "that applies to that item as `instructions`, outermost first — follow them when writing there.";
    const instructions = await initializeInstructions();
    expect(instructions).toContain(itemLevels);
    expect(instructions.indexOf("ROUTING:")).toBeLessThan(instructions.indexOf("WORKSPACE CONVENTIONS"));
    expect(instructions.indexOf(itemLevels)).toBeGreaterThan(instructions.indexOf(USAGE));
  });

  it("says nothing about read-only access to a connection that may write", async () => {
    const instructions = await initializeInstructions();
    expect(instructions).not.toMatch(/READ-ONLY/);
    expect(instructions).not.toContain("read only");
  });

  it("still serves the connector when the workspace lookup fails", async () => {
    mockGetWorkspace.mockRejectedValue(new Error("db down"));
    const instructions = await initializeInstructions();
    expect(instructions).toContain(USAGE);
    expect(instructions).toContain("workspace_id ws1");
    expect(instructions).not.toMatch(/WORKSPACE CONVENTIONS/);
  });
});

describe("the workspaces tool's explicit read", () => {
  it("returns the conventions verbatim for action: instructions", async () => {
    const ctx = connectorCtx();
    vi.mocked(workspaceContextFor).mockImplementation(resolvingTo(ctx));
    const r = await callToolAs(callerFor(ctx), "workspaces", { action: "instructions", workspace_id: "ws1" });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.text)).toEqual({ workspace_id: "ws1", name: "io", instructions: CONVENTIONS });
  });

  it("asks which workspace when action: instructions names none", async () => {
    const r = await callToolAs(callerFor(connectorCtx()), "workspaces", { action: "instructions" });
    expect(r.isError).toBe(true);
    expect(r.text).toBe("error: this call needs a `workspace_id` — `workspaces` action:list names the ones you can use");
    expect(workspaceContextFor).not.toHaveBeenCalled();
  });
});
