/**
 * Known devices (./devices.ts): every sign-in remembers its browser through one exit, a browser new
 * to an account at the remote address is reported to the person and the administrators, and a known
 * browser keeps its own count of wrong passwords.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hashPassword, sha256Hex } from "@stuga/auth";
import { deviceCookie, deviceLabel, readDeviceCookie } from "./devices.js";
import { deviceCookieOf, harness, type Harness } from "./testing/harness.js";

const PASSWORD = "trumpet walnut ceiling";
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

describe("the device cookie", () => {
  it("at the remote address is __Host-, Secure, HttpOnly, SameSite=Strict, for 400 days", async () => {
    const { res } = await h.signIn("remote", "bo", PASSWORD);
    const [set] = res.headers.getSetCookie();
    expect(set).toMatch(/^__Host-stuga-device=[\w-]{43}; Path=\/; Max-Age=34560000; HttpOnly; SameSite=Strict; Secure$/);
  });

  it("on the node's own network is stuga-device-local, which plain http cannot make Secure", async () => {
    const { res } = await h.signIn("lan", "bo", PASSWORD);
    expect(res.headers.getSetCookie()[0]).toMatch(/^stuga-device-local=[\w-]{43}; Path=\/; Max-Age=34560000; HttpOnly; SameSite=Strict$/);
    // The answer itself is what it always was.
    expect(Object.keys(await res.json()).sort()).toEqual(["access_token", "expires_in", "refresh_token", "token_type"]);
  });

  it("is read only when there is exactly one, well formed", () => {
    const value = "a".repeat(43);
    const req = (cookie: string) => new Request("https://x.test/", { headers: { cookie } });
    expect(readDeviceCookie(req(`__Host-stuga-device=${value}`), "remote")).toBe(value);
    expect(readDeviceCookie(req(`__Host-stuga-device=${value}`), "local")).toBeNull();
    expect(readDeviceCookie(req(`__Host-stuga-device=${value}; __Host-stuga-device=${"b".repeat(43)}`), "remote")).toBeNull();
    expect(readDeviceCookie(req("__Host-stuga-device=short"), "remote")).toBeNull();
    expect(deviceCookie("local", value)).not.toContain("Secure");
  });
});

describe("a sign-in at the remote address", () => {
  it("from a browser new to the account tells the person and the administrators, once, and is audited", async () => {
    const first = await h.signIn("remote", "bo", PASSWORD);
    expect(h.alerts).toEqual([
      {
        kind: "newDevice",
        input: expect.objectContaining({
          alias: "u_bo",
          username: "bo",
          name: "Bo",
          device: "Safari on iPhone",
          remoteHost: "k7f3q2.stuga.test",
          from: "203.0.113.7",
        }),
      },
    ]);
    expect(h.events).toEqual([{ alias: "u_bo", action: "node.sign_in.new_device", detail: { device: "Safari on iPhone", from: "203.0.113.7" } }]);

    // The same browser again: nothing new.
    await h.signIn("remote", "bo", PASSWORD, first.cookie);
    expect(h.alerts).toHaveLength(1);
    // A browser whose cookie was cleared is new again.
    await h.signIn("remote", "bo", PASSWORD);
    expect(h.alerts).toHaveLength(2);
  });

  it("keeps one cookie per browser, whichever accounts sign in from it", async () => {
    const bo = await h.signIn("remote", "bo", PASSWORD);
    const liv = await h.signIn("remote", "liv", PASSWORD, bo.cookie);
    expect(liv.cookie).toBe(bo.cookie);
    // New to Liv, so Liv is told.
    expect(h.alerts.map((a) => a.input.alias)).toEqual(["u_bo", "u_liv"]);
  });

  it("knows a browser only at the listener it signed in at", async () => {
    const lan = await h.signIn("lan", "bo", PASSWORD);
    // The LAN's cookie is not sent as the remote one, and a LAN sign-in is never reported.
    expect(h.alerts).toEqual([]);
    const cookie = lan.cookie!.replace("stuga-device-local", "__Host-stuga-device");
    await h.signIn("remote", "bo", PASSWORD, cookie);
    expect(h.alerts).toHaveLength(1);
    expect([...h.mem.devices.keys()].map((k) => k.split(":").slice(0, 2).join(":")).sort()).toEqual(["u_bo:local", "u_bo:remote"]);
  });

  it("through a reset link is reported too; an invite's new account only remembers its browser", async () => {
    const { sha256Hex: hashOf } = await import("@stuga/auth");
    h.mem.resets.set(hashOf("reset-1"), { alias: "u_bo", expiresAt: new Date(Date.now() + 60_000), used: false });
    const reset = await h.router.handle(h.remote("/auth/reset", { token: "reset-1", new_password: "battery staple 9" }));
    expect(reset.status).toBe(200);
    expect(deviceCookieOf(reset)).toMatch(/^__Host-stuga-device=/);
    expect(h.alerts.map((a) => a.kind)).toEqual(["newDevice", "passwordChanged"]);

    h.alerts.length = 0;
    h.mem.invites.set(hashOf("join-1"), { tokenHash: hashOf("join-1"), usesLeft: 1 });
    const joined = await h.router.handle(h.remote("/auth/register", { username: "cy", password: "battery staple 9", invite: "join-1" }));
    expect(joined.status).toBe(201);
    expect(deviceCookieOf(joined)).toMatch(/^__Host-stuga-device=/);
    expect(h.alerts).toEqual([]);
    const cy = (await h.mem.db.findAccountByUsername("cy"))!;
    expect([...h.mem.devices.keys()].filter((k) => k.startsWith(`${cy.alias}:remote:`))).toHaveLength(1);
  });
});

describe("a known browser", () => {
  it("is not paused with the account: wrong passwords from elsewhere never lock it out", async () => {
    const mine = await h.signIn("lan", "bo", PASSWORD);
    for (let i = 0; i < 5; i++) {
      const wrong = await h.router.handle(h.lan("/auth/login", { username: "bo", password: "not the password" }, {}));
      expect(wrong.status).toBe(401);
    }
    expect((await h.router.handle(h.lan("/auth/login", { username: "bo", password: PASSWORD }))).status).toBe(429);
    const known = await h.router.handle(h.lan("/auth/login", { username: "bo", password: PASSWORD }, { cookie: mine.cookie! }));
    expect(known.status).toBe(200);
  });

  it("is known only for the account that signed in from it", async () => {
    const bo = await h.signIn("lan", "bo", PASSWORD);
    for (let i = 0; i < 5; i++) await h.router.handle(h.lan("/auth/login", { username: "liv", password: "not the password" }));
    const res = await h.router.handle(h.lan("/auth/login", { username: "liv", password: PASSWORD }, { cookie: bo.cookie! }));
    expect(res.status).toBe(429);
  });

  it("is stored only as the cookie's sha-256", async () => {
    const { cookie } = await h.signIn("remote", "bo", PASSWORD);
    const value = cookie!.split("=")[1]!;
    expect([...h.mem.devices.keys()]).toContain(`u_bo:remote:${sha256Hex(value)}`);
    expect([...h.mem.devices.keys()].join()).not.toContain(value);
  });
});

describe("a device's name", () => {
  it.each([
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1", "Safari on iPhone"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15", "Safari on Mac"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0", "Edge on Windows"],
    ["Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36", "Chrome on Android"],
    ["Mozilla/5.0 (X11; Linux x86_64; rv:142.0) Gecko/20100101 Firefox/142.0", "Firefox on Linux"],
    ["Mozilla/5.0 (iPad; CPU OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0 Mobile/15E148 Safari/604.1", "Chrome on iPad"],
    ["curl/8.9.1", "Unknown browser"],
    [null, "Unknown browser"],
  ])("%s → %s", (ua, label) => {
    expect(deviceLabel(ua)).toBe(label);
  });
});
