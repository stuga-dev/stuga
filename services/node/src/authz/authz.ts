/** The authorization predicates: one definition of each rule about who may do what. */
import { atLeast } from "@stuga/protocol/domain/roles";
import { getCollection, isNodeAdminAlias, type DocRow, type FolderRow } from "@stuga/db";
import { hasAccess, hasCommentAccess, userPrincipal } from "@stuga/auth";
import { error } from "../http/respond.js";
import type { AccountCtx, Ctx } from "../auth/context.js";

/**
 * May this caller manage a resource's sharing, ownership, lock, trash, permanent
 * delete, version restore and search visibility? Its owner, or a workspace
 * owner/admin. Agents never manage, even what they own: a key is consent to
 * read and edit, not to change who can see a document.
 */
export function manages(ctx: Ctx, resource: { owner: string }): boolean {
  if (ctx.isAgent) return false;
  if (resource.owner === userPrincipal(ctx.alias)) return true;
  return atLeast(ctx.role, "admin");
}

/** Workspace-wide administration: `manages` without the owner clause. */
export function isWorkspaceAdmin(ctx: Ctx): boolean {
  return !ctx.isAgent && atLeast(ctx.role, "admin");
}

/**
 * The 403 for a guest, who may read and comment on what is shared with them but
 * not create content or browse the directory; null otherwise. `what` completes
 * "guests cannot …".
 */
export function guestForbidden(ctx: Ctx, what = "perform this action in this workspace"): Response | null {
  if (ctx.role === "guest") return error(403, `guests cannot ${what}`);
  return null;
}

/**
 * May this caller administer the node? The `node_admins` table is the one
 * roster: the first account and whoever an administrator appoints; a
 * locked-out administrator gets back in with `stuga-node reset-password`. Never an agent.
 */
export async function isNodeAdmin(ctx: AccountCtx): Promise<boolean> {
  if (ctx.isAgent) return false;
  return isNodeAdminAlias(ctx.sql, ctx.alias);
}

/** The 403 for a caller who is not a node administrator, or null. */
export async function nodeAdminRequired(ctx: AccountCtx): Promise<Response | null> {
  if (await isNodeAdmin(ctx)) return null;
  return error(403, "only a node administrator can do this");
}

/** The one sentence a read-only key sees when it tries to write. */
export const READ_ONLY_MESSAGE = "this key is read-only: it can read and search, but not change anything";

/**
 * Is a document at `parentId` inside the caller's key scope? Unscoped callers
 * reach everything; a scoped key only documents directly in one of its expanded
 * folders, never the root.
 */
export function inScope(ctx: AccountCtx, parentId: string | null): boolean {
  const folders = ctx.scope?.folders;
  if (!folders) return true;
  return parentId !== null && folders.includes(parentId);
}

function folderInScope(ctx: AccountCtx, folderId: string): boolean {
  const folders = ctx.scope?.folders;
  if (!folders) return true;
  return folders.includes(folderId);
}

/** The read predicate every document surface applies: tenant, ACL and key scope together. */
export function canReadDoc(ctx: Ctx, doc: DocRow): boolean {
  return doc.workspace_id === ctx.workspaceId && hasAccess(doc.acl_principals, ctx.principals) && inScope(ctx, doc.parent_id);
}

/** Read plus the writer tier, and never for a read-only key. */
export function canWriteDoc(ctx: Ctx, doc: DocRow): boolean {
  return canReadDoc(ctx, doc) && hasAccess(doc.acl_writers, ctx.principals) && !ctx.scope?.readOnly;
}

/** Writers and explicitly granted commenters may comment; a read-only key may not. */
export function canCommentDoc(ctx: Ctx, doc: DocRow): boolean {
  return (
    canReadDoc(ctx, doc) &&
    hasCommentAccess(doc.acl_writers, doc.acl_commenters, ctx.principals) &&
    !ctx.scope?.readOnly
  );
}

export function canReadFolder(ctx: Ctx, folder: FolderRow): boolean {
  return (
    folder.workspace_id === ctx.workspaceId &&
    hasAccess(folder.acl_principals, ctx.principals) &&
    folderInScope(ctx, folder.folder_id)
  );
}

export function canWriteFolder(ctx: Ctx, folder: FolderRow): boolean {
  return canReadFolder(ctx, folder) && hasAccess(folder.acl_writers, ctx.principals) && !ctx.scope?.readOnly;
}

/** The folder filter listing queries take: the scoped set, or null for none. */
export function scopeFolderIds(ctx: AccountCtx): string[] | null {
  return ctx.scope?.folders ?? null;
}

/** The person a credential acts for: the caller, or the human who minted an agent's key. */
export function personOf(ctx: AccountCtx): string {
  return ctx.isAgent ? ctx.onBehalfOf : ctx.alias;
}

/**
 * The collection when it belongs to the caller's person in the active workspace,
 * or null. A person and every agent acting for them share one set of collections.
 */
export async function ownedCollection(ctx: Ctx, collectionId: string) {
  const collection = await getCollection(ctx.sql, collectionId);
  if (!collection) return null;
  if (collection.workspace_id !== ctx.workspaceId) return null;
  if (collection.owner !== personOf(ctx)) return null;
  return collection;
}
