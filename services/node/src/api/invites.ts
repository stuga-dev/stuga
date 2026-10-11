/**
 * Workspace invite links: minted by an owner or admin, redeemed by a signed-in
 * person, and after a node's first account the only way anyone gets an account.
 */
import { sha256Hex } from "@stuga/auth";
import {
  getMemberRole,
  insertWorkspaceInvite,
  type InviteLabel,
  listWorkspaceInvites,
  redeemWorkspaceInvite,
  revokeWorkspaceInvite,
} from "@stuga/db";
import { canGrantRole, isInviteRole } from "@stuga/protocol/domain/roles";
import { recordAudit, type AuditInput } from "../audit/record.js";
import { error, json } from "../http/respond.js";
import type { AccountCall, WorkspaceCall } from "../http/router.js";
import { newId } from "../ids.js";
import { linkOrigin } from "../links/address.js";

/**
 * How the ledger names one link: enough to match the people who joined with it
 * to the row that created it, and no use as a credential.
 */
function inviteRef(tokenHash: string): string {
  return tokenHash.slice(0, 12);
}

/**
 * A link's ledger target and detail: who it is for, when its maker said, else what it admits as
 * and its last characters, which the reader composes in their own language.
 */
function inviteTarget(tokenHash: string, invite: InviteLabel | undefined): Pick<AuditInput, "targetKind" | "targetId" | "targetLabel"> & { detail: Record<string, unknown> } {
  return {
    targetKind: "invite",
    targetId: inviteRef(tokenHash),
    targetLabel: invite?.note ?? null,
    detail: invite ? { role: invite.role, hint: invite.token_hint } : {},
  };
}

/** The ledger row for someone joining through a link; registration redeems links too and writes the same row. */
export function inviteRedeemedAudit(tokenHash: string, role: string, invite?: InviteLabel): AuditInput {
  const target = inviteTarget(tokenHash, invite);
  // `role` is the one the person holds now: an existing member keeps theirs.
  return { action: "invite.redeem", ...target, detail: { ...target.detail, role } };
}

/** The longest note a link carries; the column allows no more. */
const MAX_INVITE_NOTE = 80;

/** What a link admits when the request does not say: one person, for seven days, as the dialog offers. */
export const DEFAULT_INVITE_USES = 1;
export const DEFAULT_INVITE_DAYS = 7;

/**
 * Absent takes `fallback`; null means no limit; anything else must be a positive number, or a typo
 * would mint a link that never lapses.
 */
function positiveOrNone(value: unknown, fallback: number): number | null | undefined {
  if (value === undefined) return fallback;
  if (value === null) return null;
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
    address?: unknown;
    note?: unknown;
  };
  // A link never carries ownership; otherwise the direct-grant escalation rule applies.
  const role = body.role ?? "member";
  if (!isInviteRole(role)) return error(400, "invalid role");
  if (!canGrantRole(callerRole, role)) {
    return error(403, "only a workspace owner can create admin invite links");
  }
  const days = positiveOrNone(body.expires_in_days, DEFAULT_INVITE_DAYS);
  if (days === undefined) return error(400, "expires_in_days must be a positive number, or null for a link that does not expire");
  const uses = positiveOrNone(body.max_uses, DEFAULT_INVITE_USES);
  if (uses === undefined || (uses !== null && !Number.isInteger(uses))) {
    return error(400, "max_uses must be a positive whole number, or null for no limit");
  }
  // The link points where its maker is unless they say (links/address.ts). A link for the remote
  // address with no limit or no expiry would be an open sign-up for anyone it leaked to, so those
  // open only on the node's own network.
  const target = linkOrigin(ctx, body.address);
  if ("error" in target) return json({ error: target.error, message: target.message }, { status: target.status });
  if (target.address === "remote" && (days === null || uses === null)) {
    return json(
      { error: "invite_local_only", message: "A link with no limit or no expiry can be made only on this node's network." },
      { status: 400 },
    );
  }
  if (body.note !== undefined && body.note !== null && typeof body.note !== "string") return error(400, "note must be a string");
  // Blank means none; a name longer than the column takes is cut, not refused.
  // Cut by characters, as the column counts them, so an emoji is never split in half.
  const note = typeof body.note === "string" ? [...body.note.trim()].slice(0, MAX_INVITE_NOTE).join("") || null : null;
  // Whoever holds a reusable admin link could hand admin to anyone, so an admin link admits one person.
  if (role === "admin" && uses !== 1) return error(400, "an admin invite link admits one person: set max_uses to 1");

  // Shown once in the join URL; only its hash is stored.
  const token = newId("inv_") + newId("");
  const tokenHash = sha256Hex(token);
  // Four characters of a long random token: enough to tell links apart, far too few to guess the rest.
  const tokenHint = token.slice(-4);
  const expiresAt = days === null ? null : new Date(Date.now() + days * 86400_000).toISOString();
  await insertWorkspaceInvite(ctx.sql, {
    tokenHash,
    tokenHint,
    note,
    workspaceId: wsId,
    role,
    createdBy: ctx.alias,
    expiresAt,
    maxUses: uses,
  });
  const ledgerTarget = inviteTarget(tokenHash, { role, token_hint: tokenHint, note });
  recordAudit(
    { ...ctx, workspaceId: wsId },
    {
      action: "invite.create",
      ...ledgerTarget,
      detail: { ...ledgerTarget.detail, expires_at: expiresAt, max_uses: uses, address: target.address },
    },
  );
  const joinUrl = `${target.origin}/join/${token}`;
  // token_hash names the link for revoking, as the listing does.
  return json(
    { token, token_hash: tokenHash, join_url: joinUrl, role, note, expires_at: expiresAt, max_uses: uses, address: target.address },
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
    recordAudit({ ...ctx, workspaceId: wsId }, { action: "invite.revoke", ...inviteTarget(tokenHash, revoked) });
  }
  return revoked ? json({ revoked: true }) : error(404, "invite not found");
}

export async function redeemInvite({ ctx, req }: AccountCall): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { token?: string };
  const token = (body.token ?? "").trim();
  if (!token) return error(400, "token required");
  const tokenHash = sha256Hex(token);
  const result = await redeemWorkspaceInvite(ctx.sql, tokenHash, ctx.alias, ctx.arrival);
  if (!result.ok) {
    if (result.reason === "local_only") {
      return json({ error: "invite_local_only", message: "This invite link works only on this node's network." }, { status: 403 });
    }
    return error(400, "this invite link is invalid, expired, or fully used");
  }
  recordAudit({ ...ctx, workspaceId: result.workspaceId }, inviteRedeemedAudit(tokenHash, result.role, result.invite));
  return json({ workspace_id: result.workspaceId, role: result.role });
}
