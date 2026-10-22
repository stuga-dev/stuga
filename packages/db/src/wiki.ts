/**
 * The wiki a workspace's pages make. The links between pages are kept in step with each page's
 * approved text as it is indexed; everything else is read from them and from the run records, always
 * as one reader reads the workspace: the pages linking to a page, the Index, the Log of decided AI
 * changes, and the check that finds pages to look at again. Nothing here names, or counts, a page, a
 * folder or a change its reader cannot open, and a new page a change holds is not the wiki's yet.
 */
import type { Fragment } from "postgres";
import type { WikiLinkKind } from "@stuga/protocol/domain/wiki";
import type { Sql } from "./client.js";
import type { Queryable } from "./sql.js";

export type { WikiLinkKind };

/** One reader in one workspace: whose principals open what, and the folders a key is confined to. */
export interface WikiReader {
  workspaceId: string;
  principals: string[];
  /** A scoped key's folders, subtrees expanded; null for none. */
  scopeFolderIds: string[] | null;
}

/** A document `alias` names that the reader may open: the tenant, the ACL and a key's folders, as canReadDoc. */
function opens(sql: Queryable, alias: string, r: WikiReader): Fragment {
  const d = sql.unsafe(alias);
  return sql`(${d}.workspace_id = ${r.workspaceId} AND ${d}.acl_principals && ${r.principals}
    ${r.scopeFolderIds ? sql`AND ${d}.parent_id = ANY(${r.scopeFolderIds})` : sql``})`;
}

/** Part of the wiki: out of the trash, and no new page a change holds, nor a row page of a database one holds. */
function inWiki(sql: Queryable, alias: string): Fragment {
  const d = sql.unsafe(alias);
  return sql`(${d}.trashed = FALSE AND NOT EXISTS (
    SELECT 1 FROM wiki_change_pages h WHERE h.state = 'held' AND (h.doc_id = ${d}.doc_id OR h.doc_id = ${d}.page_of)))`;
}

/** A citation from `l` (doc_links) of a page the reader opens whose text changed after the citing passages were last approved. */
function staleCitation(sql: Queryable, r: WikiReader): Fragment {
  return sql`(l.kind = 'citation' AND l.target_doc_id <> l.doc_id AND t.text_changed_at > l.checked_at
    AND ${opens(sql, "t", r)} AND ${inWiki(sql, "t")})`;
}

// ---- Upkeep -------------------------------------------------------------------------------

export interface DocWikiSync {
  docId: string;
  /** The snapshot the text was read from: one older than the row's links lose. */
  seq: number;
  /** sha-256 of the approved Markdown. */
  textHash: string;
  summary: string;
  /** Who made that snapshot: the aliases its flush names. */
  editors: string[];
  /** One per page and kind, the page itself left out. */
  links: Array<{ target: string; kind: WikiLinkKind; contextHash: string }>;
}

/**
 * Bring a page's summary and links in step with a snapshot of its approved text, unless they already
 * hold a later one. Only a change of text moves `text_changed_at`; a link whose passages changed is
 * approved again then, and one whose passages stayed keeps when it was. True when the text changed.
 */
export async function syncDocWiki(sql: Sql, s: DocWikiSync): Promise<boolean> {
  return sql.begin(async (tx) => {
    // docs before doc_links, as every writer of both locks them.
    const [row] = await tx<{ workspace_id: string; links_seq: number | string; text_hash: string | null }[]>`
      SELECT workspace_id, links_seq, text_hash FROM docs WHERE doc_id = ${s.docId} FOR UPDATE`;
    if (!row || Number(row.links_seq) > s.seq) return false;
    if (row.text_hash === s.textHash) {
      await tx`UPDATE docs SET links_seq = ${s.seq} WHERE doc_id = ${s.docId} AND links_seq < ${s.seq}`;
      return false;
    }
    await tx`
      UPDATE docs SET summary = ${s.summary}, text_hash = ${s.textHash}, text_changed_at = now(),
                      text_changed_by = ${s.editors}::text[], links_seq = ${s.seq}
      WHERE doc_id = ${s.docId}`;
    const links = s.links.filter((l) => l.target !== s.docId);
    const targets = links.map((l) => l.target);
    const kinds = links.map((l) => l.kind);
    const hashes = links.map((l) => l.contextHash);
    await tx`
      DELETE FROM doc_links l
      WHERE l.doc_id = ${s.docId}
        AND NOT EXISTS (
          SELECT 1 FROM unnest(${targets}::text[], ${kinds}::text[]) AS n(target, kind)
          WHERE n.target = l.target_doc_id AND n.kind = l.kind)`;
    if (links.length > 0) {
      await tx`
        INSERT INTO doc_links (doc_id, workspace_id, target_doc_id, kind, context_hash)
        SELECT ${s.docId}, ${row.workspace_id}, n.target, n.kind, n.hash
        FROM unnest(${targets}::text[], ${kinds}::text[], ${hashes}::text[]) AS n(target, kind, hash)
        ON CONFLICT (doc_id, target_doc_id, kind) DO UPDATE SET
          context_hash = EXCLUDED.context_hash,
          checked_at = CASE WHEN doc_links.context_hash = EXCLUDED.context_hash THEN doc_links.checked_at ELSE now() END`;
    }
    return true;
  }) as Promise<boolean>;
}

/**
 * A person looked at a page again: its citations of pages the reader opens that changed since count as
 * approved now. Those of pages they cannot open stay as they were. How many were marked.
 */
export async function markCitationsChecked(sql: Sql, r: WikiReader, docId: string): Promise<number> {
  const rows = await sql<{ target_doc_id: string }[]>`
    UPDATE doc_links l SET checked_at = now()
    FROM docs t
    WHERE l.doc_id = ${docId} AND l.workspace_id = ${r.workspaceId} AND t.doc_id = l.target_doc_id
      AND ${staleCitation(sql, r)}
    RETURNING l.target_doc_id`;
  return rows.length;
}

// ---- One page -----------------------------------------------------------------------------

export interface LinkingPage {
  doc_id: string;
  title: string;
  doc_type: "prose" | "database";
  parent_id: string | null;
  /** How it names the page: a link, a citation, or both. */
  kinds: WikiLinkKind[];
}

/** The pages the reader opens that link to or cite `docId`, by title; at most `limit`, and nothing of the others. */
export async function pagesLinkingTo(sql: Queryable, r: WikiReader, docId: string, limit = 200): Promise<LinkingPage[]> {
  return sql<LinkingPage[]>`
    SELECT d.doc_id, d.title, d.doc_type, d.parent_id, array_agg(DISTINCT l.kind ORDER BY l.kind) AS kinds
    FROM doc_links l JOIN docs d ON d.doc_id = l.doc_id
    WHERE l.workspace_id = ${r.workspaceId} AND l.target_doc_id = ${docId} AND l.doc_id <> ${docId}
      AND ${opens(sql, "d", r)} AND ${inWiki(sql, "d")}
    GROUP BY d.doc_id, d.title, d.doc_type, d.parent_id
    ORDER BY lower(d.title), d.doc_id
    LIMIT ${Math.min(Math.max(limit, 1), 1000)}`;
}

export interface StaleCitation {
  /** The citing page. */
  doc_id: string;
  /** The cited page that changed, which the reader opens. */
  source_id: string;
  source_title: string;
  changed_at: string;
}

/** Of `docIds` the reader opens, the citations that need checking: their source changed since they were approved. */
export async function staleCitations(sql: Queryable, r: WikiReader, docIds: readonly string[]): Promise<StaleCitation[]> {
  if (docIds.length === 0) return [];
  return sql<StaleCitation[]>`
    SELECT l.doc_id, t.doc_id AS source_id, t.title AS source_title, t.text_changed_at AS changed_at
    FROM doc_links l
    JOIN docs d ON d.doc_id = l.doc_id
    JOIN docs t ON t.doc_id = l.target_doc_id
    WHERE l.workspace_id = ${r.workspaceId} AND l.doc_id = ANY(${[...docIds]})
      AND ${opens(sql, "d", r)} AND ${inWiki(sql, "d")} AND ${staleCitation(sql, r)}
    ORDER BY l.doc_id, t.text_changed_at DESC, t.doc_id`;
}

// ---- The Index ----------------------------------------------------------------------------

export interface IndexFolder {
  folder_id: string;
  parent_id: string | null;
  title: string;
  /** The person whose My notes it is in, or null. */
  home_of: string | null;
}

/** The folders the reader opens, with the My notes each is in. */
export async function readableFolders(sql: Queryable, r: WikiReader): Promise<IndexFolder[]> {
  return sql<IndexFolder[]>`
    SELECT f.folder_id, f.parent_id, f.title, folder_home_of(f.folder_id) AS home_of
    FROM folders f
    WHERE f.workspace_id = ${r.workspaceId} AND f.acl_principals && ${r.principals}
      ${r.scopeFolderIds ? sql`AND f.folder_id = ANY(${r.scopeFolderIds})` : sql``}`;
}

export interface IndexPage {
  doc_id: string;
  title: string;
  doc_type: "prose" | "database";
  parent_id: string | null;
  summary: string;
  /** When its approved text last changed: when it was made, before it had any. */
  changed_at: string;
  /** Who changed it then, as author aliases (people, agents, co-authors); who made it, before. */
  changed_by: string[];
  needs_checking: boolean;
}

/**
 * The pages and databases the reader opens, row pages left out, in `folderIds` when given (the top level
 * is `null` in it), by folder then title: at most `limit`, and whether there were more.
 */
export async function indexPages(
  sql: Queryable,
  r: WikiReader,
  opts: { folderIds?: Array<string | null> | null; limit: number; /** Only what search finds: none kept out of search. */ searchable?: boolean },
): Promise<{ pages: IndexPage[]; truncated: boolean }> {
  const folders = opts.folderIds ?? null;
  const ids = folders?.filter((f): f is string => f !== null) ?? [];
  const top = folders?.includes(null) ?? false;
  const rows = await sql<IndexPage[]>`
    SELECT d.doc_id, d.title, d.doc_type, d.parent_id, d.summary,
           coalesce(d.text_changed_at, d.created_at) AS changed_at,
           CASE WHEN d.text_changed_at IS NULL
                THEN ARRAY[regexp_replace(coalesce(d.created_by, d.owner), '^(user|agent):', '')]
                ELSE d.text_changed_by END AS changed_by,
           EXISTS (
             SELECT 1 FROM doc_links l JOIN docs t ON t.doc_id = l.target_doc_id
             WHERE l.doc_id = d.doc_id AND ${staleCitation(sql, r)}
           ) AS needs_checking
    FROM docs d
    WHERE ${opens(sql, "d", r)} AND ${inWiki(sql, "d")} AND d.page_of IS NULL
      ${opts.searchable ? sql`AND d.search_hidden = FALSE` : sql``}
      ${folders ? sql`AND (d.parent_id = ANY(${ids}::text[]) ${top ? sql`OR d.parent_id IS NULL` : sql``})` : sql``}
    ORDER BY d.parent_id NULLS FIRST, lower(d.title), d.doc_id
    LIMIT ${opts.limit + 1}`;
  return { pages: rows.slice(0, opts.limit), truncated: rows.length > opts.limit };
}

// ---- Checking the wiki --------------------------------------------------------------------

export interface WikiScope {
  /** The folders checked, subtrees expanded, the top level as `null`; null checks the whole workspace. */
  folderIds: Array<string | null> | null;
  limit: number;
}

function inScope(sql: Queryable, alias: string, scope: WikiScope): Fragment {
  if (!scope.folderIds) return sql``;
  const d = sql.unsafe(alias);
  const ids = scope.folderIds.filter((f): f is string => f !== null);
  const top = scope.folderIds.includes(null);
  return sql`AND (${d}.parent_id = ANY(${ids}::text[]) ${top ? sql`OR ${d}.parent_id IS NULL` : sql``})`;
}

/** The pages in scope that need checking, by title, and the cited pages of each that changed since: at most `limit` pages. */
export async function stalePages(
  sql: Queryable,
  r: WikiReader,
  scope: WikiScope,
): Promise<{ pages: Array<{ doc_id: string; title: string; parent_id: string | null }>; citations: StaleCitation[]; truncated: boolean }> {
  const pages = await sql<Array<{ doc_id: string; title: string; parent_id: string | null }>>`
    SELECT d.doc_id, d.title, d.parent_id
    FROM docs d
    WHERE ${opens(sql, "d", r)} AND ${inWiki(sql, "d")} ${inScope(sql, "d", scope)}
      AND EXISTS (SELECT 1 FROM doc_links l JOIN docs t ON t.doc_id = l.target_doc_id WHERE l.doc_id = d.doc_id AND ${staleCitation(sql, r)})
    ORDER BY lower(d.title), d.doc_id
    LIMIT ${scope.limit + 1}`;
  const kept = pages.slice(0, scope.limit);
  return { pages: kept, citations: await staleCitations(sql, r, kept.map((p) => p.doc_id)), truncated: pages.length > scope.limit };
}

export interface OrphanPage {
  doc_id: string;
  title: string;
  parent_id: string | null;
}

/**
 * Pages in a folder that no other page the reader opens links to or cites. A page at the top level is
 * where a reader starts, so it is none; nor is a row page, which its database lists, nor a page in
 * someone's My notes, which are theirs rather than the wiki's.
 */
export async function orphanPages(sql: Queryable, r: WikiReader, scope: WikiScope): Promise<{ pages: OrphanPage[]; truncated: boolean }> {
  const rows = await sql<OrphanPage[]>`
    SELECT d.doc_id, d.title, d.parent_id
    FROM docs d
    WHERE ${opens(sql, "d", r)} AND ${inWiki(sql, "d")} ${inScope(sql, "d", scope)}
      AND d.doc_type = 'prose' AND d.page_of IS NULL AND d.parent_id IS NOT NULL
      AND folder_home_of(d.parent_id) IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM doc_links l JOIN docs s ON s.doc_id = l.doc_id
        WHERE l.workspace_id = ${r.workspaceId} AND l.target_doc_id = d.doc_id AND l.doc_id <> d.doc_id
          AND ${opens(sql, "s", r)} AND ${inWiki(sql, "s")})
    ORDER BY lower(d.title), d.doc_id
    LIMIT ${scope.limit + 1}`;
  return { pages: rows.slice(0, scope.limit), truncated: rows.length > scope.limit };
}

export interface BrokenLink {
  /** The page holding the link, which the reader opens. */
  doc_id: string;
  title: string;
  parent_id: string | null;
  /** The doc_id its text names, as written there. */
  target_doc_id: string;
  kind: WikiLinkKind;
  /** The target is in the trash and the reader opens it; otherwise it is gone or theirs to open is not. */
  in_trash: boolean;
  /** The target's title, only when the reader opens it. */
  target_title: string | null;
}

/**
 * Links and citations, from pages in scope, to a page that is in the trash, gone, or one the reader
 * cannot open. Only a target the reader opens is told apart (in the trash) or named.
 */
export async function brokenLinks(sql: Queryable, r: WikiReader, scope: WikiScope): Promise<{ links: BrokenLink[]; truncated: boolean }> {
  const rows = await sql<BrokenLink[]>`
    SELECT s.doc_id, s.title, s.parent_id, l.target_doc_id, l.kind,
           coalesce(${opens(sql, "t", r)} AND t.trashed, FALSE) AS in_trash,
           CASE WHEN coalesce(${opens(sql, "t", r)}, FALSE) THEN t.title END AS target_title
    FROM doc_links l
    JOIN docs s ON s.doc_id = l.doc_id
    LEFT JOIN docs t ON t.doc_id = l.target_doc_id
    WHERE l.workspace_id = ${r.workspaceId} AND l.target_doc_id <> l.doc_id
      AND ${opens(sql, "s", r)} AND ${inWiki(sql, "s")} ${inScope(sql, "s", scope)}
      AND NOT coalesce(${opens(sql, "t", r)} AND t.trashed = FALSE, FALSE)
    ORDER BY lower(s.title), s.doc_id, l.target_doc_id, l.kind
    LIMIT ${scope.limit + 1}`;
  return { links: rows.slice(0, scope.limit), truncated: rows.length > scope.limit };
}

// ---- The Log ------------------------------------------------------------------------------

/** One run of an entry, on a page the reader opens. */
export interface LogRun {
  run_id: string;
  doc_id: string;
  doc_kind: "prose" | "database";
  /** The page's title now. */
  title: string;
  change_id: string | null;
  /** The change's title and who asked for it: for the caller to show only to whom it belongs. */
  change_title: string | null;
  agent: string;
  agent_alias: string;
  client: string | null;
  source: string;
  /** The person who asked the AI. */
  reviewer: string;
  review_mode: "auto" | "review" | "colleague";
  auto_applied: boolean;
  reverted: boolean;
  accepted: number;
  rejected: number;
  conflicts: number;
  applied: number;
  decided_by: string[];
  updated_at: string;
}

/** A change, or a run in none, with every run of it on a page the reader opens. */
export interface LogEntry {
  entry_id: string;
  at: string;
  runs: LogRun[];
}

/** Where a page of the Log ended: the next page holds what came before it. */
export interface LogCursor {
  at: string;
  entryId: string;
}

/**
 * The workspace's decided AI changes, newest first: each change once, and each run in no change, on
 * pages the reader opens. One with a change still waiting on such a page is in the review inbox, not
 * here; what waits on a page they cannot open never keeps one out, nor shows. At most `limit` entries.
 */
export async function logEntries(
  sql: Queryable,
  r: WikiReader,
  opts: { before?: LogCursor | null; limit: number },
): Promise<{ entries: LogEntry[]; next: LogCursor | null }> {
  const rows = await sql<Array<LogRun & { entry_id: string; entry_at: string; status: string; pending: number }>>`
    WITH visible AS (
      SELECT r.run_id, r.doc_id, r.doc_kind, coalesce(nullif(d.title, ''), r.doc_title) AS title,
             cr.change_id, c.title AS change_title, r.agent, r.agent_alias, r.client, r.source, r.reviewer,
             r.review_mode, r.auto_applied, r.reverted, r.accepted, r.rejected, r.conflicts, r.applied,
             r.decided_by, r.updated_at, r.status, r.pending,
             coalesce(cr.change_id, r.run_id) AS entry_id
      FROM agent_runs r
      JOIN docs d ON d.doc_id = r.doc_id
      LEFT JOIN wiki_change_runs cr ON cr.run_id = r.run_id
      LEFT JOIN wiki_changes c ON c.change_id = cr.change_id
      WHERE r.workspace_id = ${r.workspaceId} AND ${opens(sql, "d", r)} AND ${inWiki(sql, "d")}
    ),
    entries AS (
      SELECT entry_id, max(updated_at) AS at
      FROM visible
      GROUP BY entry_id
      HAVING bool_and(NOT (status = 'open' AND pending > 0)) AND bool_or(accepted + rejected + conflicts + applied > 0)
    ),
    page AS (
      SELECT entry_id, at FROM entries
      ${opts.before ? sql`WHERE (at, entry_id) < (${opts.before.at}::timestamptz, ${opts.before.entryId})` : sql``}
      ORDER BY at DESC, entry_id DESC
      LIMIT ${opts.limit + 1}
    )
    SELECT v.*, p.at AS entry_at
    FROM page p JOIN visible v ON v.entry_id = p.entry_id
    WHERE v.accepted + v.rejected + v.conflicts + v.applied > 0
    ORDER BY p.at DESC, p.entry_id DESC, v.updated_at, v.run_id`;
  const entries: LogEntry[] = [];
  for (const { entry_id, entry_at, status: _status, pending: _pending, ...run } of rows) {
    const at = new Date(entry_at).toISOString();
    const last = entries[entries.length - 1];
    const shaped = { ...run, updated_at: new Date(run.updated_at).toISOString() };
    if (last && last.entry_id === entry_id) last.runs.push(shaped);
    else entries.push({ entry_id, at, runs: [shaped] });
  }
  const page = entries.slice(0, opts.limit);
  const tail = page[page.length - 1];
  return { entries: page, next: entries.length > opts.limit && tail ? { at: tail.at, entryId: tail.entry_id } : null };
}
