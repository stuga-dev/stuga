/** `/api/workspaces/:id/members`: who belongs to a workspace, and in which role. */
import {
  addOrPromoteWorkspaceMember,
  countWorkspaceOwners,
  getAnyUserAliasByHandle,
  getMemberRole,
  getWorkspace,
  isWorkspaceMember,
  listWorkspaceMembers,
  removeWorkspaceMember,
  revokeWorkspaceApiKeysForOwner,
  searchAccounts,
  updateMemberRole,
  userExists,
} from "@stuga/db";
import { type WorkspaceRole, canGrantRole, isWorkspaceRole } from "@stuga/protocol/domain/roles";
import { error, json } from "../http/respond.js";
import type { WorkspaceCall } from "../http/router.js";

// Any member, guests included, may see who is in the workspace.
export async function listMembers({ ctx, match }: WorkspaceCall): Promise<Response> {
  const wsId = match[1]!;
  if (!(await isWorkspaceMember(ctx.sql, wsId, ctx.alias))) return error(404, "not found");
  const members = await listWorkspaceMembers(ctx.sql, wsId);
  return json({ members });
}

// The add-people picker: accounts on this node outside the workspace. Only those who
// may add people can search, and a reply carries names, never emails.
export async function listMemberCandidates({ ctx, url, match }: WorkspaceCall): Promise<Response> {
  const wsId = match[1]!;
  const callerRole = await getMemberRole(ctx.sql, wsId, ctx.alias);
  if (callerRole !== "owner" && callerRole !== "admin") {
    return error(403, "only a workspace owner or admin can search for people to add");
  }
  const users = await searchAccounts(ctx.sql, url.searchParams.get("q") ?? "", { outsideWorkspace: wsId });
  return json({ users });
}

// Add someone who already has an account on this node: picked by alias, or found by
// username (or an unambiguous email or name) across every workspace; invite links cover people who do not.
export async function inviteMember({ ctx, req, match }: WorkspaceCall): Promise<Response> {
  const wsId = match[1]!;
  const callerRole = await getMemberRole(ctx.sql, wsId, ctx.alias);
  if (callerRole !== "owner" && callerRole !== "admin") {
    return error(403, "only a workspace owner or admin can invite members");
  }
  const body = (await req.json().catch(() => ({}))) as { alias?: unknown; username?: unknown; role?: string };
  const picked = typeof body.alias === "string" ? body.alias : "";
  const handle = typeof body.username === "string" ? body.username.trim() : "";
  if (!picked && !handle) return error(400, "username required");
  const role = body.role ?? "member";
  if (!isWorkspaceRole(role)) return error(400, "invalid role");
  if (!canGrantRole(callerRole, role)) {
    return error(403, "only a workspace owner can grant admin or owner");
  }
  const ws = await getWorkspace(ctx.sql, wsId);
  if (!ws) return error(404, "workspace not found");
  const alias = picked ? ((await userExists(ctx.sql, picked)) ? picked : null) : await getAnyUserAliasByHandle(ctx.sql, handle);
  if (!alias) {
    return error(400, `No account matches ${handle || "that person"}. Send them an invite link instead.`);
  }
  const seat = await addOrPromoteWorkspaceMember(ctx.sql, wsId, alias, role);
  if (!seat) return error(404, "workspace not found");
  // The stored role: an existing member is not promoted.
  return json({ invited: alias, role: seat.role, status: seat.outcome });
}

// An owner may change anyone; an admin only switches members and guests. The last owner stays.
export async function changeMemberRole({ ctx, req, match }: WorkspaceCall): Promise<Response> {
  const wsId = match[1]!;
  const target = match[2]!;
  const callerRole = await getMemberRole(ctx.sql, wsId, ctx.alias);
  if (callerRole !== "owner" && callerRole !== "admin") {
    return error(403, "only a workspace owner or admin can change roles");
  }
  const body = (await req.json().catch(() => ({}))) as { role?: unknown };
  const newRole = body.role;
  if (!isWorkspaceRole(newRole)) return error(400, "invalid role");
  const targetRole = await getMemberRole(ctx.sql, wsId, target);
  if (!targetRole) return error(404, "not a member");
  if (callerRole === "admin") {
    const touchable = (r: WorkspaceRole) => r === "member" || r === "guest";
    if (!touchable(targetRole) || !touchable(newRole)) {
      return error(403, "admins can only switch members and guests");
    }
  }
  if (targetRole === "owner" && newRole !== "owner" && (await countWorkspaceOwners(ctx.sql, wsId)) <= 1) {
    return error(400, "a workspace must keep at least one owner");
  }
  const changed = await updateMemberRole(ctx.sql, wsId, target, newRole);
  if (changed === "not_a_member") return error(404, "not a member");
  return json({ alias: target, role: newRole });
}

// Remove a member, or leave. Direct grants on documents survive (they are inert
// without membership), but the person's agent keys in this workspace are revoked:
// a key in a client's config would otherwise resume working on re-invitation.
export async function removeMember({ ctx, match }: WorkspaceCall): Promise<Response> {
  const wsId = match[1]!;
  const target = match[2]!;
  const callerRole = await getMemberRole(ctx.sql, wsId, ctx.alias);
  const self = target === ctx.alias;
  if (!self && callerRole !== "owner" && callerRole !== "admin") {
    return error(403, "only a workspace owner or admin can remove members");
  }
  const targetRole = await getMemberRole(ctx.sql, wsId, target);
  if (!targetRole) return error(404, "not a member");
  if (!self && callerRole === "admin" && (targetRole === "admin" || targetRole === "owner")) {
    return error(403, "admins cannot remove admins or owners");
  }
  if (targetRole === "owner" && (await countWorkspaceOwners(ctx.sql, wsId)) <= 1) {
    return error(400, "a workspace must keep at least one owner");
  }
  await removeWorkspaceMember(ctx.sql, wsId, target);
  // After the removal, so a failed removal never cuts off a member's agents.
  const orphaned = await revokeWorkspaceApiKeysForOwner(ctx.sql, wsId, target, ctx.alias);
  return json({ removed: target, keys_revoked: orphaned.length });
}
