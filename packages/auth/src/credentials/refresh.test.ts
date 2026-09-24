import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { hashRefreshToken, mintRefreshToken } from "./refresh.js";

describe("refresh tokens", () => {
  it("mints 32 random bytes as base64url with a sha-256 hex hash", () => {
    const { token, hash } = mintRefreshToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(createHash("sha256").update(token).digest("hex"));
  });

  it("hashRefreshToken reproduces the stored hash from the presented token", () => {
    const { token, hash } = mintRefreshToken();
    expect(hashRefreshToken(token)).toBe(hash);
    expect(hashRefreshToken(`${token}x`)).not.toBe(hash);
  });

  it("never mints the same token twice", () => {
    const seen = new Set(Array.from({ length: 50 }, () => mintRefreshToken().token));
    expect(seen.size).toBe(50);
  });
});
