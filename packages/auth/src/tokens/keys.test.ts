import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeJwt, decodeProtectedHeader } from "jose";
import { loadOrCreateSigningKey, publicJwks, signAccessToken } from "./keys.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "stuga-auth-keys-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("loadOrCreateSigningKey", () => {
  it("creates an owner-only ES256 private JWK on first use and reloads the same key", async () => {
    const file = join(dir, "identity", "signing.jwk");
    const first = await loadOrCreateSigningKey(file);
    const mode = (await stat(file)).mode & 0o777;
    expect(mode).toBe(0o600);

    const stored = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    expect(stored["kty"]).toBe("EC");
    expect(stored["crv"]).toBe("P-256");
    expect(typeof stored["d"]).toBe("string");
    expect(stored["kid"]).toBe(first.kid);

    const second = await loadOrCreateSigningKey(file);
    expect(second.kid).toBe(first.kid);
    expect(second.publicJwk).toEqual(first.publicJwk);
  });

  it("gives concurrent first boots one key, not the last writer's", async () => {
    const file = join(dir, "signing.jwk");
    const [a, b, c] = await Promise.all([
      loadOrCreateSigningKey(file),
      loadOrCreateSigningKey(file),
      loadOrCreateSigningKey(file),
    ]);
    expect(b.kid).toBe(a.kid);
    expect(c.kid).toBe(a.kid);
    const stored = JSON.parse(await readFile(file, "utf8")) as { kid: string };
    expect(stored.kid).toBe(a.kid);
  });

  it("refuses a key file that is not a private EC JWK", async () => {
    const file = join(dir, "signing.jwk");
    await (await import("node:fs/promises")).writeFile(file, JSON.stringify({ kty: "RSA" }));
    await expect(loadOrCreateSigningKey(file)).rejects.toThrow(/not a private EC JWK/);
  });
});

describe("publicJwks", () => {
  it("publishes only the public half, tagged for ES256 signatures", async () => {
    const keys = await loadOrCreateSigningKey(join(dir, "signing.jwk"));
    const jwks = publicJwks(keys);
    expect(jwks.keys).toHaveLength(1);
    const [jwk] = jwks.keys;
    expect(jwk).toMatchObject({ kty: "EC", crv: "P-256", kid: keys.kid, alg: "ES256", use: "sig" });
    expect(jwk).not.toHaveProperty("d");
    expect(jwk).not.toHaveProperty("key_ops");
  });
});

describe("signAccessToken", () => {
  it("mints the documented claim set under the node's kid", async () => {
    const keys = await loadOrCreateSigningKey(join(dir, "signing.jwk"));
    const before = Math.floor(Date.now() / 1000);
    const token = await signAccessToken(keys, {
      alias: "u_abcdefghijklmnop",
      username: "ada",
      displayName: "Ada",
      issuer: "http://localhost:8787",
      audience: "stuga-node",
      ttlSeconds: 900,
    });
    expect(decodeProtectedHeader(token)).toEqual({ alg: "ES256", kid: keys.kid, typ: "JWT" });
    const claims = decodeJwt(token);
    expect(claims).toMatchObject({
      iss: "http://localhost:8787",
      aud: "stuga-node",
      sub: "u_abcdefghijklmnop",
      preferred_username: "ada",
      name: "Ada",
      token_use: "access",
    });
    expect(claims.iat).toBeGreaterThanOrEqual(before);
    expect(claims.exp).toBe(claims.iat! + 900);
  });

  it("never mints an email claim: a local account's address is unverified", async () => {
    const keys = await loadOrCreateSigningKey(join(dir, "signing.jwk"));
    const token = await signAccessToken(keys, {
      alias: "u_abcdefghijklmnop",
      username: "nameless",
      displayName: "Nameless",
      issuer: "http://localhost:8787",
      audience: "stuga-node",
      ttlSeconds: 60,
    });
    expect(decodeJwt(token)).not.toHaveProperty("email");
  });
});
