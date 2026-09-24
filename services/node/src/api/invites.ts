/**
 * Workspace invite links: minted by an owner or admin, redeemed by a signed-in
 * person, and after a node's first account the only way anyone gets an account.
 */
import { sha256Hex } from "@stuga/auth";
import {
  getMemberRole,
  insertWorkspaceInvite,
  listWorkspaceInvites,
  redeemWorkspaceInvite,
  revokeWorkspaceInvite,
} from "@stuga/db";
import { canGrantRole, isInviteRole } from "@stuga/protocol/domain/roles";
import { recordAudit, type AuditInput } from "../audit/record.js";
import { error, json } from "../http/respond.js";
import type { AccountCall, WorkspaceCall } from "../http/router.js";
import { newId } from "../ids.js";

/**
 * How the ledger names one link: enough to match the people who joined with it
 * to the row that created it, and no use as a credential.
 */
function inviteRef(tokenHash: string): string {
  return tokenHash.slice(0, 12);
}

/** The ledger row for someone joining through a link; registration redeems links too and writes the same row. */
export function inviteRedeemedAudit(tokenHash: string, role: string): AuditInput {
  return { action: "invite.redeem", targetKind: "invite", targetId: inviteRef(tokenHash), detail: { role } };
}

/** Absent or null means no limit; anything else must be a positive number, or a typo would mint a link that never lapses. */
function positiveOrNone(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

export async function createInvite({ ctx, req, match }: WorkspaceCall): Promise<Response> {
  const wsId = match[1]!;
  const callerRole = await getMemberRole(ctx.sql, wsId, ctx.alias);
  if (callerRole !== "owner" && callerRole !== "admin") {
    return error(403, "only a workspace owner or admin can create invite links");
  }
  const body = (await req.json().catch(() => ({}))) as {
    role?: string;
    expires_in_days?: unknown;
    max_uses?: unknown;
  };
  // A link never carries ownership; otherwise the direct-grant escalation rule applies.
  const role = body.role ?? "member";
  if (!isInviteRole(role)) return error(400, "invalid role");
  if (!canGrantRole(callerRole, role)) {
    return error(403, "only a workspace owner can create admin invite links");
  }
  const days = positiveOrNone(body.expires_in_days);
  if (days === undefined) return error(400, "expires_in_days must be a positive number, or omitted for a link that does not expire");
  const uses = positiveOrNone(body.max_uses);
  if (uses === undefined || (uses !== null && !Number.isInteger(uses))) {
    return error(400, "max_uses must be a positive whole number, or omitted for no limit");
  }
  // Whoever holds a reusable admin link could hand admin to anyone, so an admin link admits one person.
  if (role === "admin" && uses !== 1) return error(400, "an admin invite link admits one person: set max_uses to 1");

  // Shown once in the join URL; only its hash is stored.
  const token = newId("inv_") + newId("");
  const tokenHash = sha256Hex(token);
  const expiresAt = days === null ? null : new Date(Date.now() + days * 86400_000).toISOString();
  await insertWorkspaceInvite(ctx.sql, {
    tokenHash,
    // Four characters of a long random token: enough to tell links apart, far too few to guess the rest.
    tokenHint: token.slice(-4),
    workspaceId: wsId,
    role,
    createdBy: ctx.alias,
    expiresAt,
    maxUses: uses,
  });
  recordAudit(
    { ...ctx, workspaceId: wsId },
    {
      action: "invite.create",
      targetKind: "invite",
      targetId: inviteRef(tokenHash),
      detail: { role, expires_at: expiresAt, max_uses: uses },
    },
  );
  const joinUrl = `${ctx.env.publicOrigin}/join/${token}`;
  // token_hash names the link for revoking, as the listing does.
  return json(
    { token, token_hash: tokenHash, join_url: joinUrl, role, expires_at: expiresAt, max_uses: uses },
    { status: 201 },
  );
}

/** The links that can still admit someone; expired and used-up links are left out. */
export async function listInvites({ ctx, match }: WorkspaceCall): Promise<Response> {
  const wsId = match[1]!;
  const callerRole = await getMemberRole(ctx.sql, wsId, ctx.alias);
  if (callerRole !== "owner" && callerRole !== "admin") {
    return error(403, "only a workspace owner or admin can view invite links");
  }
  const invites = await listWorkspaceInvites(ctx.sql, wsId);
  return json({ invites });
}

export async function revokeInvite({ ctx, match }: WorkspaceCall): Promise<Response> {
  const wsId = match[1]!;
  const tokenHash = match[2]!;
  const callerRole = await getMemberRole(ctx.sql, wsId, ctx.alias);
  if (callerRole !== "owner" && callerRole !== "admin") {
    return error(403, "only a workspace owner or admin can revoke invite links");
  }
  const revoked = await revokeWorkspaceInvite(ctx.sql, tokenHash, wsId);
  if (revoked) {
    recordAudit({ ...ctx, workspaceId: wsId }, { action: "invite.revoke", targetKind: "invite", targetId: inviteRef(tokenHash) });
  }
  return revoked ? json({ revoked: true }) : error(404, "invite not found");
}

export async function redeemInvite({ ctx, req }: AccountCall): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { token?: string };
  const token = (body.token ?? "").trim();
  if (!token) return error(400, "token required");
  const tokenHash = sha256Hex(token);
  const result = await redeemWorkspaceInvite(ctx.sql, tokenHash, ctx.alias);
  if (!result.ok) {
    return error(400, "this invite link is invalid, expired, or fully used");
  }
  recordAudit({ ...ctx, workspaceId: result.workspaceId }, inviteRedeemedAudit(tokenHash, result.role));
  return json({ workspace_id: result.workspaceId, role: result.role });
}
