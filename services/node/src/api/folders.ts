/** `/api/folders`: the folder tree. */
import { type OwnGrants, materializeAcl } from "@stuga/auth";
import {
  type FolderRow,
  createFolder,
  deleteFolderCascade,
  folderEffectiveAcl,
  getFolderAncestors,
  getFolderContentCounts,
  listFolders,
  setFolderAcl,
  updateFolder,
} from "@stuga/db";
import { recordAudit } from "../audit/record.js";
import { canWriteFolder, guestForbidden, manages, scopeFolderIds } from "../authz/authz.js";
import { docOwnership } from "../authz/ownership.js";
import { agentInstructionsError, authorizedFolder, recordItemChange, reflattenFolderSubtree } from "../documents/access.js";
import { visibilityFloor } from "../documents/create.js";
import { folderInstructionStack, inheritedLevels } from "../documents/instructions.js";
import { error, json } from "../http/respond.js";
import type { WorkspaceCall } from "../http/router.js";
import { newId } from "../ids.js";
import { folderSummary } from "./summaries.js";

export async function listFolderChildren({ ctx, url }: WorkspaceCall): Promise<Response> {
  // ?parent_id=<id> for a folder's children, ?parent_id= (empty) for the root; absent for all.
  const parentId = url.searchParams.has("parent_id")
    ? url.searchParams.get("parent_id") || null
    : undefined;
  const rawFolderSort = url.searchParams.get("sort");
  const folders = await listFolders(ctx.sql, ctx.principals, ctx.workspaceId, parentId, {
    // A doc-only sort key from the shared control falls back to title.
    sort: rawFolderSort === "updated_at" ? "updated_at" : "title",
    order: url.searchParams.get("order") === "desc" ? "desc" : "asc",
    scopeFolderIds: scopeFolderIds(ctx),
  });
  return json({ folders: folders.map(folderSummary) });
}

export async function createFolderRoute({ ctx, req }: WorkspaceCall): Promise<Response> {
  const g = guestForbidden(ctx);
  if (g) return g;
  const body = (await req.json().catch(() => ({}))) as { title?: string; parent_id?: string; agent_instructions?: unknown };
  const instructionsError = agentInstructionsError(body.agent_instructions);
  if (instructionsError) return instructionsError;
  const instructions = typeof body.agent_instructions === "string" ? body.agent_instructions : "";
  let parent: FolderRow | null = null;
  if (body.parent_id != null) {
    if (typeof body.parent_id !== "string" || !body.parent_id) {
      return error(400, "invalid parent_id");
    }
    parent = await authorizedFolder(ctx, body.parent_id);
    if (!parent) return error(404, "parent folder not found");
    if (!canWriteFolder(ctx, parent)) {
      return error(403, "view-only access to the parent folder");
    }
  }
  // A scoped key could not read back a folder created at the root.
  if (ctx.scope?.folders && !parent) {
    return error(403, "this key is scoped to folders — pass parent_id to create inside one of them");
  }
  // Owned by the human behind a key, like a document; an agent-owned root folder would be invisible to every human.
  const ownership = await docOwnership(ctx);
  const floor = await visibilityFloor(ctx);
  const own: OwnGrants = {
    p: [...new Set([...ownership.ownGrants.p, ...floor.p])],
    w: [...new Set([...ownership.ownGrants.w, ...floor.w])],
    c: [],
  };
  const effective = materializeAcl(
    ownership.owner,
    own,
    parent ? { principals: parent.acl_principals, writers: parent.acl_writers } : null,
    true,
  );
  const title = typeof body.title === "string" ? body.title.trim().slice(0, 200) : "";
  const folder = await createFolder(ctx.sql, {
    folderId: newId("f_"),
    workspaceId: ctx.workspaceId,
    owner: ownership.owner,
    title: title || "New folder",
    parentId: parent?.folder_id ?? null,
    aclPrincipals: effective.principals,
    aclWriters: effective.writers,
    inheritsPerms: true,
    ownGrants: own,
    agentInstructions: instructions,
  });
  recordAudit(ctx, {
    action: "folder.create",
    targetKind: "folder",
    targetId: folder.folder_id,
    targetLabel: folder.title,
    // The ledger keeps the size of the instructions, never their text.
    detail: { parent_id: folder.parent_id, ...(folder.agent_instructions ? { instruction_chars: folder.agent_instructions.length } : {}) },
  });
  return json(folderSummary(folder), { status: 201 });
}

// Breadcrumb ancestors (root→self), as summaries: an ancestor the caller cannot open gives away no grants or instructions.
export async function listFolderAncestors({ ctx, match }: WorkspaceCall): Promise<Response> {
  const folderId = match[1]!;
  if (!(await authorizedFolder(ctx, folderId))) return error(404, "not found");
  const ancestors = await getFolderAncestors(ctx.sql, folderId, ctx.workspaceId);
  return json({ ancestors: ancestors.map(folderSummary) });
}

/**
 * The folder's own instructions for agents as stored, and the levels above it
 * this caller can read, outermost first. Any reader may ask, agents included.
 */
export async function getFolderInstructions({ ctx, match }: WorkspaceCall): Promise<Response> {
  const folder = await authorizedFolder(ctx, match[1]!);
  if (!folder) return error(404, "not found");
  const inherited = inheritedLevels(await folderInstructionStack(ctx, folder.folder_id), folder.folder_id);
  return json({ own: folder.agent_instructions, inherited, can_edit: manages(ctx, folder) });
}

/**
 * What a folder made here would inherit: the stack of the parent it goes in,
 * its own level included, or the workspace's alone at the top level. The New
 * folder dialog shows it beside the text being written, so nobody repeats a
 * convention that already applies.
 */
export async function getPlacementInstructions({ ctx, url }: WorkspaceCall): Promise<Response> {
  const parentId = url.searchParams.get("parent_id") || null;
  if (parentId && !(await authorizedFolder(ctx, parentId))) return error(404, "not found");
  return json({ inherited: await folderInstructionStack(ctx, parentId) });
}

// What a delete would sweep up, for the confirmation dialog.
export async function getFolderContents({ ctx, match }: WorkspaceCall): Promise<Response> {
  const folderId = match[1]!;
  if (!(await authorizedFolder(ctx, folderId))) return error(404, "not found");
  return json(await getFolderContentCounts(ctx.sql, folderId, ctx.workspaceId));
}

// Rename, move and instructions for agents: owner or workspace admin only.
export async function updateFolderRoute({ ctx, req, match }: WorkspaceCall): Promise<Response> {
  const folderId = match[1]!;
  const folder = await authorizedFolder(ctx, folderId);
  if (!folder) return error(404, "not found");
  if (!manages(ctx, folder)) return error(403, "only the owner or a workspace admin can change this folder");
  const body = (await req.json().catch(() => ({}))) as { title?: string; parent_id?: string | null; agent_instructions?: unknown };
  const instructionsError = agentInstructionsError(body.agent_instructions);
  if (instructionsError) return instructionsError;
  if (body.parent_id) {
    const ancestors = await getFolderAncestors(ctx.sql, body.parent_id, ctx.workspaceId);
    if (body.parent_id === folderId || ancestors.some((a) => a.folder_id === folderId)) {
      return error(400, "cannot move a folder into itself or its descendant");
    }
    // The destination must be writable by the caller, in this workspace.
    const dest = await authorizedFolder(ctx, body.parent_id);
    if (!dest) return error(404, "destination folder not found");
    if (!canWriteFolder(ctx, dest)) return error(403, "view-only access to the destination folder");
  }
  const movingFolder = body.parent_id !== undefined && body.parent_id !== folder.parent_id;
  const agentInstructions = typeof body.agent_instructions === "string" ? body.agent_instructions : undefined;
  const updated = await updateFolder(ctx.sql, folderId, { title: body.title, parentId: body.parent_id, agentInstructions });
  // A move recomputes the folder's inherited grants against its new parent, then its subtree's.
  if (updated && movingFolder && updated.inherits_perms) {
    const parentEff =
      body.parent_id != null ? await folderEffectiveAcl(ctx.sql, body.parent_id, ctx.workspaceId) : null;
    const own = updated.own_grants;
    const eff = materializeAcl(updated.owner, own, parentEff, updated.inherits_perms);
    await setFolderAcl(ctx.sql, folderId, eff.principals, eff.writers, updated.inherits_perms, own);
    await reflattenFolderSubtree(ctx, folderId);
  }
  if (!updated) return error(404, "not found");
  // Compares title and parent only, so a change to the instructions alone records no rename or move.
  recordItemChange(ctx, "folder", folder, updated, folderId);
  // Sizes only, never the text.
  if (agentInstructions !== undefined && agentInstructions !== folder.agent_instructions) {
    recordAudit(ctx, {
      action: "folder.agent_instructions",
      targetKind: "folder",
      targetId: folderId,
      targetLabel: updated.title,
      detail: { chars: agentInstructions.length, from_chars: folder.agent_instructions.length },
    });
  }
  return json(folderSummary(updated));
}

// Delete a folder and its subtree; the documents inside go to the trash. Only
// the root folder's management is checked.
export async function deleteFolderRoute({ ctx, match }: WorkspaceCall): Promise<Response> {
  const folderId = match[1]!;
  const folder = await authorizedFolder(ctx, folderId);
  if (!folder) return error(404, "not found");
  if (!manages(ctx, folder)) return error(403, "only the owner or a workspace admin can delete this folder");
  const { folderIds, trashedDocIds } = await deleteFolderCascade(ctx.sql, folderId, ctx.workspaceId);
  recordAudit(ctx, {
    action: "folder.delete",
    targetKind: "folder",
    targetId: folderId,
    targetLabel: folder.title,
    detail: { folders: folderIds.length, docs_trashed: trashedDocIds.length },
  });
  // No jobs: searches filter trashed rows live, and snapshot GC is the trash purge's.
  return json({ deleted: true, folders: folderIds.length, docs_trashed: trashedDocIds.length });
}
