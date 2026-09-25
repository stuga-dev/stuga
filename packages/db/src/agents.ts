/** API keys, OAuth client registration and codes, and AI usage telemetry. */
import type { AiUsageInsert, ApiKeyAccess, ApiKeyRow } from "./types.js";
import { daysAgo } from "./sql.js";
import type { Sql } from "./client.js";

// ---- API keys -------------------------------------------------------------------
// A client holds "vk_<key_id>_<secret>"; only sha-256(secret) is stored.

export async function insertApiKey(
  sql: Sql,
  input: {
    keyId: string;
    secretHash: string;
    agentId: string;
    owner: string;
    workspaceId: string;
    name: string;
    /** Folder ids the key is confined to; null = the owner's whole reach. */
    scopeFolders?: string[] | null;
    access?: ApiKeyAccess;
    /** ISO timestamp; null = never expires. */
    expiresAt?: string | null;
  },
): Promise<void> {
  await sql`INSERT INTO api_keys ${sql({
    key_id: input.keyId,
    secret_hash: input.secretHash,
    agent_id: input.agentId,
    owner: input.owner,
    workspace_id: input.workspaceId,
    name: input.name,
    scope_folders: input.scopeFolders ?? null,
    access: input.access ?? "propose",
    expires_at: input.expiresAt ?? null,
  })}`;
}

/**
 * Replace a live key's secret, keeping its id, agent principal, scope and
 * deadline, so everything attributed to the agent still reads the same.
 * Owner-gated; false when no live key matched.
 */
export async function rotateApiKeySecret(sql: Sql, keyId: string, owner: string, secretHash: string): Promise<boolean> {
  const rows = await sql<{ key_id: string }[]>`
    UPDATE api_keys SET secret_hash = ${secretHash}, rotated_at = now()
    WHERE key_id = ${keyId} AND owner = ${owner} AND revoked_at IS NULL
    RETURNING key_id`;
  return rows.length > 0;
}

/** Owner-gated change to a live key's narrowing fields; null when none matched. */
export async function updateApiKey(
  sql: Sql,
  keyId: string,
  owner: string,
  patch: { scopeFolders?: string[] | null; access?: ApiKeyAccess; expiresAt?: string | null; name?: string },
): Promise<ApiKeyRow | null> {
  const set: Record<string, unknown> = {};
  if (patch.scopeFolders !== undefined) set.scope_folders = patch.scopeFolders;
  if (patch.access !== undefined) set.access = patch.access;
  if (patch.expiresAt !== undefined) set.expires_at = patch.expiresAt;
  if (patch.name !== undefined) set.name = patch.name;
  if (Object.keys(set).length === 0) {
    const rows = await sql<ApiKeyRow[]>`
      SELECT * FROM api_keys WHERE key_id = ${keyId} AND owner = ${owner} AND revoked_at IS NULL`;
    return rows[0] ?? null;
  }
  const rows = await sql<ApiKeyRow[]>`
    UPDATE api_keys SET ${sql(set)}
    WHERE key_id = ${keyId} AND owner = ${owner} AND revoked_at IS NULL
    RETURNING *`;
  return rows[0] ?? null;
}

/** Display names for agent ids, keys and OAuth grants alike, revoked ones included: their runs still need a name. */
export async function agentNames(sql: Sql, agentIds: string[]): Promise<Map<string, string>> {
  if (agentIds.length === 0) return new Map();
  const rows = await sql<{ agent_id: string; name: string }[]>`
    SELECT agent_id, name FROM api_keys WHERE agent_id = ANY(${agentIds})
    UNION ALL
    SELECT agent_id, name FROM oauth_grants WHERE agent_id = ANY(${agentIds})`;
  return new Map(rows.map((r) => [r.agent_id, r.name]));
}

/** A live key by id, for bearer verification. */
export async function getApiKey(sql: Sql, keyId: string): Promise<ApiKeyRow | null> {
  const rows = await sql<ApiKeyRow[]>`
    SELECT * FROM api_keys WHERE key_id = ${keyId} AND revoked_at IS NULL`;
  return rows[0] ?? null;
}

/** Every key an owner issued, revoked ones included. */
export async function listApiKeys(sql: Sql, owner: string): Promise<ApiKeyRow[]> {
  return sql<ApiKeyRow[]>`
    SELECT * FROM api_keys WHERE owner = ${owner} ORDER BY created_at DESC`;
}

/** Owner-gated; false when no live key matched. */
export async function revokeApiKey(sql: Sql, keyId: string, owner: string): Promise<boolean> {
  const rows = await sql<{ key_id: string }[]>`
    UPDATE api_keys SET revoked_at = now(), revoked_by = ${owner}
    WHERE key_id = ${keyId} AND owner = ${owner} AND revoked_at IS NULL
    RETURNING key_id`;
  return rows.length > 0;
}

/**
 * Revoke every key a person holds in a workspace, for when they leave it.
 * Request-time checks already refuse these keys; revoking them keeps a later
 * re-invite from silently re-arming a bearer token someone still holds.
 */
export async function revokeWorkspaceApiKeysForOwner(
  sql: Sql,
  workspaceId: string,
  owner: string,
  revokedBy: string,
): Promise<ApiKeyRow[]> {
  return sql<ApiKeyRow[]>`
    UPDATE api_keys SET revoked_at = now(), revoked_by = ${revokedBy}
    WHERE workspace_id = ${workspaceId} AND owner = ${owner} AND revoked_at IS NULL
    RETURNING *`;
}

/** Delete keys revoked more than `days` ago; until then they answer "who used it, who cut it off". */
export async function purgeRevokedApiKeys(sql: Sql, days: number): Promise<number> {
  const rows = await sql<{ key_id: string }[]>`
    DELETE FROM api_keys
    WHERE revoked_at IS NOT NULL AND revoked_at < ${daysAgo(sql, days)}
    RETURNING key_id`;
  return rows.length;
}

/** Best-effort usage stamp, written at most every five minutes per key. */
export async function touchApiKey(sql: Sql, keyId: string): Promise<void> {
  await sql`
    UPDATE api_keys SET last_used_at = now()
    WHERE key_id = ${keyId}
      AND (last_used_at IS NULL OR last_used_at < now() - interval '5 minutes')`;
}

// ---- OAuth (remote MCP connectors) --------------------------------------------------
// Clients (registered dynamically, or known by their metadata document) and single-use PKCE codes;
// the token exchange creates or renews a grant (grants.ts).

export interface OauthClientRow {
  client_id: string;
  client_secret_hash: string | null;
  redirect_uris: string[];
  client_name: string;
  /** `cimd`: the client id is the URL of its metadata document, fetched and checked by the node. */
  kind: "dcr" | "cimd";
  metadata_fetched_at: string | null;
}

export async function insertOauthClient(
  sql: Sql,
  input: { clientId: string; clientSecretHash: string | null; redirectUris: string[]; clientName: string },
): Promise<void> {
  await sql`INSERT INTO oauth_clients ${sql({
    client_id: input.clientId,
    client_secret_hash: input.clientSecretHash,
    redirect_uris: input.redirectUris,
    client_name: input.clientName,
  })}`;
}

/** Record what a client's metadata document said, fetched just now. */
export async function upsertMetadataClient(
  sql: Sql,
  input: { clientId: string; redirectUris: string[]; clientName: string },
): Promise<OauthClientRow> {
  const rows = await sql<OauthClientRow[]>`
    INSERT INTO oauth_clients ${sql({
      client_id: input.clientId,
      client_secret_hash: null,
      redirect_uris: input.redirectUris,
      client_name: input.clientName,
      kind: "cimd",
      metadata_fetched_at: new Date(),
    })}
    ON CONFLICT (client_id) DO UPDATE SET
      redirect_uris = EXCLUDED.redirect_uris,
      client_name = EXCLUDED.client_name,
      metadata_fetched_at = EXCLUDED.metadata_fetched_at,
      last_used_at = now()
    RETURNING client_id, client_secret_hash, redirect_uris, client_name, kind, metadata_fetched_at`;
  return rows[0]!;
}

/** Every lookup stamps last_used_at, which is what the unused-client purge reads. */
export async function getOauthClient(sql: Sql, clientId: string): Promise<OauthClientRow | null> {
  const rows = await sql<OauthClientRow[]>`
    UPDATE oauth_clients SET last_used_at = now() WHERE client_id = ${clientId}
    RETURNING client_id, client_secret_hash, redirect_uris, client_name, kind, metadata_fetched_at`;
  return rows[0] ?? null;
}

/**
 * Drop clients unused for `days`. Registration is open, so without this
 * anyone who reaches the node could grow the table forever. A client someone
 * still has a live grant for stays, so it can sign them in again once its
 * refresh token lapses.
 */
export async function purgeUnusedOauthClients(sql: Sql, days: number): Promise<number> {
  const rows = await sql<{ client_id: string }[]>`
    DELETE FROM oauth_clients c
    WHERE coalesce(c.last_used_at, c.created_at) < ${daysAgo(sql, days)}
      AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = c.client_id AND g.revoked_at IS NULL)
    RETURNING client_id`;
  return rows.length;
}

export async function insertOauthCode(
  sql: Sql,
  input: {
    codeHash: string;
    clientId: string;
    userAlias: string;
    /** The workspaces consented to; null = every one, now and later. */
    workspaceScope: string[] | null;
    access: ApiKeyAccess;
    redirectUri: string;
    codeChallenge: string;
    expiresAt: Date;
  },
): Promise<void> {
  await sql`INSERT INTO oauth_codes ${sql({
    code_hash: input.codeHash,
    client_id: input.clientId,
    user_alias: input.userAlias,
    workspace_scope: input.workspaceScope,
    access: input.access,
    redirect_uri: input.redirectUri,
    code_challenge: input.codeChallenge,
    expires_at: input.expiresAt,
  })}`;
}

export interface ConsumedOauthCode {
  client_id: string;
  user_alias: string;
  workspace_scope: string[] | null;
  access: ApiKeyAccess;
  redirect_uri: string;
}

/**
 * Validate and consume a code in one statement. An expired code is deleted
 * regardless; a live one only when every binding matches, so a bad exchange
 * cannot burn a legitimate code.
 */
export async function consumeOauthCode(
  sql: Sql,
  input: { codeHash: string; clientId: string; redirectUri: string; codeChallenge: string },
): Promise<ConsumedOauthCode | null> {
  const rows = await sql<ConsumedOauthCode[]>`
    WITH consumed AS (
      DELETE FROM oauth_codes
      WHERE code_hash = ${input.codeHash}
        AND (
          expires_at <= now()
          OR (
            client_id = ${input.clientId}
            AND redirect_uri = ${input.redirectUri}
            AND code_challenge = ${input.codeChallenge}
          )
        )
      RETURNING client_id, user_alias, workspace_scope, access, redirect_uri, expires_at
    )
    SELECT client_id, user_alias, workspace_scope, access, redirect_uri
    FROM consumed
    WHERE expires_at > now()`;
  return rows[0] ?? null;
}

// ---- AI usage ----------------------------------------------------------------------

export async function insertAiUsage(sql: Sql, u: AiUsageInsert): Promise<void> {
  await sql`INSERT INTO ai_usage ${sql({
    alias: u.alias,
    workspace_id: u.workspaceId,
    doc_id: u.docId,
    kind: u.kind,
    model: u.model,
    status: u.status ?? "ok",
    input_tokens: u.inputTokens ?? 0,
    output_tokens: u.outputTokens ?? 0,
    cache_read_tokens: u.cacheReadTokens ?? 0,
    cache_write_tokens: u.cacheWriteTokens ?? 0,
  })}`;
}

export async function purgeAiUsage(sql: Sql, olderThanDays: number): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    WITH gone AS (
      DELETE FROM ai_usage
      WHERE created_at < ${daysAgo(sql, olderThanDays)}
      RETURNING 1
    )
    SELECT count(*)::int AS n FROM gone`;
  return row?.n ?? 0;
}

interface TokenTotals {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

/** Raw token counts for one (model, kind); pricing is the caller's. */
export interface UsageByModelRow extends TokenTotals {
  model: string;
  kind: string;
  calls: number;
}

export interface UsageByAliasRow extends TokenTotals {
  alias: string;
  model: string;
  calls: number;
}

export interface UsageByDayRow extends TokenTotals {
  /** YYYY-MM-DD, UTC. */
  day: string;
}

/** A workspace's successful calls since `since`, grouped by model, by principal and by day. */
export async function usageRollup(
  sql: Sql,
  workspaceId: string,
  since: Date,
): Promise<{ byModel: UsageByModelRow[]; byAlias: UsageByAliasRow[]; byDay: UsageByDayRow[] }> {
  const totals = sql`
    COALESCE(sum(input_tokens), 0)::bigint       AS input_tokens,
    COALESCE(sum(output_tokens), 0)::bigint      AS output_tokens,
    COALESCE(sum(cache_read_tokens), 0)::bigint  AS cache_read_tokens,
    COALESCE(sum(cache_write_tokens), 0)::bigint AS cache_write_tokens`;
  const inWindow = sql`workspace_id = ${workspaceId} AND status = 'ok' AND created_at >= ${since}`;
  const [byModel, byAlias, byDay] = await Promise.all([
    sql<UsageByModelRow[]>`
      SELECT model, kind, count(*)::int AS calls, ${totals}
      FROM ai_usage WHERE ${inWindow}
      GROUP BY model, kind
      ORDER BY input_tokens DESC`,
    sql<UsageByAliasRow[]>`
      SELECT alias, model, count(*)::int AS calls, ${totals}
      FROM ai_usage WHERE ${inWindow}
      GROUP BY alias, model
      ORDER BY input_tokens DESC`,
    sql<UsageByDayRow[]>`
      SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, ${totals}
      FROM ai_usage WHERE ${inWindow}
      GROUP BY day
      ORDER BY day`,
  ]);
  return { byModel, byAlias, byDay };
}
