import type { Sql } from "../client.js";

/** Create these workspaces if missing, so tenant rows can reference them. */
export async function seedWorkspaces(sql: Sql, ...ids: string[]): Promise<void> {
  for (const id of ids) {
    await sql`INSERT INTO workspaces (workspace_id, name) VALUES (${id}, ${id}) ON CONFLICT (workspace_id) DO NOTHING`;
  }
}

let seeded = 0;

/**
 * A directory row, as an account's creation writes one. The username defaults
 * to one unrelated to the alias, so a lookup by handle never matches it by accident.
 */
export async function seedUser(
  sql: Sql,
  alias: string,
  displayName: string,
  email: string | null = null,
  username: string = `seed-${++seeded}`,
): Promise<void> {
  await sql`INSERT INTO users ${sql({ alias, username, display_name: displayName, email })}`;
}
