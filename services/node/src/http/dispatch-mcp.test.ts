/**
 * /mcp at the front door: its own credential path, a 401 that starts OAuth
 * discovery at the origin the client used, and one budget per credential. The
 * real buildMcpCaller runs; only the grant lookup and the route table are replaced.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mintConnectorToken } from "@stuga/auth";
import type { OauthGrantRow } from "@stuga/db";

const mcpHandler = vi.fn(async (_call: unknown) => new Response("mcp ok"));
const restHandler = vi.fn(async (_call: unknown) => new Response("rest ok"));

vi.mock("@stuga/db", async (orig) => ({
  ...(await orig<typeof import("@stuga/db")>()),
  grantForAccessToken: vi.fn(async () => null),
}));
vi.mock("./routes.js", () => ({
  APP_ROUTES: [
    { method: "*", path: "/mcp", auth: "mcp", handler: mcpHandler },
    { method: "*", path: /^\/api\//, auth: "workspace", handler: restHandler },
  ],
}));

const { grantForAccessToken } = await import("@stuga/db");
const { createApp } = await import("./dispatch.js");
import type { McpCaller } from "../auth/context.js";
import type { NodeEnv } from "../env.js";

const limit = vi.fn(async (_opts: { key: string }) => ({ success: true }));
const env = {
  sql: {},
  publicOrigin: "http://livs-air.local:8787",
  extraOrigins: ["https://studio.example"],
  rateLimit: { limit },
  jobs: { send: vi.fn(async () => {}) },
  verifier: { verify: vi.fn(async () => Promise.reject(new Error("not a session"))) },
} as unknown as NodeEnv;
const app = createApp(env);

const GRANT: OauthGrantRow = {
  grant_id: "grt_1",
  client_id: "https://claude.ai/oauth/client.json",
  name: "Claude",
  client_host: "claude.ai",
  owner: "liv",
  agent_id: "agent-conn-abc",
  workspace_scope: ["ws1"],
  access: "propose",
  created_at: "",
  last_used_at: null,
  revoked_at: null,
  revoked_by: null,
};

function request(path: string, token?: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://127.0.0.1:8787${path}`, {
    method: "POST",
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(grantForAccessToken).mockResolvedValue(null);
  limit.mockResolvedValue({ success: true });
});

describe("/mcp", () => {
  it("hands the handler the caller its access token resolves to", async () => {
    const access = mintConnectorToken("access");
    vi.mocked(grantForAccessToken).mockImplementation(async (_sql, hash) => (hash === access.hash ? GRANT : null));
    const res = await app.handle(request("/mcp", access.token));
    expect(await res.text()).toBe("mcp ok");
    const { caller } = mcpHandler.mock.calls[0]![0] as { caller: McpCaller };
    expect(caller).toMatchObject({ workspaces: ["ws1"], readOnly: false, account: { alias: "agent-conn-abc", onBehalfOf: "liv" } });
  });

  it("keys the budget by the credential, not a workspace, and refuses over it before the handler", async () => {
    vi.mocked(grantForAccessToken).mockResolvedValue(GRANT);
    const token = mintConnectorToken("access").token;
    await app.handle(request("/mcp", token));
    expect(limit).toHaveBeenCalledWith({ key: "mcp:agent-conn-abc" });

    limit.mockResolvedValue({ success: false });
    const res = await app.handle(request("/mcp", token));
    expect(res.status).toBe(429);
    expect(mcpHandler).toHaveBeenCalledTimes(1);
  });

  it("answers a missing, unknown or refresh token with a challenge naming the protected-resource document", async () => {
    for (const token of [undefined, mintConnectorToken("access").token, mintConnectorToken("refresh").token]) {
      const res = await app.handle(request("/mcp", token));
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe(
        'Bearer resource_metadata="http://livs-air.local:8787/.well-known/oauth-protected-resource/mcp"',
      );
    }
    expect(mcpHandler).not.toHaveBeenCalled();
  });

  it("points the challenge at the origin the client used, when it is one of this node's", async () => {
    const own = await app.handle(request("/mcp", undefined, { "x-stuga-host": "studio.example" }));
    expect(own.headers.get("www-authenticate")).toContain('"https://studio.example/.well-known/oauth-protected-resource/mcp"');
    const foreign = await app.handle(request("/mcp", undefined, { "x-stuga-host": "evil.example" }));
    expect(foreign.headers.get("www-authenticate")).toContain('"http://livs-air.local:8787/');
  });
});

describe("a REST route", () => {
  it("refuses an OAuth token with a plain 401 and no discovery challenge", async () => {
    vi.mocked(grantForAccessToken).mockResolvedValue(GRANT);
    const res = await app.handle(request("/api/docs", mintConnectorToken("access").token));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBeNull();
    expect(restHandler).not.toHaveBeenCalled();
    expect(grantForAccessToken).not.toHaveBeenCalled();
  });
});
