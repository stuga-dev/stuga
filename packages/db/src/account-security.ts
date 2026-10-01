/**
 * What protects a person's account beyond their password: confirming a sign-in again, the browsers
 * that have signed in to it, and Revoke everything, which takes back every way in at once.
 */
import type { TransactionSql } from "postgres";
import type { Sql } from "./client.js";
import type { CredentialArrival } from "./types.js";
import { lockSignIns, stillHolds, type PresentedSession, type StillHolds } from "./session-live.js";

/**
 * The person behind a live sign-in proved who they are again: its `confirmed_at` moves, on every
 * live row of the sign-in, and nothing else does (when it began and when it ends stay). False when
 * the sign-in is not live.
 */
export async function confirmSession(sql: Sql, input: PresentedSession): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    UPDATE refresh_sessions SET confirmed_at = now()
    WHERE session_id = ${input.sessionId} AND alias = ${input.alias} AND arrival = ${input.arrival}
      AND revoked_at IS NULL AND expires_at > now()
      AND (absolute_expires_at IS NULL OR absolute_expires_at > now())
    RETURNING id`;
  return rows.length > 0;
}

// ---- Known devices ----------------------------------------------------------------

/** A browser's device cookie for one account at one listener; only the cookie's sha-256 is kept. */
export interface KnownDeviceKey {
  alias: string;
  arrival: CredentialArrival;
  tokenHash: string;
}

/** Whether the account has signed in from this browser before, at this listener. */
export async function isKnownDevice(sql: Sql, key: KnownDeviceKey): Promise<boolean> {
  const rows = await sql`
    SELECT 1 FROM known_devices
    WHERE alias = ${key.alias} AND arrival = ${key.arrival} AND token_hash = ${key.tokenHash}`;
  return rows.length > 0;
}

/**
 * Note a sign-in from this browser: a browser seen before is only marked seen again. True when it
 * is new to the account at this listener.
 */
export async function rememberDevice(
  sql: Sql,
  input: KnownDeviceKey & { label: string; firstFrom: string | null },
): Promise<boolean> {
  const rows = await sql<{ inserted: boolean }[]>`
    INSERT INTO known_devices (alias, arrival, token_hash, label, first_from)
    VALUES (${input.alias}, ${input.arrival}, ${input.tokenHash}, ${input.label.slice(0, 64)}, ${input.firstFrom})
    ON CONFLICT (alias, arrival, token_hash) DO UPDATE SET last_seen_at = now()
    RETURNING (xmax = 0) AS inserted`;
  return rows[0]?.inserted === true;
}

/** Forget browsers that have not signed in for as long as their cookie lasts. */
export async function purgeKnownDevices(sql: Sql, days = 400): Promise<number> {
  const res = await sql`DELETE FROM known_devices WHERE last_seen_at < now() - make_interval(days => ${days})`;
  return res.count;
}

// ---- Revoke everything ------------------------------------------------------------

/** What Revoke everything takes from a person, counted before it does or as it did. */
export interface RevokeEverythingCounts {
  /** Sign-ins still on, at either address. */
  sessions: number;
  /** Whether the account is linked to the identity provider. */
  provider: boolean;
  /** Apps signed in through OAuth, not yet revoked. */
  apps: number;
  /** API keys not yet revoked. */
  api_keys: number;
  /** Invite links they made that still admit someone. */
  invites: number;
  /** Share links they made that still open a document. */
  share_links: number;
}

export interface RevokedEverything extends RevokeEverythingCounts {
  /** The sign-ins that ended, whose sockets the caller closes. */
  sessionIds: string[];
  /** Browsers forgotten, and password links that will no longer work. */
  devices: number;
  password_links: number;
}

const LIVE_INVITE = (sql: Sql | TransactionSql) => sql`
  revoked_at IS NULL
  AND (expires_at IS NULL OR expires_at > now())
  AND (max_uses IS NULL OR use_count < max_uses)`;
const LIVE_SHARE_LINK = (sql: Sql | TransactionSql) => sql`revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`;
const LIVE_SESSION = (sql: Sql) => sql`
  revoked_at IS NULL AND expires_at > now()
  AND (absolute_expires_at IS NULL OR absolute_expires_at > now())`;

/** What Revoke everything would take from `alias` now; null for no such account. */
export async function revokeEverythingCounts(sql: Sql, alias: string): Promise<RevokeEverythingCounts | null> {
  const rows = await sql<(Omit<RevokeEverythingCounts, "provider"> & { provider: boolean | null })[]>`
    SELECT
      (u.oidc_sub IS NOT NULL) AS provider,
      (SELECT count(DISTINCT session_id)::int FROM refresh_sessions WHERE alias = ${alias} AND ${LIVE_SESSION(sql)}) AS sessions,
      (SELECT count(*)::int FROM oauth_grants WHERE owner = ${alias} AND revoked_at IS NULL) AS apps,
      (SELECT count(*)::int FROM api_keys WHERE owner = ${alias} AND revoked_at IS NULL) AS api_keys,
      (SELECT count(*)::int FROM workspace_invites WHERE created_by = ${alias} AND ${LIVE_INVITE(sql)}) AS invites,
      (SELECT count(*)::int FROM share_links WHERE created_by = ${alias} AND ${LIVE_SHARE_LINK(sql)}) AS share_links
    FROM users u WHERE u.alias = ${alias}`;
  const row = rows[0];
  return row ? { ...row, provider: row.provider === true } : null;
}

/**
 * Take back every way into `alias`'s account, in one transaction: every sign-in at both addresses
 * ends, the identity provider is unlinked, every app and API key is revoked with its tokens and
 * unexchanged codes, every browser is forgotten, unused password links stop working, and the
 * invite and share links they made close. `passwordHash` becomes the account's only way back in;
 * null removes the password, for an administrator who then hands over a password link. Null when
 * there is no such account, or when `requires` (the person's own sign-in that asked) has ended
 * meanwhile: an administrator's Revoke everything that lands first is never undone by it.
 */
export async function revokeEverything(
  sql: Sql,
  input: { alias: string; by: string; passwordHash: string | null; requires?: StillHolds },
): Promise<RevokedEverything | null> {
  const { alias, by } = input;
  return (await sql.begin(async (tx) => {
    await lockSignIns(tx, alias, "exclusive");
    if (input.requires && !(await stillHolds(tx, alias, input.requires))) return null;
    const account = await tx<{ provider: boolean }[]>`
      SELECT (oidc_sub IS NOT NULL) AS provider FROM users WHERE alias = ${alias} FOR UPDATE`;
    if (!account[0]) return null;

    const sessions = await tx<{ session_id: string; live: boolean }[]>`
      UPDATE refresh_sessions SET revoked_at = now()
      WHERE alias = ${alias} AND revoked_at IS NULL
      RETURNING session_id, (expires_at > now() AND (absolute_expires_at IS NULL OR absolute_expires_at > now())) AS live`;
    await tx`UPDATE users SET oidc_sub = NULL, updated_at = now() WHERE alias = ${alias} AND oidc_sub IS NOT NULL`;
    await tx`DELETE FROM oidc_flows WHERE link_alias = ${alias}`;
    await tx`DELETE FROM oidc_tickets WHERE alias = ${alias}`;

    const grants = await tx<{ grant_id: string }[]>`
      UPDATE oauth_grants SET revoked_at = now(), revoked_by = ${by}
      WHERE owner = ${alias} AND revoked_at IS NULL
      RETURNING grant_id`;
    // Tokens of grants revoked earlier are gone already: revoking a grant deletes them.
    await tx`DELETE FROM oauth_tokens WHERE grant_id IN (SELECT grant_id FROM oauth_grants WHERE owner = ${alias})`;
    await tx`DELETE FROM oauth_codes WHERE user_alias = ${alias}`;
    const keys = await tx`
      UPDATE api_keys SET revoked_at = now(), revoked_by = ${by}
      WHERE owner = ${alias} AND revoked_at IS NULL
      RETURNING key_id`;
    const devices = await tx`DELETE FROM known_devices WHERE alias = ${alias} RETURNING token_hash`;
    const resets = await tx`DELETE FROM password_resets WHERE alias = ${alias} AND used_at IS NULL RETURNING token_hash`;
    const invites = await tx`
      UPDATE workspace_invites SET revoked_at = now()
      WHERE created_by = ${alias} AND ${LIVE_INVITE(tx)}
      RETURNING token_hash`;
    const shareLinks = await tx`
      UPDATE share_links SET revoked_at = now()
      WHERE created_by = ${alias} AND ${LIVE_SHARE_LINK(tx)}
      RETURNING token_hash`;

    if (input.passwordHash === null) {
      await tx`DELETE FROM local_accounts WHERE alias = ${alias}`;
    } else {
      await tx`
        INSERT INTO local_accounts ${tx({ alias, password_hash: input.passwordHash })}
        ON CONFLICT (alias) DO UPDATE SET password_hash = EXCLUDED.password_hash`;
    }

    const live = new Set(sessions.filter((s) => s.live).map((s) => s.session_id));
    return {
      sessions: live.size,
      sessionIds: [...new Set(sessions.map((s) => s.session_id))],
      provider: account[0].provider,
      apps: grants.length,
      api_keys: keys.length,
      invites: invites.length,
      share_links: shareLinks.length,
      devices: devices.length,
      password_links: resets.length,
    } satisfies RevokedEverything;
  })) as RevokedEverything | null;
}
