/**
 * Which bearer opens which door. An OAuth access token (`sto_`) is for /mcp
 * alone, a refresh token (`str_`) is for /oauth/token alone, and the REST and
 * socket paths refuse both before any lookup. @stuga/auth is real, so the
 * shipped prefixes and hash decide.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mintApiKey, mintConnectorToken } from "@stuga/auth";
import type { OauthGrantRow } from "@stuga/db";

vi.mock("@stuga/db", async (orig) => ({
  ...(await orig<typeof import("@stuga/db")>()),
  grantForAccessToken: vi.fn(),
  getApiKey: vi.fn(async () => null),
  touchApiKey: vi.fn(async () => {}),
  getDirectoryRow: vi.fn(async () => ({ display_name: "Liv", username: "liv", email: null })),
  resolveHumanAuth: vi.fn(async () => ({
    user: { display_name: "Liv", username: "liv", email: null },
    membership: { workspace_id: "ws1", role: "member" },
    groupIds: [],
  })),
}));

const { grantForAccessToken, getApiKey, getDirectoryRow } = await import("@stuga/db");
const { buildAccountContext, buildContext, buildMcpCaller, Unauthorized } = await import("./context.js");

const verify = vi.fn(async () => ({ alias: "liv", claims: {} }));
const env = { sql: {}, verifier: { verify } } as never;

const bearer = (token: string, path = "/mcp") =>
  new Request(`https://node.test${path}`, { headers: { authorization: `Bearer ${token}` } });

function grantRow(over: Partial<OauthGrantRow> = {}): OauthGrantRow {
  return {
    grant_id: "grt_1",
    client_id: "https://claude.ai/oauth/client.json",
    name: "Claude",
    client_host: "claude.ai",
    owner: "liv",
    agent_id: "agent-conn-abc",
    workspace_scope: ["ws1", "ws2"],
    access: "propose",
    created_at: "",
    last_used_at: null,
    revoked_at: null,
    revoked_by: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(grantForAccessToken).mockResolvedValue(null);
});

describe("an OAuth access token", () => {
  it("opens /mcp as its grant's agent, acting for its person over the workspaces they chose", async () => {
    const access = mintConnectorToken("access");
    vi.mocked(grantForAccessToken).mockImplementation(async (_sql, hash) => (hash === access.hash ? grantRow() : null));
    const caller = await buildMcpCaller(bearer(access.token), env);
    expect(caller.account).toMatchObject({
      isAgent: true,
      surface: "mcp",
      alias: "agent-conn-abc",
      displayName: "Claude",
      onBehalfOf: "liv",
      scope: { folders: null, readOnly: false, credentialId: "grt_1" },
    });
    expect(caller.workspaces).toEqual(["ws1", "ws2"]);
    expect(caller.readOnly).toBe(false);
    expect(caller.key).toBeUndefined();
    // Looked up by its hash; the token itself is never stored or compared.
    expect(vi.mocked(grantForAccessToken).mock.calls[0]![1]).toBe(access.hash);
  });

  it("carries a read grant's access, and an all-workspaces grant as null", async () => {
    vi.mocked(grantForAccessToken).mockResolvedValue(grantRow({ access: "read", workspace_scope: null }));
    const caller = await buildMcpCaller(bearer(mintConnectorToken("access").token), env);
    expect(caller.readOnly).toBe(true);
    expect(caller.account.scope?.readOnly).toBe(true);
    expect(caller.workspaces).toBeNull();
  });

  it("is refused on /mcp when no live grant stands behind it (unknown, expired or revoked)", async () => {
    await expect(buildMcpCaller(bearer(mintConnectorToken("access").token), env)).rejects.toBeInstanceOf(Unauthorized);
  });

  it("is refused by REST and sockets before any lookup", async () => {
    const token = mintConnectorToken("access").token;
    vi.mocked(grantForAccessToken).mockResolvedValue(grantRow());
    await expect(buildContext(bearer(token, "/api/docs"), env)).rejects.toBeInstanceOf(Unauthorized);
    await expect(buildContext(bearer(token, "/ws/d1"), env, "ws")).rejects.toBeInstanceOf(Unauthorized);
    await expect(buildAccountContext(bearer(token, "/api/workspaces"), env)).rejects.toBeInstanceOf(Unauthorized);
    expect(grantForAccessToken).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  });
});

describe("an OAuth refresh token", () => {
  it("is refused as a bearer on /mcp without a lookup", async () => {
    vi.mocked(grantForAccessToken).mockResolvedValue(grantRow());
    const refresh = mintConnectorToken("refresh").token;
    await expect(buildMcpCaller(bearer(refresh), env)).rejects.toThrow(/refresh token/);
    await expect(buildMcpCaller(bearer(refresh), env)).rejects.toBeInstanceOf(Unauthorized);
    expect(grantForAccessToken).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  });

  it("is refused by REST too", async () => {
    await expect(buildContext(bearer(mintConnectorToken("refresh").token, "/api/docs"), env)).rejects.toBeInstanceOf(Unauthorized);
    expect(verify).not.toHaveBeenCalled();
  });
});

describe("the other credentials on /mcp", () => {
  function keyRow(minted: ReturnType<typeof mintApiKey>, over: Record<string, unknown> = {}) {
    return {
      key_id: minted.keyId,
      secret_hash: minted.secretHash,
      agent_id: "agent-k1",
      owner: "liv",
      workspace_id: "ws1",
      name: "CI",
      scope_folders: null,
      access: "propose",
      expires_at: null,
      ...over,
    } as never;
  }

  it("keeps a folder-confined key in its own workspace, and lets an unconfined one reach its person's workspaces", async () => {
    const confined = mintApiKey();
    vi.mocked(getApiKey).mockResolvedValue(keyRow(confined, { scope_folders: ["f1"], access: "read" }));
    const c = await buildMcpCaller(bearer(confined.token), env);
    expect(c.workspaces).toEqual(["ws1"]);
    expect(c.readOnly).toBe(true);
    expect(c.key).toEqual({ workspaceId: "ws1", scope: { folders: ["f1"], readOnly: true, credentialId: confined.keyId } });

    const open = mintApiKey();
    vi.mocked(getApiKey).mockResolvedValue(keyRow(open));
    const o = await buildMcpCaller(bearer(open.token), env);
    expect(o.workspaces).toBeNull();
    expect(o.readOnly).toBe(false);
    expect(o.account).toMatchObject({ isAgent: true, surface: "mcp", onBehalfOf: "liv" });
  });

  it("takes a person's session as that person over every workspace they belong to", async () => {
    const caller = await buildMcpCaller(bearer("session-jwt"), env);
    expect(caller).toMatchObject({ workspaces: null, readOnly: false });
    expect(caller.account).toMatchObject({ isAgent: false, surface: "mcp", alias: "liv", displayName: "Liv" });
  });

  it("refuses a session whose account no longer exists", async () => {
    vi.mocked(getDirectoryRow).mockResolvedValueOnce(null);
    await expect(buildMcpCaller(bearer("session-jwt"), env)).rejects.toBeInstanceOf(Unauthorized);
  });
});
