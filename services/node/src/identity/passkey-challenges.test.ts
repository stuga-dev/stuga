/** Passkey challenges (./passkey-challenges.ts): signed per process, one purpose each, single-use. */
import { describe, expect, it } from "vitest";
import { PASSKEY_TIMEOUT_MS } from "@stuga/auth";
import { createPasskeyChallenges } from "./passkey-challenges.js";

const bo = { alias: "u_bo", sid: "s-1" };

describe("passkey challenges", () => {
  it("read back for the purpose they were made for, with the sign-in they are bound to", () => {
    const c = createPasskeyChallenges();
    const text = c.issue("reauth", bo);
    expect(c.read(text, "reauth")).toMatchObject({ purpose: "reauth", binding: bo });
    expect(c.read(c.issue("sign-in", null), "sign-in")).toMatchObject({ purpose: "sign-in", binding: null });
  });

  it("never stand in for another purpose", () => {
    const c = createPasskeyChallenges();
    const signIn = c.issue("sign-in", null);
    expect(c.read(signIn, "reauth")).toBeNull();
    expect(c.read(signIn, "add")).toBeNull();
    // Relabelled, the signature no longer matches.
    expect(c.read(signIn.replace(".sign-in.", ".reauth."), "reauth")).toBeNull();
    expect(c.read(c.issue("add", bo), "reauth")).toBeNull();
  });

  it("refuse a changed binding, a changed expiry, and any tampering", () => {
    const c = createPasskeyChallenges();
    const text = c.issue("add", bo);
    const parts = text.split(".");
    const otherSid = [...parts.slice(0, 5), Buffer.from("s-2").toString("base64url"), parts[6]].join(".");
    expect(c.read(otherSid, "add")).toBeNull();
    const otherAlias = [...parts.slice(0, 4), Buffer.from("u_liv").toString("base64url"), ...parts.slice(5)].join(".");
    expect(c.read(otherAlias, "add")).toBeNull();
    const later = [...parts.slice(0, 3), String(Number(parts[3]) + 60_000), ...parts.slice(4)].join(".");
    expect(c.read(later, "add")).toBeNull();
    expect(c.read(`${text}x`, "add")).toBeNull();
    expect(c.read("", "add")).toBeNull();
    expect(c.read("a".repeat(600), "add")).toBeNull();
  });

  it("lapse after five minutes", () => {
    let now = 1_000_000;
    const c = createPasskeyChallenges({ now: () => now });
    const text = c.issue("sign-in", null);
    now += PASSKEY_TIMEOUT_MS - 1;
    expect(c.read(text, "sign-in")).not.toBeNull();
    now += 1;
    expect(c.read(text, "sign-in")).toBeNull();
  });

  it("are void in another process: the key lives only as long as the one that signed them", () => {
    const before = createPasskeyChallenges();
    const after = createPasskeyChallenges();
    expect(after.read(before.issue("sign-in", null), "sign-in")).toBeNull();
  });

  it("are held once: a second claim fails, a released one can be claimed again, and held ones go when they lapse", () => {
    let now = 1_000_000;
    const c = createPasskeyChallenges({ now: () => now });
    const ticket = c.read(c.issue("sign-in", null), "sign-in")!;
    expect(c.claim(ticket)).toBe(true);
    expect(c.claim(ticket)).toBe(false);
    c.release(ticket);
    expect(c.claim(ticket)).toBe(true);
    expect(c.held()).toBe(1);
    now += PASSKEY_TIMEOUT_MS;
    expect(c.held()).toBe(0);
  });

  it("hold nothing for a challenge that was only asked for", () => {
    const c = createPasskeyChallenges();
    for (let i = 0; i < 100; i++) c.issue("sign-in", null);
    expect(c.held()).toBe(0);
  });
});
