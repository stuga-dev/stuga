/** Retrieval for every surface: embed the query, over-fetch ACL-filtered chunks, rerank down to topN. */
import { askDocs, insertAiUsage, type SearchLanguage, type Sql } from "@stuga/db";
import { embed, rerankChunks, type AiConfig, type RerankCandidate } from "@stuga/ai";

export interface RetrieveArgs {
  sql: Sql;
  aiCfg: AiConfig;
  /** Who usage is attributed to. */
  alias: string;
  principals: string[];
  workspaceId: string;
  query: string;
  /** Collection-expanded doc ids; null for everything the caller can read. */
  scopeDocIds: string[] | null;
  /** A scoped key's folders; null for no folder restriction. */
  scopeFolderIds?: string[] | null;
  embeddingDims: number;
  /** Read as the query is built: a rebuild of the search indexes changes them. */
  searchLanguages: () => readonly SearchLanguage[];
  topN: number;
  maxPerDoc?: number;
}

export interface RetrieveResult {
  chunks: RerankCandidate[];
  /** The embedding failed, so only the keyword leg ran. */
  degraded: boolean;
  /** The reranker failed, so results are in fusion order. */
  rerankDegraded: boolean;
}

/** Candidates fetched before the rerank narrows them to topN. */
const CANDIDATE_LIMIT = 24;

/**
 * Passages from any one document. Sections of one document cluster in embedding
 * space, so without a cap a result is often one source's account of itself.
 */
const MAX_PER_DOC = 3;

/**
 * Keep at most `maxPerDoc` passages per document, then backfill to `topN` from
 * what was set aside, so the cap never returns fewer passages than asked for.
 * Applied after the rerank, outside askDocs' SQL, so it cannot disturb the fusion or the ACL gate.
 */
function capPerDoc(chunks: RerankCandidate[], topN: number, maxPerDoc: number): RerankCandidate[] {
  const perDoc = new Map<string, number>();
  const kept: RerankCandidate[] = [];
  const overflow: RerankCandidate[] = [];
  for (const c of chunks) {
    const n = perDoc.get(c.doc_id) ?? 0;
    if (n < maxPerDoc) {
      perDoc.set(c.doc_id, n + 1);
      kept.push(c);
    } else {
      overflow.push(c);
    }
  }
  return [...kept, ...overflow].slice(0, topN);
}

/** Embed, fetch candidates, rerank and cap, attributing the embed and rerank tokens. */
export async function retrieveAndRerank(args: RetrieveArgs): Promise<RetrieveResult> {
  const { sql, aiCfg, alias, principals, workspaceId, query, scopeDocIds, topN, embeddingDims, searchLanguages } = args;

  let queryEmbedding: number[] | null = null;
  try {
    const e = await embed(aiCfg, [query]);
    queryEmbedding = e.embeddings[0] ?? null;
    await insertAiUsage(sql, {
      alias,
      workspaceId,
      docId: null,
      kind: "embedding",
      model: aiCfg.embed.model,
      inputTokens: e.inputTokens,
    }).catch(() => {});
  } catch (e) {
    console.warn("retrieve embed failed, degrading to keyword-only", {
      workspaceId,
      err: e instanceof Error ? e.message : String(e),
    });
  }

  const candidates = await askDocs(sql, {
    principals,
    workspaceId,
    query,
    queryEmbedding,
    scopeDocIds,
    scopeFolderIds: args.scopeFolderIds ?? null,
    limit: CANDIDATE_LIMIT,
    embeddingDims,
    maxDistance: aiCfg.embed.retrievalMaxDistance,
    searchLanguages,
  });
  // Reranked to a wider set so the per-document cap has something to backfill
  // from. `rankAbove: topN` keeps the judge running whenever there are more
  // candidates than will be shown, not only more than the widened request.
  const reranked = await rerankChunks(aiCfg, query, candidates, Math.min(topN * 2, CANDIDATE_LIMIT), "auto", {
    rankAbove: topN,
  });
  // `auto` resolves at call time: usage names the model that ran; null means no call happened.
  if (reranked.modelId && (reranked.usage.inputTokens || reranked.usage.outputTokens)) {
    await insertAiUsage(sql, {
      alias,
      workspaceId,
      docId: null,
      kind: "ask",
      model: reranked.modelId,
      inputTokens: reranked.usage.inputTokens,
      outputTokens: reranked.usage.outputTokens,
    }).catch(() => {});
  }
  return {
    chunks: capPerDoc(reranked.chunks, topN, args.maxPerDoc ?? MAX_PER_DOC),
    degraded: queryEmbedding === null,
    rerankDegraded: reranked.degraded,
  };
}
