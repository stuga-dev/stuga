import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * buildContext's API-key branch: an agent carries its own principal plus the
 * reach of the human who minted its key. The mocks record their arguments, so
 * resolving the agent's alias or the wrong workspace fails.
 */

const calls = {
  getMemberRole: [] as Array<{ workspaceId: string; alias: string }>,
  resolvePrincipals: [] as Array<{ alias: string; workspaceId: string; role: string }>,
};
let apiKeyRow: Record<string, unknown> | null = null;
let memberRole: string | null = "member";
let principalsResult: string[] = [];

vi.mock("@stuga/db", () => ({
  getDirectoryRow: () => Promise.resolve({ display_name: "Human", username: "human", email: null }),
  resolveHumanAuth: () => Promise.resolve({ user: null, membership: null, groupIds: [] }),
  getApiKey: () => Promise.resolve(apiKeyRow),
  touchApiKey: () => Promise.resolve(),
  getMemberRole: (_sql: unknown, workspaceId: string, alias: string) => {
    calls.getMemberRole.push({ workspaceId, alias });
    return Promise.resolve(memberRole);
  },
}));

vi.mock("@stuga/auth", () => ({
  extractToken: (req: Request) => req.headers.get("authorization")?.replace("Bearer ", "") ?? null,
  principalsFrom: (alias: string) => [`user:${alias}`],
  userPrincipal: (alias: string) => `user:${alias}`,
  AuthError: class AuthError extends Error {},
  looksLikeApiKey: (t: string) => t.startsWith("vk_"),
  parseApiKey: (t: string) => ({ keyId: "k1", secret: t.slice(3) }),
  sha256Hex: (s: string) => `hash:${s}`,
  constantTimeEqual: (a: string, b: string) => a === b,
  agentPrincipal: (id: string) => `agent:${id}`,
  connectorTokenKind: (t: string) => (t.startsWith("sto_") ? "access" : t.startsWith("str_") ? "refresh" : null),
  hashConnectorToken: (t: string) => `hash:${t}`,
}));

vi.mock("./principals.js", () => ({
  resolvePrincipals: (_sql: unknown, alias: string, workspaceId: string, role: string) => {
    calls.resolvePrincipals.push({ alias, workspaceId, role });
    return Promise.resolve(principalsResult);
  },
}));

const { buildContext, buildMcpCaller, Unauthorized, agentLabel } = await import("./context.js");

const env = { sql: {} } as never;
const request = () =>
  new Request("https://node.test/api/docs", { headers: { authorization: "Bearer vk_secret" } });

beforeEach(() => {
  calls.getMemberRole = [];
  calls.resolvePrincipals = [];
  memberRole = "member";
  principalsResult = ["user:owner-alias", "org:ws-pinned", "group:g1"];
  apiKeyRow = {
    key_id: "k1",
    secret_hash: "hash:secret",
    agent_id: "agent-conn-1",
    owner: "owner-alias",
    name: "Scout (Connector)",
    workspace_id: "ws-pinned",
  };
});
afterEach(() => vi.restoreAllMocks());

describe("buildContext — delegated agent authority", () => {
  it("inherits the consenting human's principals, keeping its own", async () => {
    const ctx = await buildContext(request(), env);
    expect(ctx.isAgent).toBe(true);
    expect(ctx.principals).toContain("agent:agent-conn-1");
    expect(ctx.principals).toEqual(
      expect.arrayContaining(["user:owner-alias", "org:ws-pinned", "group:g1"]),
    );
  });

  it("records the transport the key arrived on as its surface", async () => {
    expect((await buildContext(request(), env)).surface).toBe("api-key");
    expect((await buildMcpCaller(request(), env)).account.surface).toBe("mcp");
    expect((await buildContext(request(), env, "ws")).surface).toBe("ws");
  });

  it("resolves the key owner in the workspace pinned on the key", async () => {
    await buildContext(request(), env);
    expect(calls.getMemberRole).toEqual([{ workspaceId: "ws-pinned", alias: "owner-alias" }]);
    expect(calls.resolvePrincipals).toEqual([
      { alias: "owner-alias", workspaceId: "ws-pinned", role: "member" },
    ]);
  });

  it("adopts the human's current role", async () => {
    memberRole = "admin";
    expect((await buildContext(request(), env)).role).toBe("admin");
  });

  it("narrows to guest when the human is a guest", async () => {
    memberRole = "guest";
    principalsResult = ["user:owner-alias"];
    const ctx = await buildContext(request(), env);
    expect(ctx.role).toBe("guest");
    expect(ctx.principals).not.toContain("org:ws-pinned");
  });

  it("fails closed when the authorizing human left the workspace", async () => {
    memberRole = null;
    await expect(buildContext(request(), env)).rejects.toBeInstanceOf(Unauthorized);
    expect(calls.resolvePrincipals).toEqual([]);
  });

  it("de-duplicates principals", async () => {
    principalsResult = ["user:owner-alias", "agent:agent-conn-1"];
    const ctx = await buildContext(request(), env);
    expect(ctx.principals.filter((p) => p === "agent:agent-conn-1")).toHaveLength(1);
  });
});

describe("buildContext — client and model labels", () => {
  const labelled = (headers: Record<string, string>) =>
    new Request("https://node.test/api/docs", { headers: { authorization: "Bearer vk_secret", ...headers } });

  it("reads x-stuga-client and x-stuga-model into the agent's context", async () => {
    const ctx = await buildContext(
      labelled({ "x-stuga-client": "deepseek-harness", "x-stuga-model": "deepseek-v4-flash" }),
      env,
    );
    expect(ctx.client).toBe("deepseek-harness");
    expect(ctx.model).toBe("deepseek-v4-flash");
  });

  it("leaves both undefined when the headers are absent or blank", async () => {
    const plain = await buildContext(request(), env);
    expect(plain.client).toBeUndefined();
    expect(plain.model).toBeUndefined();
    const blank = await buildContext(labelled({ "x-stuga-client": "   " }), env);
    expect(blank.client).toBeUndefined();
  });

  it("trims, collapses whitespace and caps a label read from a request", async () => {
    const ctx = await buildContext(
      labelled({ "x-stuga-client": "  my\tharness   v2  ", "x-stuga-model": "m".repeat(200) }),
      env,
    );
    expect(ctx.client).toBe("my harness v2");
    expect(ctx.model).toBe("m".repeat(80));
  });

  it("strips control and format characters (agentLabel)", () => {
    // Fetch refuses such bytes in a header, so the sanitizer is called directly.
    const esc = String.fromCharCode(27);
    const zeroWidthSpace = String.fromCharCode(0x200b);
    expect(agentLabel(`dsh${esc}[31m v1${zeroWidthSpace}`)).toBe("dsh[31m v1");
    expect(agentLabel(null)).toBeUndefined();
    expect(agentLabel(" ")).toBeUndefined();
  });
});
