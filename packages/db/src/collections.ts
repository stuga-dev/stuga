/** Collections: a person's retrieval scopes over documents and folders. They can only narrow what the ACL allows. */
import type { Fragment } from "postgres";
import type { CollectionItemRow, CollectionRow, CollectionSummary } from "./types.js";
import { folderSubtreeCte, type Queryable } from "./sql.js";
import type { Sql } from "./client.js";

const COLLECTION_COLS = "collection_id, workspace_id, owner, name, created_at, updated_at";

export async function createCollection(
  sql: Sql,
  input: { collectionId: string; workspaceId: string; owner: string; name: string },
): Promise<CollectionRow> {
  const rows = await sql<CollectionRow[]>`
    INSERT INTO collections ${sql({
      collection_id: input.collectionId,
      workspace_id: input.workspaceId,
      owner: input.owner,
      name: input.name,
    })}
    RETURNING ${sql.unsafe(COLLECTION_COLS)}`;
  return rows[0]!;
}

/** What a caller reaches when a collection's members are counted, listed or changed. */
export interface CollectionReach {
  principals: string[];
  workspaceId: string;
  /** A folder-scoped key's folders, subtrees expanded; null when the caller is not confined. */
  scopeFolderIds: string[] | null;
}

/** Joins `d` and `f` to the members `ci` the reach may read; an unreadable member leaves both null. */
function readableMemberJoins(sql: Queryable, reach: CollectionReach): Fragment {
  const folders = reach.scopeFolderIds;
  return sql`
    LEFT JOIN docs d ON d.doc_id = ci.doc_id
      AND d.workspace_id = ${reach.workspaceId}
      AND d.trashed = FALSE
      AND d.acl_principals && ${reach.principals}
      ${folders ? sql`AND d.parent_id = ANY(${folders})` : sql``}
    LEFT JOIN folders f ON f.folder_id = ci.folder_id
      AND f.workspace_id = ${reach.workspaceId}
      AND f.acl_principals && ${reach.principals}
      ${folders ? sql`AND f.folder_id = ANY(${folders})` : sql``}`;
}

/** A person's collections in a workspace; `item_count` counts only the members the reach can read. */
export async function listCollections(sql: Sql, owner: string, reach: CollectionReach): Promise<CollectionSummary[]> {
  return sql<CollectionSummary[]>`
    SELECT c.collection_id, c.workspace_id, c.owner, c.name, c.created_at, c.updated_at,
           (COUNT(d.doc_id) + COUNT(f.folder_id))::int AS item_count
    FROM collections c
    LEFT JOIN collection_items ci ON ci.collection_id = c.collection_id
    ${readableMemberJoins(sql, reach)}
    WHERE c.owner = ${owner} AND c.workspace_id = ${reach.workspaceId}
    GROUP BY c.collection_id
    ORDER BY c.updated_at DESC
    LIMIT 200`;
}

/** Whether the reach can read every member, so renaming or deleting the collection touches nothing it cannot see. */
export async function readsEveryMember(sql: Sql, collectionId: string, reach: CollectionReach): Promise<boolean> {
  const rows = await sql<{ hidden: number }[]>`
    SELECT (COUNT(*) - COUNT(d.doc_id) - COUNT(f.folder_id))::int AS hidden
    FROM collection_items ci
    ${readableMemberJoins(sql, reach)}
    WHERE ci.collection_id = ${collectionId}`;
  return rows[0]!.hidden === 0;
}

/** Unchecked: the caller verifies workspace and owner. */
export async function getCollection(sql: Sql, collectionId: string): Promise<CollectionRow | null> {
  const rows = await sql<CollectionRow[]>`
    SELECT ${sql.unsafe(COLLECTION_COLS)} FROM collections WHERE collection_id = ${collectionId}`;
  return rows[0] ?? null;
}

export async function renameCollection(sql: Sql, collectionId: string, name: string): Promise<CollectionRow | null> {
  const rows = await sql<CollectionRow[]>`
    UPDATE collections SET name = ${name}, updated_at = now()
    WHERE collection_id = ${collectionId}
    RETURNING ${sql.unsafe(COLLECTION_COLS)}`;
  return rows[0] ?? null;
}

export async function deleteCollection(sql: Sql, collectionId: string): Promise<void> {
  await sql`DELETE FROM collections WHERE collection_id = ${collectionId}`;
}

/** The members the reach can read, oldest first, each with its current title. */
export async function listCollectionItems(sql: Sql, collectionId: string, reach: CollectionReach): Promise<CollectionItemRow[]> {
  return sql<CollectionItemRow[]>`
    SELECT ci.doc_id, ci.folder_id,
           COALESCE(d.title, f.title, '') AS title,
           ci.added_at
    FROM collection_items ci
    ${readableMemberJoins(sql, reach)}
    WHERE ci.collection_id = ${collectionId}
      AND (d.doc_id IS NOT NULL OR f.folder_id IS NOT NULL)
    ORDER BY ci.added_at ASC`;
}

/** The subset of these ids the reach can read, by the same rule as listCollectionItems. */
export async function filterVisibleRefs(
  sql: Sql,
  reach: CollectionReach,
  docIds: string[],
  folderIds: string[],
): Promise<{ docIds: string[]; folderIds: string[] }> {
  const folders = reach.scopeFolderIds;
  const docRows = docIds.length
    ? await sql<{ doc_id: string }[]>`
        SELECT doc_id FROM docs
        WHERE doc_id = ANY(${docIds}) AND workspace_id = ${reach.workspaceId}
          AND trashed = FALSE AND acl_principals && ${reach.principals}
          ${folders ? sql`AND parent_id = ANY(${folders})` : sql``}`
    : [];
  const folderRows = folderIds.length
    ? await sql<{ folder_id: string }[]>`
        SELECT folder_id FROM folders
        WHERE folder_id = ANY(${folderIds}) AND workspace_id = ${reach.workspaceId}
          AND acl_principals && ${reach.principals}
          ${folders ? sql`AND folder_id = ANY(${folders})` : sql``}`
    : [];
  return { docIds: docRows.map((r) => r.doc_id), folderIds: folderRows.map((r) => r.folder_id) };
}

/** Batch add, idempotent; the number of new members. The caller filters for visibility first (filterVisibleRefs). */
export async function addCollectionItems(
  sql: Sql,
  collectionId: string,
  refs: { docIds?: string[]; folderIds?: string[] },
): Promise<number> {
  const docIds = refs.docIds ?? [];
  const folderIds = refs.folderIds ?? [];
  if (docIds.length === 0 && folderIds.length === 0) return 0;
  let added = 0;
  if (docIds.length) {
    const rows = await sql`
      INSERT INTO collection_items (collection_id, doc_id)
      SELECT ${collectionId}, d FROM unnest(${docIds}::text[]) AS d
      ON CONFLICT DO NOTHING`;
    added += rows.count;
  }
  if (folderIds.length) {
    const rows = await sql`
      INSERT INTO collection_items (collection_id, folder_id)
      SELECT ${collectionId}, f FROM unnest(${folderIds}::text[]) AS f
      ON CONFLICT DO NOTHING`;
    added += rows.count;
  }
  await sql`UPDATE collections SET updated_at = now() WHERE collection_id = ${collectionId}`;
  return added;
}

/** The number of members removed. */
export async function removeCollectionItems(
  sql: Sql,
  collectionId: string,
  refs: { docIds?: string[]; folderIds?: string[] },
): Promise<number> {
  const docIds = refs.docIds ?? [];
  const folderIds = refs.folderIds ?? [];
  if (docIds.length === 0 && folderIds.length === 0) return 0;
  let removed = 0;
  if (docIds.length) {
    removed += (await sql`DELETE FROM collection_items WHERE collection_id = ${collectionId} AND doc_id = ANY(${docIds})`).count;
  }
  if (folderIds.length) {
    removed += (await sql`DELETE FROM collection_items WHERE collection_id = ${collectionId} AND folder_id = ANY(${folderIds})`).count;
  }
  await sql`UPDATE collections SET updated_at = now() WHERE collection_id = ${collectionId}`;
  return removed;
}

/**
 * The live doc ids a collection resolves to for this reach: direct members
 * plus everything under member folders, through the same ACL and folder gates
 * as search. An empty result means the scope holds nothing visible, never "everything".
 */
export async function expandCollectionScope(sql: Sql, collectionId: string, reach: CollectionReach): Promise<string[]> {
  const { principals, workspaceId, scopeFolderIds: folders } = reach;
  const memberFolders = sql`
    SELECT f.folder_id
    FROM collection_items ci
    JOIN collections c ON c.collection_id = ci.collection_id
    JOIN folders f ON f.folder_id = ci.folder_id
    WHERE ci.collection_id = ${collectionId}
      AND c.workspace_id = ${workspaceId}
      AND f.workspace_id = ${workspaceId}`;
  const rows = await sql<{ doc_id: string }[]>`
    WITH RECURSIVE
      ${folderSubtreeCte(sql, memberFolders, workspaceId)},
      scope_docs AS (
        SELECT doc_id FROM collection_items
        WHERE collection_id = ${collectionId} AND doc_id IS NOT NULL
        UNION
        SELECT d.doc_id FROM docs d JOIN subtree s ON d.parent_id = s.folder_id
      )
    SELECT DISTINCT d.doc_id
    FROM scope_docs sd JOIN docs d ON d.doc_id = sd.doc_id
    WHERE d.workspace_id = ${workspaceId}
      AND d.trashed = FALSE
      AND d.acl_principals && ${principals}
      ${folders ? sql`AND d.parent_id = ANY(${folders})` : sql``}`;
  return rows.map((r) => r.doc_id);
}
