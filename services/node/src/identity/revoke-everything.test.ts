/**
 * Revoke everything from the person's own session (POST /auth/revoke-everything): every sign-in at
 * both addresses ends, every way in goes, and the browser that asked keeps a new session with the
 * new password. What the database takes is tested against Postgres (packages/db
 * account-security.integration.test.ts); an administrator's is api/node/admins.test.ts.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hashPassword, sha256Hex } from "@stuga/auth";
import { deviceCookieOf, harness, type Harness } from "./testing/harness.js";
import type { TokenPair } from "./routes.js";

const PASSWORD = "trumpet walnut ceiling";
const NEW = "battery staple horse 9";
let hash: string;
beforeAll(async () => {
  hash = await hashPassword(PASSWORD);
});

let h: Harness;
beforeEach(async () => {
  h = await harness();
  await h.account("liv", hash);
  await h.account("bo", hash);
});
afterEach(() => h.close());

const bearer = (pair: TokenPair) => ({ authorization: `Bearer ${pair.access_token}` });

describe("POST /auth/revoke-everything", () => {
  it("ends every sign-in at both addresses, takes every way in, and signs this browser in with the new password", async () => {
    const lan = await h.signIn("lan", "bo", PASSWORD);
    const elsewhere = await h.signIn("remote", "bo", PASSWORD);
    const here = await h.signIn("remote", "bo", PASSWORD, elsewhere.cookie);
    h.mem.accounts.get("u_bo")!.oidc_sub = "idp-subject";
    h.mem.resets.set(sha256Hex("reset-1"), { alias: "u_bo", expiresAt: new Date(Date.now() + 60_000), used: false });
    h.alerts.length = 0;
    h.events.length = 0;

    const res = await h.router.handle(h.remote("/auth/revoke-everything", { new_password: NEW }, { ...bearer(here.pair), cookie: here.cookie! }));
    expect(res.status).toBe(200);
    const next = (await res.json()) as TokenPair;
    expect(Object.keys(next).sort()).toEqual(["access_token", "expires_in", "refresh_token", "token_type"]);
    // This browser is remembered again, under the cookie it had, and nobody is told about it as new.
    expect(deviceCookieOf(res)).toBe(here.cookie);

    // Every earlier session is over, at both addresses, and their sockets close.
    const live = [...h.mem.sessions.values()].filter((r) => !r.revoked_at);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ arrival: "remote", signed_in_with: "password" });
    expect(h.ended).toContain("u_bo");
    for (const old of [lan, elsewhere, here]) {
      const reuse = await h.router.handle(h.lan("/auth/password", { new_password: "another one 1" }, bearer(old.pair)));
      expect(reuse.status).toBe(401);
    }

    // The provider link, the unused password link, the browsers: gone. The old password no longer works.
    expect(h.mem.accounts.get("u_bo")!.oidc_sub).toBeNull();
    expect(h.mem.resets.size).toBe(0);
    expect([...h.mem.devices.keys()].filter((k) => k.startsWith("u_bo:"))).toHaveLength(1);
    expect((await h.router.handle(h.lan("/auth/login", { username: "bo", password: PASSWORD }))).status).toBe(401);
    expect((await h.router.handle(h.lan("/auth/login", { username: "bo", password: NEW }))).status).toBe(200);

    expect(h.alerts.map((a) => a.kind)).toEqual(["revokedEverything"]);
    expect(h.alerts[0]!.input).toMatchObject({ alias: "u_bo", name: "Bo", device: "Safari on iPhone" });
    expect(h.alerts[0]!.input.by).toBeUndefined();
    expect(h.events).toEqual([
      {
        alias: "u_bo",
        action: "node.account.revoke_everything",
        detail: expect.objectContaining({ sessions: 3, provider: true, password_links: 1, by_admin: false }),
      },
    ]);
  });

  it("works on the node's network the same way, leaving other people alone", async () => {
    const liv = await h.signIn("lan", "liv", PASSWORD);
    const bo = await h.signIn("lan", "bo", PASSWORD);
    const res = await h.router.handle(h.lan("/auth/revoke-everything", { new_password: NEW }, bearer(bo.pair)));
    expect(res.status).toBe(200);
    expect(deviceCookieOf(res)).toMatch(/^stuga-device-local=/);
    expect(h.ended).toEqual(["u_bo"]);
    const livRows = [...h.mem.sessions.values()].filter((r) => r.alias === "u_liv" && !r.revoked_at);
    expect(livRows).toHaveLength(1);
    expect(liv.pair.access_token).toBeTruthy();
  });

  it("takes a new password by the usual rule, and refuses an agent's key and a missing session", async () => {
    const { pair } = await h.signIn("lan", "bo", PASSWORD);
    const weak = await h.router.handle(h.lan("/auth/revoke-everything", { new_password: "short" }, bearer(pair)));
    expect(weak.status).toBe(400);
    expect([...h.mem.sessions.values()].filter((r) => !r.revoked_at)).toHaveLength(1);
    expect((await h.router.handle(h.lan("/auth/revoke-everything", { new_password: NEW }))).status).toBe(401);
    const key = await h.router.handle(h.lan("/auth/revoke-everything", { new_password: NEW }, { authorization: "Bearer vk_abcdef_0123456789abcdef" }));
    expect(key.status).toBe(403);
    expect((await key.json()).error).toBe("agent_forbidden");
  });
});

describe("an ordinary password change", () => {
  it("ends every session and tells the person, the administrators too when it happened at the remote address", async () => {
    await h.signIn("lan", "bo", PASSWORD);
    h.alerts.length = 0;
    const local = await h.router.handle(h.lan("/auth/password", { username: "bo", current_password: PASSWORD, new_password: NEW }));
    expect(local.status).toBe(200);
    expect(h.alerts.map((a) => a.kind)).toEqual(["passwordChanged"]);
    expect(h.alerts[0]!.input).toMatchObject({ alias: "u_bo", how: "changed", remoteHost: null });

    const remote = await h.signIn("remote", "bo", NEW);
    h.alerts.length = 0;
    const res = await h.router.handle(h.remote("/auth/password", { current_password: NEW, new_password: PASSWORD }, { ...bearer(remote.pair), cookie: remote.cookie! }));
    expect(res.status).toBe(200);
    expect(h.alerts.map((a) => a.kind)).toEqual(["passwordChanged"]);
    expect(h.alerts[0]!.input).toMatchObject({ how: "changed", remoteHost: "k7f3q2.stuga.test" });
    // Nothing else is taken: the browsers it signed in from stay known.
    expect(h.mem.devices.size).toBeGreaterThan(0);
  });
});
