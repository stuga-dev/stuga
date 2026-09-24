import type { DocRow } from "./types.js";
import { docCols } from "./sql.js";
import type { Sql } from "./client.js";

/**
 * The caller's starred doc ids in one workspace. Not ACL- or trash-gated: these
 * drive the star toggle, and a star on a document the caller lost must stay
 * clearable. The favorites table has no workspace column, so the tenant gate
 * joins docs.
 */
export async function listFavorites(sql: Sql, userAlias: string, workspaceId: string): Promise<string[]> {
  const rows = await sql<{ doc_id: string }[]>`
    SELECT f.doc_id
    FROM favorites f
    JOIN docs d ON d.doc_id = f.doc_id
    WHERE f.user_alias = ${userAlias}
      AND d.workspace_id = ${workspaceId}`;
  return rows.map((r) => r.doc_id);
}

/** The Favorites view: every starred document the caller can still see, live ones only, unbounded. */
export async function listFavoriteDocs(
  sql: Sql,
  userAlias: string,
  principals: string[],
  workspaceId: string,
): Promise<DocRow[]> {
  return sql<DocRow[]>`
    SELECT ${docCols(sql, "d")}
    FROM favorites f
    JOIN docs d ON d.doc_id = f.doc_id
    WHERE f.user_alias = ${userAlias}
      AND d.workspace_id = ${workspaceId}
      AND d.acl_principals && ${principals}
      AND d.trashed = FALSE
    ORDER BY d.updated_at DESC`;
}

export async function addFavorite(sql: Sql, userAlias: string, docId: string): Promise<void> {
  await sql`INSERT INTO favorites ${sql({ user_alias: userAlias, doc_id: docId })} ON CONFLICT DO NOTHING`;
}

export async function removeFavorite(sql: Sql, userAlias: string, docId: string): Promise<void> {
  await sql`DELETE FROM favorites WHERE user_alias = ${userAlias} AND doc_id = ${docId}`;
}
