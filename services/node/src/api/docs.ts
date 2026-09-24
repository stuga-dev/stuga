/** `/api/docs` and `/api/docs/:id`: list, create, read, rename/move/trash, settings and delete documents. */
import { principalId } from "@stuga/auth";
import {
  type DocSortKey,
  type SortOrder,
  clearDocChunks,
  deleteDoc,
  folderEffectiveAcl,
  getDoc,
  listDocs,
  setDocAgentInstructions,
  setDocAgentMode,
  setDocLocked,
  setDocSearchHidden,
  updateDoc,
} from "@stuga/db";
import { isReviewMode } from "@stuga/protocol/domain/events";
import { databaseDocMessage, readDocMarkdownWithProjection } from "../agents/edits.js";
import { recordAudit, recordEvent } from "../audit/record.js";
import { canReadDoc, canWriteDoc, canWriteFolder, manages, scopeFolderIds } from "../authz/authz.js";
import { type ResolvedReview, resolveReviewMode } from "../authz/review-mode.js";
import { pagesTrashedWithDatabase, restoreDatabasePages, trashDatabasePages } from "../databases/row-pages.js";
import {
  agentInstructionsError,
  authorizedDoc,
  authorizedFolder,
  destroyActorStorage,
  itemKind,
  lockedError,
  pushLockState,
  recordItemChange,
  rematerializeDoc,
} from "../documents/access.js";
import { createDocument } from "../documents/create.js";
import { docAgentInstructions, docAgentInstructionsOrNone, docInstructionStack, inheritedLevels } from "../documents/instructions.js";
import { error, json } from "../http/respond.js";
import type { WorkspaceCall } from "../http/router.js";
import { queueSnapshotSweep } from "../jobs/snapshot-sweep.js";
import { docMediaHashes, reclaimDeletedDocImages } from "../media/media-scan.js";
import { docSummary } from "./summaries.js";

function reviewJson(r: ResolvedReview): { mode: string; reason: string } {
  return { mode: r.mode, reason: r.reason };
}

/** ?sort / ?order for a doc listing. An unknown sort key falls back to the default rather than erroring. */
function docSortParams(u: URL): { sort?: DocSortKey; order?: SortOrder } {
  const raw = u.searchParams.get("sort");
  const sort = raw === "title" || raw === "created_at" || raw === "updated_at" ? raw : undefined;
  return { sort, order: u.searchParams.get("order") === "asc" ? "asc" : "desc" };
}

export async function listDocuments({ ctx, url }: WorkspaceCall): Promise<Response> {
  const trashedOnly = url.searchParams.get("trashed_only") === "true";
  const owner = url.searchParams.get("owner") ?? undefined;
  // ?parent_id=<id> for a folder's contents, ?parent_id= (empty) for the root; absent for all.
  const parentId = url.searchParams.has("parent_id")
    ? url.searchParams.get("parent_id") || null
    : undefined;
  // "Shared with me": documents granting the caller directly, wherever they are filed.
  const sharedWith = url.searchParams.get("shared") === "true" && !ctx.isAgent ? ctx.alias : undefined;
  // Row pages are left out unless asked for; the trash includes them so a deleted page can be restored.
  const pagesParam = url.searchParams.get("pages");
  const pages = pagesParam === "include" || pagesParam === "only" ? pagesParam : trashedOnly && pagesParam !== "exclude" ? "include" : "exclude";
  const pageOf = url.searchParams.get("page_of") || undefined;
  const docs = await listDocs(ctx.sql, ctx.principals, ctx.workspaceId, {
    trashedOnly,
    owner,
    parentId: sharedWith ? undefined : parentId,
    sharedWith,
    scopeFolderIds: scopeFolderIds(ctx),
    pages: pageOf ? "only" : pages,
    pageOf,
    ...docSortParams(url),
  });
  return json({ docs: docs.map(docSummary) });
}

export async function createDocumentRoute({ ctx, req }: WorkspaceCall): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const out = await createDocument(ctx, {
    title: body.title,
    docType: body.doc_type,
    parentId: body.parent_id,
    markdown: body.markdown,
    filename: body.filename,
    table: body.table,
    columns: body.columns,
  });
  if (!out.ok) return error(out.status, out.message);
  // An agent learns at once what applies to the document it just made.
  if (!ctx.isAgent) return json(out.doc, { status: 201 });
  // The document exists now: a failed lookup must not read as a failed create, or the agent makes another.
  return json({ ...out.doc, ...(await docAgentInstructionsOrNone(ctx, out.doc)) }, { status: 201 });
}

export async function getDocument({ ctx, match }: WorkspaceCall): Promise<Response> {
  const docId = match[1]!;
  const doc = await authorizedDoc(ctx, docId);
  if (!doc) return error(404, "not found");
  const summary = docSummary(doc);
  // An agent is told whether a write here would wait or land, and what to follow; a human is always the reviewer.
  if (!ctx.isAgent) return json(summary);
  return json({ ...summary, review: reviewJson(resolveReviewMode(ctx, doc)), ...(await docAgentInstructions(ctx, doc)) });
}

export async function updateDocument({ ctx, req, match }: WorkspaceCall): Promise<Response> {
  const docId = match[1]!;
  const pdoc = await authorizedDoc(ctx, docId);
  if (!pdoc) return error(404, "not found");
  // Metadata changes leave no run to review or revert, and a key carries its
  // owner's workspace-wide write grants.
  if (ctx.isAgent) {
    return error(403, "agents cannot rename, move, or trash documents");
  }
  if (!canWriteDoc(ctx, pdoc)) return error(403, "view-only access");
  // The lock freezes all metadata, restoring from the trash included.
  const lk = lockedError(pdoc);
  if (lk) return lk;
  const body = (await req.json().catch(() => ({}))) as { title?: string; trashed?: boolean; parent_id?: string | null };
  // Moving into a folder needs write access to it, in this workspace.
  if (body.parent_id) {
    const dest = await authorizedFolder(ctx, body.parent_id);
    if (!dest) return error(404, "destination folder not found");
    if (!canWriteFolder(ctx, dest)) return error(403, "view-only access to the destination folder");
  }
  const movingFolder = body.parent_id !== undefined && body.parent_id !== pdoc.parent_id;
  // Read before the restore below clears the stamp that links them.
  const pagesToRestore =
    pdoc.doc_type === "database" && body.trashed === false && pdoc.trashed ? await pagesTrashedWithDatabase(ctx, pdoc) : [];
  const updated = await updateDoc(ctx.sql, docId, {
    title: body.title,
    trashed: body.trashed,
    parentId: body.parent_id,
  });
  if (updated && body.trashed === true && !pdoc.trashed) {
    recordEvent(ctx, "doc.trashed", docId, { title: updated.title, doc_type: updated.doc_type });
  }
  if (updated) {
    const trashChange =
      body.trashed === true && !pdoc.trashed ? "trash" : body.trashed === false && pdoc.trashed ? "restore" : undefined;
    recordItemChange(ctx, "doc", pdoc, updated, docId, trashChange);
    // Row pages follow their database into and out of the trash. After the
    // database's own update, so the purge job meets the database first and a
    // failed restore brings no page back.
    if (pdoc.doc_type === "database" && trashChange === "trash") await trashDatabasePages(ctx, updated, "database trashed");
    if (pdoc.doc_type === "database" && trashChange === "restore") await restoreDatabasePages(ctx, updated, pagesToRestore);
  }
  // A move recomputes inherited grants against the new parent; direct grants survive.
  if (updated && movingFolder && updated.inherits_perms) {
    const parentEff =
      body.parent_id != null
        ? await folderEffectiveAcl(ctx.sql, body.parent_id, ctx.workspaceId)
        : null;
    await rematerializeDoc(ctx, updated, parentEff);
  }
  return updated ? json(docSummary(updated)) : error(404, "not found");
}

export async function deleteDocument({ ctx, match }: WorkspaceCall): Promise<Response> {
  const docId = match[1]!;
  const doc = await authorizedDoc(ctx, docId);
  if (!doc) return error(404, "not found");
  if (!manages(ctx, doc)) return error(403, "only the owner or a workspace admin can delete");
  // Read before the row goes: `search_text` is the only copy of the body left afterwards.
  const mediaHashes = doc.doc_type === "prose" ? await docMediaHashes(ctx.sql, docId) : [];
  // Row pages survive in the trash. Before the row delete, whose foreign key would release them as ordinary documents.
  if (doc.doc_type === "database") await trashDatabasePages(ctx, doc, "database deleted");
  await queueSnapshotSweep(ctx.sql, docId);
  await deleteDoc(ctx.sql, docId);
  // Awaited, so the images stop being fetchable when the delete returns.
  const reclaimed = await reclaimDeletedDocImages(ctx.env, ctx.sql, doc.workspace_id, mediaHashes);
  // The actor holds the content. Destroyed after the row delete, so a failed
  // delete never leaves a listed but empty document.
  await destroyActorStorage(ctx.env, docId, doc.doc_type);
  // The only trace left of what was here.
  recordAudit(ctx, {
    action: "doc.delete",
    targetKind: itemKind(doc),
    targetId: docId,
    targetLabel: doc.title,
    detail: { doc_type: doc.doc_type, media_reclaimed: reclaimed },
  });
  return json({ deleted: true, media_reclaimed: reclaimed });
}

// Not behind authorizedDoc, since the caller lacks access; always 202, so the
// answer never discloses whether the document exists.
export async function requestAccess({ ctx, match }: WorkspaceCall): Promise<Response> {
  const docId = match[1]!;
  const doc = await getDoc(ctx.sql, docId);
  if (
    doc &&
    doc.workspace_id === ctx.workspaceId &&
    !canReadDoc(ctx, doc) &&
    doc.owner.startsWith("user:")
  ) {
    await ctx.env.jobs.send({
      kind: "notify",
      recipient: principalId(doc.owner),
      workspaceId: ctx.workspaceId,
      eventType: "REQUEST_ACCESS",
      docId,
      title: `${ctx.displayName || ctx.alias} requested access to "${doc.title || "Untitled"}"`,
      body: "Open the share dialog to grant them access.",
      actor: ctx.alias,
    });
  }
  return json({ requested: true }, { status: 202 });
}

// Live markdown; an agent sees its own pending hunks laid over it, and the instructions that apply.
export async function getMarkdown({ ctx, match }: WorkspaceCall): Promise<Response> {
  const docId = match[1]!;
  const md = await readDocMarkdownWithProjection(ctx, docId);
  if (!md) return error(404, "not found");
  if (md === "database") return error(400, databaseDocMessage(docId));
  const body = { markdown: md.markdown, run_id: md.runId, pending: md.pending };
  if (!ctx.isAgent) return json(body);
  return json({ ...body, ...(await docAgentInstructions(ctx, md.doc)) });
}

/**
 * The document's own instructions for agents as stored, and the levels above it
 * this caller can read, outermost first. Any reader may ask, agents included.
 */
export async function getDocInstructions({ ctx, match }: WorkspaceCall): Promise<Response> {
  const doc = await authorizedDoc(ctx, match[1]!);
  if (!doc) return error(404, "not found");
  const inherited = inheritedLevels(await docInstructionStack(ctx, doc), doc.doc_id);
  return json({ own: doc.agent_instructions, inherited, can_edit: manages(ctx, doc) });
}

// Lock, search visibility, agent mode and instructions for agents: owner or workspace admin only.
export async function updateDocState({ ctx, req, match }: WorkspaceCall): Promise<Response> {
  const docId = match[1]!;
  const doc = await authorizedDoc(ctx, docId);
  if (!doc) return error(404, "not found");
  if (!manages(ctx, doc)) return error(403, "only the owner or a workspace admin can change these settings");
  const body = (await req.json().catch(() => ({}))) as {
    locked?: boolean;
    search_hidden?: boolean;
    agent_mode?: unknown;
    agent_instructions?: unknown;
  };
  // Every field is checked before the first write, so a refused request changes nothing.
  if (body.agent_mode !== undefined && !isReviewMode(body.agent_mode)) {
    return error(400, "agent_mode must be review | auto");
  }
  const instructionsError = agentInstructionsError(body.agent_instructions);
  if (instructionsError) return instructionsError;
  let updated = doc;
  if (typeof body.locked === "boolean" && body.locked !== doc.locked) {
    updated = (await setDocLocked(ctx.sql, docId, body.locked, ctx.alias)) ?? updated;
    // Open editors flip read-only (or writable) at once.
    await pushLockState(ctx.env, docId, body.locked, doc.doc_type);
  }
  if (typeof body.search_hidden === "boolean" && body.search_hidden !== doc.search_hidden) {
    updated = (await setDocSearchHidden(ctx.sql, docId, body.search_hidden)) ?? updated;
    // Hiding clears the chunks now (no flush may be coming); unhiding rebuilds them with a forced reindex.
    if (body.search_hidden) {
      await clearDocChunks(ctx.sql, docId);
    } else {
      await ctx.env.jobs.send({ kind: "index_doc", docId, force: true });
    }
  }
  // No actor push: every propose re-reads the row.
  if (isReviewMode(body.agent_mode) && body.agent_mode !== doc.agent_mode) {
    updated = (await setDocAgentMode(ctx.sql, docId, body.agent_mode)) ?? updated;
    recordAudit(ctx, {
      action: "doc.agent_mode",
      targetKind: itemKind(doc),
      targetId: docId,
      targetLabel: doc.title,
      detail: { mode: body.agent_mode, from: doc.agent_mode },
    });
  }
  // Stored verbatim. Advice read on every agent turn, so no push; the ledger keeps sizes, never the text.
  if (typeof body.agent_instructions === "string" && body.agent_instructions !== doc.agent_instructions) {
    updated = (await setDocAgentInstructions(ctx.sql, docId, body.agent_instructions)) ?? updated;
    recordAudit(ctx, {
      action: "doc.agent_instructions",
      targetKind: itemKind(doc),
      targetId: docId,
      targetLabel: doc.title,
      detail: { chars: body.agent_instructions.length, from_chars: doc.agent_instructions.length },
    });
  }
  return json(docSummary(updated));
}
