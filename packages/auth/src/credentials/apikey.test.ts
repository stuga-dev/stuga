import { describe, it, expect } from "vitest";
import { mintApiKey, parseApiKey, looksLikeApiKey, mintRotatedApiKeySecret } from "./apikey.js";
import { sha256Hex } from "../crypto.js";

describe("api keys", () => {
  it("mints a parseable key whose secret hashes to the stored digest", () => {
    const minted = mintApiKey();
    expect(minted.token).toMatch(/^vk_[0-9a-f]{16}_[0-9a-f]{64}$/);
    const parsed = parseApiKey(minted.token);
    expect(parsed).not.toBeNull();
    expect(parsed!.keyId).toBe(minted.keyId);
    expect(sha256Hex(parsed!.secret)).toBe(minted.secretHash);
  });

  it("mints unique key ids and secrets", () => {
    const a = mintApiKey();
    const b = mintApiKey();
    expect(a.keyId).not.toBe(b.keyId);
    expect(a.secretHash).not.toBe(b.secretHash);
  });

  it("rotates the secret under the same key id", () => {
    const minted = mintApiKey();
    const rotated = mintRotatedApiKeySecret(minted.keyId);
    expect(rotated.keyId).toBe(minted.keyId);
    expect(rotated.token).not.toBe(minted.token);
    expect(sha256Hex(parseApiKey(rotated.token)!.secret)).toBe(rotated.secretHash);
  });

  it("rejects malformed tokens", () => {
    expect(parseApiKey("vk_")).toBeNull();
    expect(parseApiKey("vk_onlyid")).toBeNull();
    expect(parseApiKey("vk__nosecretid")).toBeNull();
    expect(parseApiKey("vk_id_")).toBeNull();
    expect(parseApiKey("eyJhbGciOiJSUzI1NiJ9.x.y")).toBeNull();
    expect(looksLikeApiKey("eyJhbGciOiJSUzI1NiJ9.x.y")).toBe(false);
  });

  it("splits on the first separator, so the secret may contain underscores", () => {
    const parsed = parseApiKey("vk_abc_sec_ret_tail");
    expect(parsed).toEqual({ keyId: "abc", secret: "sec_ret_tail" });
  });
});
