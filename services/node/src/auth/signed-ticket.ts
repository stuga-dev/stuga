/**
 * Detached HMAC tickets, `<fields…>.<signature>`: the short-lived credentials
 * the node hands a browser, verified with one hash and no database read.
 *
 * Each kind signs under a key derived from the internal secret and its own
 * domain label, so a ticket verifies only for the purpose it was minted for.
 * Signatures are attacker-supplied: compare them with `constantTimeEqual`.
 */
import { createHmac } from "node:crypto";

const BASE64URL = /^[A-Za-z0-9_-]*$/;

export function b64urlEncodeText(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

/** Null for anything that is not base64url. */
export function b64urlDecodeText(value: string): string | null {
  if (!BASE64URL.test(value) || value.length % 4 === 1) return null;
  return Buffer.from(value, "base64url").toString("utf8");
}

/** Sign one ticket's payload under `domain`'s derived key. The label must be distinct per kind. */
export function signTicket(secret: string, domain: string, payload: string): string {
  const key = createHmac("sha256", secret).update(domain).digest();
  return createHmac("sha256", key).update(payload).digest("base64url");
}
