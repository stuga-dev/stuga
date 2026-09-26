import type { DocRow, OwnGrantsJson } from "./types.js";
import type { ReviewMode } from "@stuga/protocol/domain/events";
import { LIBRARY_LIST_CAP } from "@stuga/protocol/domain/limits";
import { daysAgo, docCols, globToLike, orderClause, ownGrantsJson, type Queryable, type SortOrder } from "./sql.js";
import type { Sql } from "./client.js";
import { retainedVersion } from "./versions.js";

const DOC_SORTS = {
  updated_at: "updated_at",
  created_at: "created_at",
  title: "lower(title)",
} as const;

export type DocSortKey = keyof typeof DOC_SORTS;

export async function getDoc(sql: Queryable, docId: string): Promise<DocRow | null> {
  const rows = await sql<DocRow[]>`SELECT ${docCols(sql)} FROM docs WHERE doc_id = ${docId}`;
  return rows[0] ?? null;
}

/** The Markdown the last index job derived from the head snapshot; a fallback when that snapshot is unreadable. */
export async function getDocSearchText(sql: Sql, docId: string): Promise<string | null> {
  const rows = await sql<{ search_text: string }[]>`SELECT search_text FROM docs WHERE doc_id = ${docId}`;
  return rows[0]?.search_text ?? null;
}

export interface CreateDocInput {
  docId: string;
  workspaceId: string;
  /** Full principal: `user:<alias>` or `agent:<id>`. */
  owner: string;
  title?: string;
  docType?: "prose" | "database";
  parentId?: string | null;
  aclPrincipals?: string[];
  aclWriters?: string[];
  aclCommenters?: string[];
  inheritsPerms?: boolean;
  /** Defaults to the ACL arrays inserted, which are the direct grants of a new row. */
  ownGrants?: OwnGrantsJson;
  /**
   * The workspace's visibility floor on top of the owner grant, used when the
   * ACL arrays are omitted: 'workspace_edit' adds org:<wid> to readers and
   * writers, 'workspace_view' to readers only.
   */
  defaultAccess?: "workspace_edit" | "workspace_view" | "private";
  /** Recorded as `created_by`; defaults to the owner. */
  createdBy?: string;
  /** For a database row's page: the database's doc_id, and the row as `<table_id>.<row_id>`. */
  pageOf?: string;
  pageRow?: string;
}

/** Idempotent on doc_id: an existing row is returned unchanged. */
export async function createDoc(sql: Sql, input: CreateDocInput): Promise<DocRow> {
  const owner = input.owner;
  const org = `org:${input.workspaceId}`;
  const mode = input.defaultAccess ?? "private";
  const principals = input.aclPrincipals ?? (mode === "private" ? [owner] : [owner, org]);
  const writers = input.aclWriters ?? (mode === "workspace_edit" ? [owner, org] : [owner]);
  const commenters = input.aclCommenters ?? [];
  const row = {
    doc_id: input.docId,
    workspace_id: input.workspaceId,
    owner,
    title: input.title ?? "",
    doc_type: input.docType ?? "prose",
    parent_id: input.parentId ?? null,
    created_by: input.createdBy ?? owner,
    ...(input.pageOf ? { page_of: input.pageOf, page_row: input.pageRow ?? null } : {}),
    acl_principals: principals,
    acl_writers: writers,
    acl_commenters: commenters,
    ...(input.inheritsPerms !== undefined ? { inherits_perms: input.inheritsPerms } : {}),
    own_grants: ownGrantsJson(sql, input.ownGrants ?? { p: principals, w: writers, c: commenters }),
  };
  const rows = await sql<DocRow[]>`
    INSERT INTO docs ${sql(row)}
    ON CONFLICT (doc_id) DO NOTHING
    RETURNING ${docCols(sql)}`;
  if (rows[0]) return rows[0];
  const existing = await getDoc(sql, input.docId);
  if (!existing) throw new Error(`createDoc: ${input.docId} vanished after conflict`);
  return existing;
}

/**
 * Documents the principals may see, newest first by default. doc_id breaks
 * ties so rows created in one batch keep a stable order across calls.
 */
export async function listDocs(
  sql: Sql,
  principals: string[],
  workspaceId: string,
  opts: {
    trashedOnly?: boolean;
    /** A full principal. */
    owner?: string;
    parentId?: string | null;
    /** A bare alias: documents someone else owns that grant this person directly. */
    sharedWith?: string;
    sort?: DocSortKey;
    order?: SortOrder;
    limit?: number;
    /** Only documents directly in these folders (subtrees already expanded). */
    scopeFolderIds?: string[] | null;
    /** Database row pages are left out by default; `only` with `pageOf` lists one database's. */
    pages?: "exclude" | "include" | "only";
    pageOf?: string;
  } = {},
): Promise<DocRow[]> {
  const orderBy = orderClause(DOC_SORTS, opts.sort, "updated_at", opts.order, "desc");
  const limit = Math.min(Math.max(opts.limit ?? LIBRARY_LIST_CAP, 1), 500);
  const pages = opts.pages ?? "exclude";
  return sql<DocRow[]>`
    SELECT ${docCols(sql)} FROM docs
    WHERE workspace_id = ${workspaceId}
      AND acl_principals && ${principals}
      AND trashed = ${opts.trashedOnly ?? false}
      ${pages === "exclude" ? sql`AND page_of IS NULL` : pages === "only" ? sql`AND page_of IS NOT NULL` : sql``}
      ${opts.pageOf ? sql`AND page_of = ${opts.pageOf}` : sql``}
      ${opts.scopeFolderIds ? sql`AND parent_id = ANY(${opts.scopeFolderIds})` : sql``}
      ${opts.owner ? sql`AND owner = ${opts.owner}` : sql``}
      ${opts.parentId !== undefined ? sql`AND parent_id ${opts.parentId === null ? sql`IS NULL` : sql`= ${opts.parentId}`}` : sql``}
      ${
        opts.sharedWith
          ? sql`AND owner <> ${`user:${opts.sharedWith}`} AND ${`user:${opts.sharedWith}`} = ANY(acl_principals)`
          : sql``
      }
    ORDER BY ${sql.unsafe(orderBy)}, doc_id
    LIMIT ${limit}`;
}

/**
 * Unlocked prose documents the principals may edit, for an agent to plan over.
 * `docIds` confines to a collection's documents; an empty list means nothing.
 */
export async function listEditableDocs(
  sql: Sql,
  principals: string[],
  workspaceId: string,
  opts: { exclude?: string; limit?: number; docIds?: string[] | null } = {},
): Promise<Array<{ doc_id: string; title: string; page_of: string | null }>> {
  if (opts.docIds && opts.docIds.length === 0) return [];
  return sql<{ doc_id: string; title: string; page_of: string | null }[]>`
    SELECT doc_id, title, page_of FROM docs
    WHERE workspace_id = ${workspaceId}
      AND acl_writers && ${principals}
      AND trashed = FALSE
      AND locked = FALSE
      AND doc_type = 'prose'
      ${opts.exclude ? sql`AND doc_id <> ${opts.exclude}` : sql``}
      ${opts.docIds ? sql`AND doc_id = ANY(${opts.docIds})` : sql``}
    ORDER BY updated_at DESC
    LIMIT ${opts.limit ?? 100}`;
}

/**
 * One page of every live document the principals may read, databases and row pages included, in
 * doc_id order after `after` (null for the first page): what a workspace export walks.
 */
export async function listExportDocs(
  sql: Sql,
  principals: string[],
  workspaceId: string,
  after: string | null,
  limit = 500,
): Promise<DocRow[]> {
  return sql<DocRow[]>`
    SELECT ${docCols(sql)} FROM docs
    WHERE workspace_id = ${workspaceId}
      AND acl_principals && ${principals}
      AND trashed = FALSE
      ${after === null ? sql`` : sql`AND doc_id > ${after}`}
    ORDER BY doc_id
    LIMIT ${Math.min(Math.max(limit, 1), 1000)}`;
}

/**
 * Prose documents the principals may read and search, for the ask agent. `q`
 * is a glob title filter; `parentIds` confines to folders and `docIds` to a
 * collection's documents, and an empty list means nothing rather than everything.
 */
export async function listReadableDocs(
  sql: Sql,
  principals: string[],
  workspaceId: string,
  opts: { q?: string; parentIds?: string[]; docIds?: string[] | null; limit?: number; scopeFolderIds?: string[] | null } = {},
): Promise<Array<{ doc_id: string; title: string; page_of: string | null }>> {
  const q = opts.q?.trim();
  const parents = opts.parentIds;
  if (parents && parents.length === 0) return [];
  if (opts.docIds && opts.docIds.length === 0) return [];
  return sql<{ doc_id: string; title: string; page_of: string | null }[]>`
    SELECT doc_id, title, page_of FROM docs
    WHERE workspace_id = ${workspaceId}
      AND acl_principals && ${principals}
      AND trashed = FALSE
      AND search_hidden = FALSE
      AND doc_type = 'prose'
      ${q ? sql`AND title ILIKE ${globToLike(q)} ESCAPE '\\'` : sql``}
      ${parents ? sql`AND parent_id = ANY(${parents})` : sql``}
      ${opts.docIds ? sql`AND doc_id = ANY(${opts.docIds})` : sql``}
      ${opts.scopeFolderIds ? sql`AND parent_id = ANY(${opts.scopeFolderIds})` : sql``}
    ORDER BY updated_at DESC
    LIMIT ${opts.limit ?? 50}`;
}

export interface UpdateDocPatch {
  title?: string;
  trashed?: boolean;
  parentId?: string | null;
}

export async function updateDoc(sql: Sql, docId: string, patch: UpdateDocPatch): Promise<DocRow | null> {
  const set: Record<string, unknown> = { updated_at: sql`now()` };
  if (patch.title !== undefined) {
    set.title = patch.title;
    set.title_source = "user";
  }
  if (patch.trashed !== undefined) {
    set.trashed = patch.trashed;
    set.trashed_at = patch.trashed ? sql`now()` : null;
  }
  if (patch.parentId !== undefined) set.parent_id = patch.parentId;
  if (patch.title === undefined) {
    const rows = await sql<DocRow[]>`
      UPDATE docs SET ${sql(set)} WHERE doc_id = ${docId}
      RETURNING ${docCols(sql)}`;
    return rows[0] ?? null;
  }
  // A rename also moves chunk 0's doc_title, in a second statement: its snapshot
  // starts after the docs row lock is held, so it sees chunks a concurrent
  // indexDoc committed while this waited. docs is locked before doc_chunks everywhere.
  return sql.begin(async (tx) => {
    const rows = await tx<DocRow[]>`
      UPDATE docs SET ${tx(set)} WHERE doc_id = ${docId}
      RETURNING ${docCols(tx)}`;
    const renamed = rows[0];
    if (!renamed) return null;
    await tx`UPDATE doc_chunks SET doc_title = ${renamed.title} WHERE doc_id = ${docId} AND chunk_index = 0`;
    return renamed;
  });
}

export async function deleteDoc(sql: Sql, docId: string): Promise<void> {
  await sql`DELETE FROM docs WHERE doc_id = ${docId}`;
  // agent_runs has no foreign key to docs.
  await sql`DELETE FROM agent_runs WHERE doc_id = ${docId}`;
}

/** Bump updated_at for an edit that happened outside the docs row (a database's own storage). */
export async function touchDoc(sql: Sql, docId: string): Promise<void> {
  await sql`UPDATE docs SET updated_at = now() WHERE doc_id = ${docId}`;
}

/** The trash flag of each id that still exists in this workspace; a missing id is gone for good. */
export async function docTrashStates(sql: Sql, workspaceId: string, docIds: string[]): Promise<Array<{ doc_id: string; trashed: boolean }>> {
  if (docIds.length === 0) return [];
  return sql<Array<{ doc_id: string; trashed: boolean }>>`
    SELECT doc_id, trashed FROM docs WHERE workspace_id = ${workspaceId} AND doc_id = ANY(${docIds})`;
}

/**
 * The row pages of one database. `trashedWithDatabase` keeps the pages trashed
 * at or after the database itself, compared in SQL at the column's microsecond
 * precision, so ask it while the database is still in the trash. A trashed
 * database with no stamp bounds nothing.
 */
export async function listPagesOf(
  sql: Sql,
  workspaceId: string,
  databaseId: string,
  opts: { trashed?: boolean; trashedWithDatabase?: boolean } = {},
): Promise<Array<{ doc_id: string; page_row: string | null; trashed: boolean }>> {
  return sql<Array<{ doc_id: string; page_row: string | null; trashed: boolean }>>`
    SELECT doc_id, page_row, trashed FROM docs
    WHERE workspace_id = ${workspaceId} AND page_of = ${databaseId}
      ${opts.trashed !== undefined ? sql`AND trashed = ${opts.trashed}` : sql``}
      ${
        opts.trashedWithDatabase
          ? sql`AND trashed_at >= COALESCE(
                  (SELECT db.trashed_at FROM docs db WHERE db.doc_id = ${databaseId} AND db.workspace_id = ${workspaceId}),
                  '-infinity'::timestamptz)`
          : sql``
      }
    ORDER BY doc_id`;
}

/**
 * Make one of a database's pages an ordinary document, once its row has a new
 * page: restored from the trash, it returns to the library. Anything else, or a
 * page that is gone, is left alone.
 */
export async function detachPage(sql: Sql, workspaceId: string, databaseId: string, docId: string): Promise<void> {
  await sql`
    UPDATE docs SET page_of = NULL, page_row = NULL
    WHERE doc_id = ${docId} AND workspace_id = ${workspaceId} AND page_of = ${databaseId}`;
}

/** Trash a database's live, unlocked pages. Returns the ids it trashed. */
export async function trashPagesOf(sql: Sql, databaseId: string): Promise<string[]> {
  const rows = await sql<{ doc_id: string }[]>`
    UPDATE docs SET trashed = TRUE, trashed_at = now(), updated_at = now()
    WHERE page_of = ${databaseId} AND trashed = FALSE AND locked = FALSE
    RETURNING doc_id`;
  return rows.map((r) => r.doc_id);
}

/** Documents trashed longer than the retention window, oldest first. */
export async function findExpiredTrash(
  sql: Sql,
  olderThanDays: number,
  limit = 100,
): Promise<Array<{ doc_id: string; doc_type: "prose" | "database" }>> {
  return sql<Array<{ doc_id: string; doc_type: "prose" | "database" }>>`
    SELECT doc_id, doc_type FROM docs
    WHERE trashed = TRUE
      AND trashed_at < ${daysAgo(sql, olderThanDays)}
    ORDER BY trashed_at ASC
    LIMIT ${limit}`;
}

export async function setDocLocked(sql: Sql, docId: string, locked: boolean, by: string | null): Promise<DocRow | null> {
  const rows = await sql<DocRow[]>`
    UPDATE docs
    SET locked = ${locked},
        locked_by = ${locked ? by : null},
        locked_at = ${locked ? sql`now()` : null},
        updated_at = now()
    WHERE doc_id = ${docId}
    RETURNING ${docCols(sql)}`;
  return rows[0] ?? null;
}

export async function setDocSearchHidden(sql: Sql, docId: string, hidden: boolean): Promise<DocRow | null> {
  const rows = await sql<DocRow[]>`
    UPDATE docs SET search_hidden = ${hidden}, updated_at = now()
    WHERE doc_id = ${docId}
    RETURNING ${docCols(sql)}`;
  return rows[0] ?? null;
}

/** The document's own instructions for agents; '' clears them. The caller validates the length. */
export async function setDocAgentInstructions(sql: Sql, docId: string, text: string): Promise<DocRow | null> {
  const rows = await sql<DocRow[]>`
    UPDATE docs SET agent_instructions = ${text}, updated_at = now()
    WHERE doc_id = ${docId}
    RETURNING ${docCols(sql)}`;
  return rows[0] ?? null;
}

export async function setDocAgentMode(sql: Sql, docId: string, mode: ReviewMode): Promise<DocRow | null> {
  const rows = await sql<DocRow[]>`
    UPDATE docs SET agent_mode = ${mode}, updated_at = now()
    WHERE doc_id = ${docId}
    RETURNING ${docCols(sql)}`;
  return rows[0] ?? null;
}

export async function setDocAcl(
  sql: Sql,
  docId: string,
  principals: string[],
  writers: string[],
  inherits: boolean,
  commenters: string[],
  ownGrants: OwnGrantsJson,
): Promise<void> {
  await sql`
    UPDATE docs
    SET acl_principals = ${principals}, acl_writers = ${writers}, acl_commenters = ${commenters},
        inherits_perms = ${inherits}, own_grants = ${ownGrantsJson(sql, ownGrants)}, updated_at = now()
    WHERE doc_id = ${docId}`;
}

// ---- Media references -------------------------------------------------------------
// A stored image is `media/<workspace>/<hash>` and is referenced by its path in
// Markdown. These scans over-match on purpose: a false positive only keeps an
// object, a false negative deletes one in use.

const MEDIA_PATH_PATTERN = "/api/docs/[^/]{1,64}/media/([0-9a-f]{64})";

/** One stored image, as the media store addresses it. */
export interface MediaRef {
  workspace: string;
  hash: string;
}

/** The images referenced by one page of document bodies (`search_text`), in doc_id order after `afterDocId`. */
export async function mediaRefsInBodies(
  sql: Sql,
  afterDocId: string,
  limit: number,
): Promise<{ refs: MediaRef[]; count: number; lastDocId: string | null }> {
  const rows = await sql<{ refs: MediaRef[] | null; n: number; last_id: string | null }[]>`
    WITH page AS (
      SELECT doc_id, workspace_id, search_text
        FROM docs WHERE doc_id > ${afterDocId} ORDER BY doc_id LIMIT ${limit}
    )
    SELECT
      (SELECT max(doc_id) FROM page) AS last_id,
      (SELECT count(*)::int FROM page) AS n,
      (SELECT jsonb_agg(DISTINCT jsonb_build_object('workspace', p.workspace_id, 'hash', m[1]))
         FROM page p, LATERAL regexp_matches(p.search_text, ${MEDIA_PATH_PATTERN}, 'g') m) AS refs`;
  const r = rows[0]!;
  return { refs: r.refs ?? [], count: r.n, lastDocId: r.last_id };
}

/** A snapshot whose content SQL cannot answer for: a search-hidden body or a retained version. */
export interface MediaSnapshotRow {
  source: "doc" | "version";
  doc_id: string;
  workspace_id: string;
  seq: number;
}

/** The sort key `mediaSnapshotPage` resumes after. */
export function mediaSnapshotCursor(row: MediaSnapshotRow): string {
  return `${row.doc_id}:${String(row.seq).padStart(20, "0")}:${row.source}`;
}

/**
 * One page of snapshots to decode for media references: bodies of search-hidden
 * documents (their `search_text` is stale) and every retained version, trashed
 * documents included. Resumes after a `mediaSnapshotCursor`.
 */
export async function mediaSnapshotPage(sql: Sql, after: string, limit: number): Promise<MediaSnapshotRow[]> {
  return sql<MediaSnapshotRow[]>`
    SELECT * FROM (
      SELECT 'doc' AS source, d.doc_id, d.workspace_id, d.snapshot_seq AS seq
        FROM docs d
       WHERE d.snapshot_seq > 0 AND d.search_hidden
      UNION ALL
      SELECT 'version' AS source, v.doc_id, d.workspace_id, v.seq
        FROM versions v
        JOIN docs d ON d.doc_id = v.doc_id
       WHERE ${retainedVersion(sql)}
    ) rows
    WHERE (rows.doc_id || ':' || lpad(rows.seq::text, 20, '0') || ':' || rows.source) > ${after}
    ORDER BY (rows.doc_id || ':' || lpad(rows.seq::text, 20, '0') || ':' || rows.source)
    LIMIT ${limit}`;
}

/** Which of `hashes` some document body in the workspace still references. */
export async function mediaHashesReferencedInWorkspace(sql: Sql, workspaceId: string, hashes: string[]): Promise<Set<string>> {
  const rows = await sql<{ hash: string }[]>`
    SELECT DISTINCT m[1] AS hash
      FROM docs d, LATERAL regexp_matches(d.search_text, ${MEDIA_PATH_PATTERN}, 'g') m
     WHERE d.workspace_id = ${workspaceId} AND m[1] = ANY(${hashes})`;
  return new Set(rows.map((r) => r.hash));
}
