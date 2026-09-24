/**
 * Indexing and retrieval. Search is one statement per call: a BM25 keyword leg
 * (pg_search) and a pgvector semantic leg, fused with Reciprocal Rank Fusion.
 * Both legs read the live row, so ACL and content changes apply immediately.
 */
import type { Fragment, TransactionSql } from "postgres";
import type { AskChunk, SearchResult, WorkspaceRow } from "./types.js";
import type { SearchLanguage } from "./schema/search-indexes.js";
import { scopeFragment, vectorLiteral } from "./sql.js";
import type { Sql } from "./client.js";

/** The width `doc_chunks.embedding` was created with, or null before the schema exists. */
export async function embeddingColumnDims(sql: Sql): Promise<number | null> {
  // pgvector stores the dimension in atttypmod directly.
  const rows = await sql<{ dims: number | null }[]>`
    SELECT a.atttypmod AS dims
    FROM pg_attribute a
    WHERE a.attrelid = 'doc_chunks'::regclass
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

export interface SearchInput {
  /** The searcher's flattened principal set. */
  principals: string[];
  /** ANDed into both legs; the only isolation the vector leg has. */
  workspaceId: string;
  query: string;
  /** Null skips the semantic leg. */
  queryEmbedding: number[] | null;
  embeddingDims: number;
  /** The semantic leg keeps a chunk only below this cosine distance to the query. */
  maxDistance: number;
  limit?: number;
  /** Collection scope: only these doc ids. An empty array yields no results. */
  scopeDocIds?: string[] | null;
  /** A scoped credential's folders, subtrees already expanded. */
  scopeFolderIds?: string[] | null;
  /** Must match the languages the BM25 indexes were built with; an unbuilt one fails the query. */
  searchLanguages?: readonly SearchLanguage[];
}

export interface AskInput {
  principals: string[];
  workspaceId: string;
  query: string;
  queryEmbedding: number[] | null;
  embeddingDims: number;
  /** As in SearchInput. */
  maxDistance: number;
  /** Passages to return. */
  limit?: number;
  scopeDocIds?: string[] | null;
  scopeFolderIds?: string[] | null;
  searchLanguages?: readonly SearchLanguage[];
}

function normalizeQueryLimit(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return fallback;
  return Math.min(value, 100);
}

// Every leg carries the tenant, trash, hidden, ACL and scope gates inside its
// own WHERE, ahead of its own LIMIT: a leg spends its candidate budget only on
// rows the searcher may see, and nothing outside it can widen that set.

/**
 * Document-level BM25 candidates `(doc_id, kw_snippet, kw_rank)`.
 *
 * `must` scores each document by its best field (disjunction_max), and each
 * field clause is a conjunction so more words narrow. The `search_text` clause
 * scores zero and exists because pdb.snippet() highlights only a field that
 * matched in its own right. The fuzzy title clause also scores zero, so a typo
 * can recall a document but never outrank a real match. kw_rank must stay a
 * bare pdb.score(): wrapped in arithmetic, ORDER BY leaves the index's top-K.
 */
function keywordLeg(sql: Sql, input: SearchInput, scopeFilter: Fragment, candidates: number): Fragment {
  let langLegs = sql``;
  for (const lang of input.searchLanguages ?? []) {
    langLegs = sql`${langLegs}, paradedb.match_conjunction(${`all_text_${lang}`}, ${input.query})`;
  }
  return sql`
      SELECT d.doc_id,
             -- pdb.snippet HTML-escapes around matches; decoded so the snippet is
             -- raw text on every path. &amp; goes last.
             replace(replace(replace(replace(replace(
               pdb.snippet(d.search_text, '⟦', '⟧', 200),
               '&lt;', '<'), '&gt;', '>'), '&quot;', '"'), '&#x27;', ''''), '&amp;', '&') AS kw_snippet,
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
                            paradedb.match_conjunction('all_text', ${input.query}),
                            paradedb.match_conjunction('all_text_en', ${input.query})${langLegs}]) ],
                should => ARRAY[ paradedb.const_score(0.0,
                            paradedb.match_disjunction('search_text', ${input.query})) ]),
              paradedb.const_score(0.0,
                paradedb.match('title', ${input.query}, distance => 1, conjunction_mode => true))])
      ORDER BY kw_rank DESC
      LIMIT ${candidates}`;
}

/**
 * Passage-level BM25 candidates `(doc_id, chunk_index, kw_rank)`. Disjunctive,
 * so a natural-language question matches a passage on any significant term.
 * Chunk 0 carries the title, so a title-only match cites the opening passage.
 */
function chunkKeywordLeg(sql: Sql, input: AskInput, scopeFilter: Fragment, candidates: number): Fragment {
  let langLegs = sql``;
  for (const lang of input.searchLanguages ?? []) {
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
 * Runs a hybrid query with pgvector's iterative index scan. An HNSW scan hands
 * back its nearest ef_search tuples before any gate in WHERE runs, so when the
 * query's neighbourhood belongs to documents the searcher cannot see, the
 * semantic leg came back empty; iterating keeps walking the graph until the
 * leg's LIMIT visible rows are found. That is also why each leg applies its
 * distance cutoff outside the ordered scan: inside, a neighbourhood with fewer
 * than LIMIT close passages would walk on to hnsw.max_scan_tuples.
 */
function withVectorScan<T>(sql: Sql, limit: number, run: (tx: TransactionSql) => Promise<T>): Promise<T> {
  const efSearch = Math.min(Math.max(limit, 40), 1000);
  return sql.begin(async (tx) => {
    await tx`SELECT set_config('hnsw.iterative_scan', 'strict_order', true),
                    set_config('hnsw.ef_search', ${String(efSearch)}, true)`;
    return run(tx);
  }) as Promise<T>;
}

/** Hybrid search, one row per document. */
export async function searchDocs(sql: Sql, input: SearchInput): Promise<SearchResult[]> {
  const limit = normalizeQueryLimit(input.limit, 20);
  const candidates = Math.max(limit * 4, 50);
  if (input.scopeDocIds && input.scopeDocIds.length === 0) return [];
  const scopeFilter = scopeFragment(sql, input.scopeDocIds ?? null, input.scopeFolderIds ?? null);
  const qvec = vectorLiteral(input.queryEmbedding, input.embeddingDims);
  const kwLeg = keywordLeg(sql, input, scopeFilter, candidates);
  const semLimit = candidates * 4;

  // Reciprocal Rank Fusion: each leg a document appears in adds 1/(60 + its rank
  // there), and a leg it is absent from adds nothing.
  return withVectorScan(sql, semLimit, (tx) => tx<SearchResult[]>`
    WITH q AS (
      SELECT ${qvec}::vector AS qvec
    ),
    kw_candidates AS (
      ${kwLeg}
    ),
    kw_ranked AS (
      SELECT k.*, rank() OVER (ORDER BY k.kw_rank DESC) AS kw_pos
      FROM kw_candidates k
    ),
    -- Nearest visible chunks, then the cutoff, collapsed to each document's best passage.
    chunk_near AS (
      SELECT c.doc_id, c.embedding <=> q.qvec AS dist
      FROM doc_chunks c
      JOIN docs d ON d.doc_id = c.doc_id
      , q
      WHERE d.workspace_id = ${input.workspaceId}
        AND d.trashed = FALSE
        AND d.search_hidden = FALSE
        AND d.acl_principals && ${input.principals}
        ${scopeFilter}
        AND q.qvec IS NOT NULL
        AND c.embedding IS NOT NULL
      ORDER BY c.embedding <=> q.qvec
      LIMIT ${semLimit}
    ),
    chunk_hits AS (
      SELECT doc_id, 1 - dist AS sem_score
      FROM chunk_near
      WHERE dist < ${input.maxDistance}::float8
    ),
    sem_candidates AS (
      SELECT doc_id, MAX(sem_score) AS sem_score
      FROM chunk_hits
      GROUP BY doc_id
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
             k.kw_snippet                                AS kw_snippet,
             COALESCE(1.0/(60 + k.kw_pos), 0)
               + COALESCE(1.0/(60 + s.sem_pos), 0)       AS score
      FROM kw_ranked k
      FULL OUTER JOIN sem_ranked s ON k.doc_id = s.doc_id
    )
    SELECT d.doc_id, d.title, d.page_of, d.page_row,
           f.kw_rank, f.sem_score, f.score,
           -- No highlight unless the body matched by stem: fall back to the head of the text.
           COALESCE(f.kw_snippet, left(d.search_text, 200)) AS snippet
    FROM fused f
    JOIN docs d ON d.doc_id = f.doc_id
    ORDER BY f.score DESC, d.doc_id
    LIMIT ${limit}`);
}

/** Hybrid retrieval of individual passages for cited answers, without the per-document collapse. */
export async function askDocs(sql: Sql, input: AskInput): Promise<AskChunk[]> {
  const limit = normalizeQueryLimit(input.limit, 8);
  const candidates = Math.max(limit * 4, 32);
  if (input.scopeDocIds && input.scopeDocIds.length === 0) return [];
  const scopeFilter = scopeFragment(sql, input.scopeDocIds ?? null, input.scopeFolderIds ?? null);
  const qvec = vectorLiteral(input.queryEmbedding, input.embeddingDims);
  const kwLeg = chunkKeywordLeg(sql, input, scopeFilter, candidates);
  // Reciprocal Rank Fusion, as in searchDocs, over passages.
  return withVectorScan(sql, candidates, (tx) => tx<AskChunk[]>`
    WITH q AS (
      SELECT ${qvec}::vector AS qvec
    ),
    chunk_near AS (
      SELECT c.doc_id, c.chunk_index, c.content,
             c.embedding <=> q.qvec AS dist
      FROM doc_chunks c
      JOIN docs d ON d.doc_id = c.doc_id
      , q
      WHERE d.workspace_id = ${input.workspaceId}
        AND d.trashed = FALSE
        AND d.search_hidden = FALSE
        AND d.acl_principals && ${input.principals}
        ${scopeFilter}
        AND q.qvec IS NOT NULL
        AND c.embedding IS NOT NULL
      ORDER BY c.embedding <=> q.qvec
      LIMIT ${candidates}
    ),
    chunk_hits AS (
      SELECT doc_id, chunk_index, content, 1 - dist AS sem_score
      FROM chunk_near
      WHERE dist < ${input.maxDistance}::float8
    ),
    sem_ranked AS (
      SELECT s.*, rank() OVER (ORDER BY s.sem_score DESC) AS sem_pos
      FROM chunk_hits s
    ),
    kw_hits AS (
      ${kwLeg}
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
    LIMIT ${limit}`);
}
