/** SQL building blocks shared by the query modules. Not part of the package's public surface. */
import type { Fragment, Sql, TransactionSql } from "postgres";
import type { OwnGrantsJson } from "./types.js";

/** Anything a query can run on: the pool, or a transaction opened on it. */
export type Queryable = Sql | TransactionSql;

export type SortOrder = "asc" | "desc";

export const DOC_COLUMNS = [
  "doc_id",
  "workspace_id",
  "owner",
  "title",
  "title_source",
  "doc_type",
  "parent_id",
  "snapshot_seq",
  "trashed",
  "trashed_at",
  "created_at",
  "updated_at",
  "acl_principals",
  "acl_writers",
  "acl_commenters",
  "inherits_perms",
  "locked",
  "locked_by",
  "locked_at",
  "search_hidden",
  "own_grants",
  "created_by",
  "agent_mode",
  "agent_instructions",
  "page_of",
  "page_row",
] as const;

/** A row page's database's level now, `page_of` naming it; NULL for any other document. */
function databaseLevelOf(pageOf: string): string {
  return `(SELECT coalesce(lvd.agent_mode, folder_agent_mode(lvd.parent_id), 'review') FROM docs lvd WHERE lvd.doc_id = ${pageOf})`;
}

/**
 * The DocRow projection. `search_text` stays out: it is unbounded. The levels its folders give it
 * (`folder_agent_mode`) and, for a row page, its database's (`database_agent_mode`) are read with
 * the row, after any update a RETURNING applies, so a moved document reads its new folder's level.
 * That walks the folders above it once per row: a query that reads many rows passes `joined` and
 * reads them through docLevelJoins instead.
 */
export function docCols(sql: Queryable, alias?: string, opts: { joined?: boolean } = {}): Fragment {
  const col = (c: string) => (alias ? `${alias}.${c}` : c);
  // Qualified, so the subquery's own `docs` cannot capture the outer row's columns.
  const ref = (c: string) => `${alias ?? "docs"}.${c}`;
  const levels = opts.joined
    ? "lvl_folder.folder_agent_mode, lvl_database.database_agent_mode"
    : `folder_agent_mode(${ref("parent_id")}) AS folder_agent_mode, ${databaseLevelOf(ref("page_of"))} AS database_agent_mode`;
  return sql.unsafe(`${DOC_COLUMNS.map(col).join(", ")}, ${levels}`);
}

/**
 * For a listing of documents as `alias`: the levels docCols(sql, alias, { joined: true }) reads,
 * looked up by folder and by database, which the planner caches (Memoize) or hashes, so each folder
 * chain is walked once per query rather than once per row.
 */
export function docLevelJoins(sql: Queryable, alias: string): Fragment {
  return sql.unsafe(
    `LEFT JOIN LATERAL (SELECT folder_agent_mode(lvf.folder_id) AS folder_agent_mode FROM folders lvf WHERE lvf.folder_id = ${alias}.parent_id) lvl_folder ON TRUE ` +
      `LEFT JOIN LATERAL (SELECT coalesce(lvd.agent_mode, folder_agent_mode(lvd.parent_id), 'review') AS database_agent_mode ` +
      `FROM docs lvd WHERE lvd.doc_id = ${alias}.page_of) lvl_database ON TRUE`,
  );
}

/** The folders columns a FolderRow carries as stored. */
export const FOLDER_COLUMNS = [
  "folder_id",
  "workspace_id",
  "parent_id",
  "owner",
  "title",
  "acl_principals",
  "acl_writers",
  "inherits_perms",
  "own_grants",
  "agent_instructions",
  "agent_mode",
  "approver_group",
  "created_at",
  "updated_at",
] as const;

/**
 * The FolderRow projection, with the level the folders above give it (`parent_agent_mode`), read
 * once per row; a listing passes `joined` and reads it through folderLevelJoin.
 */
export function folderCols(sql: Queryable, alias?: string, opts: { joined?: boolean } = {}): Fragment {
  const col = (c: string) => (alias ? `${alias}.${c}` : c);
  const level = opts.joined ? "lvl_parent.parent_agent_mode" : `folder_agent_mode(${col("parent_id")}) AS parent_agent_mode`;
  return sql.unsafe(`${FOLDER_COLUMNS.map(col).join(", ")}, ${level}`);
}

/** For a listing of folders as `alias`: the level folderCols(sql, alias, { joined: true }) reads, once per parent. */
export function folderLevelJoin(sql: Queryable, alias: string): Fragment {
  return sql.unsafe(
    `LEFT JOIN LATERAL (SELECT folder_agent_mode(lvp.folder_id) AS parent_agent_mode FROM folders lvp WHERE lvp.folder_id = ${alias}.parent_id) lvl_parent ON TRUE`,
  );
}

/**
 * `<column> <direction>` for a caller-supplied sort key. The map's values are
 * interpolated unescaped, so only a key the map owns selects one; anything else
 * (including a string that is not a member) gets `fallback`.
 */
export function orderClause<K extends string>(
  map: Record<K, string>,
  key: string | undefined,
  fallback: K,
  order: SortOrder | undefined,
  defaultOrder: SortOrder,
): string {
  const column = key !== undefined && Object.prototype.hasOwnProperty.call(map, key) ? map[key as K] : map[fallback];
  const direction = (order ?? defaultOrder) === "asc" ? "ASC" : "DESC";
  return `${column} ${direction}`;
}

/** Escape LIKE metacharacters; pair the pattern with `ESCAPE '\'`. */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * A title filter as a LIKE pattern: `*` and `?` are wildcards, and a filter
 * with neither matches as a substring. Pair with `ESCAPE '\'`.
 */
export function globToLike(q: string): string {
  const translated = escapeLike(q).replace(/\*/g, "%").replace(/\?/g, "_");
  return /[*?]/.test(q) ? translated : `%${translated}%`;
}

/**
 * A pgvector literal, or null when the vector is missing, not `dims` wide, or
 * holds a non-finite value. The literal is cast into SQL text, so this is its
 * only validation. `dims` is the database column's width, which only the node knows.
 */
export function vectorLiteral(embedding: number[] | null | undefined, dims: number): string | null {
  if (!embedding || embedding.length !== dims) return null;
  for (const v of embedding) if (!Number.isFinite(v)) return null;
  return `[${embedding.join(",")}]`;
}

export function isoOrNull(v: Date | string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v.toISOString() : v;
}

/** Bind a value to a JSONB column. A pre-stringified value would be stored as a JSON string. */
export function jsonb(sql: Queryable, value: unknown) {
  return sql.json(value as Parameters<Sql["json"]>[0]);
}

export function ownGrantsJson(sql: Queryable, own: OwnGrantsJson) {
  return sql.json({ p: own.p, w: own.w, c: own.c });
}

/** `now()` minus a whole number of days. */
export function daysAgo(sql: Queryable, days: number): Fragment {
  return sql`(now() - (${days} * interval '1 day'))`;
}

/** Folder chains are walked at most this deep, so a parent_id cycle terminates. */
export const MAX_FOLDER_DEPTH = 32;

/**
 * The recursive CTE `subtree(folder_id, depth)`: the folders `roots` selects
 * (one `folder_id` column) and all their descendants in the workspace.
 */
export function folderSubtreeCte(sql: Queryable, roots: Fragment, workspaceId: string): Fragment {
  return sql`subtree(folder_id, depth) AS (
      SELECT folder_id, 0 FROM (${roots}) AS roots
      UNION ALL
      SELECT f.folder_id, s.depth + 1
      FROM folders f JOIN subtree s ON f.parent_id = s.folder_id
      WHERE s.depth < ${MAX_FOLDER_DEPTH} AND f.workspace_id = ${workspaceId}
    )`;
}

/**
 * The Collection scope and a scoped credential's folders, over `docs d`. Each
 * only narrows, and sits beside the ACL gate, never in place of it.
 */
export function scopeFragment(sql: Queryable, docIds: string[] | null, folderIds: string[] | null): Fragment {
  const byDoc = docIds ? sql`AND d.doc_id = ANY(${docIds})` : sql``;
  const byFolder = folderIds ? sql`AND d.parent_id = ANY(${folderIds})` : sql``;
  return sql`${byDoc} ${byFolder}`;
}
