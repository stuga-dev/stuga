/** Search and retrieval: ACL-filtered hybrid search, and chunk retrieval for grounding. */
import { embed } from "@stuga/ai";
import { type SearchResult, insertAiUsage, searchDocs } from "@stuga/db";
import type { Ctx } from "../auth/context.js";
import { scopeFolderIds } from "../authz/authz.js";
import { error, json } from "../http/respond.js";
import type { WorkspaceCall } from "../http/router.js";
import { retrieveAndRerank } from "../retrieval/retrieve.js";
import { collectionScope } from "../retrieval/scope.js";

/** What a search or retrieval names; the REST body and the agent tools send the same fields. */
export interface SearchRequest {
  q?: string;
  limit?: number;
  collection_id?: string;
}

/**
 * A search hit as callers see it. The raw BM25 score is withheld: its IDF counts
 * every document on the node, readable or not, so a caller could read back how
 * many documents anywhere hold a word.
 */
export type SearchHit = Omit<SearchResult, "kw_rank">;

export interface SearchAnswer {
  query: string;
  results: SearchHit[];
  degraded: boolean;
  semantic: boolean;
  /** The collection resolved to nothing the caller can read, as opposed to nothing matching. */
  empty_scope?: true;
}

export interface RetrieveAnswer {
  chunks: Array<{ doc_id: string; title: string; chunk_index: number; content: string; heading_path: string | null }>;
  degraded?: boolean;
  /** Embeddings are off, so an agent does not read "no embeddings" as "nothing matched" and retry forever. */
  ai_disabled?: true;
  empty_scope?: true;
}

/** "not-found" when the request names a collection the caller cannot use. */
export async function searchDocuments(ctx: Ctx, request: SearchRequest): Promise<SearchAnswer | "not-found"> {
  const q = typeof request.q === "string" ? request.q.trim().slice(0, 4000) : "";
  if (!q) return { query: q, results: [], degraded: false, semantic: false };
  // A collection narrows the ACL gate, never replaces it; an empty scope finds nothing.
  const scopeDocIds = await collectionScope(ctx, request.collection_id);
  if (scopeDocIds === "not-found") return "not-found";
  // The semantic leg needs embeddings; without a query vector searchDocs uses its keyword legs.
  let queryEmbedding: number[] | null = null;
  const ai = ctx.env.aiSettings.current();
  const semantic = ai.embed.enabled;
  if (semantic) {
    try {
      const res = await embed(ai, [q]);
      queryEmbedding = res.embeddings[0] ?? null;
      await insertAiUsage(ctx.sql, {
        alias: ctx.alias,
        workspaceId: ctx.workspaceId,
        docId: null,
        kind: "embedding",
        model: ai.embed.model,
        inputTokens: res.inputTokens,
      }).catch(() => {});
    } catch (e) {
      // Keyword-only, but logged and flagged so an outage is visible.
      console.warn("search embed failed, degrading to keyword-only", {
        workspaceId: ctx.workspaceId,
        err: e instanceof Error ? e.message : String(e),
      });
      queryEmbedding = null;
    }
  }
  const results = await searchDocs(ctx.sql, {
    embeddingDims: ctx.env.embeddingDims,
    maxDistance: ai.embed.searchMaxDistance,
    searchLanguages: () => ctx.env.searchLanguages.current(),
    principals: ctx.principals,
    workspaceId: ctx.workspaceId,
    query: q,
    queryEmbedding,
    limit: request.limit,
    scopeDocIds,
    scopeFolderIds: scopeFolderIds(ctx),
  });
  return {
    query: q,
    results: results.map((r) => {
      const { kw_rank: _, ...hit } = r;
      return hit;
    }),
    // Degraded only when embeddings are on and failed; switched off is working as configured.
    degraded: semantic && queryEmbedding === null,
    semantic: queryEmbedding !== null,
    ...(scopeDocIds?.length === 0 ? { empty_scope: true as const } : {}),
  };
}

/** ACL-filtered, optionally collection-scoped chunks for grounding, without generating an answer. */
export async function retrievePassages(ctx: Ctx, request: SearchRequest): Promise<RetrieveAnswer | "not-found"> {
  const ai = ctx.env.aiSettings.current();
  if (!ai.embed.enabled) return { chunks: [], ai_disabled: true };
  const q = (request.q ?? "").trim().slice(0, 4000);
  if (!q) return { chunks: [] };

  // Without a collection, retrieval spans every document the caller can read.
  const scopeDocIds = await collectionScope(ctx, request.collection_id);
  if (scopeDocIds === "not-found") return "not-found";

  const { chunks, degraded } = await retrieveAndRerank({
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
  });
  return {
    chunks: chunks.map((c) => ({
      doc_id: c.doc_id,
      title: c.title,
      chunk_index: c.chunk_index,
      content: c.content,
      heading_path: c.heading_path ?? null,
    })),
    degraded,
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
