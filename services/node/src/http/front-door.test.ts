/**
 * The remote address's front door, table by table (spec §6): what each request gets before its body
 * is read. @stuga/db is mocked; nothing here may write, so the writing lookups are spies that must stay unused.
 */
import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError, mintApiKey, mintConnectorToken } from "@stuga/auth";

vi.mock("@stuga/db", async (orig) => ({
  ...(await orig<typeof import("@stuga/db")>()),
  isSessionLive: vi.fn(async () => true),
  isOauthAccessTokenLive: vi.fn(async () => false),
  getApiKey: vi.fn(async () => null),
  touchApiKey: vi.fn(async () => {}),
  grantForAccessToken: vi.fn(async () => null),
}));

const db = await import("@stuga/db");
const { createFrontDoor, PUBLIC_BODY_BYTES, SESSION_BODY_BYTES } = await import("./front-door.js");
const { signUpload } = await import("../databases/imports/format.js");
const { ARRIVAL_HEADER } = await import("../platform/http-server.js");
import type { Admission } from "../platform/http-server.js";
import type { NodeEnv } from "../env.js";

const REMOTE = "https://k7f3q2.stuga.test";
const SECRET = "internal-secret-for-tests";

/** Accepts "remote-jwt" at the remote address, and "lan-jwt" nowhere there: its audience is the LAN's. */
const verify = vi.fn(async (token: string, where: { arrival: string }) => {
  if (token === "remote-jwt" && where.arrival === "remote") return { alias: "liv", sid: "sess-1", claims: {} };
  throw new AuthError("bad token");
});
const env = {
  sql: {},
  verifier: { verify },
  internalSecret: SECRET,
  publicOrigin: "http://livs-air.local:8787",
  extraOrigins: [],
} as unknown as NodeEnv;

let clock = 1_800_000_000_000;
let door = createFrontDoor({ env, now: () => clock });

function at(path: string, method = "GET", headers: Record<string, string> = {}): Request {
  return new Request(REMOTE + path, { method, headers: { [ARRIVAL_HEADER]: "remote", ...headers } });
}
const json = { "content-type": "application/json" };
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function status(req: Request): Promise<number | Admission> {
  const out = await door(req);
  return out instanceof Response ? out.status : out;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.isSessionLive).mockResolvedValue(true);
  vi.mocked(db.isOauthAccessTokenLive).mockResolvedValue(false);
  vi.mocked(db.getApiKey).mockResolvedValue(null);
  clock = 1_800_000_000_000;
  door = createFrontDoor({ env, now: () => clock });
});

describe("what a visitor who has not signed in reaches", () => {
  it("is nothing at all of the issuer documents and readiness, the LAN's", async () => {
    for (const path of ["/.well-known/jwks.json", "/.well-known/openid-configuration", "/ready"]) {
      expect(await status(at(path)), path).toBe(404);
      expect(await status(at(path, "POST", json)), path).toBe(404);
    }
  });

  it("is the app's pages, sign-in's reads, discovery, the consent screen and agent installs, with no body", async () => {
    for (const path of [
      "/",
      "/w/docs/1",
      "/login",
      "/oauth/consent",
      "/auth/config",
      "/auth/oidc/callback",
      "/auth/complete",
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-protected-resource/mcp",
      "/oauth/authorize",
      "/oauth/client",
      "/api/agent-install/codex",
      `/api/docs/d1/media/${"a".repeat(64)}`,
    ]) {
      expect(await status(at(path)), path).toEqual({});
    }
    expect(await status(at("/api/docs", "OPTIONS"))).toEqual({});
  });

  it("is the sign-in endpoints, each with a small body counted as anonymous", async () => {
    for (const path of ["/auth/login", "/auth/register", "/auth/reset", "/auth/oidc/start", "/auth/oidc/handoff", "/auth/oidc/ticket", "/auth/oidc/complete", "/auth/oidc/link"]) {
      expect(await status(at(path, "POST", json)), path).toEqual({ maxBytes: PUBLIC_BODY_BYTES, anonymous: true });
    }
    for (const path of ["/auth/refresh", "/auth/logout"]) {
      expect(await status(at(path, "POST", json)), path).toEqual({ maxBytes: SESSION_BODY_BYTES, anonymous: true });
    }
    for (const path of ["/oauth/token", "/oauth/revoke", "/oauth/register"]) {
      expect(await status(at(path, "POST", { "content-type": "application/x-www-form-urlencoded" })), path).toEqual({
        maxBytes: PUBLIC_BODY_BYTES,
        anonymous: true,
      });
    }
    // Sign-out clears the media cookie whatever became of the session.
    expect(await status(at("/api/media/ticket", "DELETE"))).toEqual({ maxBytes: SESSION_BODY_BYTES, anonymous: true });
  });

  it("takes a POST to /auth/* only from this address's own pages, and only as JSON", async () => {
    expect(await status(at("/auth/login", "POST", { ...json, origin: "https://evil.test" }))).toBe(403);
    expect(await status(at("/auth/login", "POST", { ...json, origin: "http://livs-air.local:8787" }))).toBe(403);
    expect(await status(at("/auth/login", "POST", { ...json, origin: REMOTE }))).toEqual({ maxBytes: PUBLIC_BODY_BYTES, anonymous: true });
    expect(await status(at("/auth/login", "POST", { "content-type": "application/json; charset=utf-8" }))).toMatchObject({ anonymous: true });
    expect(await status(at("/auth/login", "POST", { "content-type": "text/plain" }))).toBe(415);
    expect(await status(at("/auth/logout", "POST"))).toBe(415);
    // A form post is how a page elsewhere would try it.
    expect(await status(at("/auth/register", "POST", { "content-type": "application/x-www-form-urlencoded" }))).toBe(415);
  });

  it("registers only so many clients an hour, and says when to come back", async () => {
    door = createFrontDoor({ env, now: () => clock, registrationsPerHour: 2 });
    const register = () => door(at("/oauth/register", "POST", json));
    expect(await register()).toMatchObject({ anonymous: true });
    clock += 10 * 60_000;
    expect(await register()).toMatchObject({ anonymous: true });
    const refused = await register();
    expect(refused).toBeInstanceOf(Response);
    expect((refused as Response).status).toBe(429);
    expect((refused as Response).headers.get("retry-after")).toBe(String(50 * 60));
    clock += 50 * 60_000;
    expect(await register()).toMatchObject({ anonymous: true });
  });
});

describe("everything else", () => {
  it("is refused without a credential, a body unread", async () => {
    for (const [path, method] of [
      ["/api/docs", "POST"],
      ["/api/workspaces/import", "POST"],
      ["/oauth/consent", "POST"],
      ["/auth/password", "POST"],
      ["/auth/confirm", "POST"],
      ["/auth/revoke-everything", "POST"],
      ["/auth/oidc/unlink", "POST"],
      ["/auth/no-such-route", "POST"],
      ["/api/docs", "GET"],
      ["/api/models", "GET"],
      ["/no/such/page", "POST"],
    ] as const) {
      const headers = method === "POST" && path.startsWith("/auth/") ? json : {};
      expect(await status(at(path, method, headers)), `${method} ${path}`).toBe(401);
    }
  });

  it("answers /mcp without a working credential with the OAuth challenge for this address", async () => {
    for (const req of [at("/mcp", "POST", json), at("/mcp"), at("/mcp", "POST", { ...json, ...bearer(mintConnectorToken("access").token) })]) {
      const res = (await door(req)) as Response;
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain(`${REMOTE}/.well-known/oauth-protected-resource/mcp`);
    }
  });

  it("checks a credential with a body fully, and writes nothing doing it", async () => {
    // A person's session at this address, live.
    expect(await status(at("/api/docs", "POST", bearer("remote-jwt")))).toEqual({});
    expect(vi.mocked(db.isSessionLive).mock.calls[0]![1]).toEqual({ sessionId: "sess-1", alias: "liv", arrival: "remote" });
    // Ended.
    vi.mocked(db.isSessionLive).mockResolvedValueOnce(false);
    expect(await status(at("/api/docs", "POST", bearer("remote-jwt")))).toBe(401);
    // Signed in on the LAN: its audience is not this address.
    expect(await status(at("/api/docs", "POST", bearer("lan-jwt")))).toBe(401);
    // An OAuth access token, looked up for this listener.
    const access = mintConnectorToken("access");
    vi.mocked(db.isOauthAccessTokenLive).mockResolvedValueOnce(true);
    expect(await status(at("/mcp", "POST", { ...json, ...bearer(access.token) }))).toEqual({});
    expect(vi.mocked(db.isOauthAccessTokenLive).mock.calls.at(-1)!.slice(1)).toEqual([access.hash, "remote"]);
    // A refresh token is never a bearer.
    expect(await status(at("/mcp", "POST", { ...json, ...bearer(mintConnectorToken("refresh").token) }))).toBe(401);
    // An API key works anywhere while it is live.
    const key = mintApiKey();
    const row = { key_id: key.keyId, secret_hash: key.secretHash, expires_at: null } as never;
    vi.mocked(db.getApiKey).mockResolvedValueOnce(row);
    expect(await status(at("/api/docs", "POST", bearer(key.token)))).toEqual({});
    vi.mocked(db.getApiKey).mockResolvedValueOnce({ ...(row as object), expires_at: new Date(Date.now() - 1000).toISOString() } as never);
    expect(await status(at("/api/docs", "POST", bearer(key.token)))).toBe(401);
    expect(db.touchApiKey).not.toHaveBeenCalled();
    expect(db.grantForAccessToken).not.toHaveBeenCalled();
  });

  it("checks a bodyless request's credential only where its route would not", async () => {
    // The route authenticates it; here it need only be there.
    expect(await status(at("/api/docs", "GET", bearer("anything")))).toEqual({});
    expect(verify).not.toHaveBeenCalled();
    // /api/models answers anyone on the LAN, so here the credential is checked.
    expect(await status(at("/api/models", "GET", bearer("anything")))).toBe(401);
    expect(await status(at("/api/models", "GET", bearer("remote-jwt")))).toEqual({});
  });

  it("takes a signed upload's URL as its credential, signed for this address", async () => {
    const doc = "d1";
    const upload = "upl_abc_000000000000000000";
    const mediaSig = (arrival: string) => createHmac("sha256", SECRET).update(`media-upload/${arrival}:${doc}:${upload}`).digest("hex");
    const mediaPath = (sig: string) => `/api/docs/${doc}/media/uploads/${upload}?sig=${sig}`;
    expect(await status(at(mediaPath(mediaSig("remote")), "PUT"))).toEqual({});
    expect(await status(at(mediaPath(mediaSig("local")), "PUT"))).toBe(403);
    expect(await status(at(`/api/docs/${doc}/media/uploads/${upload}`, "PUT"))).toBe(403);

    const imp = "imp_abc_000000000000000000";
    const importPath = (sig: string) => `/api/databases/db1/imports/${imp}/upload?sig=${sig}`;
    expect(await status(at(importPath(signUpload(SECRET, "remote", "db1", imp)), "PUT"))).toEqual({});
    expect(await status(at(importPath(signUpload(SECRET, "local", "db1", imp)), "PUT"))).toBe(403);
  });
});
