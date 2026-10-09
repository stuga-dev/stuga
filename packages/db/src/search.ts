/**
 * Indexing and retrieval. Search is one statement per call: a BM25 keyword leg
 * (pg_search) and a pgvector semantic leg, fused with Reciprocal Rank Fusion.
 * Both legs read the live row, so ACL and content changes apply immediately.
 */
import type { Fragment, TransactionSql } from "postgres";
import type { AskChunk, SearchResult, WorkspaceRow } from "./types.js";
import type { SearchLanguage } from "./schema/search-indexes.js";
import { type Queryable, scopeFragment, vectorLiteral } from "./sql.js";
import type { Sql } from "./client.js";

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
 * row back; when it refuses, the chunks are left alone too.
 */
export async function indexDoc(sql: Sql, input: IndexDocInput): Promise<void> {
  await sql.begin(async (tx) => {
    const updated = await tx<{ doc_id: string }[]>`
      UPDATE docs SET
        snapshot_seq    = ${input.snapshotSeq},
        -- A rename outranks the heading-derived title.
        title           = CASE WHEN title_source = 'user' THEN title ELSE ${input.title} END,
        search_text     = ${input.searchText},
        embedding_hash  = ${input.embeddingHash},
        updated_at = now()
      WHERE doc_id = ${input.docId}
        AND snapshot_seq <= ${input.snapshotSeq}
      RETURNING doc_id`;
    if (updated.length === 0) return;

    await tx`DELETE FROM doc_chunks WHERE doc_id = ${input.docId}`;
    if (input.chunks.length === 0) return;

    // pgvector has no implicit text→vector assignment cast, so the rows go in
    // as parallel arrays cast element-wise. Chunk 0's doc_title is read from the
    // row just written, where a rename may have kept the stored title.
    const contents = input.chunks.map((c) => c.content);
    const vectors = input.chunks.map((c) => vectorLiteral(c.embedding, input.embeddingDims));
    const headingPaths = input.chunks.map((c) => c.headingPath ?? "");
    const embedHashes = input.chunks.map((c) => c.embedHash);
    await tx`
      INSERT INTO doc_chunks (doc_id, workspace_id, chunk_index, content, heading_path, embedding, embed_hash, doc_title)
      SELECT ${input.docId}, (SELECT workspace_id FROM docs WHERE doc_id = ${input.docId}),
             ord - 1, content, NULLIF(hp, ''), NULLIF(vec, '')::vector, eh,
             CASE WHEN ord = 1 THEN (SELECT title FROM docs WHERE doc_id = ${input.docId}) END
      FROM unnest(${contents}::text[], ${headingPaths}::text[], ${vectors}::text[], ${embedHashes}::text[])
           WITH ORDINALITY AS t(content, hp, vec, eh, ord)`;
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
  /**
   * The languages the BM25 indexes answer for, read as the SQL is built: a
   * query naming one the index lacks fails. They change while the indexes are
   * rebuilt, so this is a getter rather than a value read earlier.
   */
  searchLanguages?: () => readonly SearchLanguage[];
  /** As many visible chunks as this or fewer are scored exactly; tests lower it to reach the HNSW path. */
  exactScanMax?: number;
  /** The HNSW scan's tuple budget; tests lower it below a crowd to show where the index gives up. */
  scanTuples?: number;
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

/** Scripts written without spaces between words, where a typed word is no token's prefix. */
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

/**
 * The query's last word, lowercased as the index stores it, when it may be a word
 * still being typed: letters and digits only, in a script that spaces its words,
 * and long enough to narrow (three characters, or two Hangul syllables). Null otherwise.
 */
export function completionPrefix(query: string): { head: string; prefix: string } | null {
  const words = query.trim().split(/\s+/);
  const last = words.pop() ?? "";
  if (!/^[\p{L}\p{M}\p{N}]+$/u.test(last) || UNSPACED.test(last)) return null;
  if ([...last].length < (/\p{Script=Hangul}/u.test(last) ? 2 : 3)) return null;
  return { head: words.join(" "), prefix: last.toLowerCase() };
}

/**
 * Below any real BM25 score short of a word in nearly every document, which ranks
 * nothing anyway. A title prefix outranks a body prefix, and a typo (scored zero)
 * ranks below both; pdb.score() is a float4, which keeps the two apart.
 */
const TITLE_PREFIX_SCORE = "0.000002";
const BODY_PREFIX_SCORE = "0.000001";

/** The excerpt is the best of the first 64 windows of the body that hold a match. */
const EXCERPT_WINDOWS = 64;

/**
 * Document-level BM25 candidates `(doc_id, kw_fragments, kw_rank)`.
 *
 * `must` scores each document by its best field (disjunction_max), and each
 * field clause is a conjunction so more words narrow. The `search_text` clause
 * scores zero and exists because pdb.snippets() highlights only a field that
 * matched in its own right. The fuzzy title clause also scores zero, so a typo
 * can recall a document but never outrank a real match. The prefix clauses read
 * the query's last word as unfinished, at a constant just above zero, so "whe"
 * finds "where" while typing and a whole-word match still ranks first. kw_rank
 * must stay a bare pdb.score(): wrapped in arithmetic, ORDER BY leaves the
 * index's top-K.
 *
 * kw_fragments are the body's first EXCERPT_WINDOWS windows holding a match, in
 * order; searchDocs picks the excerpt among them for the rows it returns.
 * pdb.snippets is filled in by the scan, so it stays here. pdb.snippet's own
 * pick is not used: it weighs each word by how many rows of the node's index
 * hold it, other workspaces', ones the searcher cannot read, and old versions
 * of rewritten rows until a merge drops them.
 */
function keywordLeg(
  sql: Sql,
  input: SearchInput,
  languages: readonly SearchLanguage[],
  scopeFilter: Fragment,
  candidates: number,
): Fragment {
  // Every field a whole-word match may land in: as written, stemmed English, and each language's.
  const wholeWords = (text: string) => {
    let langLegs = sql``;
    for (const lang of languages) {
      langLegs = sql`${langLegs}, paradedb.match_conjunction(${`all_text_${lang}`}, ${text})`;
    }
    return sql`paradedb.match_conjunction('all_text', ${text}),
                            paradedb.match_conjunction('all_text_en', ${text})${langLegs}`;
  };
  const completion = completionPrefix(input.query);
  let prefixLegs = sql``;
  if (completion) {
    // The finished words must all appear, matched as a whole query's are; the last one need only begin a word.
    const head = completion.head ? sql`paradedb.disjunction_max(ARRAY[${wholeWords(completion.head)}]), ` : sql``;
    const startsWord = (field: string) =>
      sql`paradedb.fuzzy_term(${field}, ${completion.prefix}, distance => 0, prefix => true)`;
    prefixLegs = sql`,
              paradedb.const_score(${sql.unsafe(TITLE_PREFIX_SCORE)}, paradedb.boolean(must => ARRAY[${head}${startsWord("title")}])),
              paradedb.const_score(${sql.unsafe(BODY_PREFIX_SCORE)}, paradedb.boolean(must => ARRAY[${head}${startsWord("all_text")}]))`;
  }
  return sql`
      SELECT d.doc_id,
             -- HTML-escaped around the <b> tags, so a < in the body cannot pass for one.
             pdb.snippets(d.search_text, '<b>', '</b>', 200, ${EXCERPT_WINDOWS}, NULL, 'position') AS kw_fragments,
             pdb.score(d) AS kw_rank
      FROM docs d
      WHERE d.workspace_id = ${input.workspaceId}
        AND d.trashed = FALSE
        AND d.search_hidden = FALSE
        AND d.acl_principals && ${input.principals}
        ${scopeFilter}
        AND d.doc_id @@@ paradedb.boolean(should => ARRAY[
              paradedb.boolean(
                must   => ARRAY[ paradedb.disjunction_max(ARRAY[
                            paradedb.boost(2.0, paradedb.match_conjunction('title', ${input.query})),
                            ${wholeWords(input.query)}]) ],
                should => ARRAY[ paradedb.const_score(0.0,
                            paradedb.match_disjunction('search_text', ${input.query})) ]),
              paradedb.const_score(0.0,
                paradedb.match('title', ${input.query}, distance => 1, conjunction_mode => true))${prefixLegs}])
      ORDER BY kw_rank DESC
      LIMIT ${candidates}`;
}

/**
 * Passage-level BM25 candidates `(doc_id, chunk_index, kw_rank)`. Disjunctive,
 * so a natural-language question matches a passage on any significant term.
 * Chunk 0 carries the title, so a title-only match cites the opening passage.
 */
function chunkKeywordLeg(
  sql: Sql,
  input: AskInput,
  languages: readonly SearchLanguage[],
  scopeFilter: Fragment,
  candidates: number,
): Fragment {
  let langLegs = sql``;
  for (const lang of languages) {
    langLegs = sql`${langLegs}, paradedb.match_disjunction(${`chunk_text_${lang}`}, ${input.query})`;
  }
  return sql`
      SELECT c.doc_id, c.chunk_index,
             pdb.score(c) AS kw_rank
      FROM doc_chunks c
      JOIN docs d ON d.doc_id = c.doc_id
      WHERE d.workspace_id = ${input.workspaceId}
        AND d.trashed = FALSE
        AND d.search_hidden = FALSE
        AND d.acl_principals && ${input.principals}
        ${scopeFilter}
        AND c.doc_id @@@ paradedb.disjunction_max(ARRAY[
              paradedb.match_disjunction('chunk_text', ${input.query})${langLegs}])
      ORDER BY kw_rank DESC
      LIMIT ${candidates}`;
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
 * passages would walk to the end of that budget.
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
                    set_config('hnsw.scan_mem_multiplier', '8', true)`;
    const scan = input.queryEmbedding ? await semanticScan(tx, input) : "index";
    // Arithmetic on the distance keeps the planner off the HNSW index.
    return run(tx, scan === "exact" ? sql`(c.embedding <=> q.qvec) + 0::float8` : sql`c.embedding <=> q.qvec`);
  }) as Promise<T>;
}

/**
 * Build and run a query naming the languages in force. A rebuild of the search
 * indexes can make one of them unknown between the read and the query, which
 * fails naming the field; read again, the languages are the ones that now
 * answer, so the query is run once more.
 */
async function withSearchLanguages<T>(
  input: { searchLanguages?: () => readonly SearchLanguage[] },
  run: (languages: readonly SearchLanguage[]) => Promise<T>,
): Promise<T> {
  const languages = () => input.searchLanguages?.() ?? [];
  try {
    return await run(languages());
  } catch (err) {
    if (!(err instanceof Error && /is not part of the pg_search index/.test(err.message))) throw err;
    return run(languages());
  }
}

/** A searchDocs row before its excerpt is chosen. */
interface SearchRow extends Omit<SearchResult, "snippet"> {
  kw_snippet: string | null;
  prefix_excerpt: string | null;
  prefix_offset: number | null;
  passage: string | null;
  head: string;
  /** Whether the excerpt excerptOf picks begins inside a fenced code block. */
  in_code: boolean;
  /** The part of the excerpt's first line the cut left out, before where it begins. */
  line_lead: string;
}

const EXCERPT_CHARS = 200;
/** Characters kept before a prefix match, so the excerpt reads as a sentence. */
const PREFIX_LEAD = 60;

/**
 * A fenced code block's opening or closing line, inside any quote or list item,
 * read as the web app's snippet renderer reads one (FENCE in its snippet.tsx).
 * Matched with 'n', so ^ and $ are line ends and no line runs into the next.
 */
const FENCE_LINE = "^[ \\t]*(?:>[ \\t]?)*[ \\t]*(?:(?:[-+*]|\\d+[.)])[ \\t]+)?(?:`{3,}[^`]*|~{3,}.*)$";
const FENCE = new RegExp(FENCE_LINE);

/** Wraps the word starting `offset` code points into `text` in highlight sentinels. */
function markWordAt(text: string, offset: number): string {
  const chars = [...text];
  const rest = chars.slice(offset).join("");
  const word = /^[\p{L}\p{M}\p{N}_]+/u.exec(rest)?.[0] ?? "";
  if (!word) return text;
  return `${chars.slice(0, offset).join("")}⟦${word}⟧${rest.slice(word.length)}`;
}

/**
 * Why a document is on the list, as text: the body's keyword highlights; else the
 * word the unfinished last term begins; else the passage closest in meaning; else
 * the document's opening.
 *
 * The text is the body's Markdown. An excerpt that begins inside a fenced code
 * block starts with a fence line the body does not have there ("```"): cut from
 * below the block's own fence, its code would read as prose, and `__iter__` as
 * emphasis. Agents read snippets too, through MCP, and the fence keeps the
 * excerpt honest Markdown.
 */
function excerptOf(row: SearchRow): string {
  const text = row.kw_snippet?.includes("⟦")
    ? row.kw_snippet
    : row.prefix_excerpt && row.prefix_offset !== null
      ? markWordAt(row.prefix_excerpt, row.prefix_offset)
      : row.passage || row.head;
  if (!row.in_code) return text;
  const line = row.line_lead + (text.split("\n", 1)[0] ?? "");
  // Cut past an opening fence's backticks, at its language ("sh"): the fence line is made whole again.
  if (row.line_lead.trim() && FENCE.test(line)) return row.line_lead + text;
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
  const qvec = vectorLiteral(input.queryEmbedding, input.embeddingDims);
  const semLimit = candidates * 4;
  // completionPrefix admits letters, marks and digits only, so the pattern needs no escaping.
  const completion = completionPrefix(input.query);
  const startsWord = completion ? `\\m${completion.prefix}` : null;

  // Reciprocal Rank Fusion: each leg a document appears in adds 1/(60 + its rank
  // there), and a leg it is absent from adds nothing.
  const rows = await withSearchLanguages(input, (languages) => withVectorScan(sql, input, semLimit, (tx, nearest) => tx<SearchRow[]>`
    WITH q AS (
      SELECT ${qvec}::vector AS qvec
    ),
    kw_candidates AS (
      ${keywordLeg(sql, input, languages, scopeFilter, candidates)}
    ),
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
             k.kw_fragments                              AS kw_fragments,
             COALESCE(1.0/(60 + k.kw_pos), 0)
               + COALESCE(1.0/(60 + s.sem_pos), 0)       AS score
      FROM kw_ranked k
      FULL OUTER JOIN sem_ranked s ON k.doc_id = s.doc_id
    ),
    top AS (
      SELECT f.*, d.title, d.doc_type, d.page_of, d.page_row
      FROM fused f
      JOIN docs d ON d.doc_id = f.doc_id
      ORDER BY f.score DESC, d.doc_id
      LIMIT ${limit}
    )
    SELECT t.doc_id, t.title, t.doc_type, t.page_of, t.page_row, t.kw_rank, t.sem_score, t.score,
           -- Null for a document that matched in its title only.
           kw.kw_snippet,
           CASE WHEN x.pos > 0 THEN substr(d.search_text, greatest(1, x.pos - ${PREFIX_LEAD}), ${EXCERPT_CHARS + PREFIX_LEAD}) END AS prefix_excerpt,
           CASE WHEN x.pos > 0 THEN x.pos - greatest(1, x.pos - ${PREFIX_LEAD}) END AS prefix_offset,
           left(ch.content, ${EXCERPT_CHARS}) AS passage,
           left(d.search_text, ${EXCERPT_CHARS}) AS head,
           -- The body is in code after the excerpt's first line when its fences through
           -- that line are odd in number, and the excerpt opens a block of its own when
           -- that line reads as a fence. Either without the other wants a fence above it.
           e.at > 0 AND (regexp_count(left(d.search_text, e.at - 1 + length(e.line)), ${FENCE_LINE}, 1, 'n')
                         + regexp_count(e.line, ${FENCE_LINE}, 1, 'n')) % 2 = 1 AS in_code,
           CASE WHEN e.at > 1 THEN reverse(split_part(reverse(left(d.search_text, e.at - 1)), chr(10), 1)) ELSE '' END AS line_lead
    FROM top t
    JOIN docs d ON d.doc_id = t.doc_id
    LEFT JOIN doc_chunks ch ON ch.doc_id = t.doc_id AND ch.chunk_index = t.sem_chunk
    -- The keyword window showing the most different matching words (as written, case
    -- aside), then the most matches, then the first. Tags are counted before the text
    -- is decoded, so only pdb.snippets' own count; they then become the sentinels
    -- excerptOf reads, and &amp; is decoded last.
    LEFT JOIN LATERAL (
      SELECT replace(replace(replace(replace(replace(replace(replace(
               f.fragment, '<b>', '⟦'), '</b>', '⟧'),
               '&lt;', '<'), '&gt;', '>'), '&quot;', '"'), '&#x27;', ''''), '&amp;', '&') AS kw_snippet
      FROM unnest(t.kw_fragments) WITH ORDINALITY AS f(fragment, ord),
           unnest((string_to_array(f.fragment, '<b>'))[2:]) AS mark
      GROUP BY f.ord, f.fragment
      ORDER BY count(DISTINCT lower(split_part(mark, '</b>', 1))) DESC, count(*) DESC, f.ord
      LIMIT 1
    ) kw ON TRUE
    -- Where the unfinished last word begins a word of the body, when the body has no keyword highlight.
    CROSS JOIN LATERAL (
      SELECT CASE WHEN ${startsWord}::text IS NOT NULL AND strpos(coalesce(kw.kw_snippet, ''), '⟦') = 0
                  THEN regexp_instr(d.search_text, ${startsWord}::text, 1, 1, 0, 'i') ELSE 0 END AS pos
    ) x
    -- Where in the body the excerpt excerptOf picks begins, tried in its order, and
    -- the rest of that line. A keyword fragment and a passage are slices of the
    -- body; 0 for the opening, which no fence can precede, or one not found.
    CROSS JOIN LATERAL (
      SELECT s.at, split_part(substr(d.search_text, greatest(s.at, 1)), chr(10), 1) AS line
      FROM (SELECT CASE WHEN strpos(kw.kw_snippet, '⟦') > 0 THEN strpos(d.search_text, translate(kw.kw_snippet, '⟦⟧', ''))
                        WHEN x.pos > 0 THEN greatest(1, x.pos - ${PREFIX_LEAD})
                        WHEN ch.content <> '' THEN strpos(d.search_text, left(ch.content, ${EXCERPT_CHARS}))
                        ELSE 0 END AS at) s
    ) e
    ORDER BY t.score DESC, t.doc_id`));
  return rows.map((row) => {
    const { kw_snippet: _k, prefix_excerpt: _p, prefix_offset: _o, passage: _s, head: _h, in_code: _c, line_lead: _l, ...hit } = row;
    return { ...hit, snippet: excerptOf(row) };
  });
}

/** Hybrid retrieval of individual passages for cited answers, without the per-document collapse. */
export async function askDocs(sql: Sql, input: AskInput): Promise<AskChunk[]> {
  const limit = normalizeQueryLimit(input.limit, 8);
  const candidates = Math.max(limit * 4, 32);
  if (input.scopeDocIds && input.scopeDocIds.length === 0) return [];
  const scopeFilter = scopeFragment(sql, input.scopeDocIds ?? null, input.scopeFolderIds ?? null);
  const qvec = vectorLiteral(input.queryEmbedding, input.embeddingDims);
  // Reciprocal Rank Fusion, as in searchDocs, over passages.
  return withSearchLanguages(input, (languages) => withVectorScan(sql, input, candidates, (tx, nearest) => tx<AskChunk[]>`
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
    kw_hits AS (
      ${chunkKeywordLeg(sql, input, languages, scopeFilter, candidates)}
    ),
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
           f.sem_score, f.score
    FROM fused f
    JOIN docs d ON d.doc_id = f.doc_id
    JOIN doc_chunks ch ON ch.doc_id = f.doc_id AND ch.chunk_index = f.chunk_index
    -- An empty passage would spend a citation on nothing.
    WHERE ch.content <> ''
    ORDER BY f.score DESC, f.doc_id, f.chunk_index
    LIMIT ${limit}`));
}
