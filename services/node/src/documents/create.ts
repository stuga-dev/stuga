/**
 * The one path every new documents row takes: POST /api/docs, the MCP `docs`
 * and `databases` create actions, and the page of a database row. Ownership and
 * access are decided here for every caller: an agent creates FOR the human who
 * minted its key (that human owns it, the agent stays a co-writer), and the
 * caller's extra grants stack on top.
 */
import { type OwnGrants, agentPrincipal, materializeAcl, orgPrincipal, userPrincipal } from "@stuga/auth";
import { type DocRow, type FolderRow, createDoc, deleteDoc, getFolder, getWorkspace, holdChangePage, updateDoc } from "@stuga/db";
import {
  MAX_IMPORT_MARKDOWN_BYTES,
  markdownByteLength,
  normalizeImportedMarkdown,
} from "@stuga/protocol/text/markdown-import";
import { proposeDocEdit, readDocMarkdownWithProjection } from "../agents/edits.js";
import { recordAudit, recordEvent } from "../audit/record.js";
import type { Ctx } from "../auth/context.js";
import { canWriteFolder } from "../authz/authz.js";
import { docOwnership } from "../authz/ownership.js";
import { callDatabaseActor } from "../databases/gate.js";
import { type ColumnSpecInput, parseColumnSpecs } from "../databases/propose.js";
import { newId } from "../ids.js";
import { queueSnapshotSweep } from "../jobs/snapshot-sweep.js";
import { authorizedFolder, destroyActorStorage } from "./access.js";
import { holdPlan } from "../changes/held.js";
import { discardOpened, openChange, resolveChange, type ChangeArgs, type ResolvedChange } from "../changes/resolve.js";

interface OwnedDocInput {
  title: string;
  /** `user`: the title was given as the document's name. */
  titleSource?: "user";
  docType: "prose" | "database";
  /** The folder the document lands in, already authorized by the caller, or null for the root. */
  parent: Pick<FolderRow, "folder_id" | "acl_principals" | "acl_writers"> | null;
  /** Direct grants on top of the creator's own. */
  grants: OwnGrants;
  inheritsPerms: boolean;
  /** For the page of a database row: the database and `<table>.<row>`. */
  page?: { of: string; row: string };
}

function uniq(list: string[]): string[] {
  return [...new Set(list)];
}

/**
 * Insert the row, owned and shared. `own_grants` records the direct grants so a
 * later folder move or share-link redeem can re-flatten the effective arrays.
 */
async function insertOwnedDoc(ctx: Ctx, input: OwnedDocInput): Promise<DocRow> {
  const ownership = await docOwnership(ctx);
  const own: OwnGrants = {
    p: uniq([...ownership.ownGrants.p, ...input.grants.p]),
    w: uniq([...ownership.ownGrants.w, ...input.grants.w]),
    c: uniq([...input.grants.c]),
  };
  const effective = materializeAcl(
    ownership.owner,
    own,
    input.parent ? { principals: input.parent.acl_principals, writers: input.parent.acl_writers } : null,
    input.inheritsPerms,
  );
  return createDoc(ctx.sql, {
    docId: newId(),
    workspaceId: ctx.workspaceId,
    owner: ownership.owner,
    title: input.title,
    ...(input.titleSource ? { titleSource: input.titleSource } : {}),
    docType: input.docType,
    parentId: input.parent?.folder_id ?? null,
    aclPrincipals: effective.principals,
    aclWriters: effective.writers,
    aclCommenters: effective.commenters,
    inheritsPerms: input.inheritsPerms,
    ownGrants: own,
    ...(input.page ? { pageOf: input.page.of, pageRow: input.page.row } : {}),
    // Who made it, as distinct from who owns it; review decisions read agent_mode, not this.
    createdBy: ctx.isAgent ? agentPrincipal(ctx.alias) : userPrincipal(ctx.alias),
    searchLanguages: ctx.env.searchLanguages.current(),
  });
}

/**
 * Record the new document in the event feed and the audit ledger; `detail` adds to the audit row. A
 * new page a change holds is announced in the feed only once it is approved (changes/held.ts).
 */
function announceDoc(ctx: Ctx, doc: DocRow, detail?: Record<string, unknown>, held = false): void {
  if (!held) recordEvent(ctx, "doc.created", doc.doc_id, { title: doc.title, doc_type: doc.doc_type, parent_id: doc.parent_id });
  recordAudit(ctx, {
    action: "doc.create",
    targetKind: doc.doc_type === "database" ? "database" : "doc",
    targetId: doc.doc_id,
    targetLabel: doc.title,
    detail: { doc_type: doc.doc_type, parent_id: doc.parent_id, ...detail },
  });
}

/**
 * Undo a create whose follow-up step failed: queue the snapshot sweep, delete
 * the row, destroy the actor. A row that cannot be deleted keeps its actor.
 */
export async function discardCreatedDoc(ctx: Ctx, doc: Pick<DocRow, "doc_id" | "doc_type">): Promise<void> {
  try {
    await queueSnapshotSweep(ctx.sql, doc.doc_id);
    await deleteDoc(ctx.sql, doc.doc_id);
  } catch {
    return;
  }
  await destroyActorStorage(ctx.env, doc.doc_id, doc.doc_type);
}

export interface CreateProseDocInput {
  title: string;
  /** A folder that no longer exists in this workspace lands the document at the root. */
  parentId: string | null;
  ownGrants: OwnGrants;
  inheritsPerms: boolean;
  page?: { of: string; row: string };
  detail?: Record<string, unknown>;
}

/** A prose document that is complete the moment its row exists. */
export async function createProseDoc(ctx: Ctx, input: CreateProseDocInput): Promise<DocRow> {
  const folder = input.parentId ? await getFolder(ctx.sql, input.parentId) : null;
  const parent = folder && folder.workspace_id === ctx.workspaceId ? folder : null;
  const doc = await insertOwnedDoc(ctx, {
    title: input.title,
    docType: "prose",
    parent,
    grants: input.ownGrants,
    inheritsPerms: input.inheritsPerms,
    page: input.page,
  });
  announceDoc(ctx, doc, input.detail);
  return doc;
}

/** A create request as a surface received it; every field is checked here. */
export interface CreateDocumentInput {
  title?: unknown;
  docType?: unknown;
  parentId?: unknown;
  /** Prose only: seed the body from this Markdown. */
  markdown?: unknown;
  /** The import's source filename, used only as a title fallback. */
  filename?: unknown;
  /** Prose only: a copy of this document the caller can read, its body as written, under `title` or the source's own. */
  copyOf?: unknown;
  /** Databases only: the starter table's name (defaults to the title). */
  table?: unknown;
  /** Databases only: the starter table's columns `[{ name, type, choices? }]`. */
  columns?: unknown;
  /** An agent's: the change it belongs to, or the title that opens one. */
  change?: ChangeArgs;
}

/**
 * `change`: the change an agent's new item belongs to. `held`: it is a new page held until that change
 * is approved, since AI edits where it was made wait for a colleague.
 */
export type CreateDocumentOutcome =
  | { ok: true; doc: DocRow; change?: ResolvedChange | null; held?: boolean }
  | { ok: false; status: number; message: string };

const TITLE_MAX = 200;

const refuse = (status: number, message: string): CreateDocumentOutcome => ({ ok: false, status, message });

/**
 * The workspace default-visibility floor for a new document or folder, an
 * agent's included: it creates for its human, and what it writes there still
 * waits for review. A folder takes it too, or a member could open a document
 * without seeing the folder that holds it. Inside a folder the floor reaches no
 * further than the folder does: inheritance only adds, so a workspace grant the
 * folder withholds would open everything created in it.
 */
export async function visibilityFloor(
  ctx: Ctx,
  parent: Pick<FolderRow, "acl_principals" | "acl_writers"> | null,
): Promise<OwnGrants> {
  const mode = (await getWorkspace(ctx.sql, ctx.workspaceId))?.default_doc_access;
  const access = mode === "workspace_view" || mode === "private" ? mode : "workspace_edit";
  const org = orgPrincipal(ctx.workspaceId);
  const reads = access !== "private" && (!parent || parent.acl_principals.includes(org));
  const writes = access === "workspace_edit" && reads && (!parent || parent.acl_writers.includes(org));
  return { p: reads ? [org] : [], w: writes ? [org] : [], c: [] };
}

/**
 * Create a document or database for a surface: validate the request, resolve
 * the parent folder, insert the owned row, seed an imported body or initialize
 * the database actor (deleting the row again if that fails), then announce it.
 * Every refusal is decided before a row exists.
 */
export async function createDocument(ctx: Ctx, input: CreateDocumentInput): Promise<CreateDocumentOutcome> {
  if (ctx.role === "guest") return refuse(403, "guests cannot create documents in this workspace");
  const docType = input.docType === undefined ? "prose" : input.docType;
  if (docType !== "prose" && docType !== "database") return refuse(400, "doc_type must be prose | database");

  const starter: { display?: string; columns?: ColumnSpecInput[] } | null = docType === "database" ? {} : null;
  if (input.table !== undefined || input.columns !== undefined) {
    if (!starter) return refuse(400, "table and columns apply only to doc_type database");
    if (input.table !== undefined) {
      if (typeof input.table !== "string" || input.table.trim() === "") return refuse(400, "table must be a non-empty name");
      starter.display = input.table.trim();
    }
    if (input.columns !== undefined) {
      const specs = parseColumnSpecs(input.columns);
      if (!specs.ok) return refuse(400, specs.message);
      starter.columns = specs.columns;
    }
  }

  let imported: { title: string; markdown: string } | null = null;
  if (typeof input.markdown === "string") {
    if (docType !== "prose") return refuse(400, "markdown import is only supported for prose documents");
    if (markdownByteLength(input.markdown) > MAX_IMPORT_MARKDOWN_BYTES) {
      return refuse(413, `markdown too large (max ${Math.floor(MAX_IMPORT_MARKDOWN_BYTES / 1024)} KB)`);
    }
    imported = normalizeImportedMarkdown(input.markdown, {
      filename: typeof input.filename === "string" ? input.filename : undefined,
    });
    // Refused before the row exists, so an empty seed below is a real failure.
    if (imported.markdown === "") return refuse(400, "nothing to import (the markdown is empty)");
  }

  // A copy keeps its body as written, with no heading added for a title: it is named, not derived.
  let copied = false;
  if (input.copyOf !== undefined) {
    if (docType !== "prose" || imported) return refuse(400, "copy_of makes a prose document and takes no markdown");
    if (typeof input.copyOf !== "string" || input.copyOf === "") return refuse(400, "invalid copy_of");
    const source = await readDocMarkdownWithProjection(ctx, input.copyOf);
    if (!source) return refuse(404, "document to copy not found");
    if (source === "database") return refuse(400, "copy_of takes a document, not a database");
    const named = typeof input.title === "string" ? input.title.trim().slice(0, TITLE_MAX) : "";
    imported = { title: named || source.doc.title, markdown: source.markdown.trim() };
    copied = true;
  }

  let parent: FolderRow | null = null;
  if (input.parentId !== undefined && input.parentId !== null) {
    if (typeof input.parentId !== "string" || input.parentId === "") return refuse(400, "invalid parent_id");
    parent = await authorizedFolder(ctx, input.parentId);
    if (!parent) return refuse(404, "parent folder not found");
    if (!canWriteFolder(ctx, parent)) return refuse(403, "view-only access to the parent folder");
  }
  // A scoped key's document at the root would be one the key itself could not read back.
  if (ctx.scope?.folders && !parent) {
    return refuse(403, "this key is scoped to folders — pass parent_id to create inside one of them");
  }

  const requestedTitle = typeof input.title === "string" ? input.title.trim().slice(0, TITLE_MAX) : "";
  const title = imported ? imported.title : requestedTitle;
  // An agent's new item belongs to its change. Where AI edits wait for a colleague it is held until
  // that change is approved, so it has one: an untitled change of its own when the agent named none.
  // Never titled after the page: a change's title reaches whoever decides any page of it, and the
  // page's only those who may open it.
  const hold = await holdPlan(ctx, parent);
  let change: ResolvedChange | null = null;
  if (ctx.isAgent) {
    const resolved = await resolveChange(ctx, input.change, null);
    if (!resolved.ok) return refuse(resolved.status, resolved.message);
    change = resolved.resolved;
    if (!change && hold) change = { change: await openChange(ctx, "", ""), opened: true };
  }
  const floor = await visibilityFloor(ctx, parent);
  let doc: DocRow;
  try {
    doc = await insertOwnedDoc(ctx, {
      // An import keeps title and body in sync: the title is derived from the body. A blank one
      // stays blank, which every reader shows as "Untitled" in their own language, until the first line names it.
      title,
      // An agent's title names the document, so accepting its text never retitles it. A person's
      // title, blank or not, is a stand-in their first line replaces until they rename it.
      ...(ctx.isAgent && requestedTitle && !imported ? { titleSource: "user" as const } : {}),
      docType,
      parent,
      // Held: its folder's access is not inherited; only its owner and those who may approve it open it.
      grants: hold ? { p: hold.grants, w: hold.grants, c: [] } : floor,
      inheritsPerms: !hold,
    });
  } catch (err) {
    await discardOpened(ctx, change);
    throw err;
  }
  if (hold && change && ctx.isAgent) {
    // What it gets once approved: the grants a page made here takes, as the creator's own are kept.
    const ownership = await docOwnership(ctx);
    const release = { p: [...new Set([...ownership.ownGrants.p, ...floor.p])], w: [...new Set([...ownership.ownGrants.w, ...floor.w])], c: [...floor.c] };
    const held = await holdChangePage(ctx.sql, {
      docId: doc.doc_id,
      changeId: change.change.change_id,
      workspaceId: ctx.workspaceId,
      heldGrants: hold.grants,
      releaseGrants: release,
      reviewer: ctx.onBehalfOf,
      approverGroup: hold.approverGroup,
    }).then(
      () => true,
      () => false,
    );
    if (!held) {
      await discardCreatedDoc(ctx, doc);
      await discardOpened(ctx, change);
      return refuse(502, "could not hold the new page for approval");
    }
  }

  if (imported && imported.markdown !== "" && !(await seedBody(ctx, doc.doc_id, imported.markdown, { change }))) {
    await discardCreatedDoc(ctx, doc);
    await discardOpened(ctx, change);
    return refuse(502, "could not write the imported content");
  }

  if (starter) {
    const initialized = await callDatabaseActor(ctx, doc.doc_id, "schema/init", {
      display: starter.display || requestedTitle || undefined,
      ...(starter.columns ? { columns: starter.columns } : {}),
      // A table named after the database, or named before the database has a name, takes the names it gets later.
      follows_title: starter.display === undefined || requestedTitle === "",
    })
      .then((res) => res.ok)
      .catch(() => false);
    if (!initialized) {
      await discardCreatedDoc(ctx, doc);
      await discardOpened(ctx, change);
      return refuse(502, "could not initialize the database");
    }
  }

  // Named as a rename names it, so the copy's first line does not take the title back.
  const created = copied && doc.title ? ((await updateDoc(ctx.sql, doc.doc_id, { title: doc.title }, ctx.env.searchLanguages.current())) ?? doc) : doc;
  announceDoc(ctx, created, change ? { change_id: change.change.change_id, ...(hold ? { held: true } : {}) } : undefined, !!hold);
  return { ok: true, doc: created, ...(ctx.isAgent ? { change, held: !!hold } : {}) };
}

/**
 * Write an imported body through the actor's apply-edits path, so the import is
 * journaled, flushed and indexed like typed content. An empty old_string on an
 * empty document is an append, so the document must be empty and the body not.
 * An agent's is proposed like its other writes, so it waits for review. With
 * `flush`, a person's is saved as a version before this returns, so the caller
 * can release the document's actor at once.
 */
export async function seedBody(ctx: Ctx, docId: string, markdown: string, opts: { flush?: boolean; change?: ResolvedChange | null } = {}): Promise<boolean> {
  if (ctx.isAgent) {
    const source = ctx.surface === "mcp" ? "connector" : "stdio";
    const resolvedChange = opts.change ? { change: opts.change.change, opened: false } : null;
    const proposed = await proposeDocEdit(ctx, { docId, action: "write", text: markdown, source, resolvedChange }).catch(() => null);
    return proposed?.kind === "proposed" || proposed?.kind === "auto_applied";
  }
  const seeded = await ctx.env.docs
    .get(docId)
    .fetch(`http://actor/apply-edits?docId=${encodeURIComponent(docId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // The alias, not the display name: it lands in versions.authors, which the UI resolves.
      body: JSON.stringify({ str_edits: [{ old_string: "", new_string: markdown }], agent: ctx.alias, flush: opts.flush }),
    })
    .then(async (res) => (res.ok ? ((await res.json().catch(() => null)) as { applied?: boolean } | null) : null))
    .catch(() => null);
  return seeded?.applied === true;
}
