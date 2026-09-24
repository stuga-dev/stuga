/** Reading a document or folder in the caller's workspace, and pushing access changes to live sessions. */
import { materializeAcl } from "@stuga/auth";
import {
  type DocRow,
  childInheritingDocs,
  childInheritingFolders,
  folderEffectiveAcl,
  getDoc,
  getFolder,
  setDocAcl,
  setFolderAcl,
} from "@stuga/db";
import { MAX_AGENT_INSTRUCTIONS_CHARS } from "@stuga/protocol/domain/limits";
import { recordAudit } from "../audit/record.js";
import type { Ctx } from "../auth/context.js";
import { canReadDoc, canReadFolder } from "../authz/authz.js";
import type { NodeEnv } from "../env.js";
import { error } from "../http/respond.js";

/** The audit target kind for a document: one spelling per item, so its history stays under one target. */
export function itemKind(doc: { doc_type?: string | null }): "doc" | "database" {
  return doc.doc_type === "database" ? "database" : "doc";
}

/**
 * The ledger row for a rename, move, trash or restore of a document or folder.
 * Trash and restore get their own actions; a rename or move is `.update` with
 * before and after. Nothing is recorded when nothing changed.
 */
export function recordItemChange(
  ctx: Ctx,
  family: "doc" | "folder",
  before: { title: string; parent_id: string | null },
  after: { title: string; parent_id: string | null; doc_type?: string | null },
  targetId: string,
  trashChange?: "trash" | "restore",
): void {
  const kind = family === "folder" ? "folder" : itemKind(after);
  const base = { targetKind: kind, targetId, targetLabel: after.title } as const;
  if (trashChange) {
    recordAudit(ctx, { ...base, action: `${family}.${trashChange}`, detail: {} });
    return;
  }
  const detail: Record<string, unknown> = {};
  if (after.title !== before.title) detail.renamed = { from: before.title, to: after.title };
  if (after.parent_id !== before.parent_id) detail.moved = { from: before.parent_id, to: after.parent_id };
  if (Object.keys(detail).length > 0) recordAudit(ctx, { ...base, action: `${family}.update`, detail });
}

/** A document the caller may read in the active workspace, or null (tenant, ACL and key scope all answer "not found"). */
export async function authorizedDoc(ctx: Ctx, docId: string) {
  const doc = await getDoc(ctx.sql, docId);
  if (!doc || !canReadDoc(ctx, doc)) return null;
  return doc;
}

/**
 * Narrow a doc to the prose pipeline. Routes that address the document actor by
 * id must not reach it with a database id, which would materialize a stray
 * empty document actor under that name.
 */
export function proseOnly(doc: DocRow | null): DocRow | null {
  return doc && doc.doc_type === "prose" ? doc : null;
}

/** A folder the caller may read in the active workspace, or null. */
export async function authorizedFolder(ctx: Ctx, folderId: string) {
  const folder = await getFolder(ctx.sql, folderId);
  if (!folder || !canReadFolder(ctx, folder)) return null;
  return folder;
}

/** The 423 for a locked document, or null. */
export function lockedError(doc: { locked: boolean }): Response | null {
  if (doc.locked) return error(423, "this document is locked; unlock it to make changes");
  return null;
}

/** The 400 for an `agent_instructions` value a workspace, folder or document cannot store, or null (absent included). */
export function agentInstructionsError(value: unknown): Response | null {
  if (value === undefined) return null;
  if (typeof value !== "string") return error(400, "agent_instructions must be text");
  if (value.length > MAX_AGENT_INSTRUCTIONS_CHARS) {
    return error(400, `agent_instructions is too long (max ${MAX_AGENT_INSTRUCTIONS_CHARS} characters)`);
  }
  return null;
}

/**
 * Recompute one document's effective ACL from its own grants and its parent
 * folder's effective sets (null at the root), persist it, and drop live
 * sessions that lost access.
 */
export async function rematerializeDoc(
  ctx: Ctx,
  doc: DocRow,
  parentEff: { principals: string[]; writers: string[] } | null,
): Promise<void> {
  const own = doc.own_grants;
  const eff = materializeAcl(doc.owner, own, parentEff, doc.inherits_perms);
  await setDocAcl(ctx.sql, doc.doc_id, eff.principals, eff.writers, doc.inherits_perms, eff.commenters, own);
  await revokeDocAccess(ctx.env, doc.doc_id, eff.principals, doc.doc_type, eff.writers);
}

/**
 * Cascade a folder-ACL change down its subtree: every inheriting child document,
 * then every inheriting child folder, whose own effective ACL is recomputed
 * before its children. The visited sets stop a corrupt cycle.
 */
export async function reflattenFolderSubtree(
  ctx: Ctx,
  folderId: string,
  visitedFolders: Set<string> = new Set(),
  visitedDocs: Set<string> = new Set(),
): Promise<void> {
  if (visitedFolders.has(folderId)) return;
  visitedFolders.add(folderId);
  const eff = await folderEffectiveAcl(ctx.sql, folderId, ctx.workspaceId);
  const docs = await childInheritingDocs(ctx.sql, folderId, ctx.workspaceId);
  for (const d of docs) {
    if (visitedDocs.has(d.doc_id)) continue;
    visitedDocs.add(d.doc_id);
    await rematerializeDoc(ctx, d, eff);
  }
  const childFolders = await childInheritingFolders(ctx.sql, folderId, ctx.workspaceId);
  for (const cf of childFolders) {
    if (visitedFolders.has(cf.folder_id)) continue;
    const own = cf.own_grants;
    const childEff = materializeAcl(cf.owner, own, eff, cf.inherits_perms);
    await setFolderAcl(ctx.sql, cf.folder_id, childEff.principals, childEff.writers, cf.inherits_perms, own);
    await reflattenFolderSubtree(ctx, cf.folder_id, visitedFolders, visitedDocs);
  }
}

/**
 * Tell a document's actor to drop sessions that lost access. A no-op for a
 * database: it has no document sockets, and every database request re-checks the ACL.
 */
export async function revokeDocAccess(
  env: NodeEnv,
  docId: string,
  allowedPrincipals: string[],
  docType: "prose" | "database",
  writers: string[],
): Promise<void> {
  if (docType !== "prose") return;
  const u = new URL("http://actor/revoke");
  u.searchParams.set("docId", docId);
  for (const p of allowedPrincipals) u.searchParams.append("principal", p);
  // Stated apart from the list, so an empty writer set still demotes every session.
  u.searchParams.set("writersStated", "1");
  for (const w of writers) u.searchParams.append("writer", w);
  try {
    await env.docs.get(docId).fetch(u.toString());
  } catch {
    // Best-effort: every socket upgrade re-checks the ACL.
  }
}

/**
 * Push a document's locked state to its live actor so open sessions flip
 * read-only at once. Best-effort: every write path re-checks `locked`. A
 * database mirrors the lock into its own actor, so an auto-applied proposal
 * cannot land in a table that was just frozen.
 */
export async function pushLockState(env: NodeEnv, docId: string, locked: boolean, docType: "prose" | "database"): Promise<void> {
  if (docType === "database") {
    try {
      await env.databases
        .get(docId)
        .fetch(`http://actor/set-locked?dbId=${encodeURIComponent(docId)}&locked=${locked ? "1" : "0"}`, {
          method: "POST",
        });
    } catch {
      /* best-effort */
    }
    return;
  }
  const u = new URL("http://actor/set-locked");
  u.searchParams.set("docId", docId);
  u.searchParams.set("locked", locked ? "1" : "0");
  try {
    await env.docs.get(docId).fetch(u.toString());
  } catch {
    /* best-effort */
  }
}

/** Drop a deleted item's actor storage. Best-effort: an actor that is already gone has nothing left to drop. */
export async function destroyActorStorage(
  env: Pick<NodeEnv, "docs" | "databases">,
  docId: string,
  docType: "prose" | "database",
): Promise<void> {
  const [actors, idParam] = docType === "database" ? [env.databases, "dbId"] : [env.docs, "docId"];
  await actors
    .get(docId)
    .fetch(`http://actor/destroy?${idParam}=${encodeURIComponent(docId)}`, { method: "POST" })
    .catch(() => {});
}
