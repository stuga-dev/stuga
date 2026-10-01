/**
 * scrypt password hashes as `scrypt$N$r$p$salt$hash` (base64url). A hash
 * verifies with the parameters stored in it, so the cost can be raised later:
 * one made with other parameters `needsRehash`, and the node hashes it again
 * on the next sign-in. The cost is OWASP's N=2^16, r=8, p=2 (64 MiB each),
 * which takes as long as N=2^17, r=8, p=1 in half the memory. Callers that run
 * hashes for people go through a HashQueue (./hash-queue.ts), so a burst of
 * sign-ins cannot take every thread or all the memory.
 */
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

export const SCRYPT_N = 65536;
export const SCRYPT_R = 8;
export const SCRYPT_P = 2;
const SALT_BYTES = 16;
const KEY_BYTES = 32;

// Bounds on stored parameters, so a tampered row cannot make one sign-in exhaust memory.
const MAX_N = 1 << 20;
const MAX_R = 32;
const MAX_P = 16;

function derive(password: string, salt: Buffer, keyLen: number, N: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLen, { N, r, p, maxmem: 256 * N * r }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, KEY_BYTES, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return ["scrypt", SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString("base64url"), key.toString("base64url")].join("$");
}

function positiveInt(s: string | undefined, max: number): number | null {
  if (s === undefined || !/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= max ? n : null;
}

interface Parsed {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  expected: Buffer;
}

function parse(stored: string): Parsed | null {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const N = positiveInt(parts[1], MAX_N);
  const r = positiveInt(parts[2], MAX_R);
  const p = positiveInt(parts[3], MAX_P);
  if (N === null || r === null || p === null || (N & (N - 1)) !== 0) return null;
  const salt = Buffer.from(parts[4]!, "base64url");
  const expected = Buffer.from(parts[5]!, "base64url");
  if (salt.length === 0 || expected.length === 0) return null;
  return { N, r, p, salt, expected };
}

/** True when `stored` was not made with the current parameters, so the next sign-in should hash the password again. */
export function needsRehash(stored: string): boolean {
  const parsed = parse(stored);
  if (!parsed) return false;
  return parsed.N !== SCRYPT_N || parsed.r !== SCRYPT_R || parsed.p !== SCRYPT_P || parsed.expected.length !== KEY_BYTES;
}

/** A malformed or foreign hash is a mismatch, never an exception. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parse(stored);
  if (!parsed) return false;
  const { N, r, p, salt, expected } = parsed;
  const actual = await derive(password, salt, expected.length, N, r, p);
  return timingSafeEqual(actual, expected);
}
