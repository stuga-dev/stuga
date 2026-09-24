/**
 * Minting a password reset, shared by POST /api/node/password-resets and
 * `stuga-node reset-password`: shown once, stored only as a sha-256, expiring in a day.
 */
import { randomHex, sha256Hex } from "@stuga/auth";
import { createPasswordReset, type Sql } from "@stuga/db";

/** Long enough to hand over out of band, short enough that a leaked link is not a standing key. */
export const RESET_TTL_MS = 24 * 60 * 60 * 1000;

/** Mint one reset for `alias`. The token is returned once; only its hash is stored. */
export async function mintPasswordReset(
  sql: Sql,
  input: { alias: string; createdBy: string; now?: Date },
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomHex(32);
  const expiresAt = new Date((input.now?.getTime() ?? Date.now()) + RESET_TTL_MS);
  await createPasswordReset(sql, {
    tokenHash: sha256Hex(token),
    alias: input.alias,
    expiresAt,
    createdBy: input.createdBy,
  });
  return { token, expiresAt };
}

export function resetUrl(publicOrigin: string, token: string): string {
  return `${publicOrigin}/reset/${token}`;
}
