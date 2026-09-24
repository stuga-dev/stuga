/**
 * Account aliases: `u_` plus 16 base64url characters. Opaque, so renaming an
 * account never rewrites ACL entries, and case-sensitive, so
 * `canonicalizeAlias` must keep them byte-for-byte.
 */
import { randomBase64url } from "../crypto.js";

const LOCAL_ALIAS = /^u_[A-Za-z0-9_-]{16}$/;

export function newAlias(): string {
  return `u_${randomBase64url(12)}`;
}

export function isLocalAlias(alias: string): boolean {
  return LOCAL_ALIAS.test(alias);
}

/**
 * Every path that turns external input into an alias must call this: aliases
 * are exact-match keys in ACLs. A node-minted alias is kept as-is; anything
 * else is trimmed and lowercased, so a synced "Alice@x.com" lands on one entry.
 */
export function canonicalizeAlias(raw: string): string {
  const trimmed = raw.trim();
  if (isLocalAlias(trimmed)) return trimmed;
  return trimmed.toLowerCase();
}
