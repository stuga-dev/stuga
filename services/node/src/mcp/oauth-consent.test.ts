import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@stuga/db", async (orig) => ({
  ...(await orig<typeof import("@stuga/db")>()),
  getOauthClient: vi.fn(),
  insertOauthCode: vi.fn(async () => {}),
  consumeOauthCode: vi.fn(async () => null),
  insertApiKey: vi.fn(async () => {}),
}));
vi.mock("../auth/context.js", async (orig) => ({
  ...(await orig<typeof import("../auth/context.js")>()),
  buildContext: vi.fn(),
}));

const { getOauthClient, insertOauthCode, consumeOauthCode } = await import("@stuga/db");
const { buildContext } = await import("../auth/context.js");
const { handleConsent, handleToken } = await import("./oauth.js");
import type { NodeEnv } from "../env.js";

const REGISTERED = "https://client.example.test/callback";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const env = { publicOrigin: "https://stuga.test" } as NodeEnv;

function consent(body: Record<string, unknown>): Promise<Response> {
  return handleConsent(
    env,
    new Request("https://stuga.test/oauth/consent", {
      method: "POST",
      headers: { authorization: "Bearer session", "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(buildContext).mockResolvedValue({ sql: {}, alias: "human-1", isAgent: false, workspaceId: "ws1", role: "member" } as never);
  vi.mocked(getOauthClient).mockResolvedValue({ client_id: "cid_1", client_secret_hash: null, redirect_uris: [REGISTERED], client_name: "A Client" });
});

describe("POST /oauth/consent", () => {
  it("answers deny with the registered redirect carrying access_denied and the state", async () => {
    const res = await consent({ decision: "deny", client_id: "cid_1", redirect_uri: REGISTERED, state: "xyz" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ redirect: `${REGISTERED}?error=access_denied&state=xyz` });
    expect(insertOauthCode).not.toHaveBeenCalled();
  });

  it("refuses to deny toward an address the client did not register", async () => {
    const res = await consent({ decision: "deny", client_id: "cid_1", redirect_uri: "https://evil.example.test/", state: "xyz" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid client/redirect" });
  });

  it("refuses to deny for an unknown client", async () => {
    vi.mocked(getOauthClient).mockResolvedValue(null);
    const res = await consent({ decision: "deny", client_id: "cid_nope", redirect_uri: REGISTERED });
    expect(res.status).toBe(400);
  });

  it("lets a guest deny", async () => {
    vi.mocked(buildContext).mockResolvedValue({ sql: {}, alias: "guest-1", isAgent: false, workspaceId: "ws1", role: "guest" } as never);
    const res = await consent({ decision: "deny", client_id: "cid_1", redirect_uri: REGISTERED });
    expect(await res.json()).toEqual({ redirect: `${REGISTERED}?error=access_denied` });
  });

  it("answers allow with a single-use code bound to the person and workspace", async () => {
    const res = await consent({ decision: "allow", client_id: "cid_1", redirect_uri: REGISTERED, state: "xyz", code_challenge: CHALLENGE });
    const redirect = new URL(((await res.json()) as { redirect: string }).redirect);
    expect(`${redirect.origin}${redirect.pathname}`).toBe(REGISTERED);
    expect(redirect.searchParams.get("code")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(redirect.searchParams.get("state")).toBe("xyz");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(insertOauthCode).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ clientId: "cid_1", userAlias: "human-1", workspaceId: "ws1", redirectUri: REGISTERED, codeChallenge: CHALLENGE }),
    );
  });

  it("requires a decision and, to allow, a PKCE challenge", async () => {
    expect((await consent({ client_id: "cid_1", redirect_uri: REGISTERED, code_challenge: CHALLENGE })).status).toBe(400);
    expect((await consent({ decision: "allow", client_id: "cid_1", redirect_uri: REGISTERED })).status).toBe(400);
    expect(insertOauthCode).not.toHaveBeenCalled();
  });

  it("refuses an agent key and a guest's allow", async () => {
    vi.mocked(buildContext).mockResolvedValue({ sql: {}, alias: "agent-1", isAgent: true, workspaceId: "ws1", role: "member" } as never);
    expect((await consent({ decision: "deny", client_id: "cid_1", redirect_uri: REGISTERED })).status).toBe(401);
    vi.mocked(buildContext).mockResolvedValue({ sql: {}, alias: "guest-1", isAgent: false, workspaceId: "ws1", role: "guest" } as never);
    expect((await consent({ decision: "allow", client_id: "cid_1", redirect_uri: REGISTERED, code_challenge: CHALLENGE })).status).toBe(403);
    expect(insertOauthCode).not.toHaveBeenCalled();
  });

  it("requires a signed-in person", async () => {
    const res = await handleConsent(env, new Request("https://stuga.test/oauth/consent", { method: "POST", body: "{}" }));
    expect(res.status).toBe(401);
    expect(buildContext).not.toHaveBeenCalled();
  });
});

describe("POST /oauth/token", () => {
  it("binds the exchange to the S256 challenge of the verifier", async () => {
    const res = await handleToken(
      { ...env, sql: {} } as NodeEnv,
      new Request("https://stuga.test/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: "c0de",
          client_id: "cid_1",
          redirect_uri: REGISTERED,
          code_verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
        }).toString(),
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_grant" });
    expect(consumeOauthCode).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ clientId: "cid_1", codeChallenge: CHALLENGE }));
  });

  it("states a lifetime, because a client that reads none may treat the token as already expired", async () => {
    vi.mocked(consumeOauthCode).mockResolvedValue({ user_alias: "human-1", workspace_id: "ws1" } as never);
    const res = await handleToken(
      { ...env, sql: {} } as NodeEnv,
      new Request("https://stuga.test/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: "c0de",
          client_id: "cid_1",
          redirect_uri: REGISTERED,
          code_verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
        }).toString(),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { access_token: string; token_type: string; expires_in: number };
    expect(body.token_type).toBe("Bearer");
    expect(body.access_token).toMatch(/^vk_/);
    // Google Antigravity stores a missing expires_in as a zero time and then never sends the token again.
    expect(body.expires_in).toBeGreaterThan(0);
  });
});
