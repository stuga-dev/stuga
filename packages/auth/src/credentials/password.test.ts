import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password.js";

describe("passwords (scrypt)", () => {
  it("round-trips and encodes its parameters and salt", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash).toMatch(/^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
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
    const cheaper = hash.replace("$16384$", "$1024$");
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
});
