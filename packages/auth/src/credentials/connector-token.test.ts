import { describe, expect, it } from "vitest";
import { sha256Hex } from "../crypto.js";
import { connectorTokenKind, hashConnectorToken, mintConnectorToken } from "./connector-token.js";
import { looksLikeApiKey } from "./apikey.js";

describe("connector tokens", () => {
  it("mints each kind behind its own prefix, stored as its sha-256", () => {
    const access = mintConnectorToken("access");
    const refresh = mintConnectorToken("refresh");
    expect(access.token).toMatch(/^sto_[A-Za-z0-9_-]{43}$/);
    expect(refresh.token).toMatch(/^str_[A-Za-z0-9_-]{43}$/);
    expect(access.hash).toBe(sha256Hex(access.token));
    expect(hashConnectorToken(refresh.token)).toBe(refresh.hash);
    expect(mintConnectorToken("access").token).not.toBe(access.token);
  });

  it("tells the kinds apart, and from API keys and session tokens", () => {
    expect(connectorTokenKind(mintConnectorToken("access").token)).toBe("access");
    expect(connectorTokenKind(mintConnectorToken("refresh").token)).toBe("refresh");
    expect(connectorTokenKind("vk_0123456789abcdef_secret")).toBeNull();
    expect(connectorTokenKind("eyJhbGciOiJFUzI1NiJ9.e30.sig")).toBeNull();
    expect(looksLikeApiKey(mintConnectorToken("access").token)).toBe(false);
  });
});
