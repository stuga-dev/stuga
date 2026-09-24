/**
 * Signing in through the identity provider, end to end: the routes over the
 * in-memory database, and the real mock provider over HTTP. A `Browser` keeps
 * the binding cookie between requests the way a real one would.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRelyingParty, createVerifier, loadOrCreateSigningKey, sha256Hex, type AuthConfig, type LocalKeys } from "@stuga/auth";
import { startMockProvider, type MockProvider } from "@stuga/auth/testing";
import type { IdentityProviderSettings } from "../config/settings/node.js";
import { createIdentityRouter, type IdentityDeps, type IdentityEvent, type IdentityRouter, type TokenPair } from "./routes.js";
import { memoryDb } from "./testing/memory-db.js";
import { safeReturnTo, withQuery } from "./http.js";

const ORIGIN = "http://localhost:8787";
const LAN = "http://nas.local:8787";
const keyDir = mkdtempSync(join(tmpdir(), "stuga-provider-"));
afterAll(() => rmSync(keyDir, { recursive: true, force: true }));

const auth: AuthConfig = {
  issuer: ORIGIN,
  audience: "stuga",
  keyFile: join(keyDir, "signing.jwk"),
  accessTokenTtlSeconds: 3600,
  refreshTokenTtlSeconds: 3600,
  refreshRotationGraceSeconds: 0,
};

let keys: LocalKeys;
let idp: MockProvider;
let mem: ReturnType<typeof memoryDb>;
let events: IdentityEvent[];
let joined: Array<{ alias: string; workspaceId: string }>;
let providerSettings: IdentityProviderSettings | null;
let router: IdentityRouter;

function deps(extra: Partial<IdentityDeps> = {}): IdentityDeps {
  return {
    auth,
    publicOrigin: ORIGIN,
    extraOrigins: [LAN],
    db: mem.db,
    keys,
    verifier: createVerifier(auth, keys),
    identityProvider: () => providerSettings,
    onIdentityChange: (e) => events.push(e),
    onInviteRedeemed: (j) => joined.push(j),
    setupCode: () => "ABCDE12345",
    ...extra,
  };
}

beforeEach(async () => {
  keys ??= await loadOrCreateSigningKey(auth.keyFile);
  idp = await startMockProvider();
  // A subject the mock provider vouches for links only while it is the node's provider.
  mem = memoryDb({ issuer: () => providerSettings?.issuer ?? null });
  events = [];
  joined = [];
  providerSettings = { issuer: idp.issuer, clientId: idp.clientId, clientSecret: null, label: "Mock", scopes: "openid profile email" };
  router = createIdentityRouter(deps());
});
afterEach(async () => {
  await idp.stop();
});

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(ORIGIN + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

interface Cookie {
  name: string;
  value: string;
}

/** The binding cookie of a sign-in over plain http, as a browser holds it. */
const plain = (value: string): Cookie => ({ name: "stuga_signin", value });

/** One browser: the cookie `start` set, sent back on the paths it is scoped to. */
class Browser {
  cookie: Cookie | null = null;
  /** Cookies another host under the same parent domain set, sent ahead of the real one as a longer path is. */
  planted: Cookie[] = [];
  lastSetCookie: string | null = null;
  headers(extra: Record<string, string> = {}): Record<string, string> {
    const jar = [...this.planted, ...(this.cookie ? [this.cookie] : [])].map((c) => `${c.name}=${c.value}`);
    return { ...(jar.length > 0 ? { cookie: jar.join("; ") } : {}), ...extra };
  }
  remember(res: Response): Response {
    const set = res.headers.get("set-cookie");
    this.lastSetCookie = set;
    if (set) {
      const [, name, value] = /^([^=]+)=([^;]*)/.exec(set)!;
      this.cookie = value && !/Max-Age=0\b/.test(set) ? { name: name!, value: value! } : null;
    }
    return res;
  }
  async post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
    return this.remember(await router.handle(post(path, body, this.headers(headers))));
  }
}

/** Start, let the provider answer, and come back through the callback; the redirect the browser lands on. */
async function signIn(browser: Browser, body: Record<string, unknown> = {}, headers: Record<string, string> = {}): Promise<string> {
  const started = await browser.post("/auth/oidc/start", body, headers);
  expect(started.status).toBe(200);
  const { url } = (await started.json()) as { url: string };
  const answer = await fetch(url, { redirect: "manual" });
  expect(answer.status).toBe(302);
  return callback(browser, answer.headers.get("location")!);
}

async function callback(browser: Browser, location: string): Promise<string> {
  const res = browser.remember(await router.handle(new Request(location, { headers: browser.headers() })));
  expect(res.status).toBe(302);
  return res.headers.get("location")!;
}

const fragment = (location: string, name: string) => new URLSearchParams(location.split("#")[1]).get(name)!;

/** A node someone already set up, with a password account and an invite to hand out. */
async function claimed(): Promise<void> {
  await mem.db.createLocalAccount({ alias: "u_owner", username: "owner", passwordHash: "x", displayName: "Owner", mayClaim: true });
}

function invite(token = "invite-1", uses = 1): string {
  mem.invites.set(sha256Hex(token), { tokenHash: "", usesLeft: uses });
  return token;
}

/** A password account, made the way registration makes one. */
async function passwordAccount(username: string, password: string): Promise<TokenPair> {
  if (mem.accounts.size > 0) invite(`for-${username}`);
  const res = await router.handle(
    post("/auth/register", { username, password, ...(mem.accounts.size > 0 ? { invite: `for-${username}` } : { setup_code: "ABCDE-12345" }) }),
  );
  expect(res.status).toBe(201);
  return (await res.json()) as TokenPair;
}

async function firstVisitTicket(browser = new Browser()): Promise<{ browser: Browser; ticket: string }> {
  const landed = await signIn(browser);
  expect(landed.startsWith("/auth/first-visit#ticket=")).toBe(true);
  return { browser, ticket: fragment(landed, "ticket") };
}

describe("starting a sign-in", () => {
  it("answers the provider's URL and binds the sign-in to this browser", async () => {
    const browser = new Browser();
    const res = await browser.post("/auth/oidc/start", { return_to: "/w/docs/1" });
    expect(res.status).toBe(200);
    const url = new URL(((await res.json()) as { url: string }).url);
    expect(url.origin).toBe(idp.issuer);
    expect(url.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/auth/oidc/callback`);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(browser.lastSetCookie).toMatch(/^stuga_signin=[\w-]{43}; Path=\/auth\/oidc; HttpOnly; SameSite=Lax; Max-Age=600$/);
    const [flow] = [...mem.flows.values()];
    expect(flow).toMatchObject({
      binding_hash: sha256Hex(`stuga_signin=${browser.cookie!.value}`),
      return_to: "/w/docs/1",
      link_alias: null,
      prompt: null,
    });
  });

  it("comes back to the origin the sign-in started on, when the node serves the app there", async () => {
    const lan = await new Browser().post("/auth/oidc/start", {}, { origin: LAN });
    expect(new URL(((await lan.json()) as { url: string }).url).searchParams.get("redirect_uri")).toBe(`${LAN}/auth/oidc/callback`);
    const stranger = await new Browser().post("/auth/oidc/start", {}, { origin: "https://evil.test" });
    expect(new URL(((await stranger.json()) as { url: string }).url).searchParams.get("redirect_uri")).toBe(`${ORIGIN}/auth/oidc/callback`);
  });

  it("on an https origin, sets a __Host- cookie no other host can plant or shadow", async () => {
    router = createIdentityRouter(deps({ publicOrigin: "https://stuga.example" }));
    const browser = new Browser();
    await browser.post("/auth/oidc/start", {}, { origin: "https://stuga.example" });
    expect(browser.lastSetCookie).toMatch(/^__Host-stuga_signin=[\w-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=600; Secure$/);
  });

  it("says so when there is no provider, or it cannot be reached", async () => {
    providerSettings = null;
    const none = await router.handle(post("/auth/oidc/start", {}));
    expect(none.status).toBe(404);
    expect((await none.json()).error).toBe("no_provider");

    providerSettings = { issuer: idp.issuer, clientId: "stuga", clientSecret: null, label: "Mock", scopes: "openid" };
    await idp.stop();
    const down = await router.handle(post("/auth/oidc/start", {}));
    expect(down.status).toBe(502);
    expect((await down.json()).error).toBe("provider_unreachable");
    expect(mem.flows.size).toBe(0);
  });

  it("asks the provider which account with select_account, and refuses any prompt but that and none", async () => {
    const res = await new Browser().post("/auth/oidc/start", { prompt: "select_account" });
    expect(res.status).toBe(200);
    expect(new URL(((await res.json()) as { url: string }).url).searchParams.get("prompt")).toBe("select_account");
    expect([...mem.flows.values()][0]).toMatchObject({ prompt: "select_account" });
    for (const prompt of ["login", "consent", "none select_account", 1]) {
      expect((await router.handle(post("/auth/oidc/start", { prompt }))).status, String(prompt)).toBe(400);
    }
  });
});

describe("choosing an account after signing out", () => {
  it("signs in as whoever the person picks at the provider, where a plain start would reuse its session", async () => {
    await claimed();
    await mem.db.linkIdentity("u_owner", "mock-subject-1", idp.issuer);
    // The provider still remembers the person who just signed out of the node.
    expect((await signIn(new Browser())).startsWith("/auth/complete#code=")).toBe(true);
    idp.chooses = { sub: "mock-subject-2", preferred_username: "bea", name: "Bea" };
    const picked = await signIn(new Browser(), { prompt: "select_account", return_to: "/w/docs/1" });
    expect(picked.startsWith("/auth/first-visit#ticket=")).toBe(true);
    expect(idp.prompts).toEqual([null, "select_account"]);
  });

  it("may ask which account when linking, which a silent start may not", async () => {
    const pair = await passwordAccount("ada", "correct horse");
    const bearer = { authorization: `Bearer ${pair.access_token}` };
    const res = await new Browser().post("/auth/oidc/start", { prompt: "select_account" }, bearer);
    expect(res.status).toBe(200);
    const ada = (await mem.db.findAccountByUsername("ada"))!;
    expect([...mem.flows.values()][0]).toMatchObject({ prompt: "select_account", link_alias: ada.alias });
  });
});

describe("signing out", () => {
  it("drops a link the account started and never finished, so a callback that comes later links nothing", async () => {
    const pair = await passwordAccount("ada", "correct horse");
    const ada = (await mem.db.findAccountByUsername("ada"))!;
    const browser = new Browser();
    const started = await browser.post("/auth/oidc/start", { return_to: "/settings/profile" }, { authorization: `Bearer ${pair.access_token}` });
    const answer = await fetch(((await started.json()) as { url: string }).url, { redirect: "manual" });
    // Someone else's sign-in in flight, which the sign-out must leave alone.
    await new Browser().post("/auth/oidc/start", {});
    expect([...mem.flows.values()].map((f) => f.link_alias).sort()).toEqual([ada.alias, null].sort());

    expect((await router.handle(post("/auth/logout", { refresh_token: pair.refresh_token }))).status).toBe(204);
    expect([...mem.flows.values()].map((f) => f.link_alias)).toEqual([null]);
    expect(await callback(browser, answer.headers.get("location")!)).toBe("/login?provider=failed");
    expect((await mem.db.findAccountByUsername("ada"))!.oidc_sub).toBeNull();
    expect(events).toEqual([]);
  });
});

describe("the browser binding", () => {
  const HTTPS = "https://stuga.example";
  const onHttps = { origin: HTTPS };

  beforeEach(() => {
    router = createIdentityRouter(deps({ publicOrigin: HTTPS, extraOrigins: [LAN] }));
  });

  it("lasts on the callback as long as the ticket or the code it hands out", async () => {
    await claimed();
    const browser = new Browser();
    const landed = await signIn(browser, {}, onHttps);
    expect(landed.startsWith("/auth/first-visit#")).toBe(true);
    expect(browser.lastSetCookie).toMatch(/^__Host-stuga_signin=[\w-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=600; Secure$/);
    const [ticket] = [...mem.tickets.values()];
    expect(ticket!.binding_hash).toBe(sha256Hex(`__Host-stuga_signin=${browser.cookie!.value}`));

    await mem.db.linkIdentity("u_owner", "mock-subject-1", idp.issuer);
    expect((await signIn(browser, {}, onHttps)).startsWith("/auth/complete#")).toBe(true);
    expect(browser.lastSetCookie).toMatch(/; Max-Age=60; Secure$/);
  });

  it("on https, never takes a plain cookie another host planted for the __Host- one", async () => {
    await claimed();
    // Someone signs in as themself and carries their own binding value and ticket to another browser.
    const attacker = new Browser();
    const ticket = fragment(await signIn(attacker, {}, onHttps), "ticket");
    expect(attacker.cookie!.name).toBe("__Host-stuga_signin");
    const victim = new Browser();
    victim.planted = [plain(attacker.cookie!.value)];
    const res = await victim.post("/auth/oidc/ticket", { ticket }, onHttps);
    expect(res.status).toBe(403);
    expect((await victim.post("/auth/oidc/link", { ticket, username: "owner", password: "x" }, onHttps)).status).toBe(403);

    // Nor one bound over plain http and carried to the https origin.
    const overHttp = new Browser();
    const httpTicket = fragment(await signIn(overHttp, {}, { origin: LAN }), "ticket");
    expect(overHttp.cookie!.name).toBe("stuga_signin");
    victim.planted = [overHttp.cookie!];
    expect((await victim.post("/auth/oidc/ticket", { ticket: httpTicket }, onHttps)).status).toBe(403);

    expect((await attacker.post("/auth/oidc/ticket", { ticket }, onHttps)).status).toBe(200);
  });

  it("on https, a planted cookie neither finishes someone else's callback nor redeems their session", async () => {
    await claimed();
    await mem.db.linkIdentity("u_owner", "mock-subject-1", idp.issuer);
    const attacker = new Browser();
    const started = await attacker.post("/auth/oidc/start", {}, onHttps);
    const answer = await fetch(((await started.json()) as { url: string }).url, { redirect: "manual" });
    const victim = new Browser();
    victim.planted = [plain(attacker.cookie!.value)];
    expect(await callback(victim, answer.headers.get("location")!)).toBe("/login?provider=failed");

    const code = fragment(await signIn(attacker, {}, onHttps), "code");
    victim.planted = [plain(attacker.cookie!.value)];
    expect((await victim.post("/auth/oidc/handoff", { code }, onHttps)).status).toBe(403);
    expect((await attacker.post("/auth/oidc/handoff", { code }, onHttps)).status).toBe(200);
  });

  it("refuses a browser that presents the cookie twice", async () => {
    router = createIdentityRouter(deps());
    await claimed();
    const { browser: attacker, ticket } = await firstVisitTicket();
    // The browser holds its own, and another host set the attacker's on a longer path, which is sent first.
    const victim = new Browser();
    await victim.post("/auth/oidc/start", {});
    victim.planted = [attacker.cookie!];
    expect((await victim.post("/auth/oidc/ticket", { ticket })).status).toBe(403);
    expect((await attacker.post("/auth/oidc/ticket", { ticket })).status).toBe(200);
  });
});

describe("a first visit", () => {
  it("shows who the provider vouched for and offers a free username, without spending the ticket", async () => {
    await claimed();
    await passwordAccount("ada", "correct horse");
    const { browser, ticket } = await firstVisitTicket();
    for (let i = 0; i < 2; i++) {
      const res = await browser.post("/auth/oidc/ticket", { ticket });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        label: "Mock",
        preferred_username: "ada",
        name: "Ada Lovelace",
        email: "ada@example.test",
        suggestion: "ada-2",
        return_to: "/",
      });
    }
  });

  it("creates an account with the invite: username, no password, the subject, and a session", async () => {
    await claimed();
    const token = invite();
    const { browser, ticket } = await firstVisitTicket();
    const res = await browser.post("/auth/oidc/complete", { ticket, username: "Ada", invite: token });
    expect(res.status).toBe(201);
    const body = (await res.json()) as TokenPair & { return_to: string };
    expect(body.return_to).toBe("/");
    expect(body.token_type).toBe("Bearer");
    expect(browser.lastSetCookie).toMatch(/^stuga_signin=; Path=\/auth\/oidc; .*Max-Age=0/);

    const account = (await mem.db.findAccountByUsername("ada"))!;
    expect(account).toMatchObject({ password_hash: null, oidc_sub: "mock-subject-1" });
    expect(account.alias).toMatch(/^u_/);
    expect(mem.names.get(account.alias)).toBe("Ada Lovelace");
    expect(mem.emails.get(account.alias)).toBe("ada@example.test");
    expect(mem.admins.has(account.alias)).toBe(false);
    expect(joined).toEqual([expect.objectContaining({ alias: account.alias, workspaceId: "w1" })]);
    expect((await createVerifier(auth, keys).verify(body.access_token)).alias).toBe(account.alias);

    // Spent: the same ticket makes nothing twice.
    const again = await browser.post("/auth/oidc/complete", { ticket, username: "ada2", invite: invite("invite-2") });
    expect(again.status).toBe(403);
    expect((await again.json()).error).toBe("ticket_invalid");
  });

  it("never makes an account without an invite, and keeps the ticket for the next try", async () => {
    await claimed();
    const { browser, ticket } = await firstVisitTicket();
    const none = await browser.post("/auth/oidc/complete", { ticket, username: "ada" });
    expect(none.status).toBe(403);
    expect((await none.json()).error).toBe("invite_required");
    const bad = await browser.post("/auth/oidc/complete", { ticket, username: "ada", invite: "never-minted" });
    expect((await bad.json()).error).toBe("invite_invalid");
    expect(await mem.db.findAccountBySub("mock-subject-1")).toBeNull();
    expect((await browser.post("/auth/oidc/complete", { ticket, username: "ada", invite: invite() })).status).toBe(201);
  });

  it("makes one account with a single-use invite however many first visits race past the check", async () => {
    await claimed();
    const token = invite();
    const visits = [];
    for (const sub of ["sub-a", "sub-b", "sub-c"]) {
      idp.user = { sub, preferred_username: sub };
      visits.push(await firstVisitTicket());
    }
    const results = await Promise.all(
      visits.map(({ browser, ticket }, i) => browser.post("/auth/oidc/complete", { ticket, username: `racer-${i}`, invite: token })),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 403, 403]);
    for (const refused of results.filter((r) => r.status === 403)) expect((await refused.json()).error).toBe("invite_invalid");
    expect(mem.accounts.size).toBe(2);
    expect(joined).toHaveLength(1);
  });

  it("refuses a reserved or taken username with a suggestion, and an invalid one", async () => {
    await claimed();
    await passwordAccount("ada", "correct horse");
    const token = invite("invite-x", 5);
    const { browser, ticket } = await firstVisitTicket();

    const reserved = await browser.post("/auth/oidc/complete", { ticket, username: "admin", invite: token });
    expect(reserved.status).toBe(409);
    expect(await reserved.json()).toMatchObject({ error: "username_reserved", suggestion: "admin-2" });

    const taken = await browser.post("/auth/oidc/complete", { ticket, username: "ada", invite: token });
    expect(taken.status).toBe(409);
    expect(await taken.json()).toMatchObject({ error: "username_taken", suggestion: "ada-2" });

    const invalid = await browser.post("/auth/oidc/complete", { ticket, username: "a", invite: token });
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error).toBe("invalid_username");

    expect((await browser.post("/auth/oidc/complete", { ticket, username: "ada-2", invite: token })).status).toBe(201);
  });

  it("is refused on a node nobody has set up: its owner always starts with a password", async () => {
    const { browser, ticket } = await firstVisitTicket();
    const res = await browser.post("/auth/oidc/complete", { ticket, username: "ada", invite: invite() });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("setup_required");
    expect(mem.accounts.size).toBe(0);
  });

  it("refuses a subject that was linked meanwhile", async () => {
    await claimed();
    const { browser, ticket } = await firstVisitTicket();
    await mem.db.linkIdentity("u_owner", "mock-subject-1", idp.issuer);
    const res = await browser.post("/auth/oidc/complete", { ticket, username: "ada", invite: invite() });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("already_linked");
  });

  it("links an existing account proven with its password, and the next sign-in goes straight in", async () => {
    const owner = await passwordAccount("ada", "correct horse");
    const { browser, ticket } = await firstVisitTicket();

    const wrong = await browser.post("/auth/oidc/link", { ticket, username: "ada", password: "not it" });
    expect(wrong.status).toBe(401);
    expect((await wrong.json()).error).toBe("invalid_credentials");
    const nobody = await browser.post("/auth/oidc/link", { ticket, username: "nobody", password: "correct horse" });
    expect(nobody.status).toBe(401);

    const res = await browser.post("/auth/oidc/link", { ticket, username: "ada", password: "correct horse" });
    expect(res.status).toBe(200);
    const pair = (await res.json()) as TokenPair & { return_to: string };
    const alias = (await createVerifier(auth, keys).verify(owner.access_token)).alias;
    expect((await createVerifier(auth, keys).verify(pair.access_token)).alias).toBe(alias);
    expect((await mem.db.findAccountByAlias(alias))!.oidc_sub).toBe("mock-subject-1");
    expect(events).toEqual([{ alias, action: "node.identity.link", detail: { via: "first_visit" } }]);
    expect(browser.lastSetCookie).toMatch(/Max-Age=0/);

    const next = await signIn(new Browser());
    expect(next.startsWith("/auth/complete#code=")).toBe(true);
  });

  it("will not link an account that already has another subject, nor one without a password", async () => {
    await passwordAccount("ada", "correct horse");
    await mem.db.linkIdentity((await mem.db.findAccountByUsername("ada"))!.alias, "someone-else", idp.issuer);
    const { browser, ticket } = await firstVisitTicket();
    const res = await browser.post("/auth/oidc/link", { ticket, username: "ada", password: "correct horse" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("already_linked");

    const made = await mem.db.createProviderAccount({
      alias: "u_nopass",
      username: "bob",
      displayName: "Bob",
      email: null,
      oidcSub: "sub-bob",
      issuer: idp.issuer,
      inviteHash: sha256Hex(invite("for-bob")),
    });
    expect(made.ok).toBe(true);
    const noPassword = await browser.post("/auth/oidc/link", { ticket, username: "bob", password: "anything at all" });
    expect(noPassword.status).toBe(401);
  });
});

describe("signing in again", () => {
  async function linkedAccount(): Promise<string> {
    await claimed();
    await mem.db.linkIdentity("u_owner", "mock-subject-1", idp.issuer);
    return "u_owner";
  }

  it("hands the session over once, to the browser that started it", async () => {
    const alias = await linkedAccount();
    const browser = new Browser();
    const landed = await signIn(browser, { return_to: "/w/docs/1" });
    const code = fragment(landed, "code");

    // Another browser holding the code gets nothing, and does not burn it for the real one.
    const thief = new Browser();
    thief.cookie = plain("not-the-cookie");
    expect((await thief.post("/auth/oidc/handoff", { code })).status).toBe(403);
    expect((await router.handle(post("/auth/oidc/handoff", { code }))).status).toBe(403);

    const cookie = browser.cookie;
    const res = await browser.post("/auth/oidc/handoff", { code });
    expect(res.status).toBe(200);
    const body = (await res.json()) as TokenPair & { return_to: string };
    expect(body.return_to).toBe("/w/docs/1");
    expect((await createVerifier(auth, keys).verify(body.access_token)).alias).toBe(alias);
    expect(browser.lastSetCookie).toMatch(/Max-Age=0/);

    // Single use, even presented again with the cookie it was bound to.
    const again = await router.handle(post("/auth/oidc/handoff", { code }, { cookie: `stuga_signin=${cookie!.value}` }));
    expect(again.status).toBe(403);
    expect((await again.json()).error).toBe("handoff_invalid");
  });

  it("gives the handoff a minute", async () => {
    await linkedAccount();
    const browser = new Browser();
    const code = fragment(await signIn(browser), "code");
    const [row] = [...mem.tickets.values()];
    expect(row!.kind).toBe("session");
    const ttl = row!.expires_at.getTime() - Date.now();
    expect(ttl).toBeGreaterThan(55_000);
    expect(ttl).toBeLessThanOrEqual(60_000);
    row!.expires_at = new Date(Date.now() - 1);
    expect((await browser.post("/auth/oidc/handoff", { code })).status).toBe(403);
  });

  it("keeps a session made through the provider alive after the provider goes away", async () => {
    await linkedAccount();
    const browser = new Browser();
    const code = fragment(await signIn(browser), "code");
    const pair = (await (await browser.post("/auth/oidc/handoff", { code })).json()) as TokenPair;
    await idp.stop();

    const renewed = await router.handle(post("/auth/refresh", { refresh_token: pair.refresh_token }));
    expect(renewed.status).toBe(200);
    const next = (await renewed.json()) as TokenPair;
    expect((await createVerifier(auth, keys).verify(next.access_token)).alias).toBe("u_owner");
    const config = await router.handle(new Request(`${ORIGIN}/auth/config`));
    expect(config.status).toBe(200);
    expect(await config.json()).toMatchObject({ provider: { label: "Mock" }, unclaimed: false });
  });
});

describe("a failed callback", () => {
  it("sends a silent sign-in the provider refused back to the login page", async () => {
    idp.loggedIn = false;
    const landed = await signIn(new Browser(), { prompt: "none" });
    expect(landed).toBe("/login?provider=failed");
    expect(mem.tickets.size).toBe(0);
  });

  it("refuses an unknown state, and a state used twice", async () => {
    const browser = new Browser();
    expect(await callback(browser, `${ORIGIN}/auth/oidc/callback?code=x&state=never`)).toBe("/login?provider=failed");

    const started = await browser.post("/auth/oidc/start", {});
    const answer = await fetch(((await started.json()) as { url: string }).url, { redirect: "manual" });
    const location = answer.headers.get("location")!;
    expect((await callback(browser, location)).startsWith("/auth/first-visit#")).toBe(true);
    expect(await callback(browser, location)).toBe("/login?provider=failed");
  });

  it("refuses a callback in a browser that did not start the sign-in", async () => {
    const started = new Browser();
    const res = await started.post("/auth/oidc/start", {});
    const answer = await fetch(((await res.json()) as { url: string }).url, { redirect: "manual" });
    const location = answer.headers.get("location")!;
    const noCookie = new Browser();
    expect(await callback(noCookie, location)).toBe("/login?provider=failed");
    // The state is spent by the failed attempt too.
    expect(await callback(started, location)).toBe("/login?provider=failed");

    const other = new Browser();
    const res2 = await started.post("/auth/oidc/start", {});
    const answer2 = await fetch(((await res2.json()) as { url: string }).url, { redirect: "manual" });
    other.cookie = plain("someone-elses-cookie");
    expect(await callback(other, answer2.headers.get("location")!)).toBe("/login?provider=failed");
    expect(mem.tickets.size).toBe(0);
  });

  it.each<[string, Record<string, unknown>]>([
    ["a wrong nonce", { nonce: "not-the-flows-nonce" }],
    ["a wrong audience", { aud: "another-client" }],
    ["a wrong issuer", { iss: "http://127.0.0.1:1" }],
  ])("refuses an id_token with %s and starts no session", async (_what, overrides) => {
    await claimed();
    await mem.db.linkIdentity("u_owner", "mock-subject-1", idp.issuer);
    idp.overrides = overrides;
    expect(await signIn(new Browser())).toBe("/login?provider=failed");
    expect(mem.tickets.size).toBe(0);
    expect(mem.sessions.size).toBe(0);
  });

  it("refuses an answer the provider marked as an error", async () => {
    idp.deny = "access_denied";
    expect(await signIn(new Browser())).toBe("/login?provider=failed");
  });
});

describe("a provider changed while a sign-in is under way", () => {
  /** What an administrator does in Access: another issuer, saved while someone is mid-sign-in. */
  const changeIssuer = () => {
    providerSettings = { ...providerSettings!, issuer: "https://other.example" };
  };

  it("links nothing when the provider changes while the callback checks its answer", async () => {
    const real = createRelyingParty();
    router = createIdentityRouter(
      deps({
        relyingParty: {
          start: (client, request) => real.start(client, request),
          async finish(client, response) {
            const identity = await real.finish(client, response);
            changeIssuer();
            return identity;
          },
        },
      }),
    );
    const pair = await passwordAccount("ada", "correct horse");
    const bearer = { authorization: `Bearer ${pair.access_token}` };
    expect(await signIn(new Browser(), { return_to: "/settings/profile" }, bearer)).toBe("/settings/profile?provider=failed");
    expect((await mem.db.findAccountByUsername("ada"))!.oidc_sub).toBeNull();
    expect(events).toEqual([]);
  });

  it("lets a first visit end in neither an account nor a link once its provider is changed, and spends it", async () => {
    await claimed();
    await passwordAccount("ada", "correct horse");
    const first = await firstVisitTicket();
    const second = await firstVisitTicket();
    changeIssuer();

    const made = await first.browser.post("/auth/oidc/complete", { ticket: first.ticket, username: "newbie", invite: invite() });
    expect(made.status).toBe(403);
    expect((await made.json()).error).toBe("ticket_invalid");
    const linked = await second.browser.post("/auth/oidc/link", { ticket: second.ticket, username: "ada", password: "correct horse" });
    expect(linked.status).toBe(403);
    expect((await linked.json()).error).toBe("ticket_invalid");

    expect([...mem.accounts.values()].map((a) => a.oidc_sub)).toEqual([null, null]);
    expect(mem.tickets.size).toBe(0);
  });
});

describe("linking from a signed-in account", () => {
  it("links on the callback, back on the page it started from", async () => {
    const pair = await passwordAccount("ada", "correct horse");
    const browser = new Browser();
    const landed = await signIn(browser, { return_to: "/settings/profile" }, { authorization: `Bearer ${pair.access_token}` });
    expect(landed).toBe("/settings/profile?provider=linked");
    const account = (await mem.db.findAccountByUsername("ada"))!;
    expect(account.oidc_sub).toBe("mock-subject-1");
    expect(events).toEqual([{ alias: account.alias, action: "node.identity.link", detail: { via: "profile" } }]);

    const again = await browser.post("/auth/oidc/start", {}, { authorization: `Bearer ${pair.access_token}` });
    expect(again.status).toBe(409);
    expect((await again.json()).error).toBe("already_linked");
  });

  it("says taken when the subject belongs to another account, and failed when the provider refuses", async () => {
    const pair = await passwordAccount("ada", "correct horse");
    const other = await mem.db.createProviderAccount({
      alias: "u_other",
      username: "other",
      displayName: "O",
      email: null,
      oidcSub: "mock-subject-1",
      issuer: idp.issuer,
      inviteHash: sha256Hex(invite("for-other")),
    });
    expect(other.ok).toBe(true);
    const bearer = { authorization: `Bearer ${pair.access_token}` };
    expect(await signIn(new Browser(), { return_to: "/settings/profile?tab=1" }, bearer)).toBe("/settings/profile?tab=1&provider=taken");
    idp.deny = "access_denied";
    expect(await signIn(new Browser(), { return_to: "/settings/profile" }, bearer)).toBe("/settings/profile?provider=failed");
  });

  it("refuses an agent's key, a bad token, and a silent link", async () => {
    const key = await router.handle(post("/auth/oidc/start", {}, { authorization: "Bearer vk_abcdef_0123456789abcdef" }));
    expect(key.status).toBe(403);
    expect((await key.json()).error).toBe("agent_forbidden");
    const bad = await router.handle(post("/auth/oidc/start", {}, { authorization: "Bearer not-a-token" }));
    expect(bad.status).toBe(401);
    expect((await bad.json()).error).toBe("invalid_token");
    const pair = await passwordAccount("ada", "correct horse");
    const silent = await router.handle(post("/auth/oidc/start", { prompt: "none" }, { authorization: `Bearer ${pair.access_token}` }));
    expect(silent.status).toBe(400);
  });
});

describe("unlinking", () => {
  it("is refused while the provider is the only way in, and allowed once a password is set", async () => {
    await claimed();
    const { browser, ticket } = await firstVisitTicket();
    const made = (await (await browser.post("/auth/oidc/complete", { ticket, username: "ada", invite: invite() })).json()) as TokenPair;
    const bearer = { authorization: `Bearer ${made.access_token}` };

    const refused = await router.handle(post("/auth/oidc/unlink", {}, bearer));
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toBe("password_required");

    expect((await router.handle(post("/auth/password", { new_password: "battery staple" }, bearer))).status).toBe(204);
    expect((await router.handle(post("/auth/oidc/unlink", {}, bearer))).status).toBe(204);
    const account = (await mem.db.findAccountByUsername("ada"))!;
    expect(account.oidc_sub).toBeNull();
    expect(events).toEqual([{ alias: account.alias, action: "node.identity.unlink", detail: {} }]);
  });

  it("refuses an agent's key and a missing session", async () => {
    expect((await router.handle(post("/auth/oidc/unlink", {}, { authorization: "Bearer vk_abcdef_0123456789abcdef" }))).status).toBe(403);
    expect((await router.handle(post("/auth/oidc/unlink", {}))).status).toBe(401);
  });
});

describe("a first password for an account made through the provider", () => {
  async function providerAccount(): Promise<TokenPair> {
    await claimed();
    const { browser, ticket } = await firstVisitTicket();
    return (await (await browser.post("/auth/oidc/complete", { ticket, username: "ada", invite: invite() })).json()) as TokenPair;
  }

  it("is set with the session alone, once, and then signs in like any password", async () => {
    const pair = await providerAccount();
    const bearer = { authorization: `Bearer ${pair.access_token}` };
    const weak = await router.handle(post("/auth/password", { new_password: "short" }, bearer));
    expect(weak.status).toBe(400);
    expect((await router.handle(post("/auth/password", { new_password: "battery staple" }, bearer))).status).toBe(204);
    expect((await router.handle(post("/auth/login", { username: "ada", password: "battery staple" }))).status).toBe(200);

    const twice = await router.handle(post("/auth/password", { new_password: "another one!" }, bearer));
    expect(twice.status).toBe(409);
    expect((await twice.json()).error).toBe("password_set");
  });

  it("cannot be changed or used before it exists", async () => {
    await providerAccount();
    const change = await router.handle(post("/auth/password", { username: "ada", current_password: "anything", new_password: "battery staple" }));
    expect(change.status).toBe(401);
    expect((await change.json()).error).toBe("invalid_credentials");
    const login = await router.handle(post("/auth/login", { username: "ada", password: "anything" }));
    expect(login.status).toBe(401);
  });

  it("is refused to an agent's key", async () => {
    const res = await router.handle(post("/auth/password", { new_password: "battery staple" }, { authorization: "Bearer vk_abcdef_0123456789abcdef" }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("agent_forbidden");
  });

  it("comes with a reset link too, when the provider is gone", async () => {
    await providerAccount();
    const alias = (await mem.db.findAccountByUsername("ada"))!.alias;
    mem.resets.set(sha256Hex("reset-1"), { alias, expiresAt: new Date(Date.now() + 60_000), used: false });
    expect((await router.handle(post("/auth/reset", { token: "reset-1", new_password: "battery staple" }))).status).toBe(200);
    expect((await router.handle(post("/auth/login", { username: "ada", password: "battery staple" }))).status).toBe(200);
  });
});

describe("where a sign-in may return to", () => {
  it("keeps a path on this node and nothing else", () => {
    for (const ok of ["/", "/w/docs/1", "/settings/profile?tab=a#x", "/join/abc"]) expect(safeReturnTo(ok)).toBe(ok);
    for (const bad of [
      "//evil.test/x",
      "/\\evil.test",
      "https://evil.test",
      "evil",
      "/login",
      "/login/",
      "/login?next=/",
      "/auth/oidc/start",
      "/auth",
      "/a\u0000b",
      "/a\nb",
      `/${"x".repeat(2048)}`,
      42,
      null,
    ]) {
      expect(safeReturnTo(bad)).toBe("/");
    }
  });

  it("adds the outcome ahead of any fragment", () => {
    expect(withQuery("/settings/profile", "provider=linked")).toBe("/settings/profile?provider=linked");
    expect(withQuery("/p?a=1#h", "provider=taken")).toBe("/p?a=1&provider=taken#h");
  });

  it("stores only a safe return path", async () => {
    await new Browser().post("/auth/oidc/start", { return_to: "//evil.test" });
    expect([...mem.flows.values()][0]!.return_to).toBe("/");
  });
});
