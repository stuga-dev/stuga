/**
 * The user directory, accounts and how they sign in (local passwords and the
 * identity provider's subject), node administrators, password resets and refresh sessions.
 */
import type { TransactionSql } from "postgres";
import type { WorkspaceRole } from "@stuga/protocol/domain/roles";
import type { SearchLanguage } from "@stuga/protocol/domain/search-languages";
import type { AccountRow, CredentialArrival, DirectoryRow, NodeAdminRow, RefreshSessionRow, SignedInWith, UserRow } from "./types.js";
import { liveSessionQuery, lockSignIns, stillHolds, type StillHolds } from "./session-live.js";
import { daysAgo, escapeLike } from "./sql.js";
import { redeemWorkspaceInviteIn } from "./workspaces.js";
import type { Sql } from "./client.js";

// ---- Directory ------------------------------------------------------------------

/** The caller's own directory row, or null when the account does not exist. */
export async function getDirectoryRow(sql: Sql, alias: string): Promise<DirectoryRow | null> {
  const rows = await sql<DirectoryRow[]>`SELECT display_name, username, email FROM users WHERE alias = ${alias}`;
  return rows[0] ?? null;
}

/** Rejecting a blank name is the caller's job. */
export async function setDisplayName(sql: Sql, alias: string, name: string): Promise<void> {
  await sql`
    UPDATE users SET display_name = ${name.trim().slice(0, 100)}, updated_at = now()
    WHERE alias = ${alias}`;
}

/** Directory rows for these aliases, limited to members of the workspace. Never oidc_sub: other people read these. */
export async function getUsers(sql: Sql, aliases: string[], workspaceId: string): Promise<UserRow[]> {
  if (aliases.length === 0) return [];
  return sql<UserRow[]>`
    SELECT u.alias, u.username, u.display_name, u.email, u.updated_at FROM users u
    JOIN workspace_members m ON m.alias = u.alias AND m.workspace_id = ${workspaceId}
    WHERE u.alias = ANY(${aliases})`;
}

/**
 * Resolve what someone typed to one alias: a username (with or without a
 * leading @), else an email, else an exact display name. The username is
 * unique and wins outright. Emails are unverified and display names are not
 * unique, so either resolves only when exactly one person matches: guessing
 * would grant access to the wrong person.
 */
async function aliasByHandle(sql: Sql, typed: string, workspaceId: string | null): Promise<string | null> {
  const handle = typed.trim().replace(/^@/, "").toLowerCase();
  if (!handle) return null;
  const rows = await sql<{ alias: string; rank: number }[]>`
    SELECT u.alias,
           CASE WHEN u.username = ${handle} THEN 0
                WHEN lower(u.email) = ${handle} THEN 1
                ELSE 2 END AS rank
    FROM users u
    ${workspaceId === null ? sql`` : sql`JOIN workspace_members m ON m.alias = u.alias AND m.workspace_id = ${workspaceId}`}
    WHERE u.username = ${handle} OR lower(u.email) = ${handle} OR lower(u.display_name) = lower(${typed.trim()})
    ORDER BY rank
    LIMIT 4`;
  const best = rows[0];
  if (!best) return null;
  const tied = rows.filter((r) => r.rank === best.rank);
  return tied.length === 1 ? best.alias : null;
}

/** For sharing: only members of the workspace resolve. */
export async function getUserAliasByHandle(sql: Sql, typed: string, workspaceId: string): Promise<string | null> {
  return aliasByHandle(sql, typed, workspaceId);
}

/** For adding workspace members only, which may reach anyone in the directory. */
export async function getAnyUserAliasByHandle(sql: Sql, typed: string): Promise<string | null> {
  return aliasByHandle(sql, typed, null);
}

/** Workspace members holding these usernames; a username no member holds is left out. */
export async function getMembersByUsername(
  sql: Sql,
  usernames: string[],
  workspaceId: string,
): Promise<Array<{ alias: string; username: string }>> {
  if (usernames.length === 0) return [];
  return sql<Array<{ alias: string; username: string }>>`
    SELECT u.alias, u.username FROM users u
    JOIN workspace_members m ON m.alias = u.alias AND m.workspace_id = ${workspaceId}
    WHERE u.username = ANY(${usernames})`;
}

/**
 * A people picker's search: accounts on the node matched by username or name,
 * usernames that start with the query first, and only those outside
 * `outsideWorkspace` when it is given. An email matches only in full, so the
 * picker cannot be used to read addresses letter by letter.
 */
export async function searchAccounts(
  sql: Sql,
  query: string,
  { outsideWorkspace, limit = 8 }: { outsideWorkspace?: string; limit?: number } = {},
): Promise<Array<Pick<UserRow, "alias" | "username" | "display_name">>> {
  const q = query.trim().replace(/^@/, "");
  if (!q) return [];
  const escaped = escapeLike(q);
  return sql<Array<Pick<UserRow, "alias" | "username" | "display_name">>>`
    SELECT u.alias, u.username, u.display_name FROM users u
    WHERE (u.username ILIKE ${`%${escaped}%`} ESCAPE '\\' OR u.display_name ILIKE ${`%${escaped}%`} ESCAPE '\\'
           OR lower(u.email) = lower(${q}))
      ${
        outsideWorkspace
          ? sql`AND NOT EXISTS (
              SELECT 1 FROM workspace_members m WHERE m.alias = u.alias AND m.workspace_id = ${outsideWorkspace})`
          : sql``
      }
    ORDER BY coalesce(u.username ILIKE ${`${escaped}%`} ESCAPE '\\', false) DESC,
             (u.display_name ILIKE ${`${escaped}%`} ESCAPE '\\') DESC,
             u.display_name ASC
    LIMIT ${limit}`;
}

/** Whether a directory row exists for this alias. */
export async function userExists(sql: Sql, alias: string): Promise<boolean> {
  const rows = await sql`SELECT 1 FROM users WHERE alias = ${alias}`;
  return rows.length > 0;
}

/** Recipient autocomplete: substring match on username, email or display name among the workspace's members. */
export async function searchUsers(sql: Sql, query: string, workspaceId: string, limit = 8): Promise<UserRow[]> {
  const q = query.trim();
  // Two characters at least, so one keystroke cannot list the whole directory.
  if (q.length < 2) return [];
  const like = `%${escapeLike(q.replace(/^@/, ""))}%`;
  return sql<UserRow[]>`
    SELECT u.alias, u.username, u.display_name, u.email, u.updated_at FROM users u
    JOIN workspace_members m ON m.alias = u.alias AND m.workspace_id = ${workspaceId}
    WHERE u.username ILIKE ${like} ESCAPE '\\' OR u.email ILIKE ${like} ESCAPE '\\'
       OR u.display_name ILIKE ${like} ESCAPE '\\'
    ORDER BY u.display_name ASC
    LIMIT ${limit}`;
}

// ---- Accounts ---------------------------------------------------------------------

/** How an account signs in, read with its directory row. */
const ACCOUNT = (sql: Sql) => sql`
  SELECT u.alias, u.username, a.password_hash, u.oidc_sub
  FROM users u LEFT JOIN local_accounts a ON a.alias = u.alias`;

/** The workspace an invite admitted a new account to. */
export interface InviteJoin {
  workspaceId: string;
  role: WorkspaceRole;
}

/**
 * What creating an account did. `admin`: it was the node's first account, which
 * claims the node and administers it. Refusals: `invite_required`, the node is
 * claimed and no invite came with the request; `invite_invalid`, the invite was
 * used up, revoked or expired by the time it was spent; `invite_local_only`, an invite with no use
 * limit or no expiry presented at the remote address. Nothing is made on a refusal.
 */
export type NewAccount<Refusal extends string> =
  | { ok: true; account: AccountRow; joined: InviteJoin | null; admin: boolean }
  | { ok: false; reason: Refusal | "invite_required" | "invite_invalid" | "invite_local_only" };

/** Thrown inside an account's transaction to undo it when its invite cannot be spent. */
class InviteRefused extends Error {
  constructor(readonly reason: "invite_invalid" | "invite_local_only") {
    super(reason);
  }
}

/**
 * Every account is created under this one lock, and decides under it whether
 * it is the first: two registrations on a fresh node cannot both find it empty
 * and both become its administrator.
 */
async function lockAccountCreation(tx: TransactionSql): Promise<{ first: boolean }> {
  await tx`SELECT pg_advisory_xact_lock(hashtext('account-creation'))`;
  const [row] = await tx<{ first: boolean }[]>`SELECT NOT EXISTS (SELECT 1 FROM users) AS first`;
  return { first: row!.first };
}

/**
 * Whether `issuer`, which vouched for a subject, is still the node's identity
 * provider. The row stays share-locked until the transaction ends, so a
 * settings save that changes the issuer waits for this link to commit and
 * then clears it, or commits first and this finds the new issuer: a sign-in
 * in flight while the provider changes never leaves the old one's subject behind.
 */
async function issuerStillTrusted(tx: TransactionSql, issuer: string): Promise<boolean> {
  const rows = await tx`SELECT 1 FROM node_settings WHERE id = TRUE AND idp_issuer = ${issuer} FOR SHARE`;
  return rows.length > 0;
}

/**
 * Spend the invite a new account is made with, in the transaction that makes
 * it: a check before the account is only advice, and a single-use invite must
 * never admit two accounts that race past it.
 */
async function spendInvite(
  tx: TransactionSql,
  inviteHash: string | null | undefined,
  alias: string,
  arrival: CredentialArrival,
): Promise<InviteJoin | null> {
  if (!inviteHash) return null;
  const redeemed = await redeemWorkspaceInviteIn(tx, inviteHash, alias, arrival);
  if (!redeemed.ok) throw new InviteRefused(redeemed.reason === "local_only" ? "invite_local_only" : "invite_invalid");
  return { workspaceId: redeemed.workspaceId, role: redeemed.role };
}

/**
 * Create a password account with its directory row in one transaction. The
 * node's first account claims it and is granted node administration; every
 * later one needs an invite, spent here with the membership it grants.
 * `username_taken` when the username or alias is taken. The username must
 * already be normalized and valid; the CHECK refuses anything else.
 */
export async function createLocalAccount(
  sql: Sql,
  input: {
    alias: string;
    username: string;
    passwordHash: string;
    displayName?: string;
    email?: string | null;
    /** The sha-256 of the invite the account is made with, spent here. The first account ignores it. */
    inviteHash?: string | null;
    /** Where the account is made; an invite with no limit or no expiry is spent only on the node's own network. */
    arrival?: CredentialArrival;
    /**
     * The caller proved the right to claim the node (its setup code). Decided here, under the
     * account lock, so a registration without it never becomes the first account, whatever it raced.
     */
    mayClaim?: boolean;
    /** The time zone setup's browser is in, an IANA name, kept as the node's when this is the first account. */
    timeZone?: string;
    /** The search languages setup chose, kept as the node's when this is the first account; `[]` chose none. */
    searchLanguages?: readonly SearchLanguage[];
  },
): Promise<NewAccount<"username_taken" | "setup_code_required">> {
  const { alias, username } = input;
  try {
    return (await sql.begin(async (tx) => {
      const { first } = await lockAccountCreation(tx);
      if (first && !input.mayClaim) return { ok: false, reason: "setup_code_required" };
      if (!first && !input.inviteHash) return { ok: false, reason: "invite_required" };
      const existing = await tx<{ alias: string }[]>`
        SELECT alias FROM users WHERE username = ${username} OR alias = ${alias}`;
      if (existing.length > 0) return { ok: false, reason: "username_taken" };
      await tx`
        INSERT INTO users ${tx({ alias, username, display_name: input.displayName ?? username, email: input.email ?? null })}`;
      await tx`INSERT INTO local_accounts ${tx({ alias, password_hash: input.passwordHash })}`;
      if (first) await tx`INSERT INTO node_admins ${tx({ alias, granted_by: null })}`;
      const choices = {
        ...(input.timeZone ? { time_zone: input.timeZone } : {}),
        ...(input.searchLanguages ? { search_languages: [...input.searchLanguages] } : {}),
      };
      if (first && Object.keys(choices).length > 0) {
        await tx`
          INSERT INTO node_settings ${tx({ id: true, ...choices, updated_by: alias })}
          ON CONFLICT (id) DO UPDATE
            SET ${tx(choices)}, updated_by = EXCLUDED.updated_by, updated_at = now()`;
      }
      const joined = first ? null : await spendInvite(tx, input.inviteHash, alias, input.arrival ?? "local");
      return { ok: true, account: { alias, username, password_hash: input.passwordHash, oidc_sub: null }, joined, admin: first };
    })) as NewAccount<"username_taken" | "setup_code_required">;
  } catch (err) {
    if (err instanceof InviteRefused) return { ok: false, reason: err.reason };
    throw err;
  }
}

/**
 * Create an account for an identity-provider subject no account is linked to:
 * a directory row carrying the subject, no password, and the membership its
 * invite grants, in one transaction. Never the first account and never an
 * administrator: the node's owner sets it up with a password (`setup_required`).
 * `provider_changed` when `issuer`, which vouched for the subject, is no longer the node's.
 */
export async function createProviderAccount(
  sql: Sql,
  input: {
    alias: string;
    username: string;
    displayName: string;
    email: string | null;
    oidcSub: string;
    /** The issuer that vouched for `oidcSub`. */
    issuer: string;
    /** The sha-256 of the invite the account is made with, spent here. */
    inviteHash?: string | null;
    /** Where the account is made; an invite with no limit or no expiry is spent only on the node's own network. */
    arrival?: CredentialArrival;
  },
): Promise<NewAccount<"username_taken" | "already_linked" | "setup_required" | "provider_changed">> {
  const { alias, username, oidcSub } = input;
  try {
    return (await sql.begin(async (tx) => {
      const { first } = await lockAccountCreation(tx);
      if (first) return { ok: false, reason: "setup_required" };
      if (!input.inviteHash) return { ok: false, reason: "invite_required" };
      if (!(await issuerStillTrusted(tx, input.issuer))) return { ok: false, reason: "provider_changed" };
      const linked = await tx`SELECT 1 FROM users WHERE oidc_sub = ${oidcSub}`;
      if (linked.length > 0) return { ok: false, reason: "already_linked" };
      const taken = await tx`SELECT 1 FROM users WHERE username = ${username} OR alias = ${alias}`;
      if (taken.length > 0) return { ok: false, reason: "username_taken" };
      await tx`
        INSERT INTO users ${tx({ alias, username, display_name: input.displayName, email: input.email, oidc_sub: oidcSub })}`;
      const joined = await spendInvite(tx, input.inviteHash, alias, input.arrival ?? "local");
      return { ok: true, account: { alias, username, password_hash: null, oidc_sub: oidcSub }, joined, admin: false };
    })) as NewAccount<"username_taken" | "already_linked" | "setup_required" | "provider_changed">;
  } catch (err) {
    if (err instanceof InviteRefused) return { ok: false, reason: err.reason };
    // A subject linked to an existing account meanwhile, by linkIdentity, which takes no creation lock.
    if (isUniqueViolation(err, "users_oidc_sub_key")) return { ok: false, reason: "already_linked" };
    throw err;
  }
}

function isUniqueViolation(err: unknown, constraint: string): boolean {
  const e = err as { code?: string; constraint_name?: string };
  return e?.code === "23505" && e.constraint_name === constraint;
}

/** Takes what was typed: surrounding space, a leading @ and case do not matter. */
export async function findAccountByUsername(sql: Sql, username: string): Promise<AccountRow | null> {
  const rows = await sql<AccountRow[]>`
    ${ACCOUNT(sql)} WHERE u.username = ${username.trim().replace(/^@/, "").toLowerCase()}`;
  return rows[0] ?? null;
}

export async function findAccountByAlias(sql: Sql, alias: string): Promise<AccountRow | null> {
  const rows = await sql<AccountRow[]>`${ACCOUNT(sql)} WHERE u.alias = ${alias}`;
  return rows[0] ?? null;
}

/** The account an identity-provider subject is linked to. */
export async function findAccountBySub(sql: Sql, sub: string): Promise<AccountRow | null> {
  const rows = await sql<AccountRow[]>`${ACCOUNT(sql)} WHERE u.oidc_sub = ${sub}`;
  return rows[0] ?? null;
}

/** Accounts on the node, whatever they sign in with. Zero means nobody has claimed it. */
export async function countAccounts(sql: Sql): Promise<number> {
  const rows = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM users`;
  return rows[0]?.n ?? 0;
}

/** Which of these usernames are taken, in one query. */
export async function takenUsernames(sql: Sql, usernames: string[]): Promise<Set<string>> {
  if (usernames.length === 0) return new Set();
  const rows = await sql<{ username: string }[]>`SELECT username FROM users WHERE username = ANY(${usernames})`;
  return new Set(rows.map((r) => r.username));
}

/** How the account signs in, for its own profile page; null when there is no such account. */
export async function getSignInMethods(
  sql: Sql,
  alias: string,
): Promise<{ hasPassword: boolean; providerLinked: boolean } | null> {
  const account = await findAccountByAlias(sql, alias);
  if (!account) return null;
  return { hasPassword: account.password_hash !== null, providerLinked: account.oidc_sub !== null };
}

/** False when the account has no password to change. Revoking other sessions is the caller's decision. */
export async function updateLocalPassword(sql: Sql, alias: string, passwordHash: string): Promise<boolean> {
  const rows = await sql<{ alias: string }[]>`
    UPDATE local_accounts SET password_hash = ${passwordHash}
    WHERE alias = ${alias}
    RETURNING alias`;
  return rows.length > 0;
}

/**
 * Store a hash of the same password made at the current cost, only while `oldHash` is still the
 * account's: a password changed meanwhile is never put back. False when it was.
 */
export async function rehashLocalPassword(sql: Sql, alias: string, oldHash: string, newHash: string): Promise<boolean> {
  const rows = await sql<{ alias: string }[]>`
    UPDATE local_accounts SET password_hash = ${newHash}
    WHERE alias = ${alias} AND password_hash = ${oldHash}
    RETURNING alias`;
  return rows.length > 0;
}

/**
 * Replace the account's password and end every sign-in it has, at both addresses, in one step, only
 * while `requires` still holds: the current password that was checked is still the account's, or
 * the confirmed sign-in that asked is still on. False, with nothing written, when it does not, or
 * the account has no password to replace.
 */
export async function replaceLocalPassword(
  sql: Sql,
  input: { alias: string; passwordHash: string; requires: StillHolds },
): Promise<boolean> {
  return (await sql.begin(async (tx) => {
    await lockSignIns(tx, input.alias, "exclusive");
    if (!(await stillHolds(tx, input.alias, input.requires))) return false;
    const rows = await tx`
      UPDATE local_accounts SET password_hash = ${input.passwordHash}
      WHERE alias = ${input.alias}
      RETURNING alias`;
    if (rows.length === 0) return false;
    await tx`UPDATE refresh_sessions SET revoked_at = now() WHERE alias = ${input.alias} AND revoked_at IS NULL`;
    return true;
  })) as boolean;
}

/**
 * Give an account its first password. False when it already has one, or does not exist, or
 * `requires` (the sign-in that asked is still on) no longer holds.
 */
export async function addLocalPassword(sql: Sql, alias: string, passwordHash: string, requires: StillHolds | null = null): Promise<boolean> {
  return (await sql.begin(async (tx) => {
    await lockSignIns(tx, alias, "shared");
    if (requires && !(await stillHolds(tx, alias, requires))) return false;
    const rows = await tx<{ alias: string }[]>`
      INSERT INTO local_accounts (alias, password_hash)
      SELECT alias, ${passwordHash} FROM users WHERE alias = ${alias}
      ON CONFLICT (alias) DO NOTHING
      RETURNING alias`;
    return rows.length > 0;
  })) as boolean;
}

/** What linking a subject to an account did. */
export type LinkOutcome = "linked" | "already_linked" | "taken" | "other_sub" | "no_account" | "provider_changed" | "changed";

/**
 * Link an identity-provider subject to an account. `taken`: another account
 * holds the subject; `other_sub`: this account is linked to a different one;
 * `provider_changed`: `issuer`, which vouched for the subject, is no longer the node's;
 * `changed`: `requires` (the password that was checked) no longer holds.
 * Linking the subject the account already holds is `already_linked`, not an error.
 */
export async function linkIdentity(
  sql: Sql,
  alias: string,
  sub: string,
  issuer: string,
  requires: StillHolds | null = null,
): Promise<LinkOutcome> {
  try {
    return (await sql.begin(async (tx) => {
      await lockSignIns(tx, alias, "shared");
      if (requires && !(await stillHolds(tx, alias, requires))) return "changed";
      if (!(await issuerStillTrusted(tx, issuer))) return "provider_changed";
      const holder = await tx<{ alias: string }[]>`SELECT alias FROM users WHERE oidc_sub = ${sub}`;
      if (holder[0]) return holder[0].alias === alias ? "already_linked" : "taken";
      const updated = await tx`
        UPDATE users SET oidc_sub = ${sub}, updated_at = now()
        WHERE alias = ${alias} AND oidc_sub IS NULL
        RETURNING alias`;
      if (updated.length > 0) return "linked";
      const exists = await tx`SELECT 1 FROM users WHERE alias = ${alias}`;
      return exists.length > 0 ? "other_sub" : "no_account";
    })) as LinkOutcome;
  } catch (err) {
    if (isUniqueViolation(err, "users_oidc_sub_key")) return "taken";
    throw err;
  }
}

/**
 * Unlink the identity provider, only while the account keeps a password: the
 * check sits in the UPDATE, so a password removed meanwhile cannot strand it.
 */
export async function unlinkIdentity(sql: Sql, alias: string): Promise<"unlinked" | "not_linked" | "no_password"> {
  const rows = await sql<{ alias: string }[]>`
    UPDATE users u SET oidc_sub = NULL, updated_at = now()
    WHERE u.alias = ${alias} AND u.oidc_sub IS NOT NULL
      AND EXISTS (SELECT 1 FROM local_accounts a WHERE a.alias = u.alias)
    RETURNING u.alias`;
  if (rows.length > 0) return "unlinked";
  const account = await findAccountByAlias(sql, alias);
  return account?.oidc_sub ? "no_password" : "not_linked";
}

/** Linked accounts with no password: they cannot sign in once the provider is removed. */
export async function countAccountsWithoutPassword(sql: Sql): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM users u
    WHERE u.oidc_sub IS NOT NULL AND NOT EXISTS (SELECT 1 FROM local_accounts a WHERE a.alias = u.alias)`;
  return rows[0]?.n ?? 0;
}

// ---- Node administrators ----------------------------------------------------------

export async function isNodeAdminAlias(sql: Sql, alias: string): Promise<boolean> {
  const rows = await sql`SELECT 1 FROM node_admins WHERE alias = ${alias}`;
  return rows.length > 0;
}

export async function listNodeAdmins(
  sql: Sql,
): Promise<Array<NodeAdminRow & { display_name: string; username: string | null; email: string | null }>> {
  return sql<Array<NodeAdminRow & { display_name: string; username: string | null; email: string | null }>>`
    SELECT n.alias, n.granted_by, n.granted_at,
           coalesce(u.display_name, '') AS display_name, u.username, u.email
    FROM node_admins n
    LEFT JOIN users u ON u.alias = n.alias
    ORDER BY n.granted_at ASC`;
}

/** Idempotent; a repeated grant keeps the original granter. */
export async function grantNodeAdmin(sql: Sql, alias: string, grantedBy: string): Promise<boolean> {
  const rows = await sql`
    INSERT INTO node_admins ${sql({ alias, granted_by: grantedBy })}
    ON CONFLICT (alias) DO NOTHING
    RETURNING alias`;
  return rows.length > 0;
}

/** The last-admin guard lives in the route. */
export async function revokeNodeAdmin(sql: Sql, alias: string): Promise<boolean> {
  const rows = await sql`DELETE FROM node_admins WHERE alias = ${alias} RETURNING alias`;
  return rows.length > 0;
}

export async function countNodeAdmins(sql: Sql): Promise<number> {
  const rows = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM node_admins`;
  return rows[0]?.n ?? 0;
}

// ---- Password resets --------------------------------------------------------------

/** Only the token's sha-256 is stored. */
export async function createPasswordReset(
  sql: Sql,
  input: { tokenHash: string; alias: string; expiresAt: Date; createdBy: string },
): Promise<void> {
  await sql`INSERT INTO password_resets ${sql({
    token_hash: input.tokenHash,
    alias: input.alias,
    expires_at: input.expiresAt,
    created_by: input.createdBy,
  })}`;
}

/**
 * Spend a reset token and set the password, atomically, adding one when the
 * account has none. The eligibility test sits in the UPDATE's WHERE, so of two
 * concurrent redemptions exactly one wins. Null when the token is unknown, expired or spent.
 */
export async function redeemPasswordReset(sql: Sql, tokenHash: string, passwordHash: string): Promise<string | null> {
  return sql.begin(async (tx) => {
    const rows = await tx<{ alias: string }[]>`
      UPDATE password_resets SET used_at = now()
      WHERE token_hash = ${tokenHash} AND used_at IS NULL AND expires_at > now()
      RETURNING alias`;
    const alias = rows[0]?.alias;
    if (!alias) return null;
    // An account made through the identity provider gets its first password here.
    await tx`
      INSERT INTO local_accounts ${tx({ alias, password_hash: passwordHash })}
      ON CONFLICT (alias) DO UPDATE SET password_hash = EXCLUDED.password_hash`;
    return alias;
  }) as Promise<string | null>;
}

/** Whether a reset token would still work: a cheap refusal before a new password is hashed. */
export async function passwordResetIsLive(sql: Sql, tokenHash: string): Promise<boolean> {
  const rows = await sql`SELECT 1 FROM password_resets WHERE token_hash = ${tokenHash} AND used_at IS NULL AND expires_at > now()`;
  return rows.length > 0;
}

export async function purgePasswordResets(sql: Sql): Promise<number> {
  const res = await sql`
    DELETE FROM password_resets
    WHERE used_at IS NOT NULL OR expires_at < now() - interval '1 day'`;
  return res.count;
}

// ---- Refresh sessions -------------------------------------------------------------

/** A new sign-in's first row: where and how it began, and when it ends unused and at the latest. */
export interface NewRefreshSession {
  id: string;
  /** The sign-in's own id, which its access tokens carry as `sid`. */
  sessionId: string;
  alias: string;
  tokenHash: string;
  /** When the token lapses unused; capped at `absoluteExpiresAt`. */
  expiresAt: Date | string;
  arrival: CredentialArrival;
  signedInWith: SignedInWith;
  /** The passkey a sign-in with one used; set exactly when `signedInWith` is "passkey". */
  passkeyId?: string | null;
  /** Required at the remote address, absent on the node's own network (a CHECK holds it so). */
  absoluteExpiresAt: Date | string | null;
}

export async function createRefreshSession(sql: Sql, input: NewRefreshSession): Promise<RefreshSessionRow> {
  return (await createRefreshSessionIf(sql, input, null))!;
}

/**
 * A new sign-in, only while `requires` still holds (session-live.ts): null, with nothing written,
 * when the password that was checked is no longer the account's, or the sign-in that asked has ended.
 */
export async function createRefreshSessionIf(
  sql: Sql,
  input: NewRefreshSession,
  requires: StillHolds | null,
): Promise<RefreshSessionRow | null> {
  return (await sql.begin(async (tx) => {
    await lockSignIns(tx, input.alias, "shared");
    if (requires && !(await stillHolds(tx, input.alias, requires))) return null;
    const rows = await tx<RefreshSessionRow[]>`
      INSERT INTO refresh_sessions
        (id, session_id, alias, token_hash, expires_at, arrival, signed_in_with, passkey_id, signed_in_at, confirmed_at, absolute_expires_at)
      VALUES (
        ${input.id}, ${input.sessionId}, ${input.alias}, ${input.tokenHash},
        LEAST(${input.expiresAt}::timestamptz, ${input.absoluteExpiresAt}::timestamptz),
        ${input.arrival}, ${input.signedInWith}, ${input.passkeyId ?? null}, now(), now(), ${input.absoluteExpiresAt}
      )
      RETURNING *`;
    return rows[0]!;
  })) as RefreshSessionRow | null;
}

/** The session for a token in whatever state it is, so a replayed token can be told from an unknown one. */
export async function findRefreshSession(sql: Sql, tokenHash: string): Promise<RefreshSessionRow | null> {
  const rows = await sql<RefreshSessionRow[]>`SELECT * FROM refresh_sessions WHERE token_hash = ${tokenHash}`;
  return rows[0] ?? null;
}

/**
 * Revoke the presented session and issue its successor, atomically, recording
 * `replaced_by`. The successor continues the same sign-in: it copies where and
 * how it began and when it ends at the latest, and lapses unused at `expiresAt`
 * or then, whichever is sooner. Null, with nothing written, when the token is
 * unknown, revoked or expired, or was issued at another listener than `arrival`;
 * of two concurrent rotations the second gets null.
 */
export async function rotateRefreshSession(
  sql: Sql,
  input: { tokenHash: string; id: string; nextTokenHash: string; expiresAt: Date | string; arrival: CredentialArrival },
): Promise<RefreshSessionRow | null> {
  return sql.begin(async (tx) => {
    const [owner] = await tx<{ alias: string }[]>`SELECT alias FROM refresh_sessions WHERE token_hash = ${input.tokenHash}`;
    if (!owner) return null;
    await lockSignIns(tx, owner.alias, "shared");
    const revoked = await tx<{ id: string }[]>`
      UPDATE refresh_sessions SET revoked_at = now(), replaced_by = ${input.nextTokenHash}
      WHERE token_hash = ${input.tokenHash} AND revoked_at IS NULL AND expires_at > now()
        AND arrival = ${input.arrival}
        AND (absolute_expires_at IS NULL OR absolute_expires_at > now())
      RETURNING id`;
    const parent = revoked[0]?.id;
    if (!parent) return null;
    const rows = await tx<RefreshSessionRow[]>`
      INSERT INTO refresh_sessions
        (id, session_id, alias, token_hash, expires_at, arrival, signed_in_with, passkey_id, signed_in_at, confirmed_at, absolute_expires_at)
      SELECT ${input.id}, session_id, alias, ${input.nextTokenHash},
             LEAST(${input.expiresAt}::timestamptz, absolute_expires_at),
             arrival, signed_in_with, passkey_id, signed_in_at, confirmed_at, absolute_expires_at
      FROM refresh_sessions WHERE id = ${parent}
      RETURNING *`;
    return rows[0] ?? null;
  }) as Promise<RefreshSessionRow | null>;
}

/**
 * A second successor for `of`, the live successor of a token renewed twice at once: the same
 * sign-in, with every column copied, its unused expiry included, so the pair ends together.
 */
export async function siblingRefreshSession(
  sql: Sql,
  input: { of: string; id: string; tokenHash: string },
): Promise<RefreshSessionRow | null> {
  return (await sql.begin(async (tx) => {
    const [owner] = await tx<{ alias: string }[]>`SELECT alias FROM refresh_sessions WHERE token_hash = ${input.of}`;
    if (!owner) return null;
    await lockSignIns(tx, owner.alias, "shared");
    const rows = await tx<RefreshSessionRow[]>`
      INSERT INTO refresh_sessions
        (id, session_id, alias, token_hash, expires_at, arrival, signed_in_with, passkey_id, signed_in_at, confirmed_at, absolute_expires_at)
      SELECT ${input.id}, session_id, alias, ${input.tokenHash}, expires_at,
             arrival, signed_in_with, passkey_id, signed_in_at, confirmed_at, absolute_expires_at
      FROM refresh_sessions
      WHERE token_hash = ${input.of} AND revoked_at IS NULL AND expires_at > now()
      RETURNING *`;
    return rows[0] ?? null;
  })) as RefreshSessionRow | null;
}

/**
 * Whether the sign-in an access token names is still on: one of its rows is unrevoked and
 * unexpired, it belongs to `alias`, and it was issued at `arrival`. A sign-out, a password change
 * or a revocation ends it, and with it every access token it issued, at once.
 */
export async function isSessionLive(sql: Sql, input: { sessionId: string; alias: string; arrival: CredentialArrival }): Promise<boolean> {
  const rows = await sql<{ live: boolean }[]>`
    SELECT EXISTS (${liveSessionQuery(sql, input)}) AS live`;
  return rows[0]?.live === true;
}

/**
 * Until when the sign-in is on unless something ends it sooner: the latest end, idle or fixed, of its
 * live rows. Null when it is not live. A renewal moves it; a revocation ends it.
 */
export async function sessionLiveUntil(
  sql: Sql,
  input: { sessionId: string; alias: string; arrival: CredentialArrival },
): Promise<Date | null> {
  const rows = await sql<{ until: Date | null }[]>`
    SELECT max(LEAST(expires_at, COALESCE(absolute_expires_at, 'infinity'::timestamptz))) AS until
    FROM refresh_sessions
    WHERE session_id = ${input.sessionId} AND alias = ${input.alias} AND arrival = ${input.arrival}
      AND revoked_at IS NULL AND expires_at > now()
      AND (absolute_expires_at IS NULL OR absolute_expires_at > now())`;
  const until = rows[0]?.until;
  return until ? new Date(until) : null;
}

/**
 * When the person behind a live sign-in last proved who they are: its sign-in, or a later
 * confirmation. Null when the sign-in is not live.
 */
export async function sessionConfirmedAt(
  sql: Sql,
  input: { sessionId: string; alias: string; arrival: CredentialArrival },
): Promise<Date | null> {
  const rows = await sql<{ confirmed_at: Date | null }[]>`
    SELECT max(confirmed_at) AS confirmed_at FROM refresh_sessions
    WHERE session_id = ${input.sessionId} AND alias = ${input.alias} AND arrival = ${input.arrival}
      AND revoked_at IS NULL AND expires_at > now()
      AND (absolute_expires_at IS NULL OR absolute_expires_at > now())`;
  const at = rows[0]?.confirmed_at;
  return at ? new Date(at) : null;
}

/**
 * Sign a session out: revoke it if it is live, and drop the provider links its
 * account started and never finished, so a sign-in completed later in this
 * browser cannot attach an identity to the account that left. Whatever state
 * the token is in, it names its account. Returns that account and the sign-in
 * it ended, or null. A token issued at another listener than `arrival` signs
 * nothing out there: it works only where it was issued.
 */
export async function endRefreshSession(
  sql: Sql,
  tokenHash: string,
  arrival?: CredentialArrival,
): Promise<{ alias: string; sessionId: string } | null> {
  return (await sql.begin(async (tx) => {
    const [session] = await tx<{ alias: string; session_id: string; arrival: CredentialArrival }[]>`
      SELECT alias, session_id, arrival FROM refresh_sessions WHERE token_hash = ${tokenHash}`;
    if (!session) return null;
    if (arrival !== undefined && session.arrival !== arrival) return null;
    await lockSignIns(tx, session.alias, "exclusive");
    // The whole sign-in: a sibling a duplicate renewal left would otherwise keep its access tokens good.
    await tx`UPDATE refresh_sessions SET revoked_at = now() WHERE session_id = ${session.session_id} AND revoked_at IS NULL`;
    await tx`DELETE FROM oidc_flows WHERE link_alias = ${session.alias}`;
    return { alias: session.alias, sessionId: session.session_id };
  })) as { alias: string; sessionId: string } | null;
}

export async function revokeRefreshSession(sql: Sql, tokenHash: string): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    UPDATE refresh_sessions SET revoked_at = now()
    WHERE token_hash = ${tokenHash} AND revoked_at IS NULL
    RETURNING id`;
  return rows.length > 0;
}

export async function revokeRefreshSessions(sql: Sql, alias: string): Promise<number> {
  return (await sql.begin(async (tx) => {
    await lockSignIns(tx, alias, "exclusive");
    const rows = await tx<{ id: string }[]>`
      UPDATE refresh_sessions SET revoked_at = now()
      WHERE alias = ${alias} AND revoked_at IS NULL
      RETURNING id`;
    return rows.length;
  })) as number;
}

/**
 * Drop sessions expired or revoked more than `graceDays` ago. Kept that long so
 * a replayed token still reads as a replay rather than as unknown.
 */
export async function purgeRefreshSessions(sql: Sql, graceDays = 7): Promise<number> {
  const rows = await sql<{ id: string }[]>`
    DELETE FROM refresh_sessions
    WHERE expires_at < ${daysAgo(sql, graceDays)}
       OR revoked_at < ${daysAgo(sql, graceDays)}
    RETURNING id`;
  return rows.length;
}

/** The directory's display name for an alias, or null when there is no row. */
export async function getUserDisplayName(sql: Sql, alias: string): Promise<string | null> {
  const rows = await sql<{ display_name: string }[]>`SELECT display_name FROM users WHERE alias = ${alias}`;
  return rows[0]?.display_name ?? null;
}

/**
 * Set or clear the optional contact address. Shape-checking is the caller's
 * job; the address is never verified, so nothing may trust it as identity.
 */
export async function setUserEmail(sql: Sql, alias: string, email: string | null): Promise<void> {
  await sql`UPDATE users SET email = ${email}, updated_at = now() WHERE alias = ${alias}`;
}

/** The directory's email for an alias, or null when there is none. */
export async function getUserEmail(sql: Sql, alias: string): Promise<string | null> {
  const rows = await sql<{ email: string | null }[]>`SELECT email FROM users WHERE alias = ${alias}`;
  return rows[0]?.email ?? null;
}
