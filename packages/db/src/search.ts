/**
 * Indexing and retrieval. Search is one statement per call: a BM25 keyword leg
 * (search-keyword.ts) and a pgvector semantic leg, fused with Reciprocal Rank
 * Fusion. Both legs read the live row, so ACL and content changes apply immediately.
 */
import type { Fragment, TransactionSql } from "postgres";
import type { SearchLanguage } from "@stuga/protocol/domain/search-languages";
import type { AskChunk, SearchResult, WorkspaceRow } from "./types.js";
import { type Queryable, scopeFragment, vectorLiteral } from "./sql.js";
import type { Sql } from "./client.js";
import { chunkKeywordCtes, keywordCtes, planKeywords, typoMatches, type KeywordPlan } from "./search-keyword.js";
import { completionAt, EXCERPT_CHARS, keywordExcerpt } from "./search-excerpt.js";
import { chunkText, docVectorsSet, searchConfigs, vectorSql, vectorTerms } from "./search-vectors.js";

export { completionPrefix, typoTolerant } from "./search-keyword.js";

/** The width `doc_chunks.embedding` was created with, or null before the schema exists. Reads only, before migrations too. */
export async function embeddingColumnDims(sql: Sql): Promise<number | null> {
  // pgvector stores the dimension in atttypmod directly.
  const rows = await sql<{ dims: number | null }[]>`
    SELECT a.atttypmod AS dims
    FROM pg_attribute a
    WHERE a.attrelid = to_regclass('public.doc_chunks')
      AND a.attname = 'embedding'
      AND a.attnum > 0
      AND NOT a.attisdropped`;
  const dims = rows[0]?.dims ?? null;
  return dims !== null && dims > 0 ? dims : null;
}

/** The hash of the text last embedded for a document; an unchanged flush skips re-embedding. */
export async function getEmbeddingHash(sql: Sql, docId: string): Promise<string | null> {
  const rows = await sql<{ embedding_hash: string | null }[]>`
    SELECT embedding_hash FROM docs WHERE doc_id = ${docId}`;
  return rows[0]?.embedding_hash ?? null;
}

export interface MissingEmbeddingChunk {
  doc_id: string;
  chunk_index: number;
  content: string;
  heading_path: string | null;
  title: string;
  /** Chunk 0's embed input is prefixed with the title. */
  is_first: boolean;
}

/**
 * Chunks still without a vector and under their attempt budget, healed in place
 * by the reconcile sweep. Chunk-level so every tick makes progress on a
 * document larger than the budget.
 */
export async function findChunksMissingEmbeddings(sql: Sql, limit = 40, maxAttempts = 5): Promise<MissingEmbeddingChunk[]> {
  return sql<MissingEmbeddingChunk[]>`
    SELECT c.doc_id, c.chunk_index, c.content, c.heading_path, d.title,
           (c.chunk_index = 0) AS is_first
    FROM doc_chunks c
    JOIN docs d ON d.doc_id = c.doc_id
    WHERE d.trashed = FALSE
      AND d.search_hidden = FALSE
      AND c.embedding IS NULL
      AND c.embed_attempts < ${maxAttempts}
    ORDER BY c.embed_attempts ASC, d.updated_at DESC
    LIMIT ${limit}`;
}

/**
 * The embedding backfill's work list: documents in a workspace with any chunk
 * lacking a vector, keyset-paged by doc_id so the pass can resume.
 */
export async function listDocsNeedingEmbeddingBackfill(
  sql: Sql,
  workspaceId: string,
  limit: number,
  afterDocId: string | null,
): Promise<Array<{ doc_id: string; snapshot_seq: number; title: string }>> {
  return sql<Array<{ doc_id: string; snapshot_seq: number; title: string }>>`
    SELECT d.doc_id, d.snapshot_seq, d.title
    FROM docs d
    WHERE d.workspace_id = ${workspaceId}
      AND d.trashed = FALSE
      AND d.search_hidden = FALSE
      AND (${afterDocId}::text IS NULL OR d.doc_id > ${afterDocId})
      AND EXISTS (SELECT 1 FROM doc_chunks c WHERE c.doc_id = d.doc_id AND c.embedding IS NULL)
    ORDER BY d.doc_id ASC
    LIMIT ${limit}`;
}

/**
 * Move the backfill cursor forward, or finish the pass with `null`. The pass
 * must move on its own cursor: a document leaves the "needs vectors" set only
 * after its index job runs, so re-querying would enqueue it again every tick.
 */
export async function advanceEmbeddingBackfill(sql: Sql, workspaceId: string, cursor: string | null): Promise<void> {
  if (cursor === null) {
    await sql`
      UPDATE workspaces
      SET embedding_backfill_at = NULL, embedding_backfill_cursor = NULL
      WHERE workspace_id = ${workspaceId}`;
    return;
  }
  await sql`
    UPDATE workspaces SET embedding_backfill_cursor = ${cursor}
    WHERE workspace_id = ${workspaceId}`;
}

/** Workspaces armed for a backfill, oldest first so none starves. */
export async function listWorkspacesAwaitingBackfill(sql: Sql, limit: number): Promise<WorkspaceRow[]> {
  return sql<WorkspaceRow[]>`
    SELECT * FROM workspaces
    WHERE embedding_backfill_at IS NOT NULL
    ORDER BY embedding_backfill_at ASC
    LIMIT ${limit}`;
}

/** An invalid vector is not stored, so a later sweep retries the chunk. */
export async function setChunkEmbedding(
  sql: Sql,
  docId: string,
  chunkIndex: number,
  embedding: number[],
  dims: number,
): Promise<void> {
  const vec = vectorLiteral(embedding, dims);
  if (vec === null) return;
  await sql`
    UPDATE doc_chunks
    SET embedding = ${vec}::vector
    WHERE doc_id = ${docId} AND chunk_index = ${chunkIndex}`;
}

export async function bumpChunkEmbedAttempt(sql: Sql, docId: string, chunkIndex: number): Promise<void> {
  await sql`
    UPDATE doc_chunks
    SET embed_attempts = embed_attempts + 1
    WHERE doc_id = ${docId} AND chunk_index = ${chunkIndex}`;
}

/**
 * Drop every stored vector node-wide, for an embedding model change. Required,
 * not optional: embed_hash covers the input and not the model, so vectors left
 * in place would be reused through getReusableChunkEmbeddings.
 */
export async function clearAllChunkEmbeddings(sql: Sql): Promise<number> {
  const res = await sql`
    UPDATE doc_chunks SET embedding = NULL, embed_attempts = 0
    WHERE embedding IS NOT NULL OR embed_attempts > 0`;
  return res.count;
}

/** Arm the backfill for every workspace not already mid-pass. */
export async function armEmbeddingBackfillAll(sql: Sql): Promise<number> {
  const res = await sql`
    UPDATE workspaces
    SET embedding_backfill_at = now(), embedding_backfill_cursor = NULL
    WHERE embedding_backfill_at IS NULL`;
  return res.count;
}

/** embed_hash → stored vector for a document's embedded chunks, so a re-index embeds only changed chunks. */
export async function getReusableChunkEmbeddings(sql: Sql, docId: string, dims: number): Promise<Map<string, number[]>> {
  const rows = await sql<{ embed_hash: string; embedding: string }[]>`
    SELECT embed_hash, embedding::text AS embedding
    FROM doc_chunks
    WHERE doc_id = ${docId} AND embedding IS NOT NULL AND embed_hash IS NOT NULL`;
  const map = new Map<string, number[]>();
  for (const r of rows) {
    const vec = r.embedding.slice(1, -1).split(",").map(Number);
    if (vec.length === dims && vec.every(Number.isFinite)) map.set(r.embed_hash, vec);
  }
  return map;
}


export interface ChunkInput {
  content: string;
  /** Null when embedding failed; the keyword leg still covers the chunk. */
  embedding: number[] | null;
  headingPath?: string | null;
  /** sha-256 of the chunk's exact embed input. */
  embedHash: string;
}

export interface IndexDocInput {
  docId: string;
  snapshotSeq: number;
  title: string;
  searchText: string;
  embeddingHash: string;
  /** Replaces the document's chunk set. */
  chunks: ChunkInput[];
  /** Width of doc_chunks.embedding in this database. */
  embeddingDims: number;
  /** The node's search languages, which the keyword vectors stem words under; none when absent. */
  searchLanguages?: readonly SearchLanguage[];
}

/** Drop a document's chunks and forget its embedding hash, so unhiding re-embeds. */
export async function clearDocChunks(sql: Sql, docId: string): Promise<void> {
  // docs before doc_chunks, the order indexDoc and a rename lock them in.
  await sql.begin(async (tx) => {
    await tx`UPDATE docs SET embedding_hash = NULL WHERE doc_id = ${docId}`;
    await tx`DELETE FROM doc_chunks WHERE doc_id = ${docId}`;
  });
}

/**
 * Write a flush's search payload and replace the chunk set, atomically. The
 * `snapshot_seq <= $seq` guard stops a late, out-of-order job from rolling the
 * row back; when it refuses, the chunks are left alone too. The row is locked
 * first, so the vectors are written for the title it keeps.
 */
export async function indexDoc(sql: Sql, input: IndexDocInput): Promise<void> {
  const languages = input.searchLanguages ?? [];
  const configs = searchConfigs(languages);
  await sql.begin(async (tx) => {
    const [row] = await tx<{ title: string; title_source: string; snapshot_seq: number }[]>`
      SELECT title, title_source, snapshot_seq FROM docs WHERE doc_id = ${input.docId} FOR UPDATE`;
    if (!row || row.snapshot_seq > input.snapshotSeq) return;
    // A rename outranks the heading-derived title.
    const title = row.title_source === "user" ? row.title : input.title;
    await tx`
      UPDATE docs SET
        snapshot_seq    = ${input.snapshotSeq},
        title           = ${title},
        search_text     = ${input.searchText},
        ${docVectorsSet(tx, { title, text: input.searchText, languages, whole: true })},
        embedding_hash  = ${input.embeddingHash},
        updated_at = now()
      WHERE doc_id = ${input.docId}`;

    await tx`DELETE FROM doc_chunks WHERE doc_id = ${input.docId}`;
    if (input.chunks.length === 0) return;

    // pgvector has no implicit text→vector assignment cast, so the rows go in
    // as parallel arrays cast element-wise, each passage's terms beside it for
    // Postgres to stem. The opening passage carries the title the row kept.
    const contents = input.chunks.map((c) => c.content);
    const vectors = input.chunks.map((c) => vectorLiteral(c.embedding, input.embeddingDims));
    const headingPaths = input.chunks.map((c) => c.headingPath ?? "");
    const embedHashes = input.chunks.map((c) => c.embedHash);
    const terms = input.chunks.map((c, i) => vectorTerms(chunkText(i === 0 ? title : null, c.headingPath ?? null, c.content), configs.length));
    await tx`
      INSERT INTO doc_chunks (doc_id, workspace_id, chunk_index, content, heading_path, embedding, embed_hash, tsv, dl)
      SELECT ${input.docId}, (SELECT workspace_id FROM docs WHERE doc_id = ${input.docId}),
             t.ord - 1, t.content, NULLIF(t.hp, ''), NULLIF(t.vec, '')::vector, t.eh,
             ${vectorSql(tx, tx`t.latin::jsonb`, tx`t.cjk::jsonb`, configs, false)}, t.dl
      FROM unnest(${contents}::text[], ${headingPaths}::text[], ${vectors}::text[], ${embedHashes}::text[],
                  ${terms.map((x) => JSON.stringify(x.latin))}::text[], ${terms.map((x) => JSON.stringify(x.cjk))}::text[],
                  ${terms.map((x) => x.length)}::int[])
           WITH ORDINALITY AS t(content, hp, vec, eh, latin, cjk, dl, ord)`;
  });
}

/**
 * Move `snapshot_seq` to a flush that had nothing to index (a search-hidden
 * document, unchanged text), so it keeps up with the actor's head. Forward
 * only, like indexDoc's guard.
 */
export async function advanceSnapshotSeq(sql: Sql, docId: string, snapshotSeq: number): Promise<void> {
  await sql`
    UPDATE docs SET snapshot_seq = ${snapshotSeq}
    WHERE doc_id = ${docId} AND snapshot_seq < ${snapshotSeq}`;
}

export interface SearchInput {
  /** The searcher's flattened principal set. */
  principals: string[];
  /** ANDed into both legs; the only isolation the vector leg has. */
  workspaceId: string;
  query: string;
  /** Null skips the semantic leg. */
  queryEmbedding: number[] | null;
  embeddingDims: number;
  /** The semantic leg keeps a chunk only below this cosine distance to the query; null keeps the nearest at any distance. */
  maxDistance: number | null;
  limit?: number;
  /** Collection scope: only these doc ids. An empty array yields no results. */
  scopeDocIds?: string[] | null;
  /** A scoped credential's folders, subtrees already expanded. */
  scopeFolderIds?: string[] | null;
  /** The node's search languages, which the query's words are stemmed under; read once per query. */
  searchLanguages?: () => readonly SearchLanguage[];
  /** As many visible chunks as this or fewer are scored exactly; tests lower it to reach the HNSW path. */
  exactScanMax?: number;
  /** The HNSW scan's tuple budget; tests lower it below a crowd to show where the index gives up. */
  scanTuples?: number;
  /**
   * The keyword leg finds a document holding any of the query's words, not only every one, ranked by
   * those it holds: for an agent's search that found none holding them all.
   */
  anyWord?: boolean;
}

export interface AskInput {
  principals: string[];
  workspaceId: string;
  query: string;
  queryEmbedding: number[] | null;
  embeddingDims: number;
  /** Passages to return. */
  limit?: number;
  scopeDocIds?: string[] | null;
  scopeFolderIds?: string[] | null;
  /** As in SearchInput. */
  searchLanguages?: () => readonly SearchLanguage[];
  /** As in SearchInput. */
  exactScanMax?: number;
  /** As in SearchInput. */
  scanTuples?: number;
}

function normalizeQueryLimit(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return fallback;
  return Math.min(value, 100);
}

// Every leg carries the tenant, trash, hidden, ACL and scope gates inside its
// own WHERE, ahead of its own LIMIT: a leg spends its candidate budget only on
// rows the searcher may see, and nothing outside it can widen that set.

/** The documents a searcher may see, over `docs d`. */
function visibleDocs(sql: Queryable, input: Pick<AskInput, "workspaceId" | "principals">, scopeFilter: Fragment): Fragment {
  return sql`d.workspace_id = ${input.workspaceId}
        AND d.trashed = FALSE
        AND d.search_hidden = FALSE
        AND d.acl_principals && ${input.principals}
        ${scopeFilter}`;
}

/**
 * The chunks a searcher may see. The HNSW index spans every workspace on the
 * node, so these gates are the semantic leg's only isolation. Whether a chunk
 * has an embedding is checked in the legs, not here: no index covers it, and
 * while a new model's backfill runs most chunks have none, so a count that
 * asked would read every visible chunk instead of stopping at its cap.
 */
function visibleChunks(sql: Queryable, input: SearchInput | AskInput, scopeFilter: Fragment): Fragment {
  return sql`c.workspace_id = ${input.workspaceId}
        AND d.workspace_id = ${input.workspaceId}
        AND d.trashed = FALSE
        AND d.search_hidden = FALSE
        AND d.acl_principals && ${input.principals}
        ${scopeFilter}`;
}

/**
 * Up to this many visible chunks, the semantic leg is an exact scan. An HNSW
 * scan stops after hnsw.max_scan_tuples tuples or its scan memory, so when the
 * searcher sees a small slice of the node (a small workspace, a narrow ACL, a
 * collection or folder) and other passages crowd the query, it can stop before
 * reaching any visible one. A small set is cheap to score exactly.
 */
const EXACT_SCAN_MAX_CHUNKS = 5000;

/** How the semantic leg will scan for this searcher: exactly over a small visible set, else by the HNSW index. */
export async function semanticScan(sql: Queryable, input: SearchInput | AskInput): Promise<"exact" | "index"> {
  const exactMax = input.exactScanMax ?? EXACT_SCAN_MAX_CHUNKS;
  const scopeFilter = scopeFragment(sql, input.scopeDocIds ?? null, input.scopeFolderIds ?? null);
  const [probe] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM (
      SELECT 1 FROM doc_chunks c JOIN docs d ON d.doc_id = c.doc_id
      WHERE ${visibleChunks(sql, input, scopeFilter)}
      LIMIT ${exactMax + 1}) visible`;
  return (probe?.n ?? 0) <= exactMax ? "exact" : "index";
}

/**
 * Runs a hybrid query with pgvector's iterative index scan, or with an exact
 * semantic leg when few chunks are visible. An HNSW scan hands back its nearest
 * ef_search tuples before any gate in WHERE runs, so a neighbourhood that
 * belongs to documents the searcher cannot see left the semantic leg empty;
 * iterating walks on toward the leg's LIMIT visible rows, within the scan
 * budget set here. That is also why the search box's distance cutoff sits
 * outside the ordered scan: inside, a neighbourhood with fewer than LIMIT close
 * passages would walk to the end of that budget. Each query is planned for its
 * own terms: how many rows hold them decides the keyword legs' best plan, which
 * a plan cached for the statement's shape would not know.
 */
function withVectorScan<T>(
  sql: Sql,
  input: SearchInput | AskInput,
  limit: number,
  run: (tx: TransactionSql, nearest: Fragment) => Promise<T>,
): Promise<T> {
  const efSearch = Math.min(Math.max(limit, 40), 1000);
  return sql.begin(async (tx) => {
    await tx`SELECT set_config('hnsw.iterative_scan', 'strict_order', true),
                    set_config('hnsw.ef_search', ${String(efSearch)}, true),
                    set_config('hnsw.max_scan_tuples', ${String(input.scanTuples ?? 100000)}, true),
                    set_config('hnsw.scan_mem_multiplier', '8', true),
                    set_config('plan_cache_mode', 'force_custom_plan', true)`;
    const scan = input.queryEmbedding ? await semanticScan(tx, input) : "index";
    // Arithmetic on the distance keeps the planner off the HNSW index.
    return run(tx, scan === "exact" ? sql`(c.embedding <=> q.qvec) + 0::float8` : sql`c.embedding <=> q.qvec`);
  }) as Promise<T>;
}

/** A searchDocs row before its excerpt is chosen. */
interface SearchRow extends Omit<SearchResult, "snippet"> {
  /** Whether the keyword leg found it. */
  keyword: boolean;
  /** The body, which the excerpt is cut from. */
  text: string;
  /** The passage closest in meaning, when the semantic leg found it. */
  passage: string | null;
  /** The positions of the body's words that hold a stem of the query, when the keyword leg found it. */
  kw_at: number[] | null;
}

/** What excerptOf picks a hit's excerpt from. */
interface Excerpt {
  /** The keyword window, its matches between sentinels; null without one. */
  keyword: string | null;
  /** The text around the word the unfinished last term begins, where in it (in code points) that word starts, and which ends were cut. */
  prefix: { text: string; offset: number; cutStart: boolean; cutEnd: boolean } | null;
  /** The opening of the passage closest in meaning, and whether the passage goes on. */
  passage: { text: string; cut: boolean } | null;
  /** The opening of the body, and whether it goes on. */
  head: { text: string; cut: boolean };
  /** Whether the excerpt excerptOf picks begins inside a fenced code block. */
  inCode: boolean;
  /** The part of the excerpt's first line the cut left out, before where it begins. */
  lineLead: string;
}

/** Characters kept before a prefix match, so the excerpt reads as a sentence. */
const PREFIX_LEAD = 60;

/**
 * A fenced code block's opening or closing line, inside any quote or list item,
 * read as the web app's snippet renderer reads one (FENCE in its snippet.tsx).
 */
const FENCE = /^[ \t]*(?:>[ \t]?)*[ \t]*(?:(?:[-+*]|\d+[.)])[ \t]+)?(?:`{3,}[^`]*|~{3,}.*)$/;

/** Characters a cut may drop to end on a word; text written without spaces has none that near, and is kept as cut. */
const WORD_CUT_MAX = 24;

/**
 * `text` without the word a cut fell inside at its start or end, so an excerpt
 * reads "queue at 8am", not "eue at 8am". `dropped` is what went from the start.
 */
function wholeWordCut(text: string, cutStart: boolean, cutEnd: boolean): { text: string; dropped: string } {
  let dropped = "";
  if (cutStart && /^\S/.test(text)) {
    const space = text.slice(0, WORD_CUT_MAX).search(/\s/);
    if (space > 0) {
      // A line break stays, so the excerpt's first line is still one of the body's.
      dropped = text.slice(0, text[space] === "\n" ? space : space + 1);
      text = text.slice(dropped.length);
    }
  }
  if (cutEnd && /\S$/.test(text)) {
    const tail = /\s\S*$/.exec(text.slice(-WORD_CUT_MAX));
    if (tail) text = text.slice(0, text.length - tail[0].length);
  }
  return { text, dropped };
}

/** Wraps the word starting `offset` code points into `text` in highlight sentinels. */
function markWordAt(text: string, offset: number): string {
  const chars = [...text];
  const rest = chars.slice(offset).join("");
  const word = /^[\p{L}\p{M}\p{N}_]+/u.exec(rest)?.[0] ?? "";
  if (!word) return text;
  return `${chars.slice(0, offset).join("")}⟦${word}⟧${rest.slice(word.length)}`;
}

/** Where `count` code points from `from` (UTF-16 units, forwards or, negative, backwards) end in `text`. */
function codePointsFrom(text: string, from: number, count: number): number {
  let at = from;
  const surrogate = (i: number) => (text.charCodeAt(i) & 0xfc00) === 0xdc00;
  for (let n = 0; n < Math.abs(count); n++) {
    if (count > 0) {
      if (at >= text.length) break;
      at += surrogate(at + 1) ? 2 : 1;
    } else {
      if (at <= 0) break;
      at -= surrogate(at - 1) && at > 1 ? 2 : 1;
    }
  }
  return at;
}

/** The opening `count` code points of `text`, and whether it goes on past them. */
function opening(text: string, count: number): { text: string; cut: boolean } {
  const end = codePointsFrom(text, 0, count);
  return { text: text.slice(0, end), cut: end < text.length };
}

/**
 * What excerptOf reads for a hit: the keyword window when the body holds a match, else the word the
 * unfinished last term begins, else the closest passage, else the opening; and where the excerpt
 * begins in the body (-1 for the opening), for whether it is in code.
 */
function excerptFor(row: SearchRow, plan: KeywordPlan): Excerpt {
  const text = row.text;
  let at = -1;
  let keyword: Excerpt["keyword"] = null;
  let prefix: Excerpt["prefix"] = null;
  let passage: Excerpt["passage"] = null;
  const window = row.keyword ? keywordExcerpt(text, { words: new Set(row.kw_at ?? []), cjk: new Set(plan.cjkMarks) }) : null;
  const word = window || plan.completion === null ? -1 : completionAt(text, plan.completion);
  if (window) {
    keyword = window.text;
    at = window.start;
  } else if (word >= 0) {
    at = codePointsFrom(text, word, -PREFIX_LEAD);
    const end = codePointsFrom(text, at, EXCERPT_CHARS + PREFIX_LEAD);
    prefix = { text: text.slice(at, end), offset: Array.from(text.slice(at, word)).length, cutStart: at > 0, cutEnd: end < text.length };
  } else if (row.passage) {
    passage = opening(row.passage, EXCERPT_CHARS);
    at = text.indexOf(passage.text);
  }
  // The body is in code after the excerpt's first line when its fences through
  // that line are odd in number, and the excerpt opens a block of its own when
  // that line reads as a fence. Either without the other wants a fence above it.
  let inCode = false;
  let lineLead = "";
  if (at >= 0) {
    const lineEnd = text.indexOf("\n", at);
    const line = text.slice(at, lineEnd < 0 ? text.length : lineEnd);
    const fences = text.slice(0, at + line.length).split("\n").filter((l) => FENCE.test(l)).length + (FENCE.test(line) ? 1 : 0);
    inCode = fences % 2 === 1;
    lineLead = text.slice(text.lastIndexOf("\n", at - 1) + 1, at);
  }
  return { keyword, prefix, passage, head: opening(text, EXCERPT_CHARS), inCode, lineLead };
}

/**
 * Why a document is on the list, as text: the body's keyword matches; else the
 * word the unfinished last term begins; else the passage closest in meaning; else
 * the document's opening.
 *
 * The text is the body's Markdown. An excerpt that begins inside a fenced code
 * block starts with a fence line the body does not have there ("```"): cut from
 * below the block's own fence, its code would read as prose, and `__iter__` as
 * emphasis. Agents read snippets too, through MCP, and the fence keeps the
 * excerpt honest Markdown.
 */
function excerptOf(row: Excerpt): string {
  let text: string;
  let lineLead = row.lineLead;
  if (row.keyword !== null) {
    // The window is cut at word edges already.
    text = row.keyword;
  } else if (row.prefix) {
    const cut = wholeWordCut(row.prefix.text, row.prefix.cutStart, row.prefix.cutEnd);
    text = markWordAt(cut.text, row.prefix.offset - [...cut.dropped].length);
    lineLead += cut.dropped;
  } else if (row.passage) {
    text = wholeWordCut(row.passage.text, false, row.passage.cut).text;
  } else {
    text = wholeWordCut(row.head.text, false, row.head.cut).text;
  }
  if (!row.inCode) return text;
  const line = lineLead + (text.split("\n", 1)[0] ?? "");
  // Cut past an opening fence's backticks, at its language ("sh"): the fence line is made whole again.
  if (lineLead.trim() && FENCE.test(line)) return lineLead + text;
  // The serializer follows an opening fence with code and a closing one with a
  // blank line, which is how the page tells them apart: blank lines go. A block
  // in a quote has its fence there too.
  const quote = /^(?:[ \t]*>[ \t]?)*/.exec(line)?.[0] ?? "";
  return `${quote}\`\`\`\n${text.replace(/^[\s>]*\n/, "")}`;
}

/**
 * Hybrid search, one row per document. Each hit's snippet says why it matched:
 * see excerptOf. The excerpts are cut after the limit, so only returned rows pay.
 */
export async function searchDocs(sql: Sql, input: SearchInput): Promise<SearchResult[]> {
  const limit = normalizeQueryLimit(input.limit, 20);
  const candidates = Math.max(limit * 4, 50);
  if (input.scopeDocIds && input.scopeDocIds.length === 0) return [];
  const scopeFilter = scopeFragment(sql, input.scopeDocIds ?? null, input.scopeFolderIds ?? null);
  const visible = visibleDocs(sql, input, scopeFilter);
  const qvec = vectorLiteral(input.queryEmbedding, input.embeddingDims);
  const semLimit = candidates * 4;
  const plan = await planKeywords(sql, input.query, input.searchLanguages?.() ?? []);

  // Reciprocal Rank Fusion: each leg a document appears in adds 1/(60 + its rank
  // there), and a leg it is absent from adds nothing.
  const rows = await withVectorScan(sql, input, semLimit, async (tx, nearest) => {
    const typoIds = await typoMatches(tx, plan, visible);
    return tx<SearchRow[]>`
    WITH q AS (
      SELECT ${qvec}::vector AS qvec
    ),
    ${keywordCtes(sql, plan, visible, candidates, typoIds, input.anyWord === true)},
    kw_ranked AS (
      SELECT k.*, rank() OVER (ORDER BY k.kw_rank DESC) AS kw_pos
      FROM kw_candidates k
    ),
    -- Nearest visible chunks, then the cutoff, collapsed to each document's best passage.
    chunk_near AS (
      SELECT c.doc_id, c.chunk_index, c.embedding <=> q.qvec AS dist
      FROM doc_chunks c
      JOIN docs d ON d.doc_id = c.doc_id
      , q
      WHERE ${visibleChunks(sql, input, scopeFilter)}
        AND q.qvec IS NOT NULL
        AND c.embedding IS NOT NULL
      ORDER BY ${nearest}
      LIMIT ${semLimit}
    ),
    chunk_hits AS (
      SELECT doc_id, chunk_index, 1 - dist AS sem_score
      FROM chunk_near
      WHERE ${input.maxDistance}::float8 IS NULL OR dist < ${input.maxDistance}::float8
    ),
    sem_best AS (
      SELECT DISTINCT ON (doc_id) doc_id, chunk_index, sem_score
      FROM chunk_hits
      ORDER BY doc_id, sem_score DESC, chunk_index
    ),
    sem_candidates AS (
      SELECT doc_id, chunk_index, sem_score
      FROM sem_best
      ORDER BY sem_score DESC
      LIMIT ${candidates}
    ),
    sem_ranked AS (
      SELECT s.*, rank() OVER (ORDER BY s.sem_score DESC) AS sem_pos
      FROM sem_candidates s
    ),
    fused AS (
      SELECT COALESCE(k.doc_id, s.doc_id)                AS doc_id,
             COALESCE(k.kw_rank, 0)                      AS kw_rank,
             COALESCE(s.sem_score, 0)                    AS sem_score,
             s.chunk_index                               AS sem_chunk,
             k.doc_id IS NOT NULL                        AS keyword,
             COALESCE(k.kw_whole, FALSE)                 AS kw_whole,
             COALESCE(1.0/(60 + k.kw_pos), 0)
               + COALESCE(1.0/(60 + s.sem_pos), 0)       AS score
      FROM kw_ranked k
      FULL OUTER JOIN sem_ranked s ON k.doc_id = s.doc_id
    ),
    top AS (
      SELECT f.*, d.title, d.doc_type, d.page_of, d.page_row, d.updated_at
      FROM fused f
      JOIN docs d ON d.doc_id = f.doc_id
      ORDER BY f.score DESC, d.doc_id
      LIMIT ${limit}
    )
    SELECT t.doc_id, t.title, t.doc_type, t.page_of, t.page_row, t.updated_at, t.kw_rank, t.kw_whole, t.sem_score, t.score,
           t.keyword, d.search_text AS text, ch.content AS passage,
           CASE WHEN t.keyword THEN (
             SELECT array_agg(DISTINCT p.p ORDER BY p.p)
             FROM unnest(d.search_tsv) AS u, unnest(u.positions) AS p(p)
             WHERE u.lexeme = ANY(${plan.marks}::text[])) END AS kw_at
    FROM top t
    JOIN docs d ON d.doc_id = t.doc_id
    LEFT JOIN doc_chunks ch ON ch.doc_id = t.doc_id AND ch.chunk_index = t.sem_chunk
    ORDER BY t.score DESC, t.doc_id`;
  });
  return rows.map((row) => {
    const { keyword: _k, text: _t, passage: _p, kw_at: _a, ...hit } = row;
    return { ...hit, snippet: excerptOf(excerptFor(row, plan)) };
  });
}

/** Hybrid retrieval of individual passages for cited answers, without the per-document collapse. */
export async function askDocs(sql: Sql, input: AskInput): Promise<AskChunk[]> {
  const limit = normalizeQueryLimit(input.limit, 8);
  const candidates = Math.max(limit * 4, 32);
  if (input.scopeDocIds && input.scopeDocIds.length === 0) return [];
  const scopeFilter = scopeFragment(sql, input.scopeDocIds ?? null, input.scopeFolderIds ?? null);
  const qvec = vectorLiteral(input.queryEmbedding, input.embeddingDims);
  const plan = await planKeywords(sql, input.query, input.searchLanguages?.() ?? []);
  // Reciprocal Rank Fusion, as in searchDocs, over passages.
  return withVectorScan(sql, input, candidates, (tx, nearest) => tx<AskChunk[]>`
    WITH q AS (
      SELECT ${qvec}::vector AS qvec
    ),
    chunk_near AS (
      SELECT c.doc_id, c.chunk_index, c.content,
             c.embedding <=> q.qvec AS dist
      FROM doc_chunks c
      JOIN docs d ON d.doc_id = c.doc_id
      , q
      WHERE ${visibleChunks(sql, input, scopeFilter)}
        AND q.qvec IS NOT NULL
        AND c.embedding IS NOT NULL
      ORDER BY ${nearest}
      LIMIT ${candidates}
    ),
    chunk_hits AS (
      SELECT doc_id, chunk_index, content, 1 - dist AS sem_score
      FROM chunk_near
    ),
    sem_ranked AS (
      SELECT s.*, rank() OVER (ORDER BY s.sem_score DESC) AS sem_pos
      FROM chunk_hits s
    ),
    ${chunkKeywordCtes(sql, plan, visibleDocs(sql, input, scopeFilter), input.workspaceId, candidates)},
    kw_ranked AS (
      SELECT k.*, rank() OVER (ORDER BY k.kw_rank DESC) AS kw_pos
      FROM kw_hits k
    ),
    fused AS (
      SELECT COALESCE(s.doc_id, k.doc_id)               AS doc_id,
             COALESCE(s.chunk_index, k.chunk_index)     AS chunk_index,
             COALESCE(s.sem_score, 0)                   AS sem_score,
             COALESCE(1.0/(60 + s.sem_pos), 0)
               + COALESCE(1.0/(60 + k.kw_pos), 0)       AS score
      FROM sem_ranked s
      FULL OUTER JOIN kw_ranked k
        ON s.doc_id = k.doc_id AND s.chunk_index = k.chunk_index
    )
    SELECT f.doc_id, d.title, f.chunk_index,
           ch.content, ch.heading_path,
           f.sem_score, f.score, ${holdsEveryWord(tx, plan)} AS kw_whole
    FROM fused f
    JOIN docs d ON d.doc_id = f.doc_id
    JOIN doc_chunks ch ON ch.doc_id = f.doc_id AND ch.chunk_index = f.chunk_index
    -- An empty passage, or one of headings alone (an index written before they were left out), would
    -- spend a citation on nothing.
    WHERE ch.content <> ''
      AND btrim(regexp_replace(ch.content, ${HEADING_LINE}, '', 'gn'), ${BLANKS}) <> ''
    ORDER BY f.score DESC, f.doc_id, f.chunk_index
    LIMIT ${limit}`);
}

/** A Markdown heading line, as Postgres's newline-sensitive regular expressions match it. */
const HEADING_LINE = "^[[:blank:]]{0,3}#{1,6}([[:blank:]].*)?$";
const BLANKS = " \t\r\n";

/**
 * Whether a passage `ch`, with its document's title `d`, holds every word of the query, as a search
 * result must: what tells an answer from the passages holding only some of the words.
 */
function holdsEveryWord(sql: Queryable, plan: KeywordPlan): Fragment {
  if (plan.groupCount === 0 || plan.queries.length === 0 || plan.titleOnly) return sql`FALSE`;
  return sql`(
    SELECT count(DISTINCT g.grp)
    FROM unnest(${plan.groups}::int[], ${plan.groupTerms}::int[]) AS g(grp, term)
    JOIN unnest(${plan.queries.map((_, k) => k + 1)}::int[], ${plan.queries}::tsquery[]) AS q(term, tq) ON q.term = g.term
    WHERE ch.tsv @@ q.tq OR d.title_tsv @@ q.tq
  ) = ${plan.groupCount}`;
}

/** A document whose title holds a word of a query, and whether any of its text is indexed. */
export interface TitledDoc {
  doc_id: string;
  title: string;
  /** Some of its text is indexed: false for a page whose approved text is empty, as a new page's is while all of it waits. */
  has_text: boolean;
}

/**
 * The visible prose documents whose titles hold any word of `query`, the best-matching titles first:
 * the pages a passage search never finds when nothing of their text is approved yet. Gated as a search
 * is (tenant, trash, hidden, ACL and scope).
 */
export async function docsByTitle(
  sql: Sql,
  input: Pick<AskInput, "principals" | "workspaceId" | "query" | "scopeDocIds" | "scopeFolderIds" | "searchLanguages" | "limit">,
): Promise<TitledDoc[]> {
  if (input.scopeDocIds && input.scopeDocIds.length === 0) return [];
  const plan = await planKeywords(sql, input.query, input.searchLanguages?.() ?? []);
  if (plan.queries.length === 0) return [];
  const scopeFilter = scopeFragment(sql, input.scopeDocIds ?? null, input.scopeFolderIds ?? null);
  const any = plan.queries.map((q) => `(${q})`).join(" | ");
  return sql<TitledDoc[]>`
    SELECT d.doc_id, d.title, EXISTS (SELECT 1 FROM doc_chunks c WHERE c.doc_id = d.doc_id) AS has_text
    FROM docs d
    WHERE ${visibleDocs(sql, input, scopeFilter)}
      AND d.doc_type = 'prose'
      AND d.title_tsv @@ ${any}::tsquery
    ORDER BY ts_rank(d.title_tsv, ${any}::tsquery) DESC, d.doc_id
    LIMIT ${normalizeQueryLimit(input.limit, 20)}`;
}

/** A database a question's or a point's words reach, best first. */
export interface WordedDatabase {
  doc_id: string;
  title: string;
}

/**
 * The visible databases whose title or text (each table's name, its column names, its cells: what its
 * indexing wrote) holds any word of `query`, those holding the most first: the tables an agent's recall and
 * its Save to Stuga plan read rows from. Gated as a search is (tenant, trash, hidden, ACL and scope).
 */
export async function databasesByWords(
  sql: Sql,
  input: Pick<AskInput, "principals" | "workspaceId" | "query" | "scopeDocIds" | "scopeFolderIds" | "searchLanguages" | "limit">,
): Promise<WordedDatabase[]> {
  if (input.scopeDocIds && input.scopeDocIds.length === 0) return [];
  const plan = await planKeywords(sql, input.query, input.searchLanguages?.() ?? []);
  if (plan.queries.length === 0) return [];
  const scopeFilter = scopeFragment(sql, input.scopeDocIds ?? null, input.scopeFolderIds ?? null);
  const any = plan.queries.map((q) => `(${q})`).join(" | ");
  // How many of the query's words it holds, title or text: one term may stand for several stems.
  const held = sql`(
    SELECT count(*) FROM unnest(${plan.queries}::tsquery[]) AS q(tq)
    WHERE d.title_tsv @@ q.tq OR d.search_tsv @@ q.tq)`;
  return sql<WordedDatabase[]>`
    SELECT d.doc_id, d.title
    FROM docs d
    WHERE ${visibleDocs(sql, input, scopeFilter)}
      AND d.doc_type = 'database'
      AND (d.title_tsv @@ ${any}::tsquery OR d.search_tsv @@ ${any}::tsquery)
    ORDER BY ${held} DESC, ts_rank(d.title_tsv, ${any}::tsquery) DESC, d.updated_at DESC, d.doc_id
    LIMIT ${normalizeQueryLimit(input.limit, 5)}`;
}

/**
 * The words of `words` that search leaves out as stopwords under any of the node's configurations
 * (English and each search language): "with", "their", "über". A word search never matches on is no
 * reason to name a place either.
 */
export async function stopwordsAmong(sql: Queryable, words: readonly string[], languages: readonly SearchLanguage[]): Promise<Set<string>> {
  const latin = [...new Set(words)].filter((w) => /^[\p{L}\p{M}\p{N}]+$/u.test(w) && /\p{L}/u.test(w));
  if (latin.length === 0) return new Set();
  const rows = await sql<{ word: string }[]>`
    SELECT w.word FROM unnest(${latin}::text[]) AS w(word)
    WHERE EXISTS (SELECT 1 FROM unnest(${searchConfigs(languages)}::regconfig[]) AS c(cfg) WHERE to_tsvector(c.cfg, w.word) = ''::tsvector)`;
  return new Set(rows.map((r) => r.word));
}
