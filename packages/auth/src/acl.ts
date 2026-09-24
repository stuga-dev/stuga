/**
 * Principals and ACL materialization. A principal is a namespaced string
 * (`user:alice`, `agent:k1`, `group:eng`, `org:<workspaceId>`); access is the
 * intersection of a resource's ACL array and the caller's principal set.
 */
import { atLeast, type WorkspaceRole } from "@stuga/protocol/domain/roles";

/** "Everyone in this workspace". Scoped per workspace; there is no global org principal. */
export function orgPrincipal(workspaceId: string): string {
  return `org:${workspaceId}`;
}

export function userPrincipal(alias: string): string {
  return `user:${alias}`;
}

/** An agent's principal set is only this: no org principal, no groups. */
export function agentPrincipal(agentId: string): string {
  return `agent:${agentId}`;
}

/** `user:alice` → `alice`. */
export function principalId(principal: string): string {
  return principal.slice(principal.indexOf(":") + 1);
}

/**
 * A human's principal set in one workspace: their user principal, their
 * workspace group ids, and `org:<wid>` unless they are a guest. Withholding the
 * org principal is the whole guest isolation mechanism. Provider group claims
 * are never principals: they are global, Stuga groups are per workspace.
 */
export function principalsFrom(
  alias: string,
  workspaceId: string,
  role: WorkspaceRole,
  groupIds: string[],
): string[] {
  const set = new Set<string>([userPrincipal(alias)]);
  if (atLeast(role, "member")) set.add(orgPrincipal(workspaceId));
  for (const id of groupIds) set.add(id);
  return [...set];
}

export function hasAccess(docAclPrincipals: string[], searcherPrincipals: string[]): boolean {
  const search = new Set(searcherPrincipals);
  for (const p of docAclPrincipals) if (search.has(p)) return true;
  return false;
}

/** Writers and granted commenters may comment. */
export function hasCommentAccess(
  aclWriters: string[],
  aclCommenters: string[],
  searcherPrincipals: string[],
): boolean {
  return hasAccess(aclWriters, searcherPrincipals) || hasAccess(aclCommenters, searcherPrincipals);
}

/**
 * The grants as written plus the owner (a full principal). A `group:` grant
 * stays the group principal and is never expanded to member aliases, so access
 * ends with the membership.
 */
export function flattenAcl(owner: string, grants: string[]): string[] {
  const out = new Set<string>([owner]);
  for (const g of grants) out.add(g);
  return [...out];
}

/**
 * Grants set directly on a resource (docs/folders.own_grants), kept so the
 * effective arrays can be re-materialized after a folder change or a move.
 * p = readers, w = writers, c = commenters.
 */
export interface OwnGrants {
  p: string[];
  w: string[];
  c: string[];
}

interface EffectiveAcl {
  principals: string[];
  writers: string[];
  commenters: string[];
}

/**
 * A resource's effective ACL from its own grants and, when it inherits, its
 * parent folder's effective readers and writers. Inheritance only adds.
 * Writers and commenters can always read, a writer is never merely a commenter,
 * and the owner is a reader and writer.
 */
export function materializeAcl(
  owner: string,
  own: OwnGrants,
  parent: { principals: string[]; writers: string[] } | null,
  inherits: boolean,
): EffectiveAcl {
  const readers = new Set(flattenAcl(owner, own.p));
  const writers = new Set(flattenAcl(owner, own.w));
  const commenters = new Set<string>(own.c);
  if (inherits && parent) {
    for (const p of parent.principals) readers.add(p);
    for (const w of parent.writers) writers.add(w);
  }
  for (const w of writers) readers.add(w);
  for (const c of commenters) readers.add(c);
  for (const w of writers) commenters.delete(w);
  return { principals: [...readers], writers: [...writers], commenters: [...commenters] };
}
