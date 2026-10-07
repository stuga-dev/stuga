/**
 * Measuring an embedding model: embed the probe as the node embeds queries and documents, take the
 * distances of every query to every passage of another domain in its own language (unrelated by
 * construction), and set each strictness level at the distance below which its share of those
 * unrelated pairs fall. Short queries and questions are measured apart, since they sit at different
 * distances from everything.
 */
import { createHash } from "node:crypto";
import type { AiConfig } from "../../config.js";
import { AiError } from "../../transport.js";
import { chunkEmbedInput } from "../chunk.js";
import type { QueryStyle, SearchCutoff } from "../cutoff.js";
import { embedProfile } from "../embed-profile.js";
import { EMBED_BATCH, type EmbedResult, embed, embedDims, embedInputs, requestedDims } from "../embed.js";
import { PROBE, domainOf } from "./probe/index.js";
import { cosineDistance, quantile, strictFromTail } from "./stats.js";

/** Raised by hand when the statistic below changes, so every node measures again. */
export const CALIBRATION_VERSION = 1;

/** The share of unrelated query–passage pairs each level lets through. */
export const UNRELATED_SHARE = { strict: 0.001, balanced: 0.01, loose: 0.05 } as const;
export type MeasuredLevel = keyof typeof UNRELATED_SHARE;

/** Every quantile kept, so levels can be re-tuned without measuring again. */
const GRID = [0.001, 0.0025, 0.005, 0.01, 0.02, 0.05, 0.1, 0.5] as const;

export interface CalibrationResult {
  version: number;
  /** The width the model returned. */
  model_dims: number;
  /** Unrelated pairs measured, by style. */
  pairs: Record<QueryStyle, number>;
  quantiles: Record<QueryStyle, Record<string, number>>;
  levels: Record<QueryStyle, Record<MeasuredLevel, number>>;
  /** Short queries' own passages kept at Balanced. */
  related_kept: number;
  /** Short-query diagnostics per language, for the benchmark; nothing acts on them. */
  by_language: Record<string, { p1: number; p5: number; p50: number; related_p50: number }>;
  tokens: number;
  ms: number;
}

/**
 * `endpoint`: the model could not be reached or answered badly, worth trying again later.
 * `inseparable`: it places related text as far as unrelated text, so no floor means anything.
 * `stopped`: the node is shutting down.
 */
export class CalibrationError extends Error {
  readonly kind: "endpoint" | "inseparable" | "stopped";
  /** Tokens the run spent before it ended, so they are accounted for too. */
  readonly tokens: number;
  constructor(kind: CalibrationError["kind"], message: string, tokens = 0) {
    super(message);
    this.kind = kind;
    this.tokens = tokens;
  }
}

interface ProbeQuery {
  text: string;
  lang: string;
  topic: string;
  style: QueryStyle;
}

interface ProbePassageText {
  text: string;
  lang: string;
  topic: string;
}

/** The probe as the node embeds it: queries as typed, passages through the indexer's own format. */
function probeTexts(): { queries: ProbeQuery[]; passages: ProbePassageText[] } {
  const queries: ProbeQuery[] = [];
  const passages: ProbePassageText[] = [];
  for (const { lang, topics } of PROBE) {
    for (const t of topics) {
      for (const text of t.short) queries.push({ text, lang, topic: t.id, style: "short" });
      queries.push({ text: t.question, lang, topic: t.id, style: "question" });
      t.passages.forEach((p, i) => passages.push({ text: chunkEmbedInput(p.title, p.headingPath, p.body, i === 0), lang, topic: t.id }));
    }
  }
  return { queries, passages };
}

const PROBE_TEXTS = probeTexts();
const digests = new Map<string, string>();

/** A hash of every string `embed` sends this model for the probe: prompts, probe texts and chunk format. */
export function probeDigest(model: string): string {
  const { query, document } = embedProfile(model);
  const memo = JSON.stringify([query, document]);
  let d = digests.get(memo);
  if (!d) {
    const h = createHash("sha256");
    for (const s of embedInputs(model, PROBE_TEXTS.queries.map((q) => q.text), "query")) h.update(s).update("\0");
    h.update("\u0001");
    for (const s of embedInputs(model, PROBE_TEXTS.passages.map((p) => p.text), "document")) h.update(s).update("\0");
    d = h.digest("hex");
    digests.set(memo, d);
  }
  return d;
}

/**
 * What a measurement belongs to: anything that changes the distances. The API key and the column's
 * width do not (padding keeps every distance), so neither is in it.
 */
export function calibrationKey(cfg: Pick<AiConfig, "embed">): string {
  const { provider, baseUrl, model } = cfg.embed;
  const width = requestedDims(embedProfile(model), embedDims(cfg), provider);
  return createHash("sha256")
    .update(JSON.stringify([CALIBRATION_VERSION, provider, baseUrl, model, width, probeDigest(model)]))
    .digest("hex");
}

/** The cutoffs one measurement gives a level. */
export function levelCutoff(result: CalibrationResult, level: MeasuredLevel): SearchCutoff {
  return { short: result.levels.short[level], question: result.levels.question[level] };
}

export interface CalibrateOptions {
  /** 0–100 as batches finish. */
  onProgress?: (percent: number) => void;
  /** Checked between batches; true ends the run with kind `stopped`. */
  shouldStop?: () => boolean;
  embedFn?: typeof embed;
}

export async function calibrate(cfg: AiConfig, opts: CalibrateOptions = {}): Promise<CalibrationResult> {
  const embedFn = opts.embedFn ?? embed;
  const started = Date.now();
  const { queries, passages } = PROBE_TEXTS;
  const total = Math.ceil(queries.length / EMBED_BATCH) + Math.ceil(passages.length / EMBED_BATCH);
  let done = 0;
  let tokens = 0;
  let modelDims = 0;

  const embedAll = async (texts: string[], role: "query" | "document"): Promise<number[][]> => {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += EMBED_BATCH) {
      if (opts.shouldStop?.()) throw new CalibrationError("stopped", "stopped", tokens);
      let res: EmbedResult;
      try {
        res = await embedFn(cfg, texts.slice(i, i + EMBED_BATCH), role);
      } catch (e) {
        if (e instanceof AiError) throw new CalibrationError("endpoint", e.message, tokens);
        throw e;
      }
      out.push(...res.embeddings);
      tokens += res.inputTokens;
      modelDims = res.modelDims;
      opts.onProgress?.(Math.round((100 * ++done) / total));
    }
    return out;
  };
  const qv = await embedAll(queries.map((q) => q.text), "query");
  const pv = await embedAll(passages.map((p) => p.text), "document");

  const nulls: Record<QueryStyle, number[]> = { short: [], question: [] };
  const related: Record<QueryStyle, number[]> = { short: [], question: [] };
  const byLang = new Map<string, { nulls: number[]; related: number[] }>();
  queries.forEach((q, qi) => {
    const lang = byLang.get(q.lang) ?? { nulls: [], related: [] };
    byLang.set(q.lang, lang);
    passages.forEach((p, pi) => {
      if (p.lang !== q.lang) return;
      const d = cosineDistance(qv[qi]!, pv[pi]!);
      if (p.topic === q.topic) {
        related[q.style].push(d);
        if (q.style === "short") lang.related.push(d);
      } else if (domainOf(p.topic) !== domainOf(q.topic)) {
        nulls[q.style].push(d);
        if (q.style === "short") lang.nulls.push(d);
      }
    });
  });

  const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);
  const styles = ["short", "question"] as const;
  const quantiles = {} as CalibrationResult["quantiles"];
  const levels = {} as CalibrationResult["levels"];
  for (const s of styles) {
    const n = sorted(nulls[s]);
    quantiles[s] = Object.fromEntries(GRID.map((q) => [String(q), quantile(n, q)]));
    const t1 = quantile(n, UNRELATED_SHARE.balanced);
    const t5 = quantile(n, UNRELATED_SHARE.loose);
    levels[s] = { strict: strictFromTail(t1, t5, n[0]!), balanced: t1, loose: t5 };
  }

  const shortNull = sorted(nulls.short);
  const relatedMedian = quantile(sorted(related.short), 0.5);
  if (relatedMedian >= quantile(shortNull, 0.05) || quantile(shortNull, 0.5) - quantile(shortNull, 0.01) < 0.002) {
    throw new CalibrationError("inseparable", `${cfg.embed.model} places related text as far as unrelated text`, tokens);
  }

  return {
    version: CALIBRATION_VERSION,
    model_dims: modelDims,
    pairs: { short: nulls.short.length, question: nulls.question.length },
    quantiles,
    levels,
    related_kept: related.short.filter((d) => d < levels.short.balanced).length / related.short.length,
    by_language: Object.fromEntries(
      [...byLang].map(([lang, d]) => {
        const n = sorted(d.nulls);
        return [lang, { p1: quantile(n, 0.01), p5: quantile(n, 0.05), p50: quantile(n, 0.5), related_p50: quantile(sorted(d.related), 0.5) }];
      }),
    ),
    tokens,
    ms: Date.now() - started,
  };
}
