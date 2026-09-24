/**
 * API keys for agents: `vk_<key_id>_<secret>`. The key id is the public lookup
 * handle; only sha-256(secret) is stored, and the full token is shown once.
 */
import { randomHex, sha256Hex } from "../crypto.js";

const API_KEY_PREFIX = "vk_";

interface ParsedApiKey {
  keyId: string;
  secret: string;
}

interface MintedApiKey {
  /** The full bearer credential; never stored. */
  token: string;
  keyId: string;
  /** sha-256 hex of the secret half, the stored form. */
  secretHash: string;
}

/** Cheap syntactic check so bearer JWTs never reach the API-key path. */
export function looksLikeApiKey(token: string): boolean {
  return token.startsWith(API_KEY_PREFIX);
}

/** Split on the first separator after the prefix (the secret may contain underscores). */
export function parseApiKey(token: string): ParsedApiKey | null {
  if (!looksLikeApiKey(token)) return null;
  const rest = token.slice(API_KEY_PREFIX.length);
  const sep = rest.indexOf("_");
  if (sep <= 0 || sep === rest.length - 1) return null;
  return { keyId: rest.slice(0, sep), secret: rest.slice(sep + 1) };
}

/** A new key: 8-byte public id, 32-byte secret. */
export function mintApiKey(): MintedApiKey {
  return mintRotatedApiKeySecret(randomHex(8));
}

/** A fresh secret for an existing key id; the agent principal behind it is unchanged. */
export function mintRotatedApiKeySecret(keyId: string): MintedApiKey {
  const secret = randomHex(32);
  return { token: `${API_KEY_PREFIX}${keyId}_${secret}`, keyId, secretHash: sha256Hex(secret) };
}
