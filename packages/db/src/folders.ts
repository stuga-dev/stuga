import type { DocRow, FolderRow, OwnGrantsJson } from "./types.js";
import {
  MAX_FOLDER_DEPTH,
  docCols,
  folderCols,
  folderSubtreeCte,
  orderClause,
  ownGrantsJson,
  type Queryable,
  type SortOrder,
} from "./sql.js";
import type { Sql } from "./client.js";

const FOLDER_SORTS = {
  title: "lower(title)",
  updated_at: "updated_at",
} as const;

export type FolderSortKey = keyof typeof FOLDER_SORTS;

export async function getFolder(sql: Sql, folderId: string): Promise<FolderRow | null> {
  const rows = await sql<FolderRow[]>`SELECT * FROM folders WHERE folder_id = ${folderId}`;
  return rows[0] ?? null;
}

export async function createFolder(
  sql: Sql,
  input: {
    folderId: string;
    workspaceId: string;
    /** Full principal: `user:<alias>` or `agent:<id>`. */
    owner: string;
    title: string;
    parentId?: string | null;
    aclPrincipals?: string[];
    aclWriters?: string[];
    inheritsPerms?: boolean;
    /** Defaults to the ACL arrays inserted. */
    ownGrants?: OwnGrantsJson;
    /** Instructions for agents working beneath the folder, set as it is created. */
    agentInstructions?: string;
  },
): Promise<FolderRow> {
  const principals = input.aclPrincipals ?? [input.owner];
  const writers = input.aclWriters ?? [input.owner];
  const row = {
    folder_id: input.folderId,
    workspace_id: input.workspaceId,
    owner: input.owner,
    title: input.title,
    parent_id: input.parentId ?? null,
    acl_principals: principals,
    acl_writers: writers,
    ...(input.inheritsPerms !== undefined ? { inherits_perms: input.inheritsPerms } : {}),
    ...(input.agentInstructions ? { agent_instructions: input.agentInstructions } : {}),
    own_grants: ownGrantsJson(sql, input.ownGrants ?? { p: principals, w: writers, c: [] }),
  };
  const rows = await sql<FolderRow[]>`INSERT INTO folders ${sql(row)} RETURNING *`;
  return rows[0]!;
}

export async function setFolderAcl(
  sql: Sql,
  folderId: string,
  principals: string[],
  writers: string[],
  inherits: boolean,
  ownGrants: OwnGrantsJson,
): Promise<void> {
  await sql`
    UPDATE folders
    SET acl_principals = ${principals}, acl_writers = ${writers}, inherits_perms = ${inherits},
        own_grants = ${ownGrantsJson(sql, ownGrants)}, updated_at = now()
    WHERE folder_id = ${folderId}`;
}

/**
 * The effective readers and writers a folder passes to its children: the union
 * of its own arrays and each ancestor's, climbing while `inherits_perms` holds.
 */
export async function folderEffectiveAcl(
  sql: Sql,
  folderId: string,
  workspaceId: string,
): Promise<{ principals: string[]; writers: string[] }> {
  const readers = new Set<string>();
  const writers = new Set<string>();
  let currentId: string | null = folderId;
  for (let depth = 0; currentId && depth < MAX_FOLDER_DEPTH; depth++) {
    const rows: FolderRow[] = await sql<FolderRow[]>`
      SELECT * FROM folders WHERE folder_id = ${currentId} AND workspace_id = ${workspaceId}`;
    const f = rows[0];
    if (!f) break;
    for (const p of f.acl_principals) readers.add(p);
    for (const w of f.acl_writers) writers.add(w);
    if (!f.inherits_perms) break;
    currentId = f.parent_id;
  }
  return { principals: [...readers], writers: [...writers] };
}

export async function childInheritingFolders(sql: Sql, parentId: string, workspaceId: string): Promise<FolderRow[]> {
  return sql<FolderRow[]>`
    SELECT * FROM folders
    WHERE parent_id = ${parentId} AND workspace_id = ${workspaceId} AND inherits_perms = TRUE`;
}

/** Live documents directly inside a folder that inherit its permissions. */
export async function childInheritingDocs(sql: Sql, parentId: string, workspaceId: string): Promise<DocRow[]> {
  return sql<DocRow[]>`
    SELECT ${docCols(sql)} FROM docs
    WHERE parent_id = ${parentId} AND workspace_id = ${workspaceId} AND inherits_perms = TRUE AND trashed = FALSE`;
}

/** Folders the principals may see, A→Z by default; folder_id breaks ties. */
export async function listFolders(
  sql: Sql,
  principals: string[],
  workspaceId: string,
  parentId?: string | null,
  opts: { sort?: FolderSortKey; order?: SortOrder; scopeFolderIds?: string[] | null } = {},
): Promise<FolderRow[]> {
  const orderBy = orderClause(FOLDER_SORTS, opts.sort, "title", opts.order, "asc");
  return sql<FolderRow[]>`
    SELECT ${folderCols(sql)} FROM folders
    WHERE workspace_id = ${workspaceId}
      AND acl_principals && ${principals}
      ${opts.scopeFolderIds ? sql`AND folder_id = ANY(${opts.scopeFolderIds})` : sql``}
      ${parentId !== undefined ? sql`AND parent_id ${parentId === null ? sql`IS NULL` : sql`= ${parentId}`}` : sql``}
    ORDER BY ${sql.unsafe(orderBy)}, folder_id`;
}

export async function updateFolder(
  sql: Sql,
  folderId: string,
  patch: { title?: string; parentId?: string | null; agentInstructions?: string },
): Promise<FolderRow | null> {
  const set: Record<string, unknown> = { updated_at: sql`now()` };
  if (patch.title !== undefined) set.title = patch.title;
  if (patch.parentId !== undefined) set.parent_id = patch.parentId;
  if (patch.agentInstructions !== undefined) set.agent_instructions = patch.agentInstructions;
  const rows = await sql<FolderRow[]>`UPDATE folders SET ${sql(set)} WHERE folder_id = ${folderId} RETURNING *`;
  return rows[0] ?? null;
}

/** The chain from the root down to the folder itself, for breadcrumbs. */
export async function getFolderAncestors(sql: Sql, folderId: string, workspaceId: string): Promise<FolderRow[]> {
  const chain: FolderRow[] = [];
  let id: string | null = folderId;
  for (let i = 0; i < MAX_FOLDER_DEPTH && id; i++) {
    const rows: FolderRow[] = await sql<FolderRow[]>`
      SELECT * FROM folders WHERE folder_id = ${id} AND workspace_id = ${workspaceId}`;
    const f: FolderRow | undefined = rows[0];
    if (!f) break;
    chain.unshift(f);
    id = f.parent_id;
  }
  return chain;
}

/** Every folder above these documents in the workspace, up to the root. */
export async function listAncestorFolderIds(sql: Queryable, docIds: string[], workspaceId: string): Promise<string[]> {
  if (docIds.length === 0) return [];
  const rows = await sql<{ folder_id: string }[]>`
    WITH RECURSIVE up(folder_id, depth) AS (
      SELECT parent_id, 0 FROM docs
      WHERE doc_id = ANY(${docIds}) AND workspace_id = ${workspaceId} AND parent_id IS NOT NULL
      UNION
      SELECT f.parent_id, u.depth + 1
      FROM folders f JOIN up u ON f.folder_id = u.folder_id
      WHERE f.parent_id IS NOT NULL AND f.workspace_id = ${workspaceId} AND u.depth < ${MAX_FOLDER_DEPTH}
    )
    SELECT DISTINCT folder_id FROM up`;
  return rows.map((r) => r.folder_id);
}

/** The ids of a folder and all its descendants in the workspace. */
export async function getFolderSubtreeIds(sql: Queryable, folderId: string, workspaceId: string): Promise<string[]> {
  const rows = await sql<{ folder_id: string }[]>`
    WITH RECURSIVE ${folderSubtreeCte(
      sql,
      sql`SELECT folder_id FROM folders WHERE folder_id = ${folderId} AND workspace_id = ${workspaceId}`,
      workspaceId,
    )}
    SELECT DISTINCT folder_id FROM subtree`;
  return rows.map((r) => r.folder_id);
}

/** What deleting a folder would sweep up: live documents and descendant folders, for the confirmation. */
export async function getFolderContentCounts(
  sql: Sql,
  folderId: string,
  workspaceId: string,
): Promise<{ docs: number; folders: number }> {
  const ids = await getFolderSubtreeIds(sql, folderId, workspaceId);
  if (ids.length === 0) return { docs: 0, folders: 0 };
  const rows = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM docs
    WHERE parent_id = ANY(${ids}) AND workspace_id = ${workspaceId} AND trashed = FALSE`;
  return { docs: rows[0]?.n ?? 0, folders: ids.length - 1 };
}

/**
 * Delete a folder's whole subtree and move its live documents to the trash,
 * atomically. Documents already in the trash keep their trashed_at, so their
 * retention clock is not reset. Locked documents stay and become top-level
 * through the folder's ON DELETE SET NULL.
 */
export async function deleteFolderCascade(
  sql: Sql,
  folderId: string,
  workspaceId: string,
): Promise<{ folderIds: string[]; trashedDocIds: string[] }> {
  return sql.begin(async (tx) => {
    const folderIds = await getFolderSubtreeIds(tx, folderId, workspaceId);
    if (folderIds.length === 0) return { folderIds: [], trashedDocIds: [] };

    // Before the folders go: parent_id is what finds these documents.
    const trashed = await tx<{ doc_id: string }[]>`
      UPDATE docs
      SET trashed = TRUE, trashed_at = now(), updated_at = now()
      WHERE parent_id = ANY(${folderIds}) AND workspace_id = ${workspaceId}
        AND trashed = FALSE AND locked = FALSE
      RETURNING doc_id`;

    await tx`DELETE FROM folders WHERE folder_id = ANY(${folderIds}) AND workspace_id = ${workspaceId}`;

    return { folderIds, trashedDocIds: trashed.map((r) => r.doc_id) };
  });
}
