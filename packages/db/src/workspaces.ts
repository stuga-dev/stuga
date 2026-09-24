/** Workspaces (the tenant boundary), their members, groups and invite links. */
import type { Fragment, TransactionSql } from "postgres";
import type { DocAccessMode } from "@stuga/protocol/domain/workspaces";
import type { WorkspaceRole } from "@stuga/protocol/domain/roles";
import type { DirectoryRow, DocRow, GroupRow, WorkspaceInviteRow, WorkspaceMemberRow, WorkspaceRow } from "./types.js";
import type { Queryable } from "./sql.js";
import type { Sql } from "./client.js";

// ---- Groups -----------------------------------------------------------------

export async function getGroupsForMember(sql: Sql, userPrincipal: string, workspaceId: string): Promise<GroupRow[]> {
  return sql<GroupRow[]>`
    SELECT * FROM groups WHERE members && ${[userPrincipal]} AND workspace_id = ${workspaceId}`;
}

/** The group ids `userPrincipal` holds in the workspace `workspaceIdExpr` names, as a text[]. */
function heldGroupIds(sql: Sql, userPrincipal: string, workspaceIdExpr: Fragment): Fragment {
  return sql`COALESCE(
      (SELECT array_agg(g.group_id) FROM groups g
        WHERE g.members && ${[userPrincipal]} AND g.workspace_id = ${workspaceIdExpr}),
      ARRAY[]::text[]
    )`;
}

/** Write a group's membership and return what it held before, or null for a new group. */
export async function upsertGroup(sql: Sql, groupId: string, members: string[], workspaceId: string): Promise<string[] | null> {
  const rows = await sql<{ members: string[] }[]>`
    WITH previous AS (
      SELECT members FROM groups WHERE workspace_id = ${workspaceId} AND group_id = ${groupId}
    ), upserted AS (
      INSERT INTO groups ${sql({ group_id: groupId, members, workspace_id: workspaceId })}
      ON CONFLICT (workspace_id, group_id) DO UPDATE SET members = EXCLUDED.members, updated_at = now()
    )
    SELECT members FROM previous`;
  return rows[0]?.members ?? null;
}

/**
 * The members of the named groups in one workspace. For addressing
 * notifications only: authorization matches the `group:` principal itself.
 */
export async function listGroupMembers(sql: Sql, groupIds: string[], workspaceId: string): Promise<string[]> {
  if (groupIds.length === 0) return [];
  const rows = await sql<{ member: string }[]>`
    SELECT DISTINCT unnest(members) AS member
    FROM groups
    WHERE workspace_id = ${workspaceId} AND group_id = ANY(${groupIds})`;
  return rows.map((r) => r.member);
}

// ---- Membership -------------------------------------------------------------

/** Every workspace the caller belongs to, with the role and groups held there. */
export async function listMembershipGroups(
  sql: Sql,
  alias: string,
  userPrincipal: string,
): Promise<Array<{ workspace_id: string; role: WorkspaceRole; group_ids: string[] }>> {
  return sql<Array<{ workspace_id: string; role: WorkspaceRole; group_ids: string[] }>>`
    SELECT m.workspace_id, m.role, ${heldGroupIds(sql, userPrincipal, sql`m.workspace_id`)} AS group_ids
    FROM workspace_members m
    WHERE m.alias = ${alias}`;
}

export interface HumanAuth {
  /** Null when the account no longer exists: its token outlived it. */
  user: DirectoryRow | null;
  /** Null when the caller belongs to no workspace. */
  membership: { workspace_id: string; role: WorkspaceRole } | null;
  /** Group principals held in the resolved workspace. */
  groupIds: string[];
}

/**
 * A human caller's directory row, workspace membership and groups in one
 * statement, read live on every request. `requestedWorkspaceId` applies only
 * where the caller is a member; otherwise the earliest-joined workspace is used.
 */
export async function resolveHumanAuth(
  sql: Sql,
  alias: string,
  userPrincipal: string,
  requestedWorkspaceId: string | null,
): Promise<HumanAuth> {
  const rows = await sql<
    Array<{
      user_alias: string | null;
      display_name: string | null;
      username: string | null;
      email: string | null;
      workspace_id: string | null;
      role: WorkspaceRole | null;
      group_ids: string[];
    }>
  >`
    WITH usr AS (
      SELECT alias, display_name, username, email FROM users WHERE alias = ${alias}
    ), pinned AS (
      SELECT workspace_id, role FROM workspace_members
      WHERE alias = ${alias} AND workspace_id = ${requestedWorkspaceId}
    ), earliest AS (
      SELECT workspace_id, role FROM workspace_members
      WHERE alias = ${alias}
      ORDER BY joined_at, workspace_id
      LIMIT 1
    ), resolved AS (
      SELECT workspace_id, role FROM pinned
      UNION ALL
      SELECT workspace_id, role FROM earliest WHERE NOT EXISTS (SELECT 1 FROM pinned)
    )
    SELECT
      u.alias        AS user_alias,
      u.display_name AS display_name,
      u.username     AS username,
      u.email        AS email,
      r.workspace_id AS workspace_id,
      r.role         AS role,
      ${heldGroupIds(sql, userPrincipal, sql`r.workspace_id`)} AS group_ids
    FROM (SELECT 1) AS anchor
    LEFT JOIN usr u      ON TRUE
    LEFT JOIN resolved r ON TRUE`;
  // The anchor row makes the result total: exactly one row, even for a stranger.
  const row = rows[0]!;
  return {
    user: row.user_alias === null ? null : { display_name: row.display_name ?? "", username: row.username ?? "", email: row.email },
    membership: row.workspace_id === null || row.role === null ? null : { workspace_id: row.workspace_id, role: row.role },
    groupIds: row.group_ids,
  };
}

export async function isWorkspaceMember(sql: Sql, workspaceId: string, alias: string): Promise<boolean> {
  const rows = await sql`
    SELECT 1 FROM workspace_members WHERE workspace_id = ${workspaceId} AND alias = ${alias}`;
  return rows.length > 0;
}

export async function isWorkspaceOwner(sql: Sql, workspaceId: string, alias: string): Promise<boolean> {
  const rows = await sql`
    SELECT 1 FROM workspace_members WHERE workspace_id = ${workspaceId} AND alias = ${alias} AND role = 'owner'`;
  return rows.length > 0;
}

export async function getMemberRole(sql: Queryable, workspaceId: string, alias: string): Promise<WorkspaceRole | null> {
  const rows = await sql<{ role: WorkspaceRole }[]>`
    SELECT role FROM workspace_members WHERE workspace_id = ${workspaceId} AND alias = ${alias}`;
  return rows[0]?.role ?? null;
}

/** Members with their directory fields; a member not yet in the directory lists with nulls. */
export async function listWorkspaceMembers(
  sql: Sql,
  workspaceId: string,
): Promise<Array<WorkspaceMemberRow & { display_name: string | null; username: string | null; email: string | null }>> {
  return sql<Array<WorkspaceMemberRow & { display_name: string | null; username: string | null; email: string | null }>>`
    SELECT m.workspace_id, m.alias, m.role, m.joined_at, u.display_name, u.username, u.email
    FROM workspace_members m
    LEFT JOIN users u ON u.alias = m.alias
    WHERE m.workspace_id = ${workspaceId}
    ORDER BY m.joined_at`;
}

export async function removeWorkspaceMember(sql: Sql, workspaceId: string, alias: string): Promise<boolean> {
  const rows = await sql<{ alias: string }[]>`
    DELETE FROM workspace_members
    WHERE workspace_id = ${workspaceId} AND alias = ${alias}
    RETURNING alias`;
  return rows.length > 0;
}

export async function countWorkspaceOwners(sql: Sql, workspaceId: string): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM workspace_members
    WHERE workspace_id = ${workspaceId} AND role = 'owner'`;
  return rows[0]?.n ?? 0;
}

export type MemberAddOutcome = "added" | "promoted" | "already_member";

/** The outcome and the role the person holds afterwards, which is not always the one requested. */
export interface MemberChange {
  outcome: MemberAddOutcome;
  role: WorkspaceRole;
}

/**
 * Add a member, or promote a guest. Any other existing role is left untouched
 * (`already_member`): demotions and admin/owner changes go through
 * updateMemberRole, behind the route's last-owner and admin-vs-owner checks.
 * Null when the workspace does not exist.
 */
export async function addOrPromoteWorkspaceMember(
  sql: Sql,
  workspaceId: string,
  alias: string,
  role: WorkspaceRole,
): Promise<MemberChange | null> {
  return sql.begin(async (tx) => {
    const ws = await lockWorkspace(tx, workspaceId);
    if (!ws) return null;
    const current = await getMemberRole(tx, workspaceId, alias);
    if (current) {
      if (current !== "guest" || role === "guest") return { outcome: "already_member", role: current };
      await tx`
        UPDATE workspace_members SET role = ${role}
        WHERE workspace_id = ${workspaceId} AND alias = ${alias}`;
      return { outcome: "promoted", role };
    }
    await tx`INSERT INTO workspace_members ${tx({ workspace_id: workspaceId, alias, role })}`;
    return { outcome: "added", role };
  }) as Promise<MemberChange | null>;
}

export type RoleChangeOutcome = "updated" | "not_a_member";

/** No last-owner guard here; the route owns that decision. */
export async function updateMemberRole(sql: Sql, workspaceId: string, alias: string, role: WorkspaceRole): Promise<RoleChangeOutcome> {
  const rows = await sql<{ alias: string }[]>`
    UPDATE workspace_members SET role = ${role}
    WHERE workspace_id = ${workspaceId} AND alias = ${alias}
    RETURNING alias`;
  return rows.length > 0 ? "updated" : "not_a_member";
}

/**
 * Lock the workspace row. Membership inserts decided on a read take it inside
 * their transaction, standing in for the membership rows that do not exist yet.
 */
async function lockWorkspace(sql: Queryable, workspaceId: string): Promise<WorkspaceRow | null> {
  const rows = await sql<WorkspaceRow[]>`
    SELECT * FROM workspaces WHERE workspace_id = ${workspaceId} FOR UPDATE`;
  return rows[0] ?? null;
}

/** Only the provided fields change. Null when the workspace does not exist. */
export async function updateWorkspaceSettings(
  sql: Sql,
  workspaceId: string,
  patch: { name?: string; defaultDocAccess?: DocAccessMode; agentInstructions?: string },
): Promise<WorkspaceRow | null> {
  const set: Record<string, unknown> = {};
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.defaultDocAccess !== undefined) set.default_doc_access = patch.defaultDocAccess;
  if (patch.agentInstructions !== undefined) set.agent_instructions = patch.agentInstructions;
  if (Object.keys(set).length === 0) return getWorkspace(sql, workspaceId);
  const rows = await sql<WorkspaceRow[]>`
    UPDATE workspaces SET ${sql(set)} WHERE workspace_id = ${workspaceId} RETURNING *`;
  return rows[0] ?? null;
}

export async function listWorkspacesForUser(sql: Sql, alias: string): Promise<Array<WorkspaceRow & { role: WorkspaceRole }>> {
  return sql<Array<WorkspaceRow & { role: WorkspaceRole }>>`
    SELECT w.*, m.role FROM workspaces w
    JOIN workspace_members m ON m.workspace_id = w.workspace_id
    WHERE m.alias = ${alias}
    ORDER BY m.joined_at`;
}

export async function getWorkspace(sql: Sql, workspaceId: string): Promise<WorkspaceRow | null> {
  const rows = await sql<WorkspaceRow[]>`SELECT * FROM workspaces WHERE workspace_id = ${workspaceId}`;
  return rows[0] ?? null;
}

/**
 * Create a workspace owned by `owner`, atomically. An omitted
 * `defaultDocAccess` leaves the column to its schema DEFAULT.
 */
export async function provisionWorkspace(
  sql: Sql,
  input: { workspaceId: string; name: string; owner: string; defaultDocAccess?: DocAccessMode },
): Promise<WorkspaceRow> {
  return sql.begin(async (tx) => {
    const insert: Record<string, unknown> = { workspace_id: input.workspaceId, name: input.name };
    if (input.defaultDocAccess !== undefined) insert.default_doc_access = input.defaultDocAccess;
    const rows = await tx<WorkspaceRow[]>`
      INSERT INTO workspaces ${tx(insert)}
      RETURNING *`;
    await tx`
      INSERT INTO workspace_members ${tx({ workspace_id: input.workspaceId, alias: input.owner, role: "owner" })}`;
    return rows[0]!;
  });
}

/**
 * Delete a workspace and, through the foreign keys, everything in it. The
 * documents are deleted first so their ids and types come back for the caller
 * to remove blobs and actor storage. Null when the workspace does not exist.
 */
export async function deleteWorkspaceCascade(
  sql: Sql,
  workspaceId: string,
): Promise<{ docs: Array<Pick<DocRow, "doc_id" | "doc_type">> } | null> {
  return sql.begin(async (tx) => {
    const ws = await lockWorkspace(tx, workspaceId);
    if (!ws) return null;
    const docs = await tx<Pick<DocRow, "doc_id" | "doc_type">[]>`
      DELETE FROM docs WHERE workspace_id = ${workspaceId} RETURNING doc_id, doc_type`;
    await tx`DELETE FROM workspaces WHERE workspace_id = ${workspaceId}`;
    return { docs };
  });
}

/** Idempotent: an existing membership keeps its role. */
export async function addWorkspaceMember(sql: Sql, workspaceId: string, alias: string, role: WorkspaceRole = "member"): Promise<void> {
  await sql`
    INSERT INTO workspace_members ${sql({ workspace_id: workspaceId, alias, role })}
    ON CONFLICT (workspace_id, alias) DO NOTHING`;
}

// ---- Invite links -------------------------------------------------------------

export async function insertWorkspaceInvite(
  sql: Sql,
  input: {
    tokenHash: string;
    tokenHint?: string | null;
    workspaceId: string;
    role: WorkspaceRole;
    createdBy: string;
    expiresAt: string | null;
    maxUses: number | null;
  },
): Promise<void> {
  await sql`
    INSERT INTO workspace_invites ${sql({
      token_hash: input.tokenHash,
      token_hint: input.tokenHint ?? null,
      workspace_id: input.workspaceId,
      role: input.role,
      created_by: input.createdBy,
      expires_at: input.expiresAt,
      max_uses: input.maxUses,
    })}`;
}

/** The links that could still admit someone: not revoked, not expired, uses left. Newest first. */
export async function listWorkspaceInvites(sql: Sql, workspaceId: string): Promise<WorkspaceInviteRow[]> {
  return sql<WorkspaceInviteRow[]>`
    SELECT * FROM workspace_invites
    WHERE workspace_id = ${workspaceId}
      AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at > now())
      AND (max_uses IS NULL OR use_count < max_uses)
    ORDER BY created_at DESC`;
}

export async function revokeWorkspaceInvite(sql: Sql, tokenHash: string, workspaceId: string): Promise<boolean> {
  const rows = await sql<{ token_hash: string }[]>`
    UPDATE workspace_invites SET revoked_at = now()
    WHERE token_hash = ${tokenHash} AND workspace_id = ${workspaceId} AND revoked_at IS NULL
    RETURNING token_hash`;
  return rows.length > 0;
}

/** `invalid` carries no reason: a route must not reveal why a token failed. */
export type InviteRedemption = { ok: true; workspaceId: string; role: WorkspaceRole } | { ok: false; reason: "invalid" };

/**
 * Redeem an invite: add the caller at its role (an existing member keeps
 * theirs) and count the use, in one transaction so `max_uses` cannot be
 * exceeded. A refused redemption uses nothing.
 */
export async function redeemWorkspaceInvite(sql: Sql, tokenHash: string, alias: string): Promise<InviteRedemption> {
  return sql.begin((tx) => redeemWorkspaceInviteIn(tx, tokenHash, alias));
}

/**
 * The redemption inside a transaction the caller holds, so creating an account
 * and spending the invite it was made with commit or roll back together. The
 * invite row is locked first, so of concurrent redemptions only as many as it
 * has uses left get through.
 */
export async function redeemWorkspaceInviteIn(
  tx: TransactionSql,
  tokenHash: string,
  alias: string,
): Promise<InviteRedemption> {
  const rows = await tx<WorkspaceInviteRow[]>`
    SELECT * FROM workspace_invites
    WHERE token_hash = ${tokenHash}
      AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at > now())
      AND (max_uses IS NULL OR use_count < max_uses)
    FOR UPDATE`;
  const invite = rows[0];
  if (!invite) return { ok: false, reason: "invalid" };

  // Invite row, then workspace row: the only path holding two locks.
  const ws = await lockWorkspace(tx, invite.workspace_id);
  if (!ws) return { ok: false, reason: "invalid" };

  const existing = await getMemberRole(tx, invite.workspace_id, alias);
  if (!existing) {
    await tx`INSERT INTO workspace_members ${tx({ workspace_id: invite.workspace_id, alias, role: invite.role })}`;
  }
  await tx`UPDATE workspace_invites SET use_count = use_count + 1 WHERE token_hash = ${tokenHash}`;
  return { ok: true, workspaceId: invite.workspace_id, role: existing ?? invite.role };
}

/** Whether an invite could be redeemed right now: not revoked, not expired, uses left. */
export async function isWorkspaceInviteRedeemable(sql: Sql, tokenHash: string): Promise<boolean> {
  const rows = await sql`
    SELECT 1 FROM workspace_invites
    WHERE token_hash = ${tokenHash}
      AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at > now())
      AND (max_uses IS NULL OR use_count < max_uses)`;
  return rows.length > 0;
}
