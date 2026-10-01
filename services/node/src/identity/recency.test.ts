/**
 * "Confirmed in the last five minutes" on the sign-in routes (./recency.ts): a session older than
 * that cannot give the account a new way in, and confirming moves only the session's
 * `confirmed_at`. The API routes it guards are tested beside them (api/keys, api/account,
 * api/node/settings, api/node/admins).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "@stuga/auth";
import { harness, type Harness } from "./testing/harness.js";
import type { TokenPair } from "./routes.js";

const PASSWORD = "trumpet walnut ceiling";
const SHORT = "correct horse";
let hash: string;
let shortHash: string;
beforeAll(async () => {
  [hash, shortHash] = await Promise.all([hashPassword(PASSWORD), hashPassword(SHORT)]);
});

let h: Harness;
beforeEach(async () => {
  h = await harness();
});
afterEach(() => h.close());

const bearer = (pair: TokenPair) => ({ authorization: `Bearer ${pair.access_token}` });

describe("POST /auth/confirm", () => {
  it("with the password moves the session's confirmed_at, and nothing about when it began or ends", async () => {
    await h.account("ada", hash);
    const { pair } = await h.signIn("remote", "ada", PASSWORD);
    h.age(30);
    const [before] = [...h.mem.sessions.values()];
    const res = await h.router.handle(h.remote("/auth/confirm", { password: PASSWORD }, bearer(pair)));
    expect(res.status).toBe(204);
    const [after] = [...h.mem.sessions.values()];
    expect(Date.now() - Date.parse(after!.confirmed_at)).toBeLessThan(5_000);
    expect(after!.signed_in_at).toBe(before!.signed_in_at);
    expect(after!.absolute_expires_at).toBe(before!.absolute_expires_at);
    expect(after!.expires_at).toBe(before!.expires_at);
  });

  it("refuses a wrong password, counted like any sign-in's, and leaves the session as it was", async () => {
    await h.account("ada", hash);
    const { pair } = await h.signIn("lan", "ada", PASSWORD);
    h.age(30);
    for (let i = 0; i < 4; i++) {
      const wrong = await h.router.handle(h.lan("/auth/confirm", { password: "not the password" }, bearer(pair)));
      expect(wrong.status).toBe(401);
      expect((await wrong.json()).error).toBe("invalid_credentials");
    }
    // The fifth pauses the account for a browser it does not know, as at the sign-in page.
    expect((await h.router.handle(h.lan("/auth/confirm", { password: "not the password" }, bearer(pair)))).status).toBe(401);
    expect((await h.router.handle(h.lan("/auth/login", { username: "ada", password: PASSWORD }))).status).toBe(429);
    const [row] = [...h.mem.sessions.values()].filter((r) => !r.revoked_at);
    expect(Date.now() - Date.parse(row!.confirmed_at)).toBeGreaterThan(29 * 60_000);
  });

  it("at the remote address holds the password to the remote rule", async () => {
    await h.account("ada", shortHash);
    // A session at the remote address that began some other way, such as a reset link.
    const { sha256Hex } = await import("@stuga/auth");
    h.mem.resets.set(sha256Hex("reset-1"), { alias: "u_ada", expiresAt: new Date(Date.now() + 60_000), used: false });
    const reset = await h.router.handle(h.remote("/auth/reset", { token: "reset-1", new_password: SHORT }));
    const pair = (await reset.json()) as TokenPair;
    const res = await h.router.handle(h.remote("/auth/confirm", { password: SHORT }, bearer(pair)));
    expect((await res.json()).error).toBe("remote_password_weak");
  });

  it("takes a person's session only", async () => {
    expect((await h.router.handle(h.lan("/auth/confirm", { password: PASSWORD }))).status).toBe(401);
    const key = await h.router.handle(h.lan("/auth/confirm", { password: PASSWORD }, { authorization: "Bearer vk_abcdef_0123456789abcdef" }));
    expect(key.status).toBe(403);
    expect((await key.json()).error).toBe("agent_forbidden");
  });
});

describe("a session older than five minutes", () => {
  it("cannot set a first password on the node's network either, until it is confirmed", async () => {
    await h.account("liv", hash);
    await h.account("ada", hash);
    const { pair } = await h.signIn("lan", "ada", PASSWORD);
    h.mem.accounts.get("u_ada")!.password_hash = null;
    h.age(6);
    const stale = await h.router.handle(h.lan("/auth/password", { new_password: "battery staple 9" }, bearer(pair)));
    expect(stale.status).toBe(401);
    expect(stale.headers.get("x-stuga-reauth")).toBe("1");
    // No password, and no provider linked: nothing to confirm with but signing in again.
    expect(await stale.json()).toEqual({ error: "reauth_required", message: "confirm it's you", methods: [] });
    h.age(1);
    expect((await h.router.handle(h.lan("/auth/password", { new_password: "battery staple 9" }, bearer(pair)))).status).toBe(204);
  });

  it("cannot revoke everything until it is confirmed", async () => {
    await h.account("ada", hash);
    const { pair } = await h.signIn("lan", "ada", PASSWORD);
    h.age(6);
    const stale = await h.router.handle(h.lan("/auth/revoke-everything", { new_password: "battery staple 9" }, bearer(pair)));
    expect(stale.status).toBe(401);
    expect((await stale.json()).methods).toEqual(["password"]);
    expect((await h.router.handle(h.lan("/auth/confirm", { password: PASSWORD }, bearer(pair)))).status).toBe(204);
    expect((await h.router.handle(h.lan("/auth/revoke-everything", { new_password: "battery staple 9" }, bearer(pair)))).status).toBe(200);
  });

  it("keeps its fixed end however often it is confirmed", async () => {
    await h.account("ada", hash);
    const { pair } = await h.signIn("remote", "ada", PASSWORD);
    const [row] = [...h.mem.sessions.values()];
    const end = row!.absolute_expires_at;
    for (let i = 0; i < 3; i++) {
      h.age(10);
      expect((await h.router.handle(h.remote("/auth/confirm", { password: PASSWORD }, bearer(pair)))).status).toBe(204);
    }
    expect([...h.mem.sessions.values()][0]!.absolute_expires_at).toBe(end);
  });
});
