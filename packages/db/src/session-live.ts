/** The test every request with a person's access token runs: is the sign-in it names still on. */
import type { TransactionSql } from "postgres";
import type { Sql } from "./client.js";
import type { CredentialArrival } from "./types.js";

/** The sign-in an access token names, as the request presents it. */
export interface PresentedSession {
  sessionId: string;
  alias: string;
  arrival: CredentialArrival;
}

/** Rows of `refresh_sessions` that keep the sign-in on: unrevoked, unexpired, its account's, issued at `arrival`. */
export function liveSessionQuery(sql: Sql | TransactionSql, input: PresentedSession) {
  return sql`
    SELECT 1 FROM refresh_sessions
    WHERE session_id = ${input.sessionId} AND alias = ${input.alias} AND arrival = ${input.arrival}
      AND revoked_at IS NULL AND expires_at > now()
      AND (absolute_expires_at IS NULL OR absolute_expires_at > now())`;
}

/**
 * The lock that orders a person's sign-ins against the revocations that end them. Everything that
 * starts or continues a sign-in (a new session, a renewal, a duplicate renewal's sibling, a first
 * password) holds it shared; everything that ends sign-ins or replaces a password holds it
 * exclusively. Under READ COMMITTED a revoking UPDATE never sees a row inserted after its snapshot,
 * so without it a renewal in flight could leave a live successor behind a sign-out, a password
 * change or Revoke everything. Taken first in every transaction, before any row lock.
 */
export async function lockSignIns(tx: TransactionSql, alias: string, mode: "shared" | "exclusive"): Promise<void> {
  if (mode === "shared") await tx`SELECT pg_advisory_xact_lock_shared(hashtext(${"sign-ins:" + alias}))`;
  else await tx`SELECT pg_advisory_xact_lock(hashtext(${"sign-ins:" + alias}))`;
}

/**
 * What must still hold when a write hands out a way in after a wait (a password hashed in the
 * queue): the account's password is still the one that was checked, or the sign-in that asked is
 * still on. Checked under `lockSignIns`, so a revocation either lands first and refuses the write,
 * or lands after and takes back what it wrote.
 */
export type StillHolds = { password: string } | { session: PresentedSession };

export async function stillHolds(tx: TransactionSql, alias: string, requires: StillHolds): Promise<boolean> {
  if ("password" in requires) {
    const rows = await tx`SELECT 1 FROM local_accounts WHERE alias = ${alias} AND password_hash = ${requires.password}`;
    return rows.length > 0;
  }
  if (requires.session.alias !== alias) return false;
  const rows = await tx`${liveSessionQuery(tx, requires.session)}`;
  return rows.length > 0;
}
