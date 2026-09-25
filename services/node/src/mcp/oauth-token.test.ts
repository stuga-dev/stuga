/**
 * The token endpoint (code exchange, refresh rotation), revocation, and clients
 * known by their metadata document (CIMD) rather than registered.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashConnectorToken } from "@stuga/auth";

vi.mock("@stuga/db", async (orig) => ({
  ...(await orig<typeof import("@stuga/db")>()),
  getOauthClient: vi.fn(),
  upsertMetadataClient: vi.fn(),
  consumeOauthCode: vi.fn(async () => null),
  getMemberRole: vi.fn(),
  upsertOauthGrant: vi.fn(),
  insertOauthToken: vi.fn(async () => {}),
  rotateRefreshToken: vi.fn(),
  revokeOauthTokenFamily: vi.fn(async () => {}),
}));
vi.mock("../net/outbound.js", () => ({ vetOutboundUrl: vi.fn() }));

const db = await import("@stuga/db");
const { vetOutboundUrl } = await import("../net/outbound.js");
const { ACCESS_TOKEN_TTL_SECONDS, REFRESH_TOKEN_IDLE_DAYS, SIGN_IN_MAX_DAYS, handleAuthorize, handleClientInfo, handleRevoke, handleToken } = await import(
  "./oauth.js"
);
import type { OauthClientRow, OauthGrantRow } from "@stuga/db";
import type { NodeEnv } from "../env.js";

const REGISTERED = "https://client.example.test/callback";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
/** Metadata fetches are budgeted per address; the budget answers from `budgetLeft`. */
let budgetLeft = true;
const env = {
  sql: {},
  publicOrigin: "https://stuga.test",
  extraOrigins: ["http://stuga.local:8787"],
  trustProxyHeaders: false,
  rateLimit: { limit: async () => ({ success: budgetLeft }) },
  auth: { refreshRotationGraceSeconds: 60 },
} as unknown as NodeEnv;

const dcrClient = (over: Partial<OauthClientRow> = {}): OauthClientRow => ({
  client_id: "cid_1",
  client_secret_hash: null,
  redirect_uris: [REGISTERED],
  client_name: "A Client",
  kind: "dcr",
  metadata_fetched_at: null,
  ...over,
});

const grantRow = (over: Partial<OauthGrantRow> = {}): OauthGrantRow => ({
  grant_id: "grt_1",
  client_id: "cid_1",
  name: "A Client",
  client_host: null,
  owner: "liv",
  agent_id: "agent-conn-abc",
  workspace_scope: ["ws1"],
  access: "propose",
  created_at: "2026-09-01T00:00:00Z",
  last_used_at: null,
  revoked_at: null,
  revoked_by: null,
  ...over,
});

function post(path: string, params: Record<string, string>, json = false): Request {
  return new Request(`https://stuga.test${path}`, {
    method: "POST",
    headers: { "content-type": json ? "application/json" : "application/x-www-form-urlencoded" },
    body: json ? JSON.stringify(params) : new URLSearchParams(params).toString(),
  });
}

const exchange = (over: Record<string, string> = {}, json = false) =>
  handleToken(
    env,
    post(
      "/oauth/token",
      { grant_type: "authorization_code", code: "c0de", client_id: "cid_1", redirect_uri: REGISTERED, code_verifier: VERIFIER, ...over },
      json,
    ),
  );

const refresh = (token: string, over: Record<string, string> = {}) =>
  handleToken(env, post("/oauth/token", { grant_type: "refresh_token", refresh_token: token, client_id: "cid_1", ...over }));

type TokenBody = { access_token: string; refresh_token: string; token_type: string; expires_in: number; scope: string };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.getOauthClient).mockResolvedValue(dcrClient());
  vi.mocked(db.consumeOauthCode).mockResolvedValue({
    client_id: "cid_1",
    user_alias: "liv",
    workspace_scope: ["ws1"],
    access: "propose",
    redirect_uri: REGISTERED,
  });
  vi.mocked(db.getMemberRole).mockResolvedValue("member");
  vi.mocked(db.upsertOauthGrant).mockImplementation(async (_sql, input) =>
    grantRow({
      grant_id: input.grantId,
      client_id: input.clientId,
      name: input.name,
      client_host: input.clientHost,
      owner: input.owner,
      agent_id: input.agentId,
      workspace_scope: input.workspaceScope,
      access: input.access,
    }),
  );
});

describe("POST /oauth/token, authorization_code", () => {
  it("binds the exchange to the S256 challenge of the verifier", async () => {
    vi.mocked(db.consumeOauthCode).mockResolvedValue(null);
    const res = await exchange();
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_grant" });
    expect(db.consumeOauthCode).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ clientId: "cid_1", redirectUri: REGISTERED, codeChallenge: CHALLENGE }),
    );
    expect(db.upsertOauthGrant).not.toHaveBeenCalled();
    expect(db.insertOauthToken).not.toHaveBeenCalled();
  });

  it("creates the grant from the consent and answers with an access and a refresh token", async () => {
    const res = await exchange();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as TokenBody;
    expect(body).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "mcp" });
    expect(body.access_token).toMatch(/^sto_/);
    expect(body.refresh_token).toMatch(/^str_/);
    expect(db.upsertOauthGrant).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        clientId: "cid_1",
        name: "A Client",
        clientHost: null,
        owner: "liv",
        workspaceScope: ["ws1"],
        access: "propose",
        grantId: expect.stringMatching(/^grt_/),
        agentId: expect.stringMatching(/^agent-conn-/),
      }),
    );
    const grantId = vi.mocked(db.upsertOauthGrant).mock.results[0]!.value.then((g: OauthGrantRow) => g.grant_id);
    const inserted = vi.mocked(db.insertOauthToken).mock.calls.map(([, row]) => row);
    // Only hashes are stored; both tokens start one family under the grant.
    expect(inserted).toEqual([
      expect.objectContaining({ kind: "access", tokenHash: hashConnectorToken(body.access_token), grantId: await grantId }),
      expect.objectContaining({ kind: "refresh", tokenHash: hashConnectorToken(body.refresh_token), grantId: await grantId }),
    ]);
    expect(inserted[0]!.familyId).toMatch(/^fam_/);
    expect(inserted[1]!.familyId).toBe(inserted[0]!.familyId);
  });

  it("states a lifetime, because a client that reads none may treat the token as already expired", async () => {
    const before = Date.now();
    const body = (await (await exchange()).json()) as TokenBody;
    // Google Antigravity stores a missing expires_in as a zero time and then never sends the token again.
    expect(body.expires_in).toBe(ACCESS_TOKEN_TTL_SECONDS);
    const [access, refreshRow] = vi.mocked(db.insertOauthToken).mock.calls.map(([, row]) => row);
    expect(access!.expiresAt.getTime()).toBeGreaterThanOrEqual(before + ACCESS_TOKEN_TTL_SECONDS * 1000);
    expect(access!.expiresAt.getTime()).toBeLessThan(before + ACCESS_TOKEN_TTL_SECONDS * 1000 + 60_000);
    expect(refreshRow!.expiresAt.getTime()).toBeGreaterThanOrEqual(before + REFRESH_TOKEN_IDLE_DAYS * 86_400_000);
  });

  it("issues a renewal's tokens under the grant it renewed, not a new one", async () => {
    vi.mocked(db.upsertOauthGrant).mockResolvedValue(grantRow({ grant_id: "grt_existing", agent_id: "agent-conn-kept" }));
    expect((await exchange()).status).toBe(200);
    const grantIds = vi.mocked(db.insertOauthToken).mock.calls.map(([, row]) => row.grantId);
    expect(grantIds).toEqual(["grt_existing", "grt_existing"]);
  });

  it("carries read access and an every-workspace scope into the grant", async () => {
    vi.mocked(db.consumeOauthCode).mockResolvedValue({
      client_id: "cid_1",
      user_alias: "liv",
      workspace_scope: null,
      access: "read",
      redirect_uri: REGISTERED,
    });
    expect((await exchange()).status).toBe(200);
    // "All" has no list to re-check; the connection's reach is live membership anyway.
    expect(db.getMemberRole).not.toHaveBeenCalled();
    expect(db.upsertOauthGrant).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ workspaceScope: null, access: "read" }));
  });

  it("refuses the exchange once the person has left every workspace they consented to", async () => {
    vi.mocked(db.consumeOauthCode).mockResolvedValue({
      client_id: "cid_1",
      user_alias: "liv",
      workspace_scope: ["ws1", "ws2"],
      access: "propose",
      redirect_uri: REGISTERED,
    });
    vi.mocked(db.getMemberRole).mockResolvedValue(null);
    const res = await exchange();
    expect(await res.json()).toEqual({ error: "invalid_grant" });
    expect(db.upsertOauthGrant).not.toHaveBeenCalled();
    expect(db.insertOauthToken).not.toHaveBeenCalled();
  });

  it("still exchanges while the person is in one of those workspaces", async () => {
    vi.mocked(db.consumeOauthCode).mockResolvedValue({
      client_id: "cid_1",
      user_alias: "liv",
      workspace_scope: ["ws1", "ws2"],
      access: "propose",
      redirect_uri: REGISTERED,
    });
    vi.mocked(db.getMemberRole).mockImplementation(async (_sql, ws) => (ws === "ws2" ? "member" : null));
    expect((await exchange()).status).toBe(200);
  });

  it("names the grant after a client that gave no name, and records a metadata client's host", async () => {
    vi.mocked(db.getOauthClient).mockResolvedValue(dcrClient({ client_name: "  " }));
    await exchange();
    expect(db.upsertOauthGrant).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ name: "MCP Connector", clientHost: null }));

    const cimdId = "https://client.example.com/oauth/client.json";
    vi.mocked(db.getOauthClient).mockResolvedValue(dcrClient({ client_id: cimdId, kind: "cimd", client_name: "Hosted" }));
    await exchange({ client_id: cimdId });
    expect(db.upsertOauthGrant).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ clientId: cimdId, name: "Hosted", clientHost: "client.example.com" }),
    );
  });

  it("accepts a JSON body as well as a form", async () => {
    expect((await exchange({}, true)).status).toBe(200);
  });

  it("refuses a request that is missing what the exchange binds to", async () => {
    const missing: Array<Record<string, string>> = [{ client_id: "" }, { code: "" }, { redirect_uri: "" }, { code_verifier: "short" }];
    for (const over of missing) {
      expect(await (await exchange(over)).json()).toEqual({ error: "invalid_request" });
    }
    expect(db.consumeOauthCode).not.toHaveBeenCalled();
  });

  it("refuses a grant type it does not offer", async () => {
    expect(await (await exchange({ grant_type: "client_credentials" })).json()).toEqual({ error: "unsupported_grant_type" });
  });

  it("refuses a resource that is not this node's /mcp before spending the code", async () => {
    const res = await exchange({ resource: "https://other.example.test/mcp" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_target" });
    expect(db.consumeOauthCode).not.toHaveBeenCalled();
  });

  it("accepts a resource naming this node's /mcp on any of its origins", async () => {
    expect((await exchange({ resource: "https://stuga.test/mcp" })).status).toBe(200);
    expect((await exchange({ resource: "http://stuga.local:8787/mcp" })).status).toBe(200);
  });
});

describe("POST /oauth/token, refresh_token", () => {
  /** What a rotation wrote for the pair it minted, and the family start it was given. */
  let rotatedRows: Array<{ tokenHash: string; kind: string; expiresAt: Date }> = [];
  const rotatesFrom = (startedAt: Date) =>
    vi.mocked(db.rotateRefreshToken).mockImplementation(async (_sql, input) => {
      if (input.clientId !== "cid_1") return { kind: "invalid" };
      rotatedRows = input.next(startedAt);
      return { kind: "rotated", grant: grantRow() };
    });

  beforeEach(() => {
    rotatedRows = [];
    rotatesFrom(new Date());
  });

  it("exchanges the refresh token for a new pair in one step, within the session grace", async () => {
    const presented = "str_presented";
    const res = await refresh(presented);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as TokenBody;
    expect(body).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "mcp" });
    expect(body.access_token).toMatch(/^sto_/);
    expect(body.refresh_token).toMatch(/^str_/);
    expect(body.refresh_token).not.toBe(presented);
    expect(db.rotateRefreshToken).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tokenHash: hashConnectorToken(presented), clientId: "cid_1", graceSeconds: 60 }),
    );
    // The pair is written inside the rotation, never beside it.
    expect(rotatedRows).toEqual([
      expect.objectContaining({ kind: "access", tokenHash: hashConnectorToken(body.access_token) }),
      expect.objectContaining({ kind: "refresh", tokenHash: hashConnectorToken(body.refresh_token) }),
    ]);
    expect(db.insertOauthToken).not.toHaveBeenCalled();
    // A refresh neither creates nor renews the grant.
    expect(db.upsertOauthGrant).not.toHaveBeenCalled();
  });

  it("ends a sign-in a year after it happened, however often it refreshed", async () => {
    const started = new Date(Date.now() - (SIGN_IN_MAX_DAYS - 2) * 86_400_000);
    rotatesFrom(started);
    const body = (await (await refresh("str_old")).json()) as TokenBody;
    const [access, refreshRow] = rotatedRows;
    const end = started.getTime() + SIGN_IN_MAX_DAYS * 86_400_000;
    // Two days left: the refresh token lapses then, not ninety days on; the access token still gets its hour.
    expect(refreshRow!.expiresAt.getTime()).toBe(end);
    expect(access!.expiresAt.getTime()).toBeLessThanOrEqual(end);
    expect(body.expires_in).toBe(ACCESS_TOKEN_TTL_SECONDS);
  });

  it("refuses a replayed, unknown, expired or revoked refresh token", async () => {
    for (const kind of ["replayed", "invalid"] as const) {
      vi.mocked(db.rotateRefreshToken).mockResolvedValue({ kind });
      const res = await refresh("str_spent");
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_grant" });
    }
  });

  it("refuses a refresh token presented by another client", async () => {
    vi.mocked(db.getOauthClient).mockResolvedValue(dcrClient({ client_id: "cid_other" }));
    const res = await refresh("str_presented", { client_id: "cid_other" });
    expect(await res.json()).toEqual({ error: "invalid_grant" });
    expect(db.rotateRefreshToken).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ clientId: "cid_other" }));
  });

  it("tells a client whose registration is gone to register again, before touching the token", async () => {
    vi.mocked(db.getOauthClient).mockResolvedValue(null);
    const res = await refresh("str_presented");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_client" });
    expect(db.rotateRefreshToken).not.toHaveBeenCalled();
  });

  it("requires a client_id and a refresh token", async () => {
    expect(await (await refresh("str_presented", { client_id: "" })).json()).toEqual({ error: "invalid_request" });
    expect(await (await refresh("")).json()).toEqual({ error: "invalid_request" });
    expect(db.rotateRefreshToken).not.toHaveBeenCalled();
  });

  it("refuses a resource that is not this node's /mcp before spending the token", async () => {
    expect(await (await refresh("str_presented", { resource: "https://other.example.test/mcp" })).json()).toEqual({ error: "invalid_target" });
    expect(db.rotateRefreshToken).not.toHaveBeenCalled();
  });
});

describe("POST /oauth/revoke", () => {
  it("ends the family of the token it is given", async () => {
    const res = await handleRevoke(env, post("/oauth/revoke", { token: "str_presented", token_type_hint: "refresh_token" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(db.revokeOauthTokenFamily).toHaveBeenCalledWith(expect.anything(), hashConnectorToken("str_presented"));
  });

  it("answers 200 for a token it does not know, so a caller learns nothing from it", async () => {
    for (const token of ["sto_unknown", "not-a-token"]) {
      expect((await handleRevoke(env, post("/oauth/revoke", { token }))).status).toBe(200);
    }
    expect((await handleRevoke(env, post("/oauth/revoke", { token: "sto_unknown" }, true))).status).toBe(200);
  });

  it("refuses a request that names no token", async () => {
    const res = await handleRevoke(env, post("/oauth/revoke", {}));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_request" });
    expect(db.revokeOauthTokenFamily).not.toHaveBeenCalled();
  });
});

describe("clients known by their metadata document", () => {
  const CIMD_ID = "https://client.example.com/oauth/client.json";
  const CIMD_REDIRECT = "https://client.example.com/oauth/callback";
  const fetchMock = vi.fn<typeof fetch>();

  const document = (over: Record<string, unknown> = {}) => ({
    client_id: CIMD_ID,
    client_name: "Hosted Client",
    redirect_uris: [CIMD_REDIRECT],
    token_endpoint_auth_method: "none",
    ...over,
  });
  const serve = (body: unknown, init: ResponseInit = {}) =>
    fetchMock.mockResolvedValue(
      new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init }),
    );

  const clientInfo = (clientId: string) =>
    handleClientInfo(env, new Request(`https://stuga.test/oauth/client?client_id=${encodeURIComponent(clientId)}`));
  const authorize = (clientId: string, redirectUri: string) =>
    handleAuthorize(
      env,
      new Request(
        `https://stuga.test/oauth/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=xyz&code_challenge=${CHALLENGE}`,
      ),
    );

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    vi.mocked(db.getOauthClient).mockResolvedValue(null);
    vi.mocked(vetOutboundUrl).mockImplementation(async (raw) => ({ ok: true, url: new URL(raw) }));
    vi.mocked(db.upsertMetadataClient).mockImplementation(async (_sql, input) => ({
      client_id: input.clientId,
      client_secret_hash: null,
      redirect_uris: input.redirectUris,
      client_name: input.clientName,
      kind: "cimd",
      metadata_fetched_at: new Date().toISOString(),
    }));
    serve(document());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches the document, records it and names its host as the one vouching for the client", async () => {
    const res = await clientInfo(CIMD_ID);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ client_id: CIMD_ID, client_name: "Hosted Client", verified_host: "client.example.com" });
    expect(vetOutboundUrl).toHaveBeenCalledWith(CIMD_ID);
    expect(fetchMock).toHaveBeenCalledWith(CIMD_ID, expect.objectContaining({ redirect: "manual" }));
    expect(db.upsertMetadataClient).toHaveBeenCalledWith(
      expect.anything(),
      { clientId: CIMD_ID, redirectUris: [CIMD_REDIRECT], clientName: "Hosted Client" },
    );
  });

  it("fetches no document once the address has spent its budget, so an open endpoint cannot send the node fetching without end", async () => {
    budgetLeft = false;
    try {
      const res = await clientInfo(CIMD_ID);
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("too many client lookups");
      expect(fetchMock).not.toHaveBeenCalled();
      expect(db.upsertMetadataClient).not.toHaveBeenCalled();
    } finally {
      budgetLeft = true;
    }
  });

  it("names no verified host for a client that registered itself", async () => {
    vi.mocked(db.getOauthClient).mockResolvedValue(dcrClient());
    expect(await (await clientInfo("cid_1")).json()).toEqual({ client_id: "cid_1", client_name: "A Client", verified_host: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a client it has no record of and cannot fetch", async () => {
    expect((await clientInfo("cid_unknown")).status).toBe(400);
    expect((await clientInfo("")).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lets a metadata client through authorize to the consent screen", async () => {
    const res = await authorize(CIMD_ID, CIMD_REDIRECT);
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!).searchParams.get("client_id")).toBe(CIMD_ID);
  });

  it("refuses a redirect the document does not list", async () => {
    const res = await authorize(CIMD_ID, "https://evil.example.test/callback");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("redirect_uri mismatch");
  });

  it("uses a document fetched within the last day without fetching it again", async () => {
    vi.mocked(db.getOauthClient).mockResolvedValue(
      dcrClient({ client_id: CIMD_ID, kind: "cimd", client_name: "Cached", metadata_fetched_at: new Date(Date.now() - 60 * 60 * 1000).toISOString() }),
    );
    expect(await (await clientInfo(CIMD_ID)).json()).toMatchObject({ client_name: "Cached" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.upsertMetadataClient).not.toHaveBeenCalled();
  });

  it("fetches a document again once a day has passed", async () => {
    vi.mocked(db.getOauthClient).mockResolvedValue(
      dcrClient({ client_id: CIMD_ID, kind: "cimd", client_name: "Stale", metadata_fetched_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() }),
    );
    expect(await (await clientInfo(CIMD_ID)).json()).toMatchObject({ client_name: "Hosted Client" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["http://client.example.com/oauth/client.json", "not https"],
    ["https://client.example.com/", "no path to name a document"],
    ["https://client.example.com", "no path at all"],
  ])("refuses %s as a client id (%s) without fetching it", async (clientId) => {
    const res = await clientInfo(clientId);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("unknown client_id");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a document on an address the node must not reach, without fetching it", async () => {
    vi.mocked(vetOutboundUrl).mockResolvedValue({ ok: false, reason: "refusing to reach a private or loopback address" });
    const res = await clientInfo(CIMD_ID);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/private or loopback/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a document that redirects rather than following it", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 302, headers: { location: "http://10.0.0.1/client.json" } }));
    const res = await clientInfo(CIMD_ID);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/HTTP 302/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(db.upsertMetadataClient).not.toHaveBeenCalled();
  });

  it.each([
    ["names another client_id", document({ client_id: "https://other.example.com/oauth/client.json" }), /different client_id/],
    ["lists no redirect", document({ redirect_uris: [] }), /redirect_uris/],
    ["lists a plain-http redirect off loopback", document({ redirect_uris: ["http://client.example.com/callback"] }), /redirect_uris/],
    ["wants a client secret", document({ token_endpoint_auth_method: "client_secret_basic" }), /public PKCE/],
    ["is not JSON", "<html></html>", /not JSON/],
  ])("refuses a document that %s", async (_what, body, message) => {
    serve(body);
    const res = await clientInfo(CIMD_ID);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(message);
    expect(db.upsertMetadataClient).not.toHaveBeenCalled();
  });

  it("refuses a document too large to be one", async () => {
    serve(JSON.stringify({ ...document(), padding: "x".repeat(70 * 1024) }));
    const res = await clientInfo(CIMD_ID);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/too large/);
  });

  it("accepts a document's loopback redirect on another port", async () => {
    serve(document({ redirect_uris: ["http://127.0.0.1:33418/callback"] }));
    expect((await authorize(CIMD_ID, "http://127.0.0.1:51000/callback")).status).toBe(302);
  });
});
