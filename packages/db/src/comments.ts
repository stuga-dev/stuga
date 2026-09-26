import type { CommentRow } from "./types.js";
import { jsonb } from "./sql.js";
import type { Sql } from "./client.js";

export async function listComments(sql: Sql, docId: string): Promise<CommentRow[]> {
  return sql<CommentRow[]>`SELECT * FROM comments WHERE doc_id = ${docId} ORDER BY num ASC`;
}

/** The workspace's live documents with more than `max` comments, and how many each has: what an export checks first. */
export async function listDocsWithCommentsOver(sql: Sql, workspaceId: string, max: number): Promise<Array<{ doc_id: string; comments: number }>> {
  return sql<Array<{ doc_id: string; comments: number }>>`
    SELECT c.doc_id, count(*)::int AS comments
    FROM comments c JOIN docs d ON d.doc_id = c.doc_id
    WHERE d.workspace_id = ${workspaceId} AND d.trashed = FALSE
    GROUP BY c.doc_id
    HAVING count(*) > ${max}
    ORDER BY c.doc_id`;
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

/** A comment's author when it came from a workspace archive: the name it carried, never an account. */
export const IMPORTED_AUTHOR_PREFIX = "imported:";

/** One comment as an archive carries it; `parentNum` names another in the same batch. */
export interface ImportedComment {
  num: number;
  parentNum: number | null;
  authorName: string;
  body: string;
  anchorQuote: string | null;
  resolved: boolean;
  /** ISO 8601. */
  createdAt: string;
}

/**
 * Add a document's comments from an archive in one transaction, numbered after
 * any it has, keeping their times, threads and resolution. They mention no one
 * and carry no anchor, since an anchor does not survive a new document; the
 * quote stays. Roots come before their replies.
 */
export async function importComments(sql: Sql, docId: string, comments: ImportedComment[]): Promise<void> {
  if (comments.length === 0) return;
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${docId}))`;
    const counted = await tx<{ base: number }[]>`SELECT COALESCE(MAX(num), 0)::int AS base FROM comments WHERE doc_id = ${docId}`;
    const base = counted[0]!.base;
    const nums = new Map<number, number>();
    const rows = comments.map((c, i) => {
      const parentNum = c.parentNum === null ? null : nums.get(c.parentNum);
      if (parentNum === undefined) throw new Error(`comment ${c.num} replies to ${c.parentNum}, which is not before it`);
      nums.set(c.num, base + i + 1);
      return {
        doc_id: docId,
        num: base + i + 1,
        parent_num: parentNum,
        author: `${IMPORTED_AUTHOR_PREFIX}${c.authorName}`,
        body: c.body,
        anchor_quote: parentNum === null ? c.anchorQuote : null,
        resolved: c.resolved,
        created_at: c.createdAt,
        updated_at: c.createdAt,
      };
    });
    // Roots first, so each reply's foreign key finds its root.
    for (const chunk of [rows.filter((r) => r.parent_num === null), rows.filter((r) => r.parent_num !== null)]) {
      for (let at = 0; at < chunk.length; at += 1000) await tx`INSERT INTO comments ${tx(chunk.slice(at, at + 1000))}`;
    }
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
