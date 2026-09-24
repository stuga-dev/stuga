import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SignJWT } from "jose";
import type { AuthConfig } from "./config.js";
import { loadOrCreateSigningKey, signAccessToken } from "./keys.js";
import { createVerifier } from "./verifier.js";

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
      username: "ada",
      displayName: "Ada Lovelace",
      issuer: c.issuer,
      audience: c.audience,
      ttlSeconds: c.accessTokenTtlSeconds,
    });

    const { verify } = createVerifier(c, keys);
    const principal = await verify(token);
    expect(principal.alias).toBe("u_abcdefghijklmnop");
    expect(principal.claims.token_use).toBe("access");
    expect(principal).not.toHaveProperty("email");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects tokens for another issuer or audience, and tokens that are not access tokens", async () => {
    const c = cfg();
    const keys = await loadOrCreateSigningKey(c.keyFile);
    const { verify } = createVerifier(c, keys);
    const base = { alias: "u_abcdefghijklmnop", username: "ada", displayName: "Ada", ttlSeconds: 60 };

    const wrongIssuer = await signAccessToken(keys, { ...base, issuer: "http://elsewhere", audience: c.audience });
    await expect(verify(wrongIssuer)).rejects.toThrow(/token verification failed/);

    const wrongAudience = await signAccessToken(keys, { ...base, issuer: c.issuer, audience: "other" });
    await expect(verify(wrongAudience)).rejects.toThrow(/"aud" claim/);

    const notAccess = await new SignJWT({ token_use: "refresh" })
      .setProtectedHeader({ alg: "ES256", kid: keys.kid })
      .setIssuer(c.issuer)
      .setAudience(c.audience)
      .setSubject("u_abcdefghijklmnop")
      .setExpirationTime("5m")
      .sign(keys.privateKey);
    await expect(verify(notAccess)).rejects.toThrow(/expected token_use=access/);
  });

  it("rejects a token signed by a different key", async () => {
    const c = cfg();
    const keys = await loadOrCreateSigningKey(c.keyFile);
    const other = await loadOrCreateSigningKey(join(dir, "other.jwk"));
    const token = await signAccessToken(other, {
      alias: "u_abcdefghijklmnop",
      username: "impostor",
      displayName: "Impostor",
      issuer: c.issuer,
      audience: c.audience,
      ttlSeconds: 60,
    });
    await expect(createVerifier(c, keys).verify(token)).rejects.toThrow(/token verification failed/);
  });
});
