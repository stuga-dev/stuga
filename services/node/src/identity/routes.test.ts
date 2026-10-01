import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jwtVerify, createLocalJWKSet } from "jose";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createHashQueue,
  createVerifier,
  hashRefreshToken,
  loadOrCreateSigningKey,
  publicJwks,
  sha256Hex,
  type AuthConfig,
  type HashLane,
  type LocalKeys,
} from "@stuga/auth";
import { SEARCH_LANGUAGES } from "@stuga/protocol/domain/search-languages";
import { ARRIVAL_HEADER, PEER_ADDRESS_HEADER } from "../platform/http-server.js";
import { slidingWindowRateLimiter } from "../platform/rate-limit.js";
import { createIdentityRouter, type IdentityDeps, type IdentityEvent, type TokenPair } from "./routes.js";
import { memoryDb } from "./testing/memory-db.js";

const keyDir = mkdtempSync(join(tmpdir(), "stuga-identity-"));
let keys: LocalKeys;
afterAll(() => rmSync(keyDir, { recursive: true, force: true }));

const ORIGIN = "http://localhost:8787";

/** The setup code every unclaimed node here has, as the node keeps it and as a person types it. */
const SETUP_CODE = "ABCDE12345";
const TYPED_CODE = "abcde-12345";

/** Strict rotation by default; the grace window has its own describe. */
const localAuth: AuthConfig = {
  issuer: ORIGIN,
  audience: "stuga",
  keyFile: join(keyDir, "signing.jwk"),
  accessTokenTtlSeconds: 3600,
  refreshTokenTtlSeconds: 60,
  refreshRotationGraceSeconds: 0,
};

let mem: ReturnType<typeof memoryDb>;
/** What the router reported through `onInviteRedeemed`, in order. */
let joined: { alias: string; tokenHash: string; workspaceId: string; role: string }[];
/** What it reported through `onIdentityChange`. */
let identityEvents: IdentityEvent[];

/** The dependencies every router here shares; a test overrides what it is about. */
function baseDeps(extra: Partial<IdentityDeps> = {}): IdentityDeps {
  return {
    auth: localAuth,
    publicOrigin: ORIGIN,
    db: mem.db,
    keys,
    verifier: createVerifier(localAuth, keys),
    onInviteRedeemed: (event) => joined.push(event),
    onIdentityChange: (event) => identityEvents.push(event),
    setupCode: () => SETUP_CODE,
    ...extra,
  };
}

function routerWith(auth: Partial<AuthConfig>) {
  return createIdentityRouter(baseDeps({ auth: { ...localAuth, ...auth } }));
}

function router() {
  return routerWith({});
}

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(ORIGIN + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

/** Long and hard to guess: what signs in at the remote address. */
const STRONG = "trumpet walnut ceiling";

/** Carries the setup code, which only the first account needs; a later one's is ignored. */
async function register(username = "ada", extra: Record<string, unknown> = {}) {
  return router().handle(
    post("/auth/register", { username, password: "correct horse", name: "Ada", setup_code: TYPED_CODE, ...extra }),
  );
}

beforeEach(async () => {
  keys ??= await loadOrCreateSigningKey(localAuth.keyFile);
  mem = memoryDb();
  joined = [];
  identityEvents = [];
});

describe("register", () => {
  it("first account becomes admin and gets a verifiable token pair", async () => {
    const res = await register();
    expect(res.status).toBe(201);
    const pair = (await res.json()) as TokenPair;
    expect(pair.expires_in).toBe(3600);
    expect(pair.refresh_token).toMatch(/\S{20,}/);

    const jwks = createLocalJWKSet(publicJwks(keys));
    const { payload } = await jwtVerify(pair.access_token, jwks, { issuer: ORIGIN, audience: "stuga" });
    const account = await mem.db.findAccountByUsername("ada");
    expect(payload.sub).toBe(account!.alias);
    expect(payload["preferred_username"]).toBe("ada");
    expect(payload).not.toHaveProperty("email");
    expect(payload["token_use"]).toBe("access");
    // The first registration writes a bootstrap node-admin grant.
    expect(mem.admins.has(account!.alias)).toBe(true);
  });

  it("stores setup's search languages with the account that claims the node, and nobody else's", async () => {
    let firstAccounts = 0;
    const r = () => createIdentityRouter(baseDeps({ onFirstAccount: () => void firstAccounts++ }));
    const body = (username: string, extra: Record<string, unknown>) => ({ username, password: "correct horse", setup_code: TYPED_CODE, ...extra });
    expect((await r().handle(post("/auth/register", body("ada", { search_languages: ["ko", "fr", "ar"] })))).status).toBe(201);
    expect(mem.settings.searchLanguages).toEqual(["ar", "fr", "ko"]);
    // The node rebuilds its search indexes for them once the account is made.
    expect(firstAccounts).toBe(1);

    mem.invites.set(sha256Hex("an-invite"), { tokenHash: sha256Hex("an-invite"), usesLeft: 1 });
    expect((await r().handle(post("/auth/register", body("grace", { invite: "an-invite", search_languages: [] })))).status).toBe(201);
    expect(mem.settings.searchLanguages).toEqual(["ar", "fr", "ko"]);
    expect(firstAccounts).toBe(1);

    // None chosen is a choice; not sending the field leaves the node's alone.
    mem = memoryDb();
    expect((await register("ada", { search_languages: [] })).status).toBe(201);
    expect(mem.settings.searchLanguages).toEqual([]);
    mem = memoryDb();
    expect((await register("ada")).status).toBe(201);
    expect(mem.settings.searchLanguages).toBeNull();
  });

  it("refuses search languages that are not a list of the choices", async () => {
    for (const search_languages of ["ko", ["ko", "en"], [null], { ko: true }, null]) {
      const res = await register("ada", { search_languages });
      expect(res.status, JSON.stringify(search_languages)).toBe(400);
      expect((await res.json()).message).toContain(`search_languages must be a list of: ${SEARCH_LANGUAGES.join(", ")}`);
    }
    expect(mem.accounts.size).toBe(0);
  });

  it("claiming the node needs its setup code, typed however loosely", async () => {
    const none = await register("ada", { setup_code: undefined });
    expect(none.status).toBe(403);
    expect((await none.json()).error).toBe("setup_code_required");

    const wrong = await register("ada", { setup_code: "ABCDE-12346" });
    expect(wrong.status).toBe(403);
    expect((await wrong.json()).error).toBe("setup_code_invalid");
    expect(mem.accounts.size).toBe(0);

    // Case, spaces and dashes do not matter, nor O typed for 0 or I and L for 1.
    const loose = await router().handle(
      post("/auth/register", { username: "ada", password: "correct horse", setup_code: " abcde 1234 5 " }),
    );
    expect(loose.status).toBe(201);
    expect(mem.admins.size).toBe(1);
  });

  it("reads O as 0 and I or L as 1 in a typed code", async () => {
    const r = createIdentityRouter(baseDeps({ setupCode: () => "0A1B2C3D4E" }));
    const res = await r.handle(post("/auth/register", { username: "ada", password: "correct horse", setup_code: "oa-ib2c3d4e" }));
    expect(res.status).toBe(201);
  });

  it("nobody can claim a node that has no setup code", async () => {
    const r = createIdentityRouter(baseDeps({ setupCode: () => null }));
    const res = await r.handle(post("/auth/register", { username: "ada", password: "correct horse", setup_code: TYPED_CODE }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("setup_code_invalid");
    expect(mem.accounts.size).toBe(0);
  });

  it("a registration without the code never becomes the first account, whatever it raced past", async () => {
    // What the router's early check would have let through had the node been claimed a moment before.
    const made = await mem.db.createLocalAccount({ alias: "u1", username: "eve", passwordHash: "x", displayName: "Eve" });
    expect(made).toEqual({ ok: false, reason: "setup_code_required" });
    expect(mem.accounts.size).toBe(0);
  });

  it("validates username and password", async () => {
    for (const bad of ["a", "ada lovelace", "ada@example.com", ".ada", ""]) {
      const res = await register(bad);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("invalid_username");
    }
    expect((await register("ada", { password: "short" })).status).toBe(400);
  });

  it("stores the username normalized, and names the account after it when no name is given", async () => {
    const res = await router().handle(post("/auth/register", { username: "  Ada.L ", password: "correct horse", setup_code: TYPED_CODE }));
    expect(res.status).toBe(201);
    const account = (await mem.db.findAccountByUsername("ada.l"))!;
    expect(await mem.db.displayNameOf(account.alias)).toBe("ada.l");
  });

  it("after the first account, creating one needs an invite link that is still valid", async () => {
    await register();

    const none = await register("bob");
    expect(none.status).toBe(403);
    expect((await none.json()).error).toBe("invite_required");

    const unknown = await register("bob", { invite: "never-minted" });
    expect(unknown.status).toBe(403);
    expect((await unknown.json()).error).toBe("invite_invalid");
    expect(await mem.db.findAccountByUsername("bob")).toBeNull();
  });

  it("admits a valid invite, consumes it, reports the join, and grants no node admin", async () => {
    await register();
    const token = "invite-token-1";
    mem.invites.set(sha256Hex(token), { tokenHash: "", usesLeft: 1 });
    const res = await register("bob", { invite: token });
    expect(res.status).toBe(201);
    const bob = (await mem.db.findAccountByUsername("bob"))!;
    expect(mem.admins.has(bob.alias)).toBe(false);
    expect(joined).toEqual([{ alias: bob.alias, tokenHash: sha256Hex(token), workspaceId: "w1", role: "member" }]);
    // A second use of a single-use invite is refused before the account exists.
    const again = await register("carol", { invite: token });
    expect(again.status).toBe(403);
    expect(joined).toHaveLength(1);
  });

  it("makes an account from a link with no limit or no expiry only on the node's own network", async () => {
    await register();
    const token = "open-link";
    mem.invites.set(sha256Hex(token), { tokenHash: "", usesLeft: 100, localOnly: true });
    const remote = { [ARRIVAL_HEADER]: "remote", [PEER_ADDRESS_HEADER]: "203.0.113.7" };
    const res = await router().handle(
      new Request("https://k7f3q2.stuga.test/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json", ...remote },
        body: JSON.stringify({ username: "mallory", password: STRONG, invite: token }),
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "invite_local_only", message: "This invite link works only on this node's network." });
    expect(await mem.db.findAccountByUsername("mallory")).toBeNull();
    // The same link on the node's own network.
    expect((await register("bob", { invite: token })).status).toBe(201);
  });

  it("a single-use invite makes one account however many registrations race past the check", async () => {
    await register();
    const token = "invite-once";
    mem.invites.set(sha256Hex(token), { tokenHash: "", usesLeft: 1 });
    const results = await Promise.all(["bob", "carol", "dave"].map((name) => register(name, { invite: token })));
    expect(results.map((r) => r.status).sort()).toEqual([201, 403, 403]);
    for (const refused of results.filter((r) => r.status === 403)) expect((await refused.json()).error).toBe("invite_invalid");
    expect(mem.accounts.size).toBe(2);
    expect(joined).toHaveLength(1);
  });

  it("of several registrations racing on an unclaimed node, one becomes its administrator and the rest need an invite", async () => {
    const results = await Promise.all(["ada", "bob", "carol"].map((name) => register(name)));
    expect(results.map((r) => r.status).sort()).toEqual([201, 403, 403]);
    for (const refused of results.filter((r) => r.status === 403)) expect((await refused.json()).error).toBe("invite_required");
    expect(mem.accounts.size).toBe(1);
    expect(mem.admins.size).toBe(1);
  });

  it("the first account needs no invite, and a stale one it carries redeems nothing", async () => {
    const res = await register("ada", { invite: "left-over" });
    expect(res.status).toBe(201);
    expect(joined).toEqual([]);
  });

  it("a taken username answers 409 with the nearest free one, whatever its case", async () => {
    await register();
    mem.invites.set(sha256Hex("invite-token-2"), { tokenHash: "", usesLeft: 1 });
    const res = await register("ADA", { invite: "invite-token-2" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "username_taken", suggestion: "ada-2" });
  });

  it("counts on from a taken name that already ends in a number, rather than giving it a second one", async () => {
    await register("admin-2");
    mem.invites.set(sha256Hex("invite-token-2"), { tokenHash: "", usesLeft: 1 });
    const res = await register("admin-2", { invite: "invite-token-2" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "username_taken", suggestion: "admin-3" });
  });

  it("refuses a reserved username, first-run setup included, and suggests another", async () => {
    for (const name of ["admin", "Root", "stuga"]) {
      const res = await register(name);
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body).toMatchObject({ error: "username_reserved" });
      expect(body.suggestion).toBe(`${name.toLowerCase()}-2`);
    }
    expect(mem.accounts.size).toBe(0);
  });
});

describe("login", () => {
  it("takes the username case-insensitively and refuses bad credentials alike", async () => {
    await register();
    const ok = await router().handle(post("/auth/login", { username: " Ada ", password: "correct horse" }));
    expect(ok.status).toBe(200);
    const wrongPassword = await router().handle(post("/auth/login", { username: "ada", password: "wrong" }));
    const unknownUser = await router().handle(post("/auth/login", { username: "who", password: "correct horse" }));
    expect(wrongPassword.status).toBe(401);
    expect(unknownUser.status).toBe(401);
    expect(await wrongPassword.json()).toEqual(await unknownUser.json());
  });
});

describe("refresh", () => {
  it("rotates: the old token dies, the new one works", async () => {
    const pair = (await (await register()).json()) as TokenPair;
    const r1 = await router().handle(post("/auth/refresh", { refresh_token: pair.refresh_token }));
    expect(r1.status).toBe(200);
    const next = (await r1.json()) as TokenPair;
    expect(next.refresh_token).not.toBe(pair.refresh_token);

    // Replaying the rotated token fails AND revokes the live successor.
    const replay = await router().handle(post("/auth/refresh", { refresh_token: pair.refresh_token }));
    expect(replay.status).toBe(401);
    const successor = await router().handle(post("/auth/refresh", { refresh_token: next.refresh_token }));
    expect(successor.status).toBe(401);
  });

  it("refuses an unknown token", async () => {
    const res = await router().handle(post("/auth/refresh", { refresh_token: "never-issued" }));
    expect(res.status).toBe(401);
  });
});

/** Two tabs renewing one session, or a lost renewal response, present a rotated token innocently; only that is forgiven. */
describe("refresh rotation grace", () => {
  const grace = () => routerWith({ refreshRotationGraceSeconds: 60, refreshTokenTtlSeconds: 3600 });

  /** The row for a token hash, reached through the store the fake exposes. */
  const rowFor = (token: string) => mem.sessions.get(hashRefreshToken(token));

  it("forgives a duplicate renewal and leaves both holders with a working token", async () => {
    const pair = (await (await register()).json()) as TokenPair;
    const first = (await (await grace().handle(post("/auth/refresh", { refresh_token: pair.refresh_token }))).json()) as TokenPair;
    // The second tab presents the token it read before the first tab rotated it.
    const second = await grace().handle(post("/auth/refresh", { refresh_token: pair.refresh_token }));
    expect(second.status).toBe(200);
    const sibling = (await second.json()) as TokenPair;
    expect(sibling.refresh_token).not.toBe(first.refresh_token);

    // Neither holder was collateral damage: both tokens still renew.
    expect((await grace().handle(post("/auth/refresh", { refresh_token: first.refresh_token }))).status).toBe(200);
    expect((await grace().handle(post("/auth/refresh", { refresh_token: sibling.refresh_token }))).status).toBe(200);
  });

  it("still sweeps a token replayed after the window has closed", async () => {
    const pair = (await (await register()).json()) as TokenPair;
    const next = (await (await grace().handle(post("/auth/refresh", { refresh_token: pair.refresh_token }))).json()) as TokenPair;

    // A token kept past the window is not a race.
    rowFor(pair.refresh_token)!.revoked_at = new Date(Date.now() - 120_000).toISOString();

    expect((await grace().handle(post("/auth/refresh", { refresh_token: pair.refresh_token }))).status).toBe(401);
    expect((await grace().handle(post("/auth/refresh", { refresh_token: next.refresh_token }))).status).toBe(401);
  });

  it("never forgives a token revoked by signing out rather than by rotation", async () => {
    const pair = (await (await register()).json()) as TokenPair;
    expect((await grace().handle(post("/auth/logout", { refresh_token: pair.refresh_token }))).status).toBe(204);
    // Sign-out sets revoked_at without replaced_by; such a token is never honoured.
    expect(rowFor(pair.refresh_token)!.replaced_by).toBeNull();
    expect((await grace().handle(post("/auth/refresh", { refresh_token: pair.refresh_token }))).status).toBe(401);
  });

  it("sweeps when the successor is already gone, because the chain is broken", async () => {
    const pair = (await (await register()).json()) as TokenPair;
    const next = (await (await grace().handle(post("/auth/refresh", { refresh_token: pair.refresh_token }))).json()) as TokenPair;
    // The successor's holder signed out, so there is no live sibling to have raced.
    await grace().handle(post("/auth/logout", { refresh_token: next.refresh_token }));

    expect((await grace().handle(post("/auth/refresh", { refresh_token: pair.refresh_token }))).status).toBe(401);
  });
});

describe("logout", () => {
  it("revokes the presented session and always answers 204", async () => {
    const pair = (await (await register()).json()) as TokenPair;
    const out = await router().handle(post("/auth/logout", { refresh_token: pair.refresh_token }));
    expect(out.status).toBe(204);
    const after = await router().handle(post("/auth/refresh", { refresh_token: pair.refresh_token }));
    expect(after.status).toBe(401);
    expect((await router().handle(post("/auth/logout", {}))).status).toBe(204);
  });

  it("closes the sockets of the sign-in it ended, and only those", async () => {
    const ended: Array<{ alias: string; sids: string[] | undefined }> = [];
    const r = createIdentityRouter(baseDeps({ onSessionsEnded: (alias, sids) => void ended.push({ alias, sids }) }));
    const pair = (await (await register()).json()) as TokenPair;
    const sid = [...mem.sessions.values()][0]!.session_id;
    expect((await r.handle(post("/auth/logout", { refresh_token: pair.refresh_token }))).status).toBe(204);
    expect(ended).toEqual([{ alias: [...mem.sessions.values()][0]!.alias, sids: [sid] }]);
  });

  it("signs nothing out with a token presented at the other listener", async () => {
    const pair = (await (await register()).json()) as TokenPair;
    const remote = new Request("https://k7f3q2.stuga.test/auth/logout", {
      method: "POST",
      headers: { "content-type": "application/json", [ARRIVAL_HEADER]: "remote", [PEER_ADDRESS_HEADER]: "203.0.113.7" },
      body: JSON.stringify({ refresh_token: pair.refresh_token }),
    });
    expect((await router().handle(remote)).status).toBe(204);
    expect([...mem.sessions.values()].every((row) => row.revoked_at === null)).toBe(true);
    // Still good where it was issued.
    expect((await router().handle(post("/auth/refresh", { refresh_token: pair.refresh_token }))).status).toBe(200);
  });
});

describe("well-known + config", () => {
  it("serves the JWKS and the issuer document", async () => {
    const r = router();
    const jwks = await r.handle(new Request(ORIGIN + "/.well-known/jwks.json"));
    expect(jwks.status).toBe(200);
    expect(((await jwks.json()) as { keys: unknown[] }).keys).toHaveLength(1);

    const disco = await r.handle(new Request(ORIGIN + "/.well-known/openid-configuration"));
    expect(await disco.json()).toEqual({
      issuer: ORIGIN,
      jwks_uri: `${ORIGIN}/.well-known/jwks.json`,
      token_endpoint: null,
    });
  });

  it("GET /auth/config reports the provider and whether the node is claimed", async () => {
    // With no name set there is none to show, and the node is told apart by its host, without the port.
    const node = { node_name: null, node_label: "localhost", origin: ORIGIN, branding: { accent_color: null } };
    const before = await router().handle(new Request(ORIGIN + "/auth/config"));
    expect(await before.json()).toEqual({ provider: null, unclaimed: true, ...node });
    await register();
    const after = await router().handle(new Request(ORIGIN + "/auth/config"));
    expect(await after.json()).toEqual({ provider: null, unclaimed: false, ...node });

    const withProvider = createIdentityRouter(
      baseDeps({
        identityProvider: () => ({ issuer: "https://id.example", clientId: "c", clientSecret: null, label: "Okta", scopes: "openid" }),
      }),
    );
    expect(await (await withProvider.handle(new Request(ORIGIN + "/auth/config"))).json()).toMatchObject({ provider: { label: "Okta" } });
  });

  it("GET /auth/config names the node at the top, with the origin /mcp gives, beside its branding, read per request", async () => {
    let name: string | null = "Liv's Mac";
    const r = createIdentityRouter(
      baseDeps({
        nodeName: () => name,
        nodeLabel: () => name ?? "livs-air",
        branding: () => ({ accentColor: "#2563eb" }),
      }),
    );
    // Asked at another address of the node, it still answers the public origin.
    const config = async () => (await (await r.handle(new Request("http://127.0.0.1:8787/auth/config"))).json()) as Record<string, unknown>;
    expect(await config()).toMatchObject({
      node_name: "Liv's Mac",
      node_label: "Liv's Mac",
      origin: ORIGIN,
      branding: { accent_color: "#2563eb" },
    });
    expect((await config()).branding).not.toHaveProperty("name");
    // Stuga's mark stands beside every node's name; a node has no logo of its own.
    expect((await config()).branding).not.toHaveProperty("logo_data_url");
    name = "Studio";
    expect(await config()).toMatchObject({ node_name: "Studio", node_label: "Studio" });
    // The name removed: nothing to show in place of the product's, and the host tells the node apart.
    name = null;
    expect(await config()).toMatchObject({ node_name: null, node_label: "livs-air" });
  });

  it("leaves the two pages a provider sign-in lands on to the app", () => {
    const r = router();
    expect(r.matches("/auth/complete")).toBe(false);
    expect(r.matches("/auth/first-visit")).toBe(false);
    expect(r.matches("/auth/oidc/callback")).toBe(true);
    expect(r.matches("/auth/config")).toBe(true);
  });

  it("wrong methods answer 405", async () => {
    const res = await router().handle(new Request(ORIGIN + "/auth/register", { method: "GET" }));
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });
});

// ---- passwords ---------------------------------------------------------------

describe("POST /auth/password (change your own)", () => {
  beforeEach(async () => {
    await register();
  });

  it("rotates the password and lets the new one sign in", async () => {
    const res = await router().handle(
      post("/auth/password", { username: "ada", current_password: "correct horse", new_password: "battery staple" }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).access_token).toBeTruthy();

    expect((await router().handle(post("/auth/login", { username: "ada", password: "battery staple" }))).status).toBe(200);
    expect((await router().handle(post("/auth/login", { username: "ada", password: "correct horse" }))).status).toBe(401);
  });

  /** Authenticated by the current password, so a stolen session cannot lock the owner out. */
  it("refuses a wrong current password, and says no more than login does", async () => {
    const res = await router().handle(
      post("/auth/password", { username: "ada", current_password: "wrong", new_password: "battery staple" }),
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("invalid_credentials");
  });

  it("answers an unknown username exactly as it answers a wrong password", async () => {
    const res = await router().handle(
      post("/auth/password", { username: "nobody", current_password: "x", new_password: "battery staple" }),
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("invalid_credentials");
  });

  it("enforces the password policy on the new password", async () => {
    const res = await router().handle(
      post("/auth/password", { username: "ada", current_password: "correct horse", new_password: "short" }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("weak_password");
  });

  /** Every other session dies, or a change after a compromise accomplishes nothing. */
  it("revokes existing sessions", async () => {
    const before = mem.sessions.size;
    expect(before).toBeGreaterThan(0);
    await router().handle(
      post("/auth/password", { username: "ada", current_password: "correct horse", new_password: "battery staple" }),
    );
    const live = [...mem.sessions.values()].filter((s) => !s.revoked_at);
    // Exactly the pair minted by this request; everything prior is revoked.
    expect(live.length).toBe(1);
  });
});

describe("POST /auth/reset (admin-minted, one-time)", () => {
  const TOKEN = "reset-token-abc";
  let alias: string;

  beforeEach(async () => {
    await register();
    // The first account is the node administrator, which is how the test learns its alias.
    alias = [...mem.admins][0]!;
    mem.resets.set(sha256Hex(TOKEN), { alias, expiresAt: new Date(Date.now() + 60_000), used: false });
  });

  it("sets the password, signs the person in, and kills every session", async () => {
    const res = await router().handle(post("/auth/reset", { token: TOKEN, new_password: "battery staple" }));
    expect(res.status).toBe(200);
    expect((await res.json()).access_token).toBeTruthy();

    // Before signing in again: only the pair the redemption issued is live.
    const live = [...mem.sessions.values()].filter((s) => !s.revoked_at);
    expect(live.length).toBe(1);

    expect((await router().handle(post("/auth/login", { username: "ada", password: "battery staple" }))).status).toBe(200);
  });

  it("is single-use", async () => {
    expect((await router().handle(post("/auth/reset", { token: TOKEN, new_password: "battery staple" }))).status).toBe(200);
    const second = await router().handle(post("/auth/reset", { token: TOKEN, new_password: "another one" }));
    expect(second.status).toBe(403);
    expect((await second.json()).error).toBe("reset_invalid");
  });

  it("refuses an expired token", async () => {
    mem.resets.set(sha256Hex("stale"), { alias, expiresAt: new Date(Date.now() - 1), used: false });
    const res = await router().handle(post("/auth/reset", { token: "stale", new_password: "battery staple" }));
    expect(res.status).toBe(403);
  });

  it("refuses an unknown token", async () => {
    const res = await router().handle(post("/auth/reset", { token: "never-minted", new_password: "battery staple" }));
    expect(res.status).toBe(403);
  });
});

describe("credential throttling", () => {
  /** /auth/* is dispatched ahead of the app's rate limiter, so it throttles itself. */
  function limitedRouter(budget: number) {
    let n = 0;
    return createIdentityRouter(baseDeps({ limiter: { limit: async () => ({ success: ++n <= budget }) } }));
  }

  it("returns 429 once the budget is spent", async () => {
    const r = limitedRouter(2);
    const attempt = () => r.handle(post("/auth/login", { username: "ada", password: "nope" }));
    // Two keys are consumed per attempt (source + target), so a budget of two
    // covers exactly one attempt.
    expect((await attempt()).status).toBe(401);
    const limited = await attempt();
    expect(limited.status).toBe(429);
    expect((await limited.json()).error).toBe("rate_limited");
    expect(limited.headers.get("retry-after")).toBe("60");
  });

  it("throttles the identity-provider endpoints a guess could go through", async () => {
    for (const path of ["/auth/oidc/start", "/auth/oidc/complete", "/auth/oidc/link"]) {
      const res = await limitedRouter(0).handle(post(path, { username: "ada" }));
      expect(res.status).toBe(429);
    }
  });

  it("does not throttle the endpoints that present a token they already hold", async () => {
    const r = limitedRouter(0);
    const res = await r.handle(post("/auth/refresh", { refresh_token: "whatever" }));
    expect(res.status).not.toBe(429);
  });

  /** A caller-written header would give every attempt a fresh bucket; the listener stamps the real peer. */
  describe("which address the budget belongs to", () => {
    /** Records the keys the limiter is asked about, and always says yes. */
    function keyRecordingRouter(trustProxyHeaders: boolean): { keys: string[]; router: ReturnType<typeof createIdentityRouter> } {
      const seen: string[] = [];
      const router = createIdentityRouter(
        baseDeps({
          limiter: {
            limit: async ({ key }: { key: string }) => {
              seen.push(key);
              return { success: true };
            },
          },
          trustProxyHeaders,
        }),
      );
      return { keys: seen, router };
    }

    const spoofed = {
      "x-forwarded-for": "203.0.113.9",
      "x-real-ip": "203.0.113.9",
      [PEER_ADDRESS_HEADER]: "10.0.0.7",
    };

    it("ignores a forwarded header nobody vouched for", async () => {
      const { keys, router } = keyRecordingRouter(false);
      await router.handle(post("/auth/login", { username: "ada", password: "nope" }, spoofed));
      expect(keys).toContain("auth:ip:local:10.0.0.7");
      expect(keys).not.toContain("auth:ip:local:203.0.113.9");
    });

    it("believes it once the operator says something in front is setting it", async () => {
      const { keys, router } = keyRecordingRouter(true);
      await router.handle(post("/auth/login", { username: "ada", password: "nope" }, spoofed));
      expect(keys).toContain("auth:ip:local:203.0.113.9");
    });

    it("takes the address the proxy appended, not one the client wrote ahead of it", async () => {
      const { keys, router } = keyRecordingRouter(true);
      await router.handle(
        post("/auth/login", { username: "ada", password: "nope" }, { "x-forwarded-for": "198.51.100.77, 203.0.113.9" }),
      );
      expect(keys).toContain("auth:ip:local:203.0.113.9");
      expect(keys).not.toContain("auth:ip:local:198.51.100.77");
    });

    it("still throttles when there is no address at all, rather than skipping", async () => {
      const { keys, router } = keyRecordingRouter(false);
      await router.handle(post("/auth/login", { username: "ada", password: "nope" }));
      expect(keys).toContain("auth:ip:local:unknown");
    });
  });

  it("refuses an oversized password before it reaches the hash", async () => {
    // scrypt cost grows with input. Asserted through the hash queue: the 401 alone would pass without the cap.
    let hashes = 0;
    const queue = createHashQueue();
    const counting = { ...queue, run: <T,>(lane: HashLane, work: () => Promise<T>) => ((hashes += 1), queue.run(lane, work)) };
    const r = createIdentityRouter(baseDeps({ hashQueue: counting }));

    const oversized = await r.handle(post("/auth/login", { username: "ada", password: "x".repeat(2000) }));
    expect(oversized.status).toBe(401);
    expect((await oversized.json()).error).toBe("invalid_credentials");
    expect(hashes).toBe(0);

    // A normal-length password is hashed (against the decoy, made first, for a name with no account).
    const normal = await r.handle(post("/auth/login", { username: "ada", password: "nope" }));
    expect(normal.status).toBe(401);
    expect(hashes).toBe(2);
  });
});

describe("at the remote address", () => {
  const REMOTE = "https://k7f3q2.stuga.test";
  const remote = (path: string, init: RequestInit = {}, peer = "203.0.113.7") =>
    new Request(REMOTE + path, {
      ...init,
      headers: { [ARRIVAL_HEADER]: "remote", [PEER_ADDRESS_HEADER]: peer, ...(init.headers as Record<string, string>) },
    });
  const remotePost = (path: string, body: unknown, peer?: string) =>
    remote(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, peer);
  const named = (name: string | null) =>
    createIdentityRouter(baseDeps({ nodeName: () => name, nodeLabel: () => name ?? "livs-air", remoteId: () => "k7f3q2" }));

  it("/auth/config names the remote origin, and an unnamed node by its remote id rather than its LAN host", async () => {
    const config = async (r: ReturnType<typeof named>) => (await (await r.handle(remote("/auth/config"))).json()) as Record<string, unknown>;
    expect(await config(named(null))).toMatchObject({ node_name: null, node_label: "k7f3q2", origin: REMOTE });
    expect(await config(named("Studio"))).toMatchObject({ node_name: "Studio", node_label: "Studio", origin: REMOTE });
    // On the LAN, as before.
    expect(await (await named(null).handle(new Request(ORIGIN + "/auth/config"))).json()).toMatchObject({ node_label: "livs-air", origin: ORIGIN });
  });

  it("/auth/config names the remote address while it is on, on both listeners, and nothing while it is off", async () => {
    let on = false;
    const r = createIdentityRouter(baseDeps({ remoteOrigin: () => (on ? REMOTE : null) }));
    const config = async (req: Request) => (await (await r.handle(req)).json()) as Record<string, unknown>;
    expect(await config(new Request(ORIGIN + "/auth/config"))).not.toHaveProperty("remote_origin");
    on = true;
    expect(await config(new Request(ORIGIN + "/auth/config"))).toMatchObject({ remote_origin: REMOTE });
    expect(await config(remote("/auth/config"))).toMatchObject({ remote_origin: REMOTE, origin: REMOTE });
  });

  it("has no issuer documents, whose issuer is PUBLIC_ORIGIN, while the LAN still serves both", async () => {
    for (const path of ["/.well-known/openid-configuration", "/.well-known/jwks.json"]) {
      const res = await router().handle(remote(path));
      expect(res.status, path).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
      expect((await router().handle(new Request(ORIGIN + path))).status, path).toBe(200);
    }
  });

  it("never claims the node with its setup code", async () => {
    const res = await router().handle(remotePost("/auth/register", { username: "ada", password: "correct horse", setup_code: TYPED_CODE }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("setup_not_remote");
    expect(await mem.db.countAccounts()).toBe(0);
  });

  it("still lets an invite make an account once the node is claimed", async () => {
    expect((await register()).status).toBe(201);
    mem.invites.set(sha256Hex("an-invite"), { tokenHash: sha256Hex("an-invite"), usesLeft: 1 });
    const res = await router().handle(remotePost("/auth/register", { username: "grace", password: "correct horse", invite: "an-invite" }));
    expect(res.status).toBe(201);
  });

  it("keys the throttle on the listener too, the source by its PROXY address", async () => {
    const keys: string[] = [];
    const r = createIdentityRouter(
      baseDeps({
        limiter: {
          limit: async ({ key }: { key: string }) => {
            keys.push(key);
            return { success: true };
          },
        },
        trustProxyHeaders: true,
      }),
    );
    await r.handle(remotePost("/auth/login", { username: "ada", password: "nope" }, "2001:db8:5:17::9"));
    await r.handle(post("/auth/login", { username: "ada", password: "nope" }, { [PEER_ADDRESS_HEADER]: "10.0.0.7" }));
    expect(keys).toEqual(["auth:ip:remote:2001:db8:5:17::/64", "auth:id:remote:ada", "auth:ip:local:10.0.0.7", "auth:id:local:ada"]);
  });

  it("cannot lock the LAN out of an account: the same username has a bucket per listener", async () => {
    // The node's own budget: 20 attempts a minute per source and per account.
    const limiter = slidingWindowRateLimiter({ limit: 20, windowSeconds: 60 });
    const r = createIdentityRouter(baseDeps({ limiter }));
    expect((await register("ada", { password: STRONG })).status).toBe(201);
    for (let i = 0; i < 20; i++) {
      expect((await r.handle(remotePost("/auth/login", { username: "ada", password: "wrong one" }))).status).toBe(401);
    }
    expect((await r.handle(remotePost("/auth/login", { username: "ada", password: "wrong one" }))).status).toBe(429);
    // Another visitor at the remote address, and the owner on the LAN, both still get in.
    expect((await r.handle(post("/auth/login", { username: "ada", password: STRONG }, { [PEER_ADDRESS_HEADER]: "10.0.0.7" }))).status).toBe(200);
    mem.invites.set(sha256Hex("second"), { tokenHash: sha256Hex("second"), usesLeft: 1 });
    expect((await register("grace", { invite: "second", password: STRONG })).status).toBe(201);
    expect((await r.handle(remotePost("/auth/login", { username: "grace", password: STRONG }, "198.51.100.23"))).status).toBe(200);
  });
});

/** A session belongs to the listener it was signed in at, and records how and when it began (spec T2, T11, T15). */
describe("where a session was signed in", () => {
  const REMOTE = "https://k7f3q2.stuga.test";
  const LOCAL = { arrival: "local" } as const;
  const AT_REMOTE = { arrival: "remote", origin: REMOTE } as const;
  const remotePost = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    new Request(REMOTE + path, {
      method: "POST",
      headers: { "content-type": "application/json", [ARRIVAL_HEADER]: "remote", ...headers },
      body: JSON.stringify(body),
    });
  const verify = (token: string, where: typeof LOCAL | typeof AT_REMOTE) => createVerifier(localAuth, keys).verify(token, where);
  const rowOf = (token: string) => mem.sessions.get(hashRefreshToken(token))!;
  const hours = (iso: string, from = Date.now()) => (Date.parse(iso) - from) / 3_600_000;

  async function remoteLogin(r = router()): Promise<TokenPair> {
    const res = await r.handle(remotePost("/auth/login", { username: "ada", password: STRONG }));
    expect(res.status).toBe(200);
    return (await res.json()) as TokenPair;
  }

  it("mints a remote sign-in's access token for the remote origin alone, naming its session", async () => {
    await register("ada", { password: STRONG });
    const pair = await remoteLogin();
    const { sid } = await verify(pair.access_token, AT_REMOTE);
    expect(sid).toBe(rowOf(pair.refresh_token).session_id);
    await expect(verify(pair.access_token, LOCAL)).rejects.toThrow(/"aud" claim/);
    // And a LAN sign-in's for the LAN alone.
    const lan = (await (await router().handle(post("/auth/login", { username: "ada", password: STRONG }))).json()) as TokenPair;
    expect((await verify(lan.access_token, LOCAL)).sid).toBe(rowOf(lan.refresh_token).session_id);
    await expect(verify(lan.access_token, AT_REMOTE)).rejects.toThrow(/"aud" claim/);
  });

  it("records how each session began, and gives one at the remote address an end at sign-in", async () => {
    const setup = (await (await register("ada", { password: STRONG })).json()) as TokenPair;
    expect(rowOf(setup.refresh_token)).toMatchObject({ arrival: "local", signed_in_with: "setup", absolute_expires_at: null });
    const pair = await remoteLogin();
    const row = rowOf(pair.refresh_token);
    expect(row).toMatchObject({ arrival: "remote", signed_in_with: "password" });
    // Seven days unused, thirty in all.
    expect(hours(row.expires_at)).toBeCloseTo(7 * 24, 0);
    expect(hours(row.absolute_expires_at!)).toBeCloseTo(30 * 24, 0);
    mem.invites.set(sha256Hex("inv"), { tokenHash: sha256Hex("inv"), usesLeft: 1 });
    const joined = (await (await router().handle(remotePost("/auth/register", { username: "grace", password: "correct horse", invite: "inv" }))).json()) as TokenPair;
    expect(rowOf(joined.refresh_token)).toMatchObject({ arrival: "remote", signed_in_with: "invite" });
  });

  it("renews a remote session only at the remote address, never past the end it was given, and keeps how it began", async () => {
    await register("ada", { password: STRONG });
    const r = routerWith({ remoteSessionMaxSeconds: 2 * 3600, remoteRefreshTokenTtlSeconds: 24 * 3600 });
    const pair = await remoteLogin(r);
    const first = rowOf(pair.refresh_token);
    // At the LAN it is unknown, and nothing is signed out for it.
    const elsewhere = await r.handle(post("/auth/refresh", { refresh_token: pair.refresh_token }));
    expect(elsewhere.status).toBe(401);
    expect(rowOf(pair.refresh_token).revoked_at).toBeNull();

    const renewed = await r.handle(remotePost("/auth/refresh", { refresh_token: pair.refresh_token }));
    expect(renewed.status).toBe(200);
    const next = (await renewed.json()) as TokenPair;
    const row = rowOf(next.refresh_token);
    expect(row).toMatchObject({
      session_id: first.session_id,
      arrival: "remote",
      signed_in_with: "password",
      signed_in_at: first.signed_in_at,
      confirmed_at: first.confirmed_at,
      absolute_expires_at: first.absolute_expires_at,
    });
    // Asked for a day unused, given what is left of the two hours.
    expect(row.expires_at).toBe(first.absolute_expires_at);
    expect((await verify(next.access_token, AT_REMOTE)).sid).toBe(first.session_id);
    await expect(verify(next.access_token, LOCAL)).rejects.toThrow();

    // Past its end, renewal fails however recently it was used.
    row.absolute_expires_at = new Date(Date.now() - 1000).toISOString();
    expect((await r.handle(remotePost("/auth/refresh", { refresh_token: next.refresh_token }))).status).toBe(401);
  });

  it("refuses a LAN refresh token at the remote address without signing anyone out, and records it once an hour", async () => {
    const pair = (await (await register()).json()) as TokenPair;
    const r = router();
    expect((await r.handle(remotePost("/auth/refresh", { refresh_token: pair.refresh_token }))).status).toBe(401);
    expect((await r.handle(remotePost("/auth/refresh", { refresh_token: pair.refresh_token }))).status).toBe(401);
    const alias = (await mem.db.findAccountByUsername("ada"))!.alias;
    expect(identityEvents).toEqual([{ alias, action: "node.session.wrong_address", detail: { issued_at: "local", presented_at: "remote" } }]);
    expect((await r.handle(post("/auth/refresh", { refresh_token: pair.refresh_token }))).status).toBe(200);
  });

  it("keeps a LAN session sliding, with no end of its own", async () => {
    const pair = (await (await register()).json()) as TokenPair;
    const next = (await (await routerWith({ refreshTokenTtlSeconds: 3600 }).handle(post("/auth/refresh", { refresh_token: pair.refresh_token }))).json()) as TokenPair;
    expect(rowOf(next.refresh_token)).toMatchObject({ arrival: "local", absolute_expires_at: null });
    expect(hours(rowOf(next.refresh_token).expires_at)).toBeCloseTo(1, 1);
  });

  it("gives a duplicate renewal's sibling the same sign-in and end, on the LAN and at the remote address (W4)", async () => {
    await register("ada", { password: STRONG });
    const grace = routerWith({ refreshRotationGraceSeconds: 60, remoteSessionMaxSeconds: 3 * 3600 });
    for (const [label, start, send] of [
      ["remote", () => remoteLogin(grace), (body: unknown) => remotePost("/auth/refresh", body)],
      [
        "local",
        async () => (await (await grace.handle(post("/auth/login", { username: "ada", password: STRONG }))).json()) as TokenPair,
        (body: unknown) => post("/auth/refresh", body),
      ],
    ] as const) {
      const pair = await start();
      const first = (await (await grace.handle(send({ refresh_token: pair.refresh_token }))).json()) as TokenPair;
      const second = await grace.handle(send({ refresh_token: pair.refresh_token }));
      expect(second.status, label).toBe(200);
      const sibling = rowOf(((await second.json()) as TokenPair).refresh_token);
      const successor = rowOf(first.refresh_token);
      expect(sibling, label).toMatchObject({
        session_id: successor.session_id,
        arrival: successor.arrival,
        signed_in_with: successor.signed_in_with,
        signed_in_at: successor.signed_in_at,
        confirmed_at: successor.confirmed_at,
        absolute_expires_at: successor.absolute_expires_at,
        expires_at: successor.expires_at,
      });
    }
  });

  it("refuses a person's token at the identity routes once its session has ended", async () => {
    await register("ada", { password: STRONG });
    const pair = await remoteLogin();
    const bearer = { authorization: `Bearer ${pair.access_token}` };
    // Unlinking needs a live session: before sign-out it reaches the account (which has nothing to unlink), after it does not.
    expect((await router().handle(remotePost("/auth/oidc/unlink", {}, bearer))).status).toBe(204);
    expect((await router().handle(remotePost("/auth/logout", { refresh_token: pair.refresh_token }))).status).toBe(204);
    const after = await router().handle(remotePost("/auth/oidc/unlink", {}, bearer));
    expect(after.status).toBe(401);
    expect((await after.json()).error).toBe("invalid_token");
    // And a token presented at the other listener is refused before any lookup.
    expect((await router().handle(post("/auth/oidc/unlink", {}, bearer))).status).toBe(401);
  });
});

describe("ending every session of an account", () => {
  it("closes the sockets they opened, on a password change, a reset and a replay", async () => {
    const ended: string[] = [];
    const r = () => createIdentityRouter(baseDeps({ onSessionsEnded: (alias) => ended.push(alias) }));
    const pair = (await (await register()).json()) as TokenPair;
    const alias = (await mem.db.findAccountByUsername("ada"))!.alias;

    expect((await r().handle(post("/auth/password", { username: "ada", current_password: "correct horse", new_password: "battery staple 9" }))).status).toBe(200);
    expect(ended).toEqual([alias]);

    mem.resets.set(sha256Hex("reset-1"), { alias, expiresAt: new Date(Date.now() + 60_000), used: false });
    expect((await r().handle(post("/auth/reset", { token: "reset-1", new_password: "battery staple 10" }))).status).toBe(200);
    expect(ended).toEqual([alias, alias]);

    // The first pair's refresh token was revoked with the change: presenting it again is a replay.
    expect((await r().handle(post("/auth/refresh", { refresh_token: pair.refresh_token }))).status).toBe(401);
    expect(ended).toEqual([alias, alias, alias]);
  });
});
