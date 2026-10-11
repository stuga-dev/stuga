/**
 * Why the person landed where they did, carried across the full-page redirect
 * that took them there: a sign-in that ended, or a membership that did. Kept in
 * this tab only, and read by the page they land on.
 */
import { readStored, removeStored, writeStored } from "../storage";
import { getActiveWorkspace, setActiveWorkspace, workspaceName } from "./workspace-pointer";

const SESSION_ENDED_KEY = "stuga_session_ended";
const MEMBERSHIP_ENDED_KEY = "stuga_membership_ended";

/** The sign-in ended under this page (expired, or signed out elsewhere). */
export function noteSessionEnded(): void {
  writeStored("session", SESSION_ENDED_KEY, "1");
}

export function sessionEnded(): boolean {
  return readStored("session", SESSION_ENDED_KEY) === "1";
}

export function clearSessionEnded(): void {
  removeStored("session", SESSION_ENDED_KEY);
}

/**
 * The person is no longer a member of the active workspace; its name is kept for the page that
 * says so. A later note that no longer knows the name keeps the one already held. With no active
 * workspace nothing ended: a new account has simply not joined one yet.
 */
export function noteMembershipEnded(): void {
  const active = getActiveWorkspace();
  if (!active) return;
  const name = workspaceName(active) ?? "";
  if (!name && membershipEnded() !== null) return;
  writeStored("session", MEMBERSHIP_ENDED_KEY, name);
}

/** The name of the workspace the membership ended in, "" when unknown, or null when none ended. */
export function membershipEnded(): string | null {
  return readStored("session", MEMBERSHIP_ENDED_KEY);
}

export function clearMembershipEnded(): void {
  removeStored("session", MEMBERSHIP_ENDED_KEY);
}

/**
 * Adopt the node's word on which workspace is active, "none" included: a stale id from another account
 * must not keep riding x-stuga-workspace. When the workspace this browser had open is gone from a list
 * now empty, the person was removed (perhaps while away, or before a reload): that is noted first,
 * while its name is still known, for the page they land on to say so.
 */
export function adoptActiveWorkspace(active: string | null, memberships: number): void {
  const stored = getActiveWorkspace();
  if (stored === active) return;
  if (memberships === 0 && stored) noteMembershipEnded();
  setActiveWorkspace(active);
}
