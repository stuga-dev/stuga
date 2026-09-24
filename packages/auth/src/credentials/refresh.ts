/** Refresh tokens for node-local sessions: opaque random strings, stored only as sha-256. */
import { randomBase64url, sha256Hex } from "../crypto.js";

export function hashRefreshToken(token: string): string {
  return sha256Hex(token);
}

/** 32 random bytes, base64url, with the stored hash. */
export function mintRefreshToken(): { token: string; hash: string } {
  const token = randomBase64url(32);
  return { token, hash: hashRefreshToken(token) };
}
