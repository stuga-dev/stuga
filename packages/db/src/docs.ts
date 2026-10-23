import type { DocRow, OwnGrantsJson } from "./types.js";
import type { ReviewMode } from "@stuga/protocol/domain/events";
import { LIBRARY_LIST_CAP } from "@stuga/protocol/domain/limits";
import { daysAgo, docCols, docLevelJoins, globToLike, orderClause, ownGrantsJson, type Queryable, type SortOrder } from "./sql.js";
import type { SearchLanguage } from "@stuga/protocol/domain/search-languages";
import type { Sql } from "./client.js";
import { docVectorsSet, writeTitleVectors } from "./search-vectors.js";
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

/** What a database's indexing reads beside its text: how many rows it holds, and its ledger's newest op. */
export interface DatabaseFacts {
  rows: number;
  /** Epoch milliseconds; null before any change. */
  changedAt: number | null;
  /** The alias that op names: a person, an agent (`agent-…`), or the AI co-author (`panel:<alias>`). */
  changedBy: string | null;
}

/**
 * A database's cell text, which the workspace search reads as a document's
 * body. A database has no snapshots and no passages: only `search_text` moves,
 * with the keyword vectors, which are then all a database has, stemmed under
 * the node's search languages. With `facts`, its row count and its last change
 * too, which the wiki's Index shows and a page citing it is checked against.
 */
export async function setDatabaseSearchText(
  sql: Sql,
  docId: string,
  text: string,
  languages: readonly SearchLanguage[] = [],
  facts?: DatabaseFacts,
): Promise<void> {
  await sql.begin(async (tx) => {
    const [row] = await tx<{ title: string; search_text: string }[]>`
      SELECT title, search_text FROM docs WHERE doc_id = ${docId} AND doc_type = 'database' FOR UPDATE`;
    if (!row) return;
    if (row.search_text !== text) {
      await tx`
        UPDATE docs SET search_text = ${text}, ${docVectorsSet(tx, { title: row.title, text, languages, whole: true })}
        WHERE doc_id = ${docId}`;
    }
    if (!facts) return;
    const changedAt = facts.changedAt === null ? null : new Date(facts.changedAt).toISOString();
    const changedBy = facts.changedBy === null ? [] : [facts.changedBy];
    // Only what moved: an unchanged database keeps its row as it is.
    await tx`
      UPDATE docs SET row_count = ${facts.rows}, text_changed_at = coalesce(${changedAt}::timestamptz, text_changed_at),
                      text_changed_by = CASE WHEN ${changedAt}::timestamptz IS NULL THEN text_changed_by ELSE ${changedBy}::text[] END
      WHERE doc_id = ${docId}
        AND (row_count IS DISTINCT FROM ${facts.rows}
             OR (${changedAt}::timestamptz IS NOT NULL AND text_changed_at IS DISTINCT FROM ${changedAt}::timestamptz))`;
  });
}

export interface CreateDocInput {
  docId: string;
  workspaceId: string;
  /** Full principal: `user:<alias>` or `agent:<id>`. */
  owner: string;
  title?: string;
  /** `user` when the title was given as the document's name, so its first line never retitles it; else `heading`. */
  titleSource?: "heading" | "user";
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
  /** The node's search languages, which the title's keyword vector stems words under; none when absent. */
  searchLanguages?: readonly SearchLanguage[];
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
    ...(input.titleSource ? { title_source: input.titleSource } : {}),
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
  const rows = await sql.begin(async (tx) => {
    const inserted = await tx<DocRow[]>`
      INSERT INTO docs ${tx(row)}
      ON CONFLICT (doc_id) DO NOTHING
      RETURNING ${docCols(tx)}`;
    // A new document's text and passages are empty: its title is all its vectors hold.
    if (inserted[0]) {
      await tx`
        UPDATE docs SET ${docVectorsSet(tx, { title: row.title, text: null, languages: input.searchLanguages ?? [], whole: true })}
        WHERE doc_id = ${input.docId}`;
    }
    return inserted;
  });
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
    /** None directly in these folders: one person's My notes, listed apart. */
    notInFolders?: string[];
    /** Only documents search finds: none kept out of search. */
    searchable?: boolean;
    /** Database row pages are left out by default; `only` with `pageOf` lists one database's. */
    pages?: "exclude" | "include" | "only";
    pageOf?: string;
  } = {},
): Promise<DocRow[]> {
  const orderBy = orderClause(DOC_SORTS, opts.sort, "updated_at", opts.order, "desc");
  const limit = Math.min(Math.max(opts.limit ?? LIBRARY_LIST_CAP, 1), 500);
  const pages = opts.pages ?? "exclude";
  return sql<DocRow[]>`
    SELECT ${docCols(sql, "d", { joined: true })} FROM docs d ${docLevelJoins(sql, "d")}
    WHERE workspace_id = ${workspaceId}
      AND acl_principals && ${principals}
      AND trashed = ${opts.trashedOnly ?? false}
      ${pages === "exclude" ? sql`AND page_of IS NULL` : pages === "only" ? sql`AND page_of IS NOT NULL` : sql``}
      ${opts.pageOf ? sql`AND page_of = ${opts.pageOf}` : sql``}
      ${opts.scopeFolderIds ? sql`AND parent_id = ANY(${opts.scopeFolderIds})` : sql``}
      ${opts.notInFolders?.length ? sql`AND (parent_id IS NULL OR NOT parent_id = ANY(${opts.notInFolders}))` : sql``}
      ${opts.searchable ? sql`AND search_hidden = FALSE` : sql``}
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
 * How many documents the principals may read, as listDocs finds them with no limit (live, row pages
 * left out, only those search finds, within `scopeFolderIds` when given), and how many of those are
 * directly in the folders of `split`.
 */
export async function countSearchableDocs(
  sql: Sql,
  principals: string[],
  workspaceId: string,
  opts: { scopeFolderIds?: string[] | null; split?: string[] } = {},
): Promise<{ total: number; split: number }> {
  const [row] = await sql<{ total: number; split: number }[]>`
    SELECT count(*)::int AS total, count(*) FILTER (WHERE parent_id = ANY(${opts.split ?? []}::text[]))::int AS split
    FROM docs
    WHERE workspace_id = ${workspaceId}
      AND acl_principals && ${principals}
      AND trashed = FALSE
      AND search_hidden = FALSE
      AND page_of IS NULL
      ${opts.scopeFolderIds ? sql`AND parent_id = ANY(${opts.scopeFolderIds})` : sql``}`;
  return row ?? { total: 0, split: 0 };
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
    SELECT ${docCols(sql, "d", { joined: true })} FROM docs d ${docLevelJoins(sql, "d")}
    WHERE workspace_id = ${workspaceId}
      AND acl_principals && ${principals}
      AND trashed = FALSE
      -- A new page a change holds, or a row page of such a database, is not the workspace's until it is approved.
      AND NOT EXISTS (
        SELECT 1 FROM wiki_change_pages h
        WHERE h.state = 'held' AND (h.doc_id = d.doc_id OR h.doc_id = d.page_of))
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

export async function updateDoc(
  sql: Sql,
  docId: string,
  patch: UpdateDocPatch,
  /** The node's search languages, which a new title's keyword vectors stem words under; none when absent. */
  searchLanguages: readonly SearchLanguage[] = [],
): Promise<DocRow | null> {
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
  // A rename also writes the vectors the title is in, chunk 0's among them, after
  // the docs row lock is held, so they read chunks a concurrent indexDoc committed
  // while this waited. docs is locked before doc_chunks everywhere.
  return sql.begin(async (tx) => {
    const rows = await tx<DocRow[]>`
      UPDATE docs SET ${tx(set)} WHERE doc_id = ${docId}
      RETURNING ${docCols(tx)}`;
    const renamed = rows[0];
    if (!renamed) return null;
    await writeTitleVectors(tx, docId, renamed.title, searchLanguages);
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
): Promise<Array<{ doc_id: string; doc_type: "prose" | "database"; workspace_id: string }>> {
  return sql<Array<{ doc_id: string; doc_type: "prose" | "database"; workspace_id: string }>>`
    SELECT doc_id, doc_type, workspace_id FROM docs
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

/** The document's own review level; null follows its folder. Who may set which level is the caller's to check. */
export async function setDocAgentMode(sql: Sql, docId: string, mode: ReviewMode | null): Promise<DocRow | null> {
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
