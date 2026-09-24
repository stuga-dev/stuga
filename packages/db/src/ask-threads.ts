/** Saved cross-document research conversations, private to their owner within a workspace. */
import type { AskThreadRow, AskThreadSummary, AskTurnRow } from "./types.js";
import { daysAgo, jsonb } from "./sql.js";
import type { Sql } from "./client.js";

export async function createAskThread(
  sql: Sql,
  input: { threadId: string; workspaceId: string; owner: string; title?: string; collectionId?: string | null },
): Promise<AskThreadRow> {
  const rows = await sql<AskThreadRow[]>`
    INSERT INTO ask_threads (thread_id, workspace_id, owner, title, collection_id)
    VALUES (${input.threadId}, ${input.workspaceId}, ${input.owner}, ${input.title ?? ""}, ${input.collectionId ?? null})
    RETURNING *`;
  return rows[0]!;
}

/** The owner's threads in a workspace, newest activity first. */
export async function listAskThreads(sql: Sql, workspaceId: string, owner: string, limit = 100): Promise<AskThreadSummary[]> {
  return sql<AskThreadSummary[]>`
    SELECT t.*,
           COALESCE(c.n, 0)::int AS turn_count,
           last_q.question       AS last_question
    FROM ask_threads t
    LEFT JOIN LATERAL (SELECT count(*) AS n FROM ask_turns WHERE thread_id = t.thread_id) c ON TRUE
    LEFT JOIN LATERAL (
      SELECT question FROM ask_turns WHERE thread_id = t.thread_id ORDER BY seq DESC LIMIT 1
    ) last_q ON TRUE
    WHERE t.workspace_id = ${workspaceId} AND t.owner = ${owner}
    ORDER BY t.updated_at DESC
    LIMIT ${limit}`;
}

/** Unchecked: the caller verifies workspace and owner. */
export async function getAskThread(sql: Sql, threadId: string): Promise<AskThreadRow | null> {
  const rows = await sql<AskThreadRow[]>`SELECT * FROM ask_threads WHERE thread_id = ${threadId}`;
  return rows[0] ?? null;
}

export async function listAskTurns(sql: Sql, threadId: string): Promise<AskTurnRow[]> {
  return sql<AskTurnRow[]>`SELECT * FROM ask_turns WHERE thread_id = ${threadId} ORDER BY seq`;
}

/** Append one exchange and bump the thread's activity time, atomically. */
export async function appendAskTurn(
  sql: Sql,
  input: {
    threadId: string;
    question: string;
    answer: string;
    citations: unknown[];
    steps: unknown[];
    model: string;
    rounds: number;
    stopReason: string;
    inputTokens: number;
    outputTokens: number;
  },
): Promise<AskTurnRow> {
  return sql.begin(async (tx) => {
    // Locking the thread serializes appends: MAX(seq) + 1 alone collides under READ COMMITTED.
    await tx`SELECT 1 FROM ask_threads WHERE thread_id = ${input.threadId} FOR UPDATE`;
    const rows = await tx<AskTurnRow[]>`
      INSERT INTO ask_turns
        (thread_id, seq, question, answer, citations, steps, model, rounds, stop_reason, input_tokens, output_tokens)
      SELECT ${input.threadId},
             COALESCE(MAX(seq), 0) + 1,
             ${input.question},
             ${input.answer},
             ${jsonb(tx, input.citations)},
             ${jsonb(tx, input.steps)},
             ${input.model},
             ${input.rounds},
             ${input.stopReason},
             ${input.inputTokens},
             ${input.outputTokens}
      FROM ask_turns WHERE thread_id = ${input.threadId}
      RETURNING *`;
    await tx`UPDATE ask_threads SET updated_at = now() WHERE thread_id = ${input.threadId}`;
    return rows[0]!;
  });
}

export async function renameAskThread(sql: Sql, threadId: string, title: string): Promise<AskThreadRow | null> {
  const rows = await sql<AskThreadRow[]>`
    UPDATE ask_threads SET title = ${title}, updated_at = now()
    WHERE thread_id = ${threadId} RETURNING *`;
  return rows[0] ?? null;
}

/** Title a thread from its first question without overwriting a title someone set. */
export async function setAskThreadTitleIfEmpty(sql: Sql, threadId: string, title: string): Promise<void> {
  await sql`UPDATE ask_threads SET title = ${title} WHERE thread_id = ${threadId} AND title = ''`;
}

export async function deleteAskThread(sql: Sql, threadId: string): Promise<void> {
  await sql`DELETE FROM ask_threads WHERE thread_id = ${threadId}`;
}

/** Delete threads with no activity for `olderThanDays`, turns included. */
export async function purgeAskThreads(sql: Sql, olderThanDays: number): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    WITH gone AS (
      DELETE FROM ask_threads
      WHERE updated_at < ${daysAgo(sql, olderThanDays)}
      RETURNING 1
    )
    SELECT count(*)::int AS n FROM gone`;
  return row?.n ?? 0;
}
