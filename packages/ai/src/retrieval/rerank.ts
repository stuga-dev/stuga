/**
 * Reranking of retrieval candidates by a judge that scores every candidate in
 * one request: Jev over System One when it is set up, otherwise the chat model
 * when chat is on, otherwise none. The top N by score are kept; any failure
 * degrades to the similarity order, never short of N while candidates remain.
 */
import { completeText } from "../chat.js";
import type { AiConfig } from "../config.js";
import { requestFailure, type ModelFailure } from "../failure.js";
import { AiError } from "../transport.js";
import { ZERO_USAGE, type TokenUsage } from "../types.js";
import { excerpts } from "./excerpt.js";
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
  /** Why the judge's answer went unused, when degraded. */
  failure?: ModelFailure;
}

/** One score per candidate, in candidate order; higher is more relevant. */
interface Verdict {
  scores: number[] | null;
  usage: TokenUsage;
  modelId: string | null;
  failure?: ModelFailure;
}

/** Characters of each candidate shown to the judge: the part that best matches the query, when longer. */
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

  const { scores, usage, modelId, failure } = await judge(cfg, query, candidates);
  if (!scores) return { chunks: candidates.slice(0, topN), usage, degraded: true, modelId, failure };
  const ranked = candidates
    .map((c, i) => ({ c, i, score: scores[i] ?? 0 }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((r) => r.c);
  return { chunks: ranked.slice(0, topN), usage, degraded: false, modelId };
}

/** What the judge reads of each candidate: its title, heading path and an excerpt. */
function passagesOf(query: string, candidates: RerankCandidate[]) {
  const texts = excerpts(query, candidates.map((c) => c.content), SNIPPET_CHARS);
  return candidates.map((c, i) => ({ title: c.title || "Untitled", section: c.heading_path ?? "", text: texts[i]! }));
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
  const passages = passagesOf(query, candidates);
  try {
    const out = await askSystemOne(
      cfg.rerank,
      { query, passages: Object.fromEntries(passages.map((p, i) => [ids[i], p])) },
      Object.fromEntries(ids.map((id) => [id, question(id)])),
    );
    return { scores: ids.map((id) => out.probabilities[id]!), usage: { ...ZERO_USAGE, inputTokens: out.inputTokens }, modelId: out.model };
  } catch (e) {
    const failure = requestFailure("systemone", cfg.rerank.model, e instanceof Error ? e.message : String(e), {
      key: cfg.rerank.apiKey,
      status: e instanceof AiError ? e.status : undefined,
    });
    return { scores: null, usage: { ...ZERO_USAGE }, modelId: cfg.rerank.model, failure };
  }
}

const JUDGE_SYSTEM = `You are a search relevance judge. Given a user query and numbered
document snippets, rate how well EACH snippet helps answer or act on the query.
Score each 0-10 (10 = directly answers it; 0 = irrelevant). Judge only relevance,
not writing quality. Respond with ONLY a JSON array of {"i":<number>,"score":<0-10>}
for every snippet, no prose.`;

/**
 * The scores take about 12 tokens a candidate. Reasoning shares the cap, so a
 * model that cannot switch it off still has room to finish the array.
 */
const JUDGE_MAX_TOKENS = 8192;

async function judgeWithChat(cfg: AiConfig, query: string, candidates: RerankCandidate[]): Promise<Verdict> {
  const list = passagesOf(query, candidates)
    .map((p, i) => `[${i}] ${p.section ? `${p.title} — ${p.section}` : p.title}\n${p.text}`)
    .join("\n\n");
  // As little reasoning as the model allows: off where it can be, else its lowest level.
  const out = await completeText(cfg, {
    system: JUDGE_SYSTEM,
    prompt: `Query: ${query}\n\nSnippets:\n${list}`,
    maxTokens: JUDGE_MAX_TOKENS,
    thinking: "off",
  });
  const verdict = { scores: null, usage: out.usage, modelId: out.modelId };
  if (out.failure) return { ...verdict, failure: out.failure };
  // A cut-off answer is not salvaged: every passage it never reached would rank as irrelevant.
  const scores = parseScores(out.text, candidates.length) ?? (out.cutOff ? null : statedScores(out.text, candidates.length));
  if (scores) return { ...verdict, scores };
  const failure: ModelFailure = {
    kind: out.cutOff ? "cut_off" : "unparseable",
    protocol: out.protocol,
    model: out.modelId ?? "",
    message: out.cutOff ? "the answer reached the token cap before the scores closed" : "the answer held no scores",
  };
  return { ...verdict, failure };
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

/** `{"i":3,"score":7}` anywhere in the answer, and a `[3] 7` line. */
const SCORE_OBJECT = /\{\s*"i"\s*:\s*(\d+)\s*,\s*"score"\s*:\s*(\d*\.?\d+)\s*\}/g;
const SCORE_LINE = /^\s*\[(\d+)\]\s*[:=-]?\s*(\d*\.?\d+)\s*$/gm;

/**
 * Scores a finished answer states without the array asked for: the objects one per line, a list
 * with a note after it, or `[i] score` lines. The first score for each passage counts, and at least
 * half the passages must have one, so a stray number in prose is never read as a ranking.
 */
function statedScores(text: string, n: number): number[] | null {
  for (const pattern of [SCORE_OBJECT, SCORE_LINE]) {
    const out = Array.from({ length: n }, () => 0);
    const seen = new Set<number>();
    for (const [, index, score] of text.matchAll(pattern)) {
      const i = Number(index);
      if (i < n && !seen.has(i)) {
        seen.add(i);
        out[i] = Math.max(0, Math.min(10, Number(score)));
      }
    }
    if (seen.size * 2 >= n) return out;
  }
  return null;
}
