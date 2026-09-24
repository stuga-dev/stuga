import { randomHex } from "@stuga/auth";

/** 8 hex chars: the id a response and its log line share. */
export function requestId(): string {
  return randomHex(4);
}

/** `prefix` plus 12 base64url-ish characters (72 random bits). */
export function newId(prefix = ""): string {
  const buf = new Uint8Array(9);
  crypto.getRandomValues(buf);
  return prefix + btoa(String.fromCharCode(...buf)).replace(/[+/=]/g, "").slice(0, 12);
}
