/** `/api/folders`: the folder tree. */
import { type OwnGrants, materializeAcl, userPrincipal } from "@stuga/auth";
import {
  type FolderRow,
  clampMovedReviewLevels,
  createFolder,
  deleteFolderCascade,
  folderEffectiveAcl,
  getFolder,
  getFolderAncestors,
  getFolderContentCounts,
  listFolders,
  listGroups,
  setFolderAcl,
  setFolderReview,
  updateFolder,
  waitingRunsIn,
} from "@stuga/db";
import { isReviewMode } from "@stuga/protocol/domain/events";
import { recordAudit } from "../audit/record.js";
import { canReadFolder, canWriteFolder, guestForbidden, isWorkspaceAdmin, manages, scopeFolderIds } from "../authz/authz.js";
import { folderReviewChain } from "../authz/review-mode.js";
import { docOwnership } from "../authz/ownership.js";
import { agentInstructionsError, authorizedFolder, pushTrashState, recordItemChange, reflattenFolderSubtree } from "../documents/access.js";
import { visibilityFloor } from "../documents/create.js";
import { folderInstructionStack, inheritedLevels } from "../documents/instructions.js";
import {
  type LevelChange,
  type LevelTarget,
  type MovePlan,
  folderLevelTarget,
  notifyRegrouped,
  planLevelChange,
  planMove,
  recordClampedLevels,
  recordLevelChange,
  recordMove,
} from "../documents/review-level.js";
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
  const floor = await visibilityFloor(ctx, parent);
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

/** The ids alone, which keep the breadcrumb's shape; the summary's other fields are null. */
function redactedAncestor(row: FolderRow) {
  return {
    folder_id: row.folder_id,
    parent_id: row.parent_id,
    title: null,
    owner: null,
    created_at: null,
    updated_at: null,
    agent_mode: null,
    agent_mode_floor: null,
    agent_mode_floors: null,
    approver_group: null,
  };
}

// Breadcrumb ancestors (root→self). Someone shared only a subfolder learns nothing about the folders
// above it but their ids: an ancestor the caller cannot read, key scope included, is redacted.
export async function listFolderAncestors({ ctx, match }: WorkspaceCall): Promise<Response> {
  const folderId = match[1]!;
  if (!(await authorizedFolder(ctx, folderId))) return error(404, "not found");
  const ancestors = await getFolderAncestors(ctx.sql, folderId, ctx.workspaceId);
  return json({ ancestors: ancestors.map((f) => (canReadFolder(ctx, f) ? folderSummary(f) : redactedAncestor(f))) });
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

// Rename, move, instructions for agents, review level and approver group: owner or workspace admin
// only, but for a review level below the folder above's, which that folder's owner may also set. A
// move and a level in one request are checked together: the level as set at the folder's new place.
export async function updateFolderRoute({ ctx, req, match }: WorkspaceCall): Promise<Response> {
  const folderId = match[1]!;
  const folder = await authorizedFolder(ctx, folderId);
  if (!folder) return error(404, "not found");
  const body = (await req.json().catch(() => ({}))) as {
    title?: string;
    parent_id?: string | null;
    agent_instructions?: unknown;
    agent_mode?: unknown;
    approver_group?: unknown;
  };
  const managed = manages(ctx, folder);
  // A level alone may also come from the owner of the folder above; an agent changes none of it.
  const levelOnly = !ctx.isAgent && body.agent_mode !== undefined && Object.keys(body).every((k) => k === "agent_mode");
  if (!managed && !levelOnly) return error(403, "only the owner or a workspace admin can change this folder");
  const instructionsError = agentInstructionsError(body.agent_instructions);
  if (instructionsError) return instructionsError;
  if (body.agent_mode !== undefined && !isReviewMode(body.agent_mode)) return error(400, "agent_mode must be auto | review | colleague");
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
  const parentAfter = movingFolder ? (body.parent_id ?? null) : folder.parent_id;
  // A move must not review AI edits to what it moves more loosely than the folders it leaves allow.
  let movePlan: MovePlan | null = null;
  if (movingFolder) {
    const planned = await planMove(ctx, { kind: "folder", folder }, parentAfter);
    if (planned instanceof Response) return planned;
    movePlan = planned;
  }
  // A group of this workspace, by its principal; null for anyone else who can edit.
  let approverGroup: string | null | undefined;
  if (body.approver_group !== undefined) {
    if (body.approver_group !== null && (typeof body.approver_group !== "string" || !body.approver_group)) {
      return error(400, "approver_group must be a group or null");
    }
    if (typeof body.approver_group === "string") {
      const principal = body.approver_group.startsWith("group:") ? body.approver_group : `group:${body.approver_group}`;
      if (!(await listGroups(ctx.sql, ctx.workspaceId)).some((g) => g.group_id === principal)) return error(404, "group not found");
      approverGroup = principal;
    } else {
      approverGroup = null;
    }
    // Beneath a folder that names a group, naming another is that folder's owner's call, or an admin's;
    // clearing it follows that folder's again.
    if (approverGroup !== null && approverGroup !== folder.approver_group) {
      const above = (await folderReviewChain(ctx.sql, parentAfter, ctx.workspaceId)).groupFolder;
      if (above && !isWorkspaceAdmin(ctx) && above.owner !== userPrincipal(ctx.alias)) {
        return error(403, "only the owner of the folder that names the approver group, or a workspace admin, can name another beneath it");
      }
    }
  }
  const regrouped = approverGroup !== undefined && approverGroup !== folder.approver_group;
  // The level as it would be at the folder's place after the move, its own looser one left behind.
  const levelTarget: LevelTarget = movePlan
    ? { ...folderLevelTarget(ctx, folder), parentId: parentAfter, current: movePlan.after }
    : folderLevelTarget(ctx, folder);
  let level: LevelChange | null = null;
  if (isReviewMode(body.agent_mode) && body.agent_mode !== levelTarget.current) {
    const planned = await planLevelChange(ctx, levelTarget, body.agent_mode);
    if (planned instanceof Response) return planned;
    level = planned;
  }
  // The runs waiting beneath it, with the group each followed, to tell whoever may approve them once it changes.
  const waitingBefore = regrouped || movingFolder ? await waitingRunsIn(ctx.sql, { folderId }, ctx.workspaceId) : [];
  const agentInstructions = typeof body.agent_instructions === "string" ? body.agent_instructions : undefined;
  let updated = await updateFolder(ctx.sql, folderId, { title: body.title, parentId: body.parent_id, agentInstructions });
  // A move recomputes the folder's inherited grants against its new parent, then its subtree's.
  if (updated && movingFolder && updated.inherits_perms) {
    const parentEff =
      body.parent_id != null ? await folderEffectiveAcl(ctx.sql, body.parent_id, ctx.workspaceId) : null;
    const own = updated.own_grants;
    const eff = materializeAcl(updated.owner, own, parentEff, updated.inherits_perms);
    await setFolderAcl(ctx.sql, folderId, eff.principals, eff.writers, updated.inherits_perms, own);
    await reflattenFolderSubtree(ctx, folderId);
  }
  // Levels set below the old place's were exceptions for that place: they do not travel.
  if (updated && movingFolder) {
    const clamped = await clampMovedReviewLevels(ctx.sql, { kind: "folder", id: folderId }, ctx.workspaceId);
    recordClampedLevels(ctx, clamped);
    if (movePlan) await recordMove(ctx, movePlan);
  }
  if (updated && (level || regrouped)) {
    await setFolderReview(ctx.sql, folderId, {
      ...(level ? { agentMode: level.own } : {}),
      ...(approverGroup !== undefined ? { approverGroup } : {}),
    });
    if (level && isReviewMode(body.agent_mode)) await recordLevelChange(ctx, levelTarget, body.agent_mode, level);
    if (regrouped) {
      recordAudit(ctx, {
        action: "folder.approver_group",
        targetKind: "folder",
        targetId: folderId,
        targetLabel: updated.title,
        detail: { group: approverGroup, from: folder.approver_group },
      });
    }
  }
  if (updated && (regrouped || movingFolder)) await notifyRegrouped(ctx, { folderId }, waitingBefore);
  // Read again once everything is written: a move or a level changes what it reads.
  if (updated && (movingFolder || level || regrouped)) updated = (await getFolder(ctx.sql, folderId)) ?? updated;
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

// Delete a folder and its subtree; every document inside goes to the trash, or
// nothing happens while one of them is locked. Only the root folder's management
// is checked.
export async function deleteFolderRoute({ ctx, match }: WorkspaceCall): Promise<Response> {
  const folderId = match[1]!;
  const folder = await authorizedFolder(ctx, folderId);
  if (!folder) return error(404, "not found");
  if (!manages(ctx, folder)) return error(403, "only the owner or a workspace admin can delete this folder");
  const { folderIds, trashedDocIds, trashedDocs, locked } = await deleteFolderCascade(ctx.sql, folderId, ctx.workspaceId);
  if (locked > 0) return error(423, "this folder holds a locked document; unlock it to delete the folder");
  recordAudit(ctx, {
    action: "folder.delete",
    targetKind: "folder",
    targetId: folderId,
    targetLabel: folder.title,
    detail: { folders: folderIds.length, docs_trashed: trashedDocIds.length },
  });
  // Open pages hear at once that they went into the trash.
  for (const d of trashedDocs) await pushTrashState(ctx.env, d.doc_id, true, d.doc_type);
  // No jobs: searches filter trashed rows live, and snapshot GC is the trash purge's.
  return json({ deleted: true, folders: folderIds.length, docs_trashed: trashedDocIds.length });
}
