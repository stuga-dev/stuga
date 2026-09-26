/**
 * What the node re-asserts on every boot, unlike a migration, which runs once:
 * the server's extension files can change under an existing database at any
 * restart, and a restart can stop a rebuild of the search indexes midway.
 */
import type { Sql } from "../client.js";
import { reconcileSearchIndexes, type SearchLanguage } from "./search-indexes.js";

export interface RepairOutcome {
  /** Extensions whose catalog entries were brought up to the installed files. */
  updatedExtensions: string[];
  /** BM25 indexes this boot created (`+name`) or dropped (`-name`). */
  searchIndexChanges: string[];
  /** BM25 indexes this boot rebuilt: SearchIndexRepair.rebuilt. */
  rebuiltSearchIndexes: string[];
}

const EXTENSION_NAME = /^[a-z_][a-z0-9_]*$/;

export async function runBootRepairs(
  sql: Sql,
  opts: { searchLanguages?: readonly SearchLanguage[] } = {},
): Promise<RepairOutcome> {
  // An upgraded extension binary keeps running against the old catalog entries
  // until ALTER EXTENSION UPDATE brings them level.
  const stale = await sql<{ extname: string }[]>`
    SELECT e.extname
    FROM pg_extension e
    JOIN pg_available_extensions a ON a.name = e.extname
    WHERE e.extversion IS DISTINCT FROM a.default_version`;

  const updated: string[] = [];
  for (const { extname } of stale) {
    if (!EXTENSION_NAME.test(extname)) continue;
    // An extension without an update path must not stop the node booting.
    try {
      await sql.unsafe(`ALTER EXTENSION "${extname}" UPDATE`);
      updated.push(extname);
    } catch {
      // left at its installed version; the next boot tries again
    }
  }

  // After the extension sweep, so the indexes are built against the updated pg_search.
  const search = await reconcileSearchIndexes(sql, opts.searchLanguages ?? []);

  return { updatedExtensions: updated, searchIndexChanges: search.changes, rebuiltSearchIndexes: search.rebuilt };
}
