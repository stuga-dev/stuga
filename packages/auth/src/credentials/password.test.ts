import { describe, expect, it } from "vitest";
import { hashPassword, needsRehash, verifyPassword } from "./password.js";

describe("passwords (scrypt)", () => {
  it("round-trips and encodes its parameters and salt", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash).toMatch(/^scrypt\$65536\$8\$2\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
    expect(await verifyPassword("correct horse battery stapl", hash)).toBe(false);
    expect(await verifyPassword("", hash)).toBe(false);
  });

  it("salts every hash, so equal passwords never share a hash", async () => {
    const a = await hashPassword("same");
    const b = await hashPassword("same");
    expect(a).not.toBe(b);
    expect(await verifyPassword("same", a)).toBe(true);
    expect(await verifyPassword("same", b)).toBe(true);
  });

  it("verifies with the parameters stored in the hash, not the current defaults", async () => {
    const hash = await hashPassword("pw");
    // Re-label the hash as a cheaper derivation: the stored digest no longer
    // matches, proving the parameters in the string are the ones used.
    const cheaper = hash.replace("$65536$", "$1024$");
    expect(await verifyPassword("pw", cheaper)).toBe(false);
  });

  it("treats malformed or foreign hashes as a mismatch, never an exception", async () => {
    for (const bad of [
      "",
      "plaintext",
      "bcrypt$10$abc$def",
      "scrypt$16384$8$1$salt",
      "scrypt$notanumber$8$1$c2FsdA$aGFzaA",
      "scrypt$16383$8$1$c2FsdA$aGFzaA", // not a power of two
      "scrypt$1073741824$8$1$c2FsdA$aGFzaA", // beyond the accepted cost
      "scrypt$16384$8$1$$aGFzaA",
    ]) {
      expect(await verifyPassword("pw", bad)).toBe(false);
    }
  });

  it("verifies an older, cheaper hash, and says it needs hashing again", async () => {
    // N=2^14, r=8, p=1: what the node stored before the cost went up.
    const { scrypt } = await import("node:crypto");
    const salt = Buffer.from("0123456789abcdef");
    const key = await new Promise<Buffer>((res, rej) =>
      scrypt("pw", salt, 32, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? rej(e) : res(k))),
    );
    const old = ["scrypt", 16384, 8, 1, salt.toString("base64url"), key.toString("base64url")].join("$");
    expect(await verifyPassword("pw", old)).toBe(true);
    expect(needsRehash(old)).toBe(true);
    expect(needsRehash(await hashPassword("pw"))).toBe(false);
    // Nothing to redo for what is not a hash at all.
    expect(needsRehash("plaintext")).toBe(false);
  });
});
