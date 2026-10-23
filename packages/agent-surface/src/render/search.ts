/**
 * Search and retrieval answers, merged across the workspaces a call covered.
 * An empty result has causes an agent must tell apart (no match, a collection
 * this credential cannot read, no embeddings, a workspace it could not reach).
 * Only the node knows which, so these report its flags and never infer one
 * from an empty list.
 */
import type { RecalledRow, RetrieveBody, RowTable, RowsMore, SearchBody, TablesWaiting } from "../backend.js";
import { interleaveByRank } from "../merge.js";

export const EMPTY_SCOPE_NOTE =
  "This collection resolved to 0 documents this connector can access. The collection may be empty, or " +
  "its documents may not be shared with this connector — ask the workspace owner to share them.";

/** Agent skills match the leading "Semantic search is off on this node" verbatim to fall back to keyword search. */
export const RETRIEVE_SEMANTIC_OFF_MESSAGE = "Semantic search is off on this node — use `search` for keyword search instead";

/** Said when no document holds every word of a search, so the agent knows the list is the next best. */
export const PARTIAL_SEARCH_NOTE =
  "No document holds every word of this query, so these hold some of them, those holding the most and rarest " +
  "first: check that a result is about the question before you rely on it, and try other words if none is, in " +
  "another language too when pages may be written in one.";

/** Said when a node's embeddings are off and its passages were found by their words. */
export const KEYWORD_PASSAGES_NOTE =
  "Semantic search is off on this node, so these passages were found by the question's words, not its meaning: if " +
  "none answers it, try other words, or `search`. Pages may be written in another language than the question: try " +
  "its words in that language too.";

/** Said when no passage found by its words holds every word of the question. */
export const PARTIAL_PASSAGES_NOTE =
  "No passage holds every word of the question, so these hold some of them: check that one answers it before you " +
  "rely on it. The answer may be on a page written in another language: ask again with the question's words in it.";

/** Said with the rows a recall lists, where a model reading them acts on it. */
export const ROWS_NOTE =
  "`rows` are rows of tables whose cells hold words of the question, cited as a passage is: name the table and " +
  "the row, and who last changed it and when. Their cells are the approved table. For a precise answer over a " +
  "table (every row that matches, a count, a sum, a filter), run `query` on it: `database_id`, with the names " +
  "`tables` gives (`table_name`, and `columns`: each column's SQL name by its name) in the SQL; `rows_more` names the " +
  "tables with more rows than are listed. `tables_waiting` counts the changes " +
  "other people asked for that wait in those tables. To cite a row, pass its `database_id` as `doc_id` with its " +
  "`table_id` and `row_id`.";

/** Rows to list per call, across workspaces. */
const DEFAULT_ROWS = 5;

/** A row's link: its table, open at the row; a row that waits to be added, its database. */
function rowLink(origin: string, r: RecalledRow): string | undefined {
  if (!origin) return undefined;
  if (r.waiting_row) return `${origin}/doc/${r.database_id}`;
  return `${origin}/doc/${r.database_id}?table=${encodeURIComponent(r.table_id)}&row=${encodeURIComponent(r.row_id)}`;
}

/** The rows of every workspace's answer, merged by rank, each naming its workspace and linked; the note when there are any. */
function rowsPart(
  parts: ReadonlyArray<WorkspacePart<{ rows?: RecalledRow[]; rows_more?: RowsMore[]; tables_waiting?: TablesWaiting[]; tables?: RowTable[] }>>,
): Record<string, unknown> {
  const rows = interleaveByRank(
    parts.map((p) => (p.body.rows ?? []).map((r) => ({ workspace_id: p.workspace_id, ...r, url: rowLink(p.origin, r) }))),
    DEFAULT_ROWS,
  );
  if (rows.length === 0) return {};
  const more = parts.flatMap((p) => (p.body.rows_more ?? []).map((m) => ({ workspace_id: p.workspace_id, ...m })));
  const waiting = parts.flatMap((p) => (p.body.tables_waiting ?? []).map((w) => ({ workspace_id: p.workspace_id, ...w })));
  // The tables of the rows listed, with the names SQL reads them by.
  const listed = new Set(rows.map((r) => `${r.workspace_id}\u0000${r.database_id}\u0000${r.table_id}`));
  const tables = parts.flatMap((p) =>
    (p.body.tables ?? []).filter((t) => listed.has(`${p.workspace_id}\u0000${t.database_id}\u0000${t.table_id}`)).map((t) => ({ workspace_id: p.workspace_id, ...t })),
  );
  return {
    rows,
    ...(tables.length > 0 ? { tables } : {}),
    ...(more.length > 0 ? { rows_more: more } : {}),
    ...(waiting.length > 0 ? { tables_waiting: waiting } : {}),
    rows_note: ROWS_NOTE,
  };
}

/** A workspace a call named but could not cover just now, and why. */
export interface UnavailableWorkspace {
  workspace_id: string;
  reason: string;
}

/** One workspace's answer, with the origin its documents are linked from ("" when there is none). */
export interface WorkspacePart<T> {
  workspace_id: string;
  origin: string;
  body: T;
}

const DEFAULT_SEARCH_RESULTS = 20;
const DEFAULT_PASSAGES = 8;

const link = (origin: string, docId: string): string | undefined => (origin ? `${origin}/doc/${docId}` : undefined);

/** Documents in rank order across workspaces, each naming its workspace. Per-workspace scores are dropped: they do not compare. */
export function renderSearch(
  query: string,
  parts: ReadonlyArray<WorkspacePart<SearchBody>>,
  unavailable: readonly UnavailableWorkspace[],
  limit = DEFAULT_SEARCH_RESULTS,
): string {
  const results = interleaveByRank(
    parts.map((p) =>
      p.body.results.map(({ score: _score, sem_score: _sem, ...hit }) => ({ workspace_id: p.workspace_id, ...hit, url: link(p.origin, hit.doc_id) })),
    ),
    limit,
  );
  return JSON.stringify({
    query,
    results,
    // Both can be true at once, and the agent needs both to describe what it saw.
    degraded: parts.some((p) => p.body.degraded),
    semantic: parts.length > 0 && parts.every((p) => p.body.semantic),
    unavailable,
    ...(parts.some((p) => p.body.partial) ? { partial: true, partial_note: PARTIAL_SEARCH_NOTE } : {}),
    ...(parts.length === 1 && parts[0]!.body.empty_scope ? { note: EMPTY_SCOPE_NOTE } : {}),
    ...rowsPart(parts),
  });
}

/** Passages in rank order across workspaces, as citable excerpts with a link when there is an origin to build it from. */
export function renderPassages(
  parts: ReadonlyArray<WorkspacePart<RetrieveBody>>,
  unavailable: readonly UnavailableWorkspace[],
  limit = DEFAULT_PASSAGES,
): string {
  const passages = interleaveByRank(
    parts.map((p) =>
      p.body.chunks.map((c) => ({
        workspace_id: p.workspace_id,
        doc_id: c.doc_id,
        title: c.title,
        heading_path: c.heading_path,
        content: c.content,
        url: link(p.origin, c.doc_id),
        // Who wrote it, when a backend says: an agent cites it.
        ...(c.updated_at !== undefined ? { updated_at: c.updated_at } : {}),
        ...(c.last_edited_by !== undefined ? { last_edited_by: c.last_edited_by } : {}),
        ...(c.ai_edits !== undefined ? { ai_edits: c.ai_edits } : {}),
        ...(c.pending_changes !== undefined ? { pending_changes: c.pending_changes } : {}),
      })),
    ),
    limit,
  );
  const keywordOnly = parts.some((p) => p.body.keyword_only === true);
  // Partial when every workspace that found something found only some of the words.
  const found = parts.filter((p) => p.body.chunks.length > 0);
  const partial = found.length > 0 && found.every((p) => p.body.partial === true);
  return JSON.stringify({
    passages,
    degraded: parts.some((p) => p.body.degraded === true),
    ...(keywordOnly ? { semantic: false, keyword_note: KEYWORD_PASSAGES_NOTE } : {}),
    ...(partial ? { partial: true, partial_note: PARTIAL_PASSAGES_NOTE } : {}),
    unavailable,
    ...(parts.length === 1 && parts[0]!.body.empty_scope ? { note: EMPTY_SCOPE_NOTE } : {}),
    ...rowsPart(parts),
  });
}
