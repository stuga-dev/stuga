import type { DocRow, FolderRow, OwnGrantsJson } from "./types.js";
import type { ReviewMode } from "@stuga/protocol/domain/events";
import {
  FOLDER_COLUMNS,
  MAX_FOLDER_DEPTH,
  docCols,
  docLevelJoins,
  folderCols,
  folderLevelJoin,
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
  const rows = await sql<FolderRow[]>`SELECT ${folderCols(sql)} FROM folders WHERE folder_id = ${folderId}`;
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
  const rows = await sql<FolderRow[]>`INSERT INTO folders ${sql(row)} RETURNING ${folderCols(sql)}`;
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

/** What folderEffectiveAcl reads of each folder it climbs. */
type AclLink = Pick<FolderRow, "parent_id" | "acl_principals" | "acl_writers" | "inherits_perms">;

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
    const rows: AclLink[] = await sql<AclLink[]>`
      SELECT parent_id, acl_principals, acl_writers, inherits_perms
      FROM folders WHERE folder_id = ${currentId} AND workspace_id = ${workspaceId}`;
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
    SELECT ${folderCols(sql, "f", { joined: true })} FROM folders f ${folderLevelJoin(sql, "f")}
    WHERE parent_id = ${parentId} AND workspace_id = ${workspaceId} AND inherits_perms = TRUE`;
}

/** Live documents directly inside a folder that inherit its permissions. */
export async function childInheritingDocs(sql: Sql, parentId: string, workspaceId: string): Promise<DocRow[]> {
  return sql<DocRow[]>`
    SELECT ${docCols(sql, "d", { joined: true })} FROM docs d ${docLevelJoins(sql, "d")}
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
    SELECT ${folderCols(sql, "f", { joined: true })} FROM folders f ${folderLevelJoin(sql, "f")}
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
  const rows = await sql<FolderRow[]>`UPDATE folders SET ${sql(set)} WHERE folder_id = ${folderId} RETURNING ${folderCols(sql)}`;
  return rows[0] ?? null;
}

/**
 * The chain from the root down to the folder itself, for breadcrumbs, move checks and review levels,
 * read in one query; each folder's `parent_agent_mode` is worked out from the chain above it. No ACL
 * applies: a caller that shows it redacts the ancestors its reader cannot read.
 */
export async function getFolderAncestors(sql: Queryable, folderId: string, workspaceId: string): Promise<FolderRow[]> {
  const rawCols = sql.unsafe(FOLDER_COLUMNS.map((c) => `f.${c}`).join(", "));
  const rows = await sql<Array<Omit<FolderRow, "parent_agent_mode"> & { depth: number }>>`
    WITH RECURSIVE up AS (
      SELECT ${rawCols}, 0 AS depth
      FROM folders f WHERE f.folder_id = ${folderId} AND f.workspace_id = ${workspaceId}
      UNION ALL
      SELECT ${rawCols}, u.depth + 1
      FROM folders f JOIN up u ON f.folder_id = u.parent_id
      WHERE f.workspace_id = ${workspaceId} AND u.depth < ${MAX_FOLDER_DEPTH - 1}
    )
    SELECT * FROM up ORDER BY depth DESC`;
  const chain: FolderRow[] = [];
  // Above the chain's top there is nothing, unless the chain was cut short at the depth limit.
  let above: ReviewMode | null = null;
  const top = rows[0];
  if (top?.parent_id) {
    const [r] = await sql<{ mode: ReviewMode | null }[]>`SELECT folder_agent_mode(${top.parent_id}::text) AS mode`;
    above = r?.mode ?? null;
  }
  for (const { depth: _depth, ...f } of rows) {
    chain.push({ ...f, parent_agent_mode: above });
    // What the next folder down inherits: the nearest level set, this folder's own first.
    above = f.agent_mode ?? above;
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

/**
 * What deleting a folder would sweep up, for the confirmation: live documents and descendant folders,
 * and how many of those documents are locked, which keeps the folder from being deleted.
 */
export async function getFolderContentCounts(
  sql: Sql,
  folderId: string,
  workspaceId: string,
): Promise<{ docs: number; folders: number; locked: number }> {
  const ids = await getFolderSubtreeIds(sql, folderId, workspaceId);
  if (ids.length === 0) return { docs: 0, folders: 0, locked: 0 };
  const rows = await sql<{ n: number; locked: number }[]>`
    SELECT count(*)::int AS n, count(*) FILTER (WHERE locked)::int AS locked FROM docs
    WHERE parent_id = ANY(${ids}) AND workspace_id = ${workspaceId} AND trashed = FALSE`;
  return { docs: rows[0]?.n ?? 0, folders: ids.length - 1, locked: rows[0]?.locked ?? 0 };
}

/**
 * Delete a folder's whole subtree and move every live document in it to the
 * trash, atomically, or nothing when one of them is locked (`locked` counts
 * them): a lock keeps a document from being deleted, in a folder or not.
 * Documents already in the trash keep their trashed_at, so their retention
 * clock is not reset. Every document in the subtree is filed in the deleted
 * folder's parent (the top level for a top-level folder), where restoring it
 * puts it, so deleting a folder never takes what was in it out from under a
 * level or approver group a folder above sets.
 */
export async function deleteFolderCascade(
  sql: Sql,
  folderId: string,
  workspaceId: string,
): Promise<{ folderIds: string[]; trashedDocIds: string[]; trashedDocs: Array<{ doc_id: string; doc_type: "prose" | "database" }>; locked: number }> {
  return sql.begin(async (tx) => {
    const folderIds = await getFolderSubtreeIds(tx, folderId, workspaceId);
    if (folderIds.length === 0) return { folderIds: [], trashedDocIds: [], trashedDocs: [], locked: 0 };

    const [lockedRow] = await tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM docs
      WHERE parent_id = ANY(${folderIds}) AND workspace_id = ${workspaceId} AND trashed = FALSE AND locked`;
    const locked = lockedRow?.n ?? 0;
    if (locked > 0) return { folderIds: [], trashedDocIds: [], trashedDocs: [], locked };

    // Before the folders go: parent_id is what finds these documents.
    const trashed = await tx<{ doc_id: string; doc_type: "prose" | "database" }[]>`
      UPDATE docs
      SET trashed = TRUE, trashed_at = now(), updated_at = now()
      WHERE parent_id = ANY(${folderIds}) AND workspace_id = ${workspaceId} AND trashed = FALSE
      RETURNING doc_id, doc_type`;
    await tx`
      UPDATE docs
      SET parent_id = (SELECT parent_id FROM folders WHERE folder_id = ${folderId} AND workspace_id = ${workspaceId})
      WHERE parent_id = ANY(${folderIds}) AND workspace_id = ${workspaceId}`;

    await tx`DELETE FROM folders WHERE folder_id = ANY(${folderIds}) AND workspace_id = ${workspaceId}`;

    return { folderIds, trashedDocIds: trashed.map((r) => r.doc_id), trashedDocs: trashed.map(({ doc_id, doc_type }) => ({ doc_id, doc_type })), locked: 0 };
  });
}
