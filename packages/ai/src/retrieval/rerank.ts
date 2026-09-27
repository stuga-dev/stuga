/**
 * Reranking of retrieval candidates by a judge that scores every candidate in
 * one request: Jev over System One when it is set up, otherwise the chat model
 * when chat is on, otherwise none. The top N by score are kept; any failure
 * degrades to the similarity order, never short of N while candidates remain.
 */
import { completeText } from "../chat.js";
import type { AiConfig } from "../config.js";
import { ZERO_USAGE, type TokenUsage } from "../types.js";
import { askSystemOne, type NoulQuestion } from "./system-one.js";

export interface RerankCandidate {
  doc_id: string;
  title: string;
  chunk_index: number;
  content: string;
  /** Carried through so citations keep it. */
  heading_path?: string | null;
}

export interface RerankResult {
  /** The top N after reranking, or in similarity order when degraded or unjudged. */
  chunks: RerankCandidate[];
  usage: TokenUsage;
  degraded: boolean;
  /** The model that ran (for the usage ledger, including failed calls), or null when no call was made. */
  modelId: string | null;
}

/** One score per candidate, in candidate order; higher is more relevant. */
interface Verdict {
  scores: number[] | null;
  usage: TokenUsage;
  modelId: string | null;
}

/** Per-candidate content shown to the judge. */
const SNIPPET_CHARS = 1200;

/** Rerank `candidates`, which must be in similarity order (the fallback and tiebreaker), keeping the best `topN`. */
export async function rerankChunks(
  cfg: AiConfig,
  query: string,
  candidates: RerankCandidate[],
  topN: number,
  opts: {
    /**
     * Skip the call only at or below this many candidates (default `topN`). For
     * callers that narrow the result further afterwards and still need it ranked.
     */
    rankAbove?: number;
  } = {},
): Promise<RerankResult> {
  const unjudged = { chunks: candidates.slice(0, topN), usage: { ...ZERO_USAGE }, degraded: false, modelId: null };
  if (candidates.length <= (opts.rankAbove ?? topN)) return unjudged;
  const judge = cfg.rerank.enabled ? judgeWithSystemOne : cfg.chat.enabled ? judgeWithChat : null;
  if (!judge) return unjudged;

  const { scores, usage, modelId } = await judge(cfg, query, candidates);
  if (!scores) return { chunks: candidates.slice(0, topN), usage, degraded: true, modelId };
  const ranked = candidates
    .map((c, i) => ({ c, i, score: scores[i] ?? 0 }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((r) => r.c);
  return { chunks: ranked.slice(0, topN), usage, degraded: false, modelId };
}

function passageOf(c: RerankCandidate) {
  return { title: c.title || "Untitled", section: c.heading_path ?? "", text: c.content.slice(0, SNIPPET_CHARS).trim() };
}

/**
 * Every candidate is one yes/no question over a state holding the query and all
 * the passages, so a search costs one request whatever the candidate count.
 */
async function judgeWithSystemOne(cfg: AiConfig, query: string, candidates: RerankCandidate[]): Promise<Verdict> {
  const question = (id: string): NoulQuestion => ({
    type: "noul",
    instructions: `Does passage ${id} help answer the query?`,
    criteria: {
      true: "The passage states the information the query asks for, or information needed to answer it",
      false: "The passage is only on a related topic, or is irrelevant to the query",
    },
  });
  const ids = candidates.map((_, i) => `p${i}`);
  try {
    const out = await askSystemOne(
      cfg.rerank,
      { query, passages: Object.fromEntries(candidates.map((c, i) => [ids[i], passageOf(c)])) },
      Object.fromEntries(ids.map((id) => [id, question(id)])),
    );
    return { scores: ids.map((id) => out.probabilities[id]!), usage: { ...ZERO_USAGE, inputTokens: out.inputTokens }, modelId: out.model };
  } catch {
    return { scores: null, usage: { ...ZERO_USAGE }, modelId: cfg.rerank.model };
  }
}

const JUDGE_SYSTEM = `You are a search relevance judge. Given a user query and numbered
document snippets, rate how well EACH snippet helps answer or act on the query.
Score each 0-10 (10 = directly answers it; 0 = irrelevant). Judge only relevance,
not writing quality. Respond with ONLY a JSON array of {"i":<number>,"score":<0-10>}
for every snippet, no prose.`;

async function judgeWithChat(cfg: AiConfig, query: string, candidates: RerankCandidate[]): Promise<Verdict> {
  const list = candidates
    .map((c, i) => {
      const p = passageOf(c);
      return `[${i}] ${p.section ? `${p.title} — ${p.section}` : p.title}\n${p.text}`;
    })
    .join("\n\n");
  const out = await completeText(cfg, { system: JUDGE_SYSTEM, prompt: `Query: ${query}\n\nSnippets:\n${list}`, maxTokens: 1024 });
  return { scores: out.error ? null : parseScores(out.text, candidates.length), usage: out.usage, modelId: out.modelId };
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
