/** Each person's bookmarks to other Stuga nodes, for the workspace switcher. Nothing here is verified or shared. */
import type { UserNodeRow } from "./types.js";
import type { Sql } from "./client.js";

/** A person's bookmarks, in the order they were added. */
export async function listUserNodes(sql: Sql, alias: string): Promise<UserNodeRow[]> {
  return sql<UserNodeRow[]>`
    SELECT id, label, origin FROM user_nodes
    WHERE alias = ${alias}
    ORDER BY position, created_at, id`;
}

export type AddUserNodeResult = { ok: true; node: UserNodeRow } | { ok: false; reason: "already_added" | "limit_reached" };

/** Append a bookmark, unless the person already has this origin or `max` bookmarks. */
export async function addUserNode(
  sql: Sql,
  input: { id: string; alias: string; label: string; origin: string },
  max: number,
): Promise<AddUserNodeResult> {
  return (await sql.begin(async (tx) => {
    // Serializes one person's adds, so the cap and the next position hold under concurrent requests.
    await tx`SELECT pg_advisory_xact_lock(hashtext(${"user_nodes:" + input.alias}))`;
    const [held] = await tx<{ count: number; duplicate: boolean; next: number }[]>`
      SELECT COUNT(*)::int AS count,
             COALESCE(bool_or(origin = ${input.origin}), FALSE) AS duplicate,
             COALESCE(MAX(position), 0) + 1 AS next
      FROM user_nodes WHERE alias = ${input.alias}`;
    if (held!.duplicate) return { ok: false, reason: "already_added" };
    if (held!.count >= max) return { ok: false, reason: "limit_reached" };
    const rows = await tx<UserNodeRow[]>`
      INSERT INTO user_nodes ${tx({
        id: input.id,
        alias: input.alias,
        label: input.label,
        origin: input.origin,
        position: held!.next,
      })}
      RETURNING id, label, origin`;
    return { ok: true, node: rows[0]! };
  })) as AddUserNodeResult;
}

/** Whether a bookmark of this person's was removed; another person's id removes nothing. */
export async function removeUserNode(sql: Sql, alias: string, id: string): Promise<boolean> {
  const rows = await sql`DELETE FROM user_nodes WHERE id = ${id} AND alias = ${alias}`;
  return rows.count > 0;
}
