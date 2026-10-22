/**
 * How AI edits to an item are reviewed: its level, from its own setting or its folders', the
 * folder that sets it, the approver group that applies, and who may approve at `colleague`.
 */
import { looserReviewMode, reviewLevelOf, type ReviewMode } from "@stuga/protocol/domain/events";
import type { Queryable } from "./sql.js";
import { folderCols, folderSubtreeCte } from "./sql.js";
import type { Sql } from "./client.js";
import type { FolderRow } from "./types.js";

/** An item as approver lookups read it: who can read and write it, and who owns it (a full principal). */
export interface ApprovalItem {
  acl_principals: string[];
  acl_writers: string[];
  owner: string;
}

/** One question approversFor answers: who may approve `reviewer`'s run on `item` under `groups`. */
export interface ApproverQuery {
  key: string;
  item: ApprovalItem;
  reviewer: string;
  groups: string[];
}

/**
 * Who may approve a run at `colleague`: everyone else who can write the item and holds the approver
 * groups; when nobody does, its owner or a workspace owner or admin who can write it stands in
 * (`standIn`). When `aliases` is empty nobody may yet, and `cause` says why: nobody else can edit
 * the item (`nobody`), or nobody in its approver groups can (`group`).
 */
export interface Approvers {
  aliases: string[];
  standIn: boolean;
  cause: "nobody" | "group" | null;
}

/**
 * approversFor answers for many runs in one query: what an inbox page or a document's run list
 * asks, keyed by `key`. A member's principals are worked out as a session's are: `user:<alias>`,
 * the workspace's `org:` principal for anyone but a guest, and their groups.
 */
export async function approversFor(sql: Queryable, workspaceId: string, queries: ApproverQuery[]): Promise<Map<string, Approvers>> {
  const out = new Map<string, Approvers>();
  const unique = [...new Map(queries.map((q) => [q.key, q])).values()];
  if (unique.length === 0) return out;
  const rows = await sql<{ key: string; colleagues: string[]; managers: string[]; writers: number }[]>`
    WITH mp AS (
      SELECT m.alias, m.role,
             array_remove(ARRAY['user:' || m.alias, CASE WHEN m.role <> 'guest' THEN 'org:' || m.workspace_id END], NULL)
             || COALESCE((SELECT array_agg(g.group_id) FROM groups g
                          WHERE g.workspace_id = m.workspace_id AND g.members @> ARRAY['user:' || m.alias]), ARRAY[]::text[])
             AS principals
      FROM workspace_members m
      WHERE m.workspace_id = ${workspaceId}
    ),
    q AS (
      SELECT * FROM jsonb_to_recordset(${sql.json(
        unique.map((x) => ({
          key: x.key,
          readers: x.item.acl_principals,
          writers: x.item.acl_writers,
          owner: x.item.owner,
          reviewer: x.reviewer,
          groups: x.groups,
        })),
      )}::jsonb) AS x(key text, readers text[], writers text[], owner text, reviewer text, groups text[])
    )
    SELECT q.key,
           coalesce(array_agg(mp.alias ORDER BY mp.alias) FILTER (WHERE mp.principals @> q.groups), ARRAY[]::text[]) AS colleagues,
           coalesce(array_agg(mp.alias ORDER BY mp.alias) FILTER (WHERE mp.role IN ('owner', 'admin') OR 'user:' || mp.alias = q.owner),
                    ARRAY[]::text[]) AS managers,
           count(mp.alias)::int AS writers
    FROM q
    LEFT JOIN mp ON mp.alias <> q.reviewer AND mp.principals && q.readers AND mp.principals && q.writers
    GROUP BY q.key`;
  for (const q of unique) {
    const r = rows.find((row) => row.key === q.key);
    const colleagues = r?.colleagues ?? [];
    const managers = r?.managers ?? [];
    if (colleagues.length > 0) out.set(q.key, { aliases: colleagues, standIn: false, cause: null });
    else if (managers.length > 0) out.set(q.key, { aliases: managers, standIn: true, cause: null });
    else out.set(q.key, { aliases: [], standIn: true, cause: (r?.writers ?? 0) > 0 && q.groups.length > 0 ? "group" : "nobody" });
  }
  return out;
}

/** approversFor for one run. */
export async function colleagueApprovers(
  sql: Queryable,
  item: ApprovalItem & { workspace_id: string },
  reviewer: string,
  groups: string[],
): Promise<Approvers> {
  const found = await approversFor(sql, item.workspace_id, [{ key: "run", item, reviewer, groups }]);
  return found.get("run")!;
}

/**
 * The workspace's owners and admins who can read an item with these readers, other than `exclude`:
 * who hears that its level was loosened, or that its changes wait for an approver. With `owner`,
 * the item's owner too, when they can read it.
 */
export async function managersWhoCanRead(
  sql: Queryable,
  workspaceId: string,
  item: { acl_principals: string[]; owner?: string },
  exclude: string,
): Promise<string[]> {
  const rows = await sql<{ alias: string }[]>`
    WITH mp AS (
      SELECT m.alias, m.role,
             array_remove(ARRAY['user:' || m.alias, CASE WHEN m.role <> 'guest' THEN 'org:' || m.workspace_id END], NULL)
             || COALESCE((SELECT array_agg(g.group_id) FROM groups g
                          WHERE g.workspace_id = m.workspace_id AND g.members @> ARRAY['user:' || m.alias]), ARRAY[]::text[])
             AS principals
      FROM workspace_members m
      WHERE m.workspace_id = ${workspaceId} AND m.alias <> ${exclude}
    )
    SELECT alias FROM mp
    WHERE principals && ${item.acl_principals}::text[]
      AND (role IN ('owner', 'admin') ${item.owner ? sql`OR 'user:' || alias = ${item.owner}` : sql``})
    ORDER BY alias`;
  return rows.map((r) => r.alias);
}

/** An item whose own level a move set back to following its folder. */
export interface ClampedLevel {
  kind: "doc" | "folder";
  id: string;
  title: string;
  /** Its own level before, looser than its new place allows. */
  from: ReviewMode;
}

/**
 * After a move, set back to following its folder every item in the moved part (a document, or a
 * folder and everything beneath it) whose own level is looser than the level it now inherits. A
 * looser level is an exception the folder's owner or an admin made for that place, and does not
 * travel with the item. Returns what it changed.
 */
export async function clampMovedReviewLevels(
  sql: Sql,
  moved: { kind: "doc"; id: string } | { kind: "folder"; id: string },
  workspaceId: string,
): Promise<ClampedLevel[]> {
  return sql.begin(async (tx) => {
    const out: ClampedLevel[] = [];
    if (moved.kind === "doc") {
      // A folder gives what is in it `review` unless one sets another; the top level gives nothing.
      const rows = await tx<{ doc_id: string; title: string; agent_mode: ReviewMode | null; inherited: ReviewMode | null }[]>`
        SELECT doc_id, title, agent_mode,
               CASE WHEN parent_id IS NULL THEN NULL ELSE coalesce(folder_agent_mode(parent_id), 'review') END AS inherited
        FROM docs WHERE doc_id = ${moved.id} AND workspace_id = ${workspaceId} FOR UPDATE`;
      const d = rows[0];
      if (d?.agent_mode && d.inherited && looserReviewMode(d.agent_mode, d.inherited)) {
        await tx`UPDATE docs SET agent_mode = NULL, updated_at = now() WHERE doc_id = ${d.doc_id}`;
        out.push({ kind: "doc", id: d.doc_id, title: d.title, from: d.agent_mode });
      }
      return out;
    }
    // Top down: a folder set back changes what everything beneath it inherits.
    const folders = await tx<{ folder_id: string; parent_id: string | null; title: string; agent_mode: ReviewMode | null; depth: number }[]>`
      WITH RECURSIVE ${folderSubtreeCte(tx, tx`SELECT folder_id FROM folders WHERE folder_id = ${moved.id} AND workspace_id = ${workspaceId}`, workspaceId)}
      SELECT f.folder_id, f.parent_id, f.title, f.agent_mode, min(s.depth) AS depth
      FROM subtree s JOIN folders f ON f.folder_id = s.folder_id
      GROUP BY f.folder_id
      ORDER BY depth`;
    const top = folders[0];
    if (!top) return out;
    const above = await tx<{ mode: ReviewMode | null }[]>`SELECT folder_agent_mode(${top.parent_id}::text) AS mode`;
    // Each folder's level now: its own, else what it inherits, else `review`.
    const levelOf = new Map<string, ReviewMode>();
    for (const f of folders) {
      const inherited =
        f.folder_id === top.folder_id ? (top.parent_id === null ? null : reviewLevelOf(null, above[0]?.mode ?? null)) : (levelOf.get(f.parent_id ?? "") ?? null);
      let own = f.agent_mode;
      if (own && inherited && looserReviewMode(own, inherited)) {
        await tx`UPDATE folders SET agent_mode = NULL, updated_at = now() WHERE folder_id = ${f.folder_id}`;
        out.push({ kind: "folder", id: f.folder_id, title: f.title, from: own });
        own = null;
      }
      levelOf.set(f.folder_id, reviewLevelOf(own, inherited));
    }
    const docs = await tx<{ doc_id: string; parent_id: string; title: string; agent_mode: ReviewMode }[]>`
      SELECT doc_id, parent_id, title, agent_mode FROM docs
      WHERE parent_id = ANY(${folders.map((f) => f.folder_id)}) AND workspace_id = ${workspaceId} AND agent_mode IS NOT NULL
      FOR UPDATE`;
    for (const d of docs) {
      const inherited = levelOf.get(d.parent_id) ?? null;
      if (inherited && looserReviewMode(d.agent_mode, inherited)) {
        await tx`UPDATE docs SET agent_mode = NULL, updated_at = now() WHERE doc_id = ${d.doc_id}`;
        out.push({ kind: "doc", id: d.doc_id, title: d.title, from: d.agent_mode });
      }
    }
    return out;
  }) as Promise<ClampedLevel[]>;
}

/** A folder beneath a moved one, as the move's level check reads it. */
export interface SubtreeFolder {
  folder_id: string;
  parent_id: string;
  owner: string;
  agent_mode: ReviewMode | null;
}

/** A document beneath a moved folder, trashed ones included, as the move's level check reads it. */
export interface SubtreeDoc {
  doc_id: string;
  parent_id: string;
  owner: string;
  agent_mode: ReviewMode | null;
  page_of: string | null;
  /** For a row page, its database's level now (DocRow.database_agent_mode). */
  database_agent_mode: ReviewMode | null;
}

/** Every folder strictly beneath `folderId`, parents before children, and every document in it or them. */
export async function reviewSubtree(sql: Queryable, folderId: string, workspaceId: string): Promise<{ folders: SubtreeFolder[]; docs: SubtreeDoc[] }> {
  const folders = await sql<(SubtreeFolder & { depth: number })[]>`
    WITH RECURSIVE ${folderSubtreeCte(sql, sql`SELECT folder_id FROM folders WHERE folder_id = ${folderId} AND workspace_id = ${workspaceId}`, workspaceId)}
    SELECT f.folder_id, f.parent_id, f.owner, f.agent_mode, min(s.depth) AS depth
    FROM subtree s JOIN folders f ON f.folder_id = s.folder_id
    WHERE f.folder_id <> ${folderId}
    GROUP BY f.folder_id
    ORDER BY depth`;
  const docs = await sql<SubtreeDoc[]>`
    SELECT d.doc_id, d.parent_id, d.owner, d.agent_mode, d.page_of,
           (SELECT coalesce(p.agent_mode, folder_agent_mode(p.parent_id), 'review') FROM docs p WHERE p.doc_id = d.page_of) AS database_agent_mode
    FROM docs d
    WHERE d.workspace_id = ${workspaceId} AND d.parent_id = ANY(${[folderId, ...folders.map((f) => f.folder_id)]})`;
  return { folders: folders.map(({ depth: _depth, ...f }) => f), docs };
}

/** A run waiting for a decision, as the inbox mirror holds it, with its document's group and level now. */
export interface WaitingRunBeneath {
  run_id: string;
  doc_id: string;
  reviewer: string;
  review_mode: ReviewMode;
  approver_group: string | null;
  agent: string;
  agent_alias: string;
  doc_title: string;
  pending: number;
  /** The approver group the document's folders name now. */
  doc_group: string | null;
  /** The document's level now, its database's included for a row page (docReviewLevel). */
  doc_level: ReviewMode;
}

/** Runs with changes waiting on one document, or on the documents in a folder or beneath it: at most 500, newest first. */
export async function waitingRunsIn(
  sql: Queryable,
  scope: { folderId: string } | { docId: string },
  workspaceId: string,
): Promise<WaitingRunBeneath[]> {
  const where =
    "docId" in scope
      ? sql`AND d.doc_id = ${scope.docId}`
      : sql`AND d.parent_id IN (
          WITH RECURSIVE ${folderSubtreeCte(sql, sql`SELECT folder_id FROM folders WHERE folder_id = ${scope.folderId} AND workspace_id = ${workspaceId}`, workspaceId)}
          SELECT folder_id FROM subtree)`;
  return sql<WaitingRunBeneath[]>`
    SELECT r.run_id, r.doc_id, r.reviewer, r.review_mode, r.approver_group, r.agent, r.agent_alias,
           coalesce(nullif(d.title, ''), r.doc_title) AS doc_title, r.pending, lvl.doc_group,
           CASE WHEN 'colleague' IN (coalesce(d.agent_mode, lvl.folder_mode, 'review'), lvl_db.database_mode) THEN 'colleague'
                WHEN 'review' IN (coalesce(d.agent_mode, lvl.folder_mode, 'review'), lvl_db.database_mode) THEN 'review'
                ELSE 'auto' END AS doc_level
    FROM agent_runs r
    JOIN docs d ON d.doc_id = r.doc_id
    LEFT JOIN LATERAL (
      SELECT folder_approver_group(lf.folder_id) AS doc_group, folder_agent_mode(lf.folder_id) AS folder_mode
      FROM folders lf WHERE lf.folder_id = d.parent_id
    ) lvl ON TRUE
    LEFT JOIN LATERAL (
      SELECT coalesce(ld.agent_mode, folder_agent_mode(ld.parent_id), 'review') AS database_mode FROM docs ld WHERE ld.doc_id = d.page_of
    ) lvl_db ON TRUE
    WHERE r.workspace_id = ${workspaceId} AND d.workspace_id = ${workspaceId} AND d.trashed = FALSE
      AND r.status = 'open' AND r.pending > 0
      ${where}
    ORDER BY r.updated_at DESC
    LIMIT 500`;
}

/** A folder's own review level (null follows the folder above) and approver group (null for none). */
export async function setFolderReview(
  sql: Sql,
  folderId: string,
  patch: { agentMode?: ReviewMode | null; approverGroup?: string | null },
): Promise<FolderRow | null> {
  const set: Record<string, unknown> = { updated_at: sql`now()` };
  if (patch.agentMode !== undefined) set.agent_mode = patch.agentMode;
  if (patch.approverGroup !== undefined) set.approver_group = patch.approverGroup;
  const rows = await sql<FolderRow[]>`
    UPDATE folders SET ${sql(set)} WHERE folder_id = ${folderId}
    RETURNING ${folderCols(sql)}`;
  return rows[0] ?? null;
}
