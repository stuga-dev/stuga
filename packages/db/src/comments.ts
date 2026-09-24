import type { CommentRow } from "./types.js";
import { jsonb } from "./sql.js";
import type { Sql } from "./client.js";

export async function listComments(sql: Sql, docId: string): Promise<CommentRow[]> {
  return sql<CommentRow[]>`SELECT * FROM comments WHERE doc_id = ${docId} ORDER BY num ASC`;
}

export async function getComment(sql: Sql, docId: string, num: number): Promise<CommentRow | null> {
  const rows = await sql<CommentRow[]>`SELECT * FROM comments WHERE doc_id = ${docId} AND num = ${num}`;
  return rows[0] ?? null;
}

/** A reply (`parentNum` set) is stored without an anchor; the thread's anchor lives on its root. */
export async function addComment(
  sql: Sql,
  c: {
    docId: string;
    author: string;
    body: string;
    parentNum?: number | null;
    anchorStart?: string | null;
    anchorEnd?: string | null;
    anchorQuote?: string | null;
    mentions?: CommentRow["mentions"];
  },
): Promise<CommentRow> {
  const parentNum = c.parentNum ?? null;
  const anchorStart = parentNum === null ? (c.anchorStart ?? null) : null;
  const anchorEnd = parentNum === null ? (c.anchorEnd ?? null) : null;
  const anchorQuote = parentNum === null ? (c.anchorQuote ?? null) : null;
  return sql.begin(async (tx) => {
    // Serializes the per-document MAX(num) read, which READ COMMITTED would not.
    await tx`SELECT pg_advisory_xact_lock(hashtext(${c.docId}))`;
    const rows = await tx<CommentRow[]>`
      WITH n AS (
        SELECT COALESCE(MAX(num), 0) + 1 AS num FROM comments WHERE doc_id = ${c.docId}
      )
      INSERT INTO comments (doc_id, num, parent_num, author, body, anchor_start, anchor_end, anchor_quote, mentions)
      SELECT ${c.docId}, n.num, ${parentNum}, ${c.author}, ${c.body},
             ${anchorStart}, ${anchorEnd}, ${anchorQuote}, ${jsonb(tx, c.mentions ?? [])} FROM n
      RETURNING *`;
    return rows[0]!;
  });
}

export async function setCommentResolved(sql: Sql, docId: string, num: number, resolved: boolean): Promise<CommentRow | null> {
  const rows = await sql<CommentRow[]>`
    UPDATE comments SET resolved = ${resolved}, updated_at = now()
    WHERE doc_id = ${docId} AND num = ${num}
    RETURNING *`;
  return rows[0] ?? null;
}

/** Replies go with their root through the foreign key. */
export async function deleteComment(sql: Sql, docId: string, num: number): Promise<boolean> {
  const rows = await sql`DELETE FROM comments WHERE doc_id = ${docId} AND num = ${num} RETURNING num`;
  return rows.count > 0;
}

/**
 * Replace a document's mention set with `aliases` and return the ones that were
 * not in it before. Serialized per document, so two index jobs racing on one
 * document cannot both report the same person as new.
 */
export async function syncDocMentions(sql: Sql, docId: string, aliases: string[]): Promise<string[]> {
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${"doc_mentions:" + docId}))`;
    await tx`DELETE FROM doc_mentions WHERE doc_id = ${docId} AND NOT (alias = ANY(${aliases}))`;
    if (aliases.length === 0) return [];
    const added = await tx<{ alias: string }[]>`
      INSERT INTO doc_mentions (doc_id, alias)
      SELECT ${docId}, a FROM unnest(${aliases}::text[]) AS a
      ON CONFLICT DO NOTHING
      RETURNING alias`;
    const fresh = new Set(added.map((r) => r.alias));
    return aliases.filter((a) => fresh.has(a));
  }) as Promise<string[]>;
}
