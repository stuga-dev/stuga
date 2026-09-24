/**
 * The workspace's conventions reach a connector twice: in the `initialize`
 * instructions, before any tool call, and through `workspaces`
 * action:instructions.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@stuga/db", async (orig) => ({
  ...(await orig<typeof import("@stuga/db")>()),
  getWorkspace: vi.fn(),
  getDoc: vi.fn(),
  listDocs: vi.fn(async () => []),
  getMemberRole: vi.fn(),
  getGroupsForMember: vi.fn(async () => []),
  listWorkspacesForUser: vi.fn(async () => []),
}));

const { getWorkspace } = await import("@stuga/db");
const { handleMcpRequest } = await import("./handler.js");
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildInstructions } from "@stuga/agent-surface/instructions";
import type { AuthConfig, LocalKeys, TokenVerifier } from "@stuga/auth";
import { identifyNode } from "@stuga/mcp/node";
import { buildServer } from "@stuga/mcp/server";
import type { Ctx } from "../auth/context.js";
import { createIdentityRouter } from "../identity/routes.js";
import { memoryDb } from "../identity/testing/memory-db.js";

const mockGetWorkspace = getWorkspace as unknown as ReturnType<typeof vi.fn>;

const CONVENTIONS = "always add 中文翻译在后面\nDaily notes go in Journal/.";

function connectorCtx(overrides: Partial<Ctx> = {}): Ctx {
  return {
    sql: {},
    alias: "agent-conn-abc",
    displayName: "Connector",
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
      settings: { current: () => ({ nodeLabel: "Studio" }) },
    },
    ...overrides,
  } as unknown as Ctx;
}

/** One JSON-RPC round trip against the real MCP server. */
async function rpc(method: string, params: Record<string, unknown>, ctx = connectorCtx()): Promise<Record<string, unknown>> {
  const req = new Request("https://api.test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await (await handleMcpRequest(ctx, req)).text();
  const payload =
    text.startsWith("event:") || text.startsWith("data:") ? JSON.parse(/data: (.*)/.exec(text)![1]!) : JSON.parse(text);
  return (payload.result ?? {}) as Record<string, unknown>;
}

/** What the client is handed at handshake, before any tool exists to it. */
async function initializeInstructions(ctx = connectorCtx()): Promise<string> {
  const result = await rpc(
    "initialize",
    { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test-client", version: "0" } },
    ctx,
  );
  return String(result.instructions ?? "");
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetWorkspace.mockResolvedValue({ workspace_id: "ws1", name: "io", agent_instructions: CONVENTIONS });
});

describe("MCP initialize", () => {
  it("uses the product title, and names the node a call lands on in its first line", async () => {
    const result = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    expect(result.serverInfo).toMatchObject({ name: "stuga", title: "Stuga" });
    expect(String(result.instructions).split("\n")[0]).toBe(
      'This connection is to the Stuga node "Studio" at https://stuga.test. `workspaces` action:list names every workspace you can reach and the node each is on.',
    );
  });

  it("names each node's own name and origin, so the model knows which node a call lands on", async () => {
    const studio = connectorCtx();
    const liv = connectorCtx({
      env: { ...studio.env, publicOrigin: "http://localhost:8787", settings: { current: () => ({ nodeLabel: "Liv’s Mac" }) } } as unknown as Ctx["env"],
    });
    const [a, b] = [await initializeInstructions(liv), await initializeInstructions(studio)];
    expect(a.startsWith('This connection is to the Stuga node "Liv’s Mac" at http://localhost:8787.')).toBe(true);
    expect(b.startsWith('This connection is to the Stuga node "Studio" at https://stuga.test.')).toBe(true);
  });

  it("opens with the same first line as the stdio server, which reached the node at another of its addresses", async () => {
    const ctx = connectorCtx();
    const http = (await initializeInstructions(ctx)).split("\n")[0];

    // The stdio server asks the node's own /auth/config, served from the same settings as /mcp.
    const identity = createIdentityRouter({
      auth: {} as AuthConfig,
      publicOrigin: ctx.env.publicOrigin,
      db: memoryDb().db,
      keys: {} as LocalKeys,
      verifier: {} as TokenVerifier,
      nodeLabel: () => ctx.env.settings.current().nodeLabel,
    });
    const fetchImpl = (async (input: string | URL | Request) => identity.handle(new Request(String(input)))) as typeof fetch;
    const config = { url: "http://127.0.0.1:8787", token: "vk_abc_def", client: "claude-desktop", version: "0.3.0", nodeName: "Old name" };
    const server = buildServer({ config, node: await identifyNode(config, fetchImpl), fetch: fetchImpl });
    const client = new Client({ name: "t", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);

    const stdio = (client.getInstructions() ?? "").split("\n")[0];
    expect(stdio).toBe(http);
    expect(stdio).toContain('"Studio" at https://stuga.test.');
    expect(client.getServerVersion()).toMatchObject({ title: "Stuga" });
  });

  it("hands the workspace's conventions to the client at handshake", async () => {
    const instructions = await initializeInstructions();
    expect(instructions).toContain("always add 中文翻译在后面");
    expect(instructions).toContain("Daily notes go in Journal/.");
    expect(instructions).toMatch(/WORKSPACE CONVENTIONS/);
    expect(mockGetWorkspace).toHaveBeenCalledWith(expect.anything(), "ws1");
  });

  it("puts them before the server's own usage guide", async () => {
    const instructions = await initializeInstructions();
    expect(instructions.indexOf("WORKSPACE CONVENTIONS")).toBeLessThan(
      instructions.indexOf("Stuga lets you read and edit"),
    );
  });

  it("says nothing about conventions when the workspace wrote none", async () => {
    mockGetWorkspace.mockResolvedValue({ workspace_id: "ws1", name: "io", agent_instructions: "   " });
    const instructions = await initializeInstructions();
    expect(instructions).not.toMatch(/WORKSPACE CONVENTIONS/);
    expect(instructions).toContain("Stuga lets you read and edit");
  });

  it("tells a read-only key what it can call, after the conventions and before the usage guide", async () => {
    const instructions = await initializeInstructions(connectorCtx({ scope: { folders: null, readOnly: true, keyId: "k1" } }));
    const lead = instructions.indexOf("READ-ONLY:");
    expect(lead).toBeGreaterThan(instructions.indexOf("WORKSPACE CONVENTIONS"));
    expect(lead).toBeLessThan(instructions.indexOf("Stuga lets you read and edit"));
    expect(instructions).toContain("`markdown` action:read|status|provenance");
    expect(instructions).toContain('refused with "this key is read-only"');
  });

  it("says where the instructions set below the workspace come from, after the conventions, on both servers", async () => {
    const itemLevels =
      "Folders, databases and documents can carry their own instructions for agents, which add to the workspace's: " +
      "`markdown` action:read, `docs` action:metadata and action:create, and `databases` action:schema return the stack " +
      "that applies to that item as `instructions`, outermost first — follow them when writing there.";
    const http = await initializeInstructions();
    const stdio = buildInstructions({ variant: "stdio", node: { name: "Studio", origin: "https://stuga.test" }, conventions: CONVENTIONS });
    for (const instructions of [http, stdio]) {
      expect(instructions).toContain(itemLevels);
      expect(instructions.indexOf("ROUTING:")).toBeLessThan(instructions.indexOf("WORKSPACE CONVENTIONS"));
      expect(instructions.indexOf(itemLevels)).toBeGreaterThan(instructions.indexOf("Stuga lets you read and edit"));
    }
  });

  it("says nothing about read-only access to a key that may write", async () => {
    expect(await initializeInstructions()).not.toMatch(/READ-ONLY/);
  });

  it("still serves the connector when the workspace lookup fails", async () => {
    mockGetWorkspace.mockRejectedValue(new Error("db down"));
    const instructions = await initializeInstructions();
    expect(instructions).toContain("Stuga lets you read and edit");
    expect(instructions).not.toMatch(/WORKSPACE CONVENTIONS/);
  });
});

describe("the workspaces tool's explicit read", () => {
  it("returns the conventions verbatim for action: instructions", async () => {
    const result = await rpc("tools/call", { name: "workspaces", arguments: { action: "instructions" } });
    const text = String((result.content as Array<{ text?: string }>)?.[0]?.text ?? "");
    expect(JSON.parse(text)).toEqual({ workspace_id: "ws1", name: "io", instructions: CONVENTIONS });
  });
});
