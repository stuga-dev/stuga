/**
 * A person's passkeys (docs/remote-access.md): public keys for the remote address's host (`rp_id`),
 * the only place they are added and used. Removing one ends the sign-ins it made, which the foreign
 * key on `refresh_sessions.passkey_id` does.
 */
import type { Sql } from "./client.js";
import { lockSignIns, stillHolds, type StillHolds } from "./session-live.js";

/** COSE algorithms a passkey may use: Ed25519, ES256, RS256. */
export type PasskeyAlgorithm = -8 | -7 | -257;

export interface PasskeyRow {
  credential_id: string;
  alias: string;
  rp_id: string;
  public_key: Uint8Array;
  algorithm: PasskeyAlgorithm;
  sign_count: number;
  transports: string[];
  backup_eligible: boolean;
  synced: boolean;
  name: string;
  created_at: string;
  last_used_at: string | null;
}

/** What a person sees of a passkey: never its key. */
export type PasskeySummary = Pick<PasskeyRow, "credential_id" | "rp_id" | "name" | "synced" | "backup_eligible" | "created_at" | "last_used_at">;

export interface NewPasskey {
  credentialId: string;
  alias: string;
  rpId: string;
  publicKey: Uint8Array;
  algorithm: PasskeyAlgorithm;
  signCount: number;
  transports: string[];
  backupEligible: boolean;
  synced: boolean;
  name: string;
}

/** A credential id and how the browser may reach it, for `allowCredentials` and `excludeCredentials`. */
export interface PasskeyDescriptor {
  id: string;
  transports: string[];
}

const toRow = (r: PasskeyRow): PasskeyRow => ({ ...r, sign_count: Number(r.sign_count), public_key: new Uint8Array(r.public_key) });

/**
 * A new passkey; never replaces one. `exists` when its credential id is taken, by anyone; `ended`
 * when `requires` (the sign-in that asked is still on) no longer holds. Under the account's shared
 * sign-in lock, so a Revoke everything either lands first and refuses it, or lands after and removes it.
 */
export async function insertPasskey(sql: Sql, p: NewPasskey, requires: StillHolds | null = null): Promise<"added" | "exists" | "ended"> {
  return (await sql.begin(async (tx) => {
    await lockSignIns(tx, p.alias, "shared");
    if (requires && !(await stillHolds(tx, p.alias, requires))) return "ended";
    const rows = await tx`
      INSERT INTO passkeys
        (credential_id, alias, rp_id, public_key, algorithm, sign_count, transports, backup_eligible, synced, name)
      VALUES (
        ${p.credentialId}, ${p.alias}, ${p.rpId}, ${Buffer.from(p.publicKey)}, ${p.algorithm}, ${p.signCount},
        ${p.transports}::text[], ${p.backupEligible}, ${p.synced}, ${p.name.slice(0, 64)}
      )
      ON CONFLICT (credential_id) DO NOTHING
      RETURNING credential_id`;
    return rows.length > 0 ? "added" : "exists";
  })) as "added" | "exists" | "ended";
}

/** The passkey `credentialId`, only when it was made at `rpId`. */
export async function findPasskey(sql: Sql, credentialId: string, rpId: string): Promise<PasskeyRow | null> {
  const rows = await sql<PasskeyRow[]>`SELECT * FROM passkeys WHERE credential_id = ${credentialId} AND rp_id = ${rpId}`;
  return rows[0] ? toRow(rows[0]) : null;
}

/** Every passkey of `alias`, newest first, at any host. */
export async function listPasskeys(sql: Sql, alias: string): Promise<PasskeySummary[]> {
  return sql<PasskeySummary[]>`
    SELECT credential_id, rp_id, name, synced, backup_eligible, created_at, last_used_at
    FROM passkeys WHERE alias = ${alias}
    ORDER BY created_at DESC, credential_id`;
}

/** The passkeys of `alias` made at `rpId`. */
export async function passkeyDescriptors(sql: Sql, alias: string, rpId: string): Promise<PasskeyDescriptor[]> {
  const rows = await sql<{ credential_id: string; transports: string[] }[]>`
    SELECT credential_id, transports FROM passkeys WHERE alias = ${alias} AND rp_id = ${rpId}
    ORDER BY created_at`;
  return rows.map((r) => ({ id: r.credential_id, transports: r.transports }));
}

/** Whether `alias` has a passkey made at `rpId`. */
export async function hasPasskeyAt(sql: Sql, alias: string, rpId: string): Promise<boolean> {
  const rows = await sql`SELECT 1 FROM passkeys WHERE alias = ${alias} AND rp_id = ${rpId} LIMIT 1`;
  return rows.length > 0;
}

/**
 * A sign-in with the passkey worked: its counter and whether it is synced now, and when it was last
 * used. False when it was removed meanwhile, or when another sign-in with it has since stored a
 * counter as high: the counter only rises (0 stays 0, for a passkey that keeps none), so two
 * assertions checked against the same stored counter cannot both count.
 */
export async function recordPasskeyUse(sql: Sql, input: { credentialId: string; signCount: number; synced: boolean }): Promise<boolean> {
  const rows = await sql`
    UPDATE passkeys SET sign_count = ${input.signCount}, synced = ${input.synced}, last_used_at = now()
    WHERE credential_id = ${input.credentialId}
      AND (sign_count < ${input.signCount} OR (sign_count = 0 AND ${input.signCount}::bigint = 0))
    RETURNING credential_id`;
  return rows.length > 0;
}

/** A new name for one of `alias`'s passkeys; false when it has no such passkey. */
export async function renamePasskey(sql: Sql, alias: string, credentialId: string, name: string): Promise<boolean> {
  const rows = await sql`
    UPDATE passkeys SET name = ${name.slice(0, 64)}
    WHERE alias = ${alias} AND credential_id = ${credentialId}
    RETURNING credential_id`;
  return rows.length > 0;
}

/** A passkey removed, and the sign-ins it made, which ended with it. */
export interface RemovedPasskey {
  name: string;
  synced: boolean;
  backup_eligible: boolean;
  /** The sign-ins the passkey made, whose sockets the caller closes. */
  sessionIds: string[];
}

/**
 * Remove one of `alias`'s passkeys, and with it every sign-in it made: the foreign key deletes their
 * rows, so their access tokens stop working at once. Under the account's exclusive sign-in lock, so
 * a renewal in flight cannot leave a successor behind. Null when it has no such passkey.
 */
export async function removePasskey(sql: Sql, alias: string, credentialId: string): Promise<RemovedPasskey | null> {
  return (await sql.begin(async (tx) => {
    await lockSignIns(tx, alias, "exclusive");
    const sessions = await tx<{ session_id: string }[]>`
      SELECT DISTINCT session_id FROM refresh_sessions WHERE passkey_id = ${credentialId} AND alias = ${alias}`;
    const removed = await tx<{ name: string; synced: boolean; backup_eligible: boolean }[]>`
      DELETE FROM passkeys WHERE alias = ${alias} AND credential_id = ${credentialId}
      RETURNING name, synced, backup_eligible`;
    if (!removed[0]) return null;
    return { ...removed[0], sessionIds: sessions.map((s) => s.session_id) } satisfies RemovedPasskey;
  })) as RemovedPasskey | null;
}

/** Whether "Sign in faster next time" is still to be offered: not dismissed, and no passkey at `rpId` yet. */
export async function passkeyOfferDue(sql: Sql, alias: string, rpId: string): Promise<boolean> {
  const rows = await sql<{ due: boolean }[]>`
    SELECT (u.passkey_offer_dismissed_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM passkeys p WHERE p.alias = u.alias AND p.rp_id = ${rpId})) AS due
    FROM users u WHERE u.alias = ${alias}`;
  return rows[0]?.due === true;
}

/** The person said Not now: the offer is not made again, on any device. */
export async function dismissPasskeyOffer(sql: Sql, alias: string): Promise<void> {
  await sql`UPDATE users SET passkey_offer_dismissed_at = now() WHERE alias = ${alias} AND passkey_offer_dismissed_at IS NULL`;
}
