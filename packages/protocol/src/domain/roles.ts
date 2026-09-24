/**
 * Role vocabularies. Workspace roles (standing in a tenant) and share roles
 * (capability on one document) are separate axes and never compared. Node
 * administration is membership in node_admins, not a role here.
 */

/** Standing inside one workspace. */
export type WorkspaceRole = "owner" | "admin" | "member" | "guest";

/**
 * Seniority. A guest's isolation comes from not holding `org:<wid>` in its
 * principal set, not from a rank comparison.
 */
const RANK: Record<WorkspaceRole, number> = { owner: 3, admin: 2, member: 1, guest: 0 };

export function isWorkspaceRole(v: unknown): v is WorkspaceRole {
  return typeof v === "string" && Object.hasOwn(RANK, v);
}

/** True when `role` is at least as senior as `min`. */
export function atLeast(role: WorkspaceRole, min: WorkspaceRole): boolean {
  return RANK[role] >= RANK[min];
}

/** Only an owner may grant owner or admin; an admin minting admins would be a self-escalation ladder. */
export function canGrantRole(callerRole: WorkspaceRole, granted: WorkspaceRole): boolean {
  if (granted === "owner" || granted === "admin") return callerRole === "owner";
  return atLeast(callerRole, "admin");
}

/** Roles an invite may carry. Ownership is never handed out by a link. */
export type InviteRole = Exclude<WorkspaceRole, "owner">;

export const INVITE_ROLES: readonly InviteRole[] = ["admin", "member", "guest"];

export function isInviteRole(v: unknown): v is InviteRole {
  return typeof v === "string" && (INVITE_ROLES as readonly string[]).includes(v);
}

/** What a share link or per-person grant lets you do to one document. */
export type ShareRole = "viewer" | "commenter" | "editor";

export const SHARE_ROLES: readonly ShareRole[] = ["viewer", "commenter", "editor"];

export function isShareRole(v: unknown): v is ShareRole {
  return typeof v === "string" && (SHARE_ROLES as readonly string[]).includes(v);
}
