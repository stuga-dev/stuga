import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** `bytes` bytes from the CSPRNG, as lowercase hex. */
export function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

/** `bytes` bytes from the CSPRNG, as unpadded base64url. */
export function randomBase64url(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Timing-safe string comparison; unequal lengths compare false. */
export function constantTimeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
