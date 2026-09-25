/**
 * OAuth grants and their tokens. A grant is one person's authorization of one
 * client over the workspaces they chose; its agent keeps one identity for life,
 * so a grant is revoked and never deleted. Tokens are stored as sha-256 only.
 */
import type { ApiKeyAccess, OauthGrantRow } from "./types.js";
import type { Sql } from "./client.js";
import type { Queryable } from "./sql.js";

/**
 * The person's live grant for this client, created or renewed with what they
 * just consented to. A renewal keeps the grant's id, agent and name.
 */
export async function upsertOauthGrant(
  sql: Sql,
  input: {
    grantId: string;
    clientId: string;
    name: string;
    clientHost: string | null;
    owner: string;
    agentId: string;
    workspaceScope: string[] | null;
    access: ApiKeyAccess;
  },
): Promise<OauthGrantRow> {
  const rows = await sql<OauthGrantRow[]>`
    INSERT INTO oauth_grants ${sql({
      grant_id: input.grantId,
      client_id: input.clientId,
      name: input.name,
      client_host: input.clientHost,
      owner: input.owner,
      agent_id: input.agentId,
      workspace_scope: input.workspaceScope,
      access: input.access,
    })}
    ON CONFLICT (owner, client_id) WHERE revoked_at IS NULL DO UPDATE SET
      workspace_scope = EXCLUDED.workspace_scope,
      access = EXCLUDED.access,
      client_host = EXCLUDED.client_host
    RETURNING *`;
  return rows[0]!;
}

/** Every grant a person made, revoked ones included, newest first. */
export async function listOauthGrants(sql: Sql, owner: string): Promise<OauthGrantRow[]> {
  return sql<OauthGrantRow[]>`SELECT * FROM oauth_grants WHERE owner = ${owner} ORDER BY created_at DESC`;
}

/** Owner-gated change to a live grant; null when none matched. */
export async function updateOauthGrant(
  sql: Sql,
  grantId: string,
  owner: string,
  patch: { name?: string; access?: ApiKeyAccess },
): Promise<OauthGrantRow | null> {
  const set: Record<string, unknown> = {};
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.access !== undefined) set.access = patch.access;
  const rows =
    Object.keys(set).length === 0
      ? await sql<OauthGrantRow[]>`SELECT * FROM oauth_grants WHERE grant_id = ${grantId} AND owner = ${owner} AND revoked_at IS NULL`
      : await sql<OauthGrantRow[]>`
          UPDATE oauth_grants SET ${sql(set)}
          WHERE grant_id = ${grantId} AND owner = ${owner} AND revoked_at IS NULL
          RETURNING *`;
  return rows[0] ?? null;
}

/** Owner-gated; its tokens stop working at once. False when no live grant matched. */
export async function revokeOauthGrant(sql: Sql, grantId: string, owner: string): Promise<boolean> {
  return sql.begin(async (tx) => {
    const rows = await tx<{ grant_id: string }[]>`
      UPDATE oauth_grants SET revoked_at = now(), revoked_by = ${owner}
      WHERE grant_id = ${grantId} AND owner = ${owner} AND revoked_at IS NULL
      RETURNING grant_id`;
    if (rows.length === 0) return false;
    await tx`DELETE FROM oauth_tokens WHERE grant_id = ${grantId}`;
    return true;
  });
}

/**
 * A person left a workspace: grants that named it stop naming it, so a
 * re-invite does not quietly hand it back to an app, and a grant left naming
 * nothing is revoked. One consented to "now and later" keeps following them.
 */
export async function dropWorkspaceFromOwnerGrants(sql: Sql, workspaceId: string, owner: string, revokedBy: string): Promise<number> {
  return sql.begin(async (tx) => {
    await tx`
      UPDATE oauth_grants SET workspace_scope = array_remove(workspace_scope, ${workspaceId})
      WHERE owner = ${owner} AND revoked_at IS NULL AND ${workspaceId} = ANY(workspace_scope)`;
    const emptied = await tx<{ grant_id: string }[]>`
      UPDATE oauth_grants SET revoked_at = now(), revoked_by = ${revokedBy}
      WHERE owner = ${owner} AND revoked_at IS NULL AND workspace_scope = '{}'
      RETURNING grant_id`;
    if (emptied.length > 0) await tx`DELETE FROM oauth_tokens WHERE grant_id = ANY(${emptied.map((g) => g.grant_id)})`;
    return emptied.length;
  });
}

export async function insertOauthToken(
  sql: Sql,
  input: { tokenHash: string; grantId: string; kind: "access" | "refresh"; familyId: string; familyStartedAt: Date; expiresAt: Date },
): Promise<void> {
  await sql`INSERT INTO oauth_tokens ${sql({
    token_hash: input.tokenHash,
    grant_id: input.grantId,
    kind: input.kind,
    family_id: input.familyId,
    family_started_at: input.familyStartedAt,
    expires_at: input.expiresAt,
  })}`;
}

/** The live grant behind an unexpired access token, stamping its use at most every five minutes. */
export async function grantForAccessToken(sql: Sql, tokenHash: string): Promise<OauthGrantRow | null> {
  const rows = await sql<OauthGrantRow[]>`
    SELECT g.* FROM oauth_tokens t JOIN oauth_grants g USING (grant_id)
    WHERE t.token_hash = ${tokenHash} AND t.kind = 'access' AND t.expires_at > now() AND g.revoked_at IS NULL`;
  const grant = rows[0];
  if (!grant) return null;
  await sql`
    UPDATE oauth_grants SET last_used_at = now()
    WHERE grant_id = ${grant.grant_id} AND (last_used_at IS NULL OR last_used_at < now() - interval '5 minutes')`.catch(() => {});
  return grant;
}

/** A token row as the node mints it; the family is the rotation's. */
export interface NewOauthToken {
  tokenHash: string;
  kind: "access" | "refresh";
  expiresAt: Date;
}

export type RotatedRefreshToken =
  | { kind: "rotated"; grant: OauthGrantRow }
  /** Presented again after the grace window: someone else holds a copy, so the whole chain is ended. */
  | { kind: "replayed" }
  | { kind: "invalid" };

/** Every change to one sign-in's chain takes this lock first, then touches rows, so spends, replays and revokes queue. */
async function lockFamily(tx: Queryable, familyId: string): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtext(${`oauth-family:${familyId}`}))`;
}

/**
 * Exchange a refresh token for the tokens `next` mints, in one transaction, so
 * a replay or a revoke of the same sign-in never misses them. A token presented
 * again within `graceSeconds` of being spent is one client refreshing twice at
 * once, or a response it lost: it gets a sibling pair. Later, it is a copy in
 * someone else's hands, and the chain ends (RFC 9700). An unknown, expired or
 * revoked token, or one another client presents, is invalid.
 */
export async function rotateRefreshToken(
  sql: Sql,
  input: { tokenHash: string; clientId: string; graceSeconds: number; next: (familyStartedAt: Date) => NewOauthToken[] },
): Promise<RotatedRefreshToken> {
  return sql.begin(async (tx) => {
    const [found] = await tx<{ family_id: string }[]>`
      SELECT family_id FROM oauth_tokens WHERE token_hash = ${input.tokenHash} AND kind = 'refresh'`;
    if (!found) return { kind: "invalid" } as const;
    await lockFamily(tx, found.family_id);
    const rows = await tx<Array<{ family_id: string; family_started_at: string; used_at: string | null; expires_at: string } & OauthGrantRow>>`
      SELECT t.family_id, t.family_started_at, t.used_at, t.expires_at, g.*
      FROM oauth_tokens t JOIN oauth_grants g USING (grant_id)
      WHERE t.token_hash = ${input.tokenHash} AND t.kind = 'refresh' AND g.client_id = ${input.clientId}`;
    const row = rows[0];
    if (!row || row.revoked_at !== null || Date.parse(row.expires_at) <= Date.now()) return { kind: "invalid" } as const;
    if (row.used_at !== null) {
      if (Date.now() - Date.parse(row.used_at) > input.graceSeconds * 1000) {
        await tx`DELETE FROM oauth_tokens WHERE family_id = ${row.family_id}`;
        return { kind: "replayed" } as const;
      }
    } else {
      await tx`UPDATE oauth_tokens SET used_at = now() WHERE token_hash = ${input.tokenHash}`;
    }
    const { family_id: familyId, family_started_at: started, used_at: _used, expires_at: _expires, ...grant } = row;
    const familyStartedAt = new Date(started);
    for (const token of input.next(familyStartedAt)) {
      await tx`INSERT INTO oauth_tokens ${tx({
        token_hash: token.tokenHash,
        grant_id: grant.grant_id,
        kind: token.kind,
        family_id: familyId,
        family_started_at: familyStartedAt,
        expires_at: token.expiresAt,
      })}`;
    }
    return { kind: "rotated", grant: grant as OauthGrantRow } as const;
  });
}

/** RFC 7009: end the chain a token belongs to, after any exchange of it in flight. Unknown tokens are not an error. */
export async function revokeOauthTokenFamily(sql: Sql, tokenHash: string): Promise<void> {
  await sql.begin(async (tx) => {
    const [found] = await tx<{ family_id: string }[]>`SELECT family_id FROM oauth_tokens WHERE token_hash = ${tokenHash}`;
    if (!found) return;
    await lockFamily(tx, found.family_id);
    await tx`DELETE FROM oauth_tokens WHERE family_id = ${found.family_id}`;
  });
}

/** Drop expired tokens; a spent refresh token is kept until then, so a replay is still recognised. */
export async function purgeExpiredOauthTokens(sql: Sql): Promise<number> {
  const rows = await sql<{ token_hash: string }[]>`DELETE FROM oauth_tokens WHERE expires_at < now() RETURNING token_hash`;
  return rows.length;
}
