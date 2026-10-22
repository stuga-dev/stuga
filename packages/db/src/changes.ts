/**
 * Changes: the runs one agent makes across several pages for one piece of work, reviewed as one, and
 * the new pages it made where AI edits wait for a colleague, held until approved.
 */
import type { Sql } from "./client.js";
import { daysAgo, ownGrantsJson, type Queryable } from "./sql.js";
import type { OwnGrantsJson, WikiChangePageRow, WikiChangeRow, WikiChangeRunRow } from "./types.js";

export interface NewChange {
  changeId: string;
  workspaceId: string;
  title: string;
  summary: string;
  agent: string;
  agentAlias: string;
  onBehalfOf: string;
  client: string | null;
  model: string | null;
}

export async function createChange(sql: Queryable, c: NewChange): Promise<WikiChangeRow> {
  const rows = await sql<WikiChangeRow[]>`
    INSERT INTO wiki_changes (change_id, workspace_id, title, summary, agent, agent_alias, on_behalf_of, client, model)
    VALUES (${c.changeId}, ${c.workspaceId}, ${c.title}, ${c.summary}, ${c.agent}, ${c.agentAlias}, ${c.onBehalfOf}, ${c.client}, ${c.model})
    RETURNING *`;
  return rows[0]!;
}

export async function getChange(sql: Queryable, changeId: string): Promise<WikiChangeRow | null> {
  const rows = await sql<WikiChangeRow[]>`SELECT * FROM wiki_changes WHERE change_id = ${changeId}`;
  return rows[0] ?? null;
}

/** The changes with these ids, in one read. */
export async function getChanges(sql: Queryable, changeIds: readonly string[]): Promise<WikiChangeRow[]> {
  if (changeIds.length === 0) return [];
  return sql<WikiChangeRow[]>`SELECT * FROM wiki_changes WHERE change_id = ANY(${[...changeIds]})`;
}

/** A later write's word on the change: its summary when given, the labels it came with. */
export async function touchChange(sql: Queryable, changeId: string, patch: { summary?: string; client?: string | null; model?: string | null }): Promise<void> {
  await sql`
    UPDATE wiki_changes SET
      summary = coalesce(${patch.summary ?? null}, summary),
      client = coalesce(${patch.client ?? null}, client),
      model = coalesce(${patch.model ?? null}, model),
      updated_at = now()
    WHERE change_id = ${changeId}`;
}

/** Forget a change nothing came of: no run and no page. True when it went. */
export async function deleteChangeIfEmpty(sql: Queryable, changeId: string): Promise<boolean> {
  const rows = await sql<{ change_id: string }[]>`
    DELETE FROM wiki_changes c
    WHERE c.change_id = ${changeId}
      AND NOT EXISTS (SELECT 1 FROM wiki_change_runs r WHERE r.change_id = c.change_id)
      AND NOT EXISTS (SELECT 1 FROM wiki_change_pages p WHERE p.change_id = c.change_id)
    RETURNING change_id`;
  return rows.length > 0;
}

/**
 * Link a run to its change, once; a run of another workspace's change is never linked. The proposal's
 * answer links it at once, and the inbox mirror again, so a lost write on either side heals.
 */
export async function linkChangeRun(sql: Queryable, link: { changeId: string; workspaceId: string; docId: string; runId: string; docKind: "prose" | "database" }): Promise<void> {
  await sql`
    INSERT INTO wiki_change_runs (change_id, doc_id, run_id, doc_kind)
    SELECT ${link.changeId}, ${link.docId}, ${link.runId}, ${link.docKind}
    WHERE EXISTS (SELECT 1 FROM wiki_changes WHERE change_id = ${link.changeId} AND workspace_id = ${link.workspaceId})
    ON CONFLICT DO NOTHING`;
  await sql`UPDATE wiki_changes SET updated_at = now() WHERE change_id = ${link.changeId} AND workspace_id = ${link.workspaceId}`;
}

/** How many runs a change holds. */
export async function changeRunCount(sql: Queryable, changeId: string): Promise<number> {
  const rows = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM wiki_change_runs WHERE change_id = ${changeId}`;
  return rows[0]?.n ?? 0;
}

/** A change's runs, oldest first. */
export async function listChangeRuns(sql: Queryable, changeId: string): Promise<WikiChangeRunRow[]> {
  return sql<WikiChangeRunRow[]>`
    SELECT change_id, doc_id, run_id, doc_kind, created_at FROM wiki_change_runs
    WHERE change_id = ${changeId} ORDER BY created_at, run_id`;
}

/** The change each of these runs belongs to. */
export async function changesOfRuns(sql: Queryable, runIds: readonly string[]): Promise<Map<string, string>> {
  if (runIds.length === 0) return new Map();
  const rows = await sql<{ run_id: string; change_id: string }[]>`
    SELECT run_id, change_id FROM wiki_change_runs WHERE run_id = ANY(${[...runIds]})`;
  return new Map(rows.map((r) => [r.run_id, r.change_id]));
}

// ---- New pages a change holds ---------------------------------------------------------

export interface HeldPage {
  docId: string;
  changeId: string;
  workspaceId: string;
  heldGrants: string[];
  releaseGrants: OwnGrantsJson;
  reviewer: string;
  approverGroup: string | null;
}

export async function holdChangePage(sql: Queryable, p: HeldPage): Promise<void> {
  await sql`
    INSERT INTO wiki_change_pages (doc_id, change_id, workspace_id, held_grants, release_grants, reviewer, approver_group)
    VALUES (${p.docId}, ${p.changeId}, ${p.workspaceId}, ${p.heldGrants}, ${ownGrantsJson(sql, p.releaseGrants)}, ${p.reviewer}, ${p.approverGroup})`;
}

/** The change page a document is, in whatever state, or null for any other document. */
export async function changePageOf(sql: Queryable, docId: string): Promise<WikiChangePageRow | null> {
  const rows = await sql<WikiChangePageRow[]>`SELECT * FROM wiki_change_pages WHERE doc_id = ${docId}`;
  return rows[0] ?? null;
}

/** The new pages a change made, oldest first. */
export async function listChangePages(sql: Queryable, changeId: string): Promise<WikiChangePageRow[]> {
  return sql<WikiChangePageRow[]>`SELECT * FROM wiki_change_pages WHERE change_id = ${changeId} ORDER BY created_at, doc_id`;
}

/** Which of these documents are new pages still held for approval. */
export async function heldDocIds(sql: Queryable, docIds: readonly string[]): Promise<Set<string>> {
  if (docIds.length === 0) return new Set();
  const rows = await sql<{ doc_id: string }[]>`
    SELECT doc_id FROM wiki_change_pages WHERE doc_id = ANY(${[...docIds]}) AND state = 'held'`;
  return new Set(rows.map((r) => r.doc_id));
}

/**
 * Settle a held page: `released` once approved, `removed` once declined or withdrawn. Guarded on
 * `held`, so of two racing decisions only one settles it; the row it settled, or null.
 */
export async function settleChangePage(
  sql: Queryable,
  docId: string,
  state: "released" | "removed",
  by: string,
  note: string | null,
): Promise<WikiChangePageRow | null> {
  const rows = await sql<WikiChangePageRow[]>`
    UPDATE wiki_change_pages SET state = ${state}, decided_by = ${by}, decided_at = now(), note = ${note}
    WHERE doc_id = ${docId} AND state = 'held'
    RETURNING *`;
  return rows[0] ?? null;
}

/**
 * Forget changes untouched for `days` whose runs the inbox no longer holds open and that hold no page
 * still waiting; their runs' mirror rows are swept on the same clock.
 */
export async function purgeWikiChanges(sql: Sql, days: number): Promise<number> {
  const rows = await sql<{ change_id: string }[]>`
    DELETE FROM wiki_changes c
    WHERE c.updated_at < ${daysAgo(sql, days)}
      AND NOT EXISTS (SELECT 1 FROM wiki_change_pages p WHERE p.change_id = c.change_id AND p.state = 'held')
      AND NOT EXISTS (
        SELECT 1 FROM wiki_change_runs r JOIN agent_runs a ON a.run_id = r.run_id
        WHERE r.change_id = c.change_id AND a.status = 'open')
    RETURNING change_id`;
  return rows.length;
}
