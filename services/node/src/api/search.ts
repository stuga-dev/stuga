/** Search and retrieval: ACL-filtered hybrid search, and chunk retrieval for grounding. */
import { cutoffFor } from "@stuga/ai";
import { type SearchResult, insertAiUsage, searchDocs } from "@stuga/db";
import type { Ctx } from "../auth/context.js";
import { scopeFolderIds } from "../authz/authz.js";
import { error, json } from "../http/respond.js";
import type { WorkspaceCall } from "../http/router.js";
import { embedQuery } from "../retrieval/query-embedding.js";
import { retrieveAndRerank } from "../retrieval/retrieve.js";
import { collectionScope } from "../retrieval/scope.js";

/** What a search or retrieval names; the REST body and the agent tools send the same fields. */
export interface SearchRequest {
  q?: string;
  limit?: number;
  collection_id?: string;
  /** Skip the semantic leg: a quick first answer while a person is still typing. */
  keyword_only?: boolean;
}

/**
 * A search hit as callers see it. The raw BM25 score is withheld: its IDF counts
 * every document on the node, readable or not, so a caller could read back how
 * many documents anywhere hold a word.
 */
export type SearchHit = Omit<SearchResult, "kw_rank" | "kw_whole">;

export interface SearchAnswer {
  query: string;
  results: SearchHit[];
  degraded: boolean;
  semantic: boolean;
  /** The collection resolved to nothing the caller can read, as opposed to nothing matching. */
  empty_scope?: true;
  /**
   * An agent's search only: no document holds every word of the query, so these hold some of them,
   * ranked by how many and how rare. A person's search box keeps matching every word.
   */
  partial?: true;
}

export interface RetrieveAnswer {
  chunks: Array<{ doc_id: string; title: string; chunk_index: number; content: string; heading_path: string | null }>;
  degraded?: boolean;
  /** Embeddings are off, so an agent does not read "no embeddings" as "nothing matched" and retry forever. */
  ai_disabled?: true;
  /** An agent's retrieval only: embeddings are off, so these passages were found by their words alone. */
  keyword_only?: true;
  /** An agent's keyword retrieval only: no passage holds every word of the question, so these hold some of them. */
  partial?: true;
  empty_scope?: true;
}

/** How an agent's search and retrieval differ from a person's, whose answers stay as they are. */
export interface RecallOptions {
  /** When no document holds every word, rank those holding any of them, and say the answer is partial. */
  anyWordFallback?: boolean;
  /** When embeddings are off, retrieve passages by their words instead of refusing. */
  keywordWhenOff?: boolean;
}

/**
 * The query's vector for the semantic leg, its usage recorded when the provider was called, or null
 * when the call failed: the search then runs on its keyword legs, logged so an outage is visible.
 * Kept per caller, not per person, so a narrowed agent key learns nothing of its person's searches.
 */
export async function queryVector(ctx: Ctx, q: string): Promise<number[] | null> {
  const ai = ctx.env.aiSettings.current();
  try {
    const res = await embedQuery(ai, ctx.workspaceId, ctx.alias, q);
    // A kept vector cost nothing this time.
    if (res.called) {
      await insertAiUsage(ctx.sql, {
        alias: ctx.alias,
        workspaceId: ctx.workspaceId,
        docId: null,
        kind: "embedding",
        model: ai.embed.model,
        inputTokens: res.inputTokens,
      }).catch(() => {});
    }
    return res.embedding;
  } catch (e) {
    console.warn("search embed failed, degrading to keyword-only", {
      workspaceId: ctx.workspaceId,
      err: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

/** "not-found" when the request names a collection the caller cannot use. */
export async function searchDocuments(ctx: Ctx, request: SearchRequest, opts: RecallOptions = {}): Promise<SearchAnswer | "not-found"> {
  const q = typeof request.q === "string" ? request.q.trim().slice(0, 4000) : "";
  if (!q) return { query: q, results: [], degraded: false, semantic: false };
  // A collection narrows the ACL gate, never replaces it; an empty scope finds nothing.
  const scopeDocIds = await collectionScope(ctx, request.collection_id);
  if (scopeDocIds === "not-found") return "not-found";
  // The semantic leg needs embeddings; without a query vector searchDocs uses its keyword legs.
  const ai = ctx.env.aiSettings.current();
  const semantic = ai.embed.enabled && request.keyword_only !== true;
  const queryEmbedding = semantic ? await queryVector(ctx, q) : null;
  const input = {
    embeddingDims: ctx.env.embeddingDims,
    // The level's distance for this model and this style of query; null drops nothing by distance.
    maxDistance: cutoffFor(q, ai.embed.searchCutoff),
    searchLanguages: () => ctx.env.searchLanguages.current(),
    principals: ctx.principals,
    workspaceId: ctx.workspaceId,
    query: q,
    queryEmbedding,
    limit: request.limit,
    scopeDocIds,
    scopeFolderIds: scopeFolderIds(ctx),
  };
  let results = await searchDocs(ctx.sql, input);
  // An agent asks in a sentence ("travel expense reimbursement"), which no page may hold whole: then
  // the pages holding some of its words, said to be partial, rather than nothing and a retry.
  let partial = false;
  if (opts.anyWordFallback && !results.some((r) => r.kw_whole)) {
    const some = await searchDocs(ctx.sql, { ...input, anyWord: true });
    if (some.some((r) => r.kw_rank > 0)) {
      results = some;
      partial = true;
    }
  }
  return {
    query: q,
    results: results.map((r) => {
      const { kw_rank: _rank, kw_whole: _whole, ...hit } = r;
      return hit;
    }),
    // Degraded only when embeddings are on and failed; switched off is working as configured.
    degraded: semantic && queryEmbedding === null,
    semantic: queryEmbedding !== null,
    ...(scopeDocIds?.length === 0 ? { empty_scope: true as const } : {}),
    ...(partial ? { partial: true as const } : {}),
  };
}

/** ACL-filtered, optionally collection-scoped chunks for grounding, without generating an answer. */
export async function retrievePassages(ctx: Ctx, request: SearchRequest, opts: RecallOptions = {}): Promise<RetrieveAnswer | "not-found"> {
  const ai = ctx.env.aiSettings.current();
  const keywordOnly = !ai.embed.enabled;
  if (keywordOnly && !opts.keywordWhenOff) return { chunks: [], ai_disabled: true };
  const q = (request.q ?? "").trim().slice(0, 4000);
  if (!q) return { chunks: [] };

  // Without a collection, retrieval spans every document the caller can read.
  const scopeDocIds = await collectionScope(ctx, request.collection_id);
  if (scopeDocIds === "not-found") return "not-found";

  const { chunks, degraded, whole } = await retrieveAndRerank({
    sql: ctx.sql,
    embeddingDims: ctx.env.embeddingDims,
    searchLanguages: () => ctx.env.searchLanguages.current(),
    aiCfg: ai,
    alias: ctx.alias,
    principals: ctx.principals,
    workspaceId: ctx.workspaceId,
    query: q,
    scopeDocIds,
    scopeFolderIds: scopeFolderIds(ctx),
    topN: Math.min(request.limit ?? 8, 12),
    keywordOnly,
  });
  return {
    chunks: chunks.map((c) => ({
      doc_id: c.doc_id,
      title: c.title,
      chunk_index: c.chunk_index,
      content: c.content,
      heading_path: c.heading_path ?? null,
    })),
    // Switched off is working as configured, not a failure.
    degraded: degraded && !keywordOnly,
    ...(keywordOnly ? { keyword_only: true as const } : {}),
    // By its words alone, a passage holding only some of them may be about something else: said, as search says it.
    ...(keywordOnly && chunks.length > 0 && !whole ? { partial: true as const } : {}),
    ...(scopeDocIds?.length === 0 ? { empty_scope: true as const } : {}),
  };
}

export async function search({ ctx, req }: WorkspaceCall): Promise<Response> {
  const answer = await searchDocuments(ctx, (await req.json().catch(() => ({}))) as SearchRequest);
  return answer === "not-found" ? error(404, "not found") : json(answer);
}

export async function retrieve({ ctx, req }: WorkspaceCall): Promise<Response> {
  const answer = await retrievePassages(ctx, (await req.json().catch(() => ({}))) as SearchRequest);
  return answer === "not-found" ? error(404, "not found") : json(answer);
}
