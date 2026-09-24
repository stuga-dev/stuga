/**
 * LLM reranking of retrieval candidates: one call scores every candidate 0–10
 * and the top N are kept. Any failure degrades to the similarity order, and the
 * result is never short of N while candidates remain.
 */
import type { AiConfig } from "../config.js";
import { resolveModel } from "../models.js";
import { streamTurn } from "../providers/dispatch.js";
import { ZERO_USAGE, type TokenUsage } from "../types.js";

export interface RerankCandidate {
  doc_id: string;
  title: string;
  chunk_index: number;
  content: string;
  /** Carried through so citations keep it. */
  heading_path?: string | null;
}

export interface RerankResult {
  /** The top N after reranking, or in similarity order when degraded. */
  chunks: RerankCandidate[];
  usage: TokenUsage;
  degraded: boolean;
  /** The model that ran (for the usage ledger, including failed calls), or null when no call was made. */
  modelId: string | null;
}

/** Per-candidate content shown to the judge. */
const SNIPPET_CHARS = 1200;
/** Keep a candidate scoring at least this (0–10). */
const KEEP_SCORE = 3;

const SYSTEM = `You are a search relevance judge. Given a user query and numbered
document snippets, rate how well EACH snippet helps answer or act on the query.
Score each 0-10 (10 = directly answers it; 0 = irrelevant). Judge only relevance,
not writing quality. Respond with ONLY a JSON array of {"i":<number>,"score":<0-10>}
for every snippet, no prose.`;

/** Rerank `candidates`, which must be in similarity order (the fallback and tiebreaker), keeping the best `topN`. */
export async function rerankChunks(
  cfg: AiConfig,
  query: string,
  candidates: RerankCandidate[],
  topN: number,
  model = "auto",
  opts: {
    /**
     * Skip the call only at or below this many candidates (default `topN`). For
     * callers that narrow the result further afterwards and still need it ranked.
     */
    rankAbove?: number;
  } = {},
): Promise<RerankResult> {
  if (candidates.length === 0) return { chunks: [], usage: { ...ZERO_USAGE }, degraded: false, modelId: null };
  if (candidates.length <= (opts.rankAbove ?? topN))
    return { chunks: candidates, usage: { ...ZERO_USAGE }, degraded: false, modelId: null };

  const list = candidates
    .map((c, i) => {
      const label = c.heading_path ? `${c.title || "Untitled"} — ${c.heading_path}` : c.title || "Untitled";
      return `[${i}] ${label}\n${c.content.slice(0, SNIPPET_CHARS).trim()}`;
    })
    .join("\n\n");
  const turnText = `Query: ${query}\n\nSnippets:\n${list}`;

  const modelId = resolveModel(cfg, model);

  let full = "";
  let usage: TokenUsage = { ...ZERO_USAGE };
  try {
    for await (const delta of streamTurn(
      cfg,
      {
        modelId,
        system: SYSTEM,
        messages: [{ role: "user", content: [{ text: turnText }] }],
        maxTokens: 1024,
      },
      (u) => {
        usage = u;
      },
    )) {
      full += delta;
    }
    const scores = parseScores(full, candidates.length);
    if (!scores) return degrade(candidates, topN, usage, modelId);

    const ranked = candidates
      .map((c, i) => ({ c, i, score: scores[i] ?? 0 }))
      .sort((a, b) => b.score - a.score || a.i - b.i);

    const kept: RerankCandidate[] = [];
    for (const r of ranked) {
      if (r.score >= KEEP_SCORE || kept.length < topN) kept.push(r.c);
      if (kept.length >= topN && r.score < KEEP_SCORE) break;
    }
    return { chunks: kept.slice(0, topN), usage, degraded: false, modelId };
  } catch {
    return degrade(candidates, topN, usage, modelId);
  }
}

function degrade(candidates: RerankCandidate[], topN: number, usage: TokenUsage, modelId: string): RerankResult {
  return { chunks: candidates.slice(0, topN), usage, degraded: true, modelId };
}

/** The judge's JSON array as index → score, tolerating surrounding prose or fences. */
function parseScores(text: string, n: number): number[] | null {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return null;
  let arr: unknown;
  try {
    arr = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(arr)) return null;
  const out = Array.from({ length: n }, () => 0);
  let any = false;
  for (const item of arr) {
    if (item && typeof item === "object" && "i" in item && "score" in item) {
      const i = Number((item as { i: unknown }).i);
      const s = Number((item as { score: unknown }).score);
      if (Number.isInteger(i) && i >= 0 && i < n && Number.isFinite(s)) {
        out[i] = Math.max(0, Math.min(10, s));
        any = true;
      }
    }
  }
  return any ? out : null;
}
