import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { constantTimeEqual, randomBase64url, randomHex, sha256Hex } from "./crypto.js";

describe("sha256Hex", () => {
  it("returns the lowercase hex digest synchronously", () => {
    expect(sha256Hex("s")).toBe(createHash("sha256").update("s").digest("hex"));
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});

describe("constantTimeEqual", () => {
  it("is true only for identical strings", () => {
    const h = sha256Hex("s");
    expect(constantTimeEqual(h, h)).toBe(true);
    expect(constantTimeEqual(h, sha256Hex("t"))).toBe(false);
  });

  it("compares unequal lengths as false instead of throwing", () => {
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("", "a")).toBe(false);
  });

  it("compares by bytes, so strings whose UTF-8 lengths differ are unequal", () => {
    expect(constantTimeEqual("é", "e")).toBe(false);
    expect(constantTimeEqual("é", "é")).toBe(true);
  });
});

describe("random encodings", () => {
  it("draws the requested number of bytes, freshly each time", () => {
    expect(randomHex(8)).toMatch(/^[0-9a-f]{16}$/);
    expect(randomBase64url(12)).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(randomHex(16)).not.toBe(randomHex(16));
  });
});
