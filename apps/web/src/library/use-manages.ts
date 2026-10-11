/**
 * Whether the person may change an item for everyone (its sharing, lock, search visibility and how
 * AI edits land): its owner, or an owner or admin of the workspace. The server decides; this only
 * keeps controls that would be refused from looking live.
 */
import { useCallback } from "react";
import { getAlias } from "../lib/http/client";
import { useWorkspaceRole } from "../state/workspace-role";

/** `(owner) => boolean` for the active workspace; false for everything not owned until the role is known. */
export function useManages(): (owner: string) => boolean {
  const role = useWorkspaceRole();
  const isAdmin = role === "owner" || role === "admin";
  return useCallback((owner: string) => isAdmin || owner === `user:${getAlias()}`, [isAdmin]);
}
