import { describe, expect, it } from "vitest";
import { canonicalizeAlias, isLocalAlias, newAlias } from "./alias.js";

describe("node-local aliases", () => {
  it("mints u_ + 16 base64url characters, unique each time", () => {
    const a = newAlias();
    const b = newAlias();
    expect(a).toMatch(/^u_[A-Za-z0-9_-]{16}$/);
    expect(a).not.toBe(b);
    expect(isLocalAlias(a)).toBe(true);
  });

  it("does not mistake provider subjects or emails for local aliases", () => {
    expect(isLocalAlias("8f14e45f-ceea-467a-9f3a-1b2c3d4e5f60")).toBe(false);
    expect(isLocalAlias("u_short")).toBe(false);
    expect(isLocalAlias("user@example.test")).toBe(false);
    expect(isLocalAlias("U_abcdefghijklmnop")).toBe(false);
  });
});

describe("canonicalizeAlias", () => {
  it("trims and lowercases anything that is not a node-minted alias", () => {
    expect(canonicalizeAlias("  Alice@Example.COM ")).toBe("alice@example.com");
  });

  it("keeps a node-minted alias byte-for-byte (base64url is case-sensitive)", () => {
    const alias = newAlias();
    expect(canonicalizeAlias(alias)).toBe(alias);
    expect(canonicalizeAlias(`  ${alias}  `)).toBe(alias);
  });
});
