import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SignJWT } from "jose";
import type { AuthConfig } from "./config.js";
import { loadOrCreateSigningKey, signAccessToken } from "./keys.js";
import { createVerifier, type TokenArrival } from "./verifier.js";

const LOCAL: TokenArrival = { arrival: "local" };
const REMOTE_ORIGIN = "https://k7f3q2.stuga.test";
const REMOTE: TokenArrival = { arrival: "remote", origin: REMOTE_ORIGIN };

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "stuga-auth-verifier-"));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

describe("createVerifier", () => {
  const cfg = (): AuthConfig => ({
    issuer: "http://localhost:8787",
    audience: "stuga-node",
    keyFile: join(dir, "signing.jwk"),
    accessTokenTtlSeconds: 900,
    refreshTokenTtlSeconds: 86400,
    refreshRotationGraceSeconds: 60,
  });

  it("round-trips a node-signed access token without touching the network", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("no network"))));
    const c = cfg();
    const keys = await loadOrCreateSigningKey(c.keyFile);
    const token = await signAccessToken(keys, {
      alias: "u_abcdefghijklmnop",
      sid: "s_1",
      username: "ada",
      displayName: "Ada Lovelace",
      issuer: c.issuer,
      audience: c.audience,
      ttlSeconds: c.accessTokenTtlSeconds,
    });

    const { verify } = createVerifier(c, keys);
    const principal = await verify(token, LOCAL);
    expect(principal.alias).toBe("u_abcdefghijklmnop");
    expect(principal.sid).toBe("s_1");
    expect(principal.claims.token_use).toBe("access");
    expect(principal).not.toHaveProperty("email");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects tokens for another issuer or audience, and tokens that are not access tokens", async () => {
    const c = cfg();
    const keys = await loadOrCreateSigningKey(c.keyFile);
    const { verify } = createVerifier(c, keys);
    const base = { alias: "u_abcdefghijklmnop", sid: "s_1", username: "ada", displayName: "Ada", ttlSeconds: 60 };

    const wrongIssuer = await signAccessToken(keys, { ...base, issuer: "http://elsewhere", audience: c.audience });
    await expect(verify(wrongIssuer, LOCAL)).rejects.toThrow(/token verification failed/);

    const wrongAudience = await signAccessToken(keys, { ...base, issuer: c.issuer, audience: "other" });
    await expect(verify(wrongAudience, LOCAL)).rejects.toThrow(/"aud" claim/);

    const notAccess = await new SignJWT({ token_use: "refresh", sid: "s_1" })
      .setProtectedHeader({ alg: "ES256", kid: keys.kid })
      .setIssuer(c.issuer)
      .setAudience(c.audience)
      .setSubject("u_abcdefghijklmnop")
      .setExpirationTime("5m")
      .sign(keys.privateKey);
    await expect(verify(notAccess, LOCAL)).rejects.toThrow(/expected token_use=access/);
  });

  it("rejects a token signed by a different key", async () => {
    const c = cfg();
    const keys = await loadOrCreateSigningKey(c.keyFile);
    const other = await loadOrCreateSigningKey(join(dir, "other.jwk"));
    const token = await signAccessToken(other, {
      alias: "u_abcdefghijklmnop",
      sid: "s_1",
      username: "impostor",
      displayName: "Impostor",
      issuer: c.issuer,
      audience: c.audience,
      ttlSeconds: 60,
    });
    await expect(createVerifier(c, keys).verify(token, LOCAL)).rejects.toThrow(/token verification failed/);
  });

  it("takes a token only where it was issued: the LAN's audience on the LAN, the remote origin at the remote address", async () => {
    const c = cfg();
    const keys = await loadOrCreateSigningKey(c.keyFile);
    const { verify } = createVerifier(c, keys);
    const base = { alias: "u_abcdefghijklmnop", sid: "s_1", username: "ada", displayName: "Ada", issuer: c.issuer, ttlSeconds: 60 };
    const local = await signAccessToken(keys, { ...base, audience: c.audience });
    const remote = await signAccessToken(keys, { ...base, audience: REMOTE_ORIGIN });

    expect((await verify(local, LOCAL)).alias).toBe(base.alias);
    expect((await verify(remote, REMOTE)).alias).toBe(base.alias);
    await expect(verify(local, REMOTE)).rejects.toThrow(/"aud" claim/);
    await expect(verify(remote, LOCAL)).rejects.toThrow(/"aud" claim/);
    // Another node's remote address is another audience.
    await expect(verify(remote, { arrival: "remote", origin: "https://zzzzzz.stuga.test" })).rejects.toThrow(/"aud" claim/);
  });

  it("refuses a token that names no session, on either listener", async () => {
    const c = cfg();
    const keys = await loadOrCreateSigningKey(c.keyFile);
    const { verify } = createVerifier(c, keys);
    const sessionless = (aud: string) =>
      new SignJWT({ token_use: "access" })
        .setProtectedHeader({ alg: "ES256", kid: keys.kid })
        .setIssuer(c.issuer)
        .setAudience(aud)
        .setSubject("u_abcdefghijklmnop")
        .setExpirationTime("5m")
        .sign(keys.privateKey);
    await expect(verify(await sessionless(c.audience), LOCAL)).rejects.toThrow(/missing sid/);
    await expect(verify(await sessionless(REMOTE_ORIGIN), REMOTE)).rejects.toThrow(/missing sid/);
  });
});
