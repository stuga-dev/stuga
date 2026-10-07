/**
 * The measurement over a small stand-in probe (two languages, one topic in each of the eight
 * domains) and a fake model whose vectors cluster by topic, so the pairing rules, roles, batches,
 * progress and failures can be checked exactly.
 */
import { describe, expect, it, vi } from "vitest";
import { CFG } from "../../test-helpers.js";
import { AiError } from "../../transport.js";
import { chunkEmbedInput } from "../chunk.js";
import type { EmbedRole } from "../embed-profile.js";
import type { EmbedResult } from "../embed.js";

vi.mock("./probe/index.js", () => {
  const domains = ["food", "sport", "money-law-work", "health", "nature-space", "machines-software", "arts-history-language", "home-garden-craft"];
  const lang = (code: string) => ({
    lang: code,
    topics: domains.map((d) => ({
      id: `${d}.t`,
      short: [`${code} ${d} one`, `${code} ${d} two`],
      question: `${code}: what about ${d} here?`,
      passages: [
        { title: `${code} ${d} title`, headingPath: null, body: `${code} ${d} first body` },
        { title: `${code} ${d} title`, headingPath: "A > B", body: `${code} ${d} later body` },
      ],
    })),
  });
  return { PROBE: [lang("en"), lang("de")], domainOf: (id: string) => id.slice(0, id.indexOf(".")) };
});

const { calibrate, calibrationKey, CalibrationError } = await import("./calibrate.js");
const { cosineDistance, quantile } = await import("./stats.js");

/** A text's topic is the domain word in it; its vector points at that domain, nudged by a hash of the text. */
function fakeVector(text: string): number[] {
  const domains = ["food", "sport", "money-law-work", "health", "nature-space", "machines-software", "arts-history-language", "home-garden-craft"];
  const v: number[] = domains.map((d) => (text.includes(d) ? 1 : 0));
  let h = 2166136261;
  for (const c of text) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  for (let i = 0; i < 8; i++) {
    h = Math.imul(h ^ (h >>> 13), 0x5bd1e995);
    v.push(((h >>> 0) / 2 ** 32 - 0.5) * 0.6);
  }
  return v;
}

function fakeEmbed(calls: { texts: string[]; role: EmbedRole }[] = []) {
  return vi.fn(async (_cfg: unknown, texts: string[], role: EmbedRole): Promise<EmbedResult> => {
    calls.push({ texts, role });
    return { embeddings: texts.map(fakeVector), modelDims: 16, inputTokens: texts.length };
  });
}

describe("calibrate", () => {
  it("pairs each query with other domains' passages in its own language, and sets the levels from them", async () => {
    const result = await calibrate(CFG, { embedFn: fakeEmbed() });
    // Per language: 16 short queries × 14 other-domain passages, and 8 questions × 14.
    expect(result.pairs).toEqual({ short: 2 * 16 * 14, question: 2 * 8 * 14 });

    const domains = ["food", "sport", "money-law-work", "health", "nature-space", "machines-software", "arts-history-language", "home-garden-craft"];
    const nulls: number[] = [];
    for (const lang of ["en", "de"]) {
      for (const d of domains) {
        for (const q of [`${lang} ${d} one`, `${lang} ${d} two`]) {
          for (const o of domains.filter((x) => x !== d)) {
            nulls.push(cosineDistance(fakeVector(q), fakeVector(chunkEmbedInput(`${lang} ${o} title`, null, `${lang} ${o} first body`, true))));
            nulls.push(cosineDistance(fakeVector(q), fakeVector(chunkEmbedInput(`${lang} ${o} title`, "A > B", `${lang} ${o} later body`, false))));
          }
        }
      }
    }
    nulls.sort((a, b) => a - b);
    expect(result.levels.short.balanced).toBe(quantile(nulls, 0.01));
    expect(result.levels.short.loose).toBe(quantile(nulls, 0.05));
    expect(result.levels.short.strict).toBeLessThanOrEqual(result.levels.short.balanced);
    expect(result.related_kept).toBe(1);
    expect(Object.keys(result.by_language).sort()).toEqual(["de", "en"]);
    expect(result.model_dims).toBe(16);
    expect(result.tokens).toBe(2 * 8 * 3 + 2 * 8 * 2);
  });

  it("embeds queries as queries and passages as the indexer formats documents, sixteen at a time, in order", async () => {
    const calls: { texts: string[]; role: EmbedRole }[] = [];
    const progress: number[] = [];
    await calibrate(CFG, { embedFn: fakeEmbed(calls), onProgress: (p) => progress.push(p) });
    expect(calls.every((c) => c.texts.length <= 16)).toBe(true);
    const queries = calls.filter((c) => c.role === "query").flatMap((c) => c.texts);
    const documents = calls.filter((c) => c.role === "document").flatMap((c) => c.texts);
    expect(queries).toHaveLength(48);
    expect(documents).toHaveLength(32);
    expect(documents[0]).toBe(chunkEmbedInput("en food title", null, "en food first body", true));
    expect(documents[1]).toBe(chunkEmbedInput("en food title", "A > B", "en food later body", false));
    const roles = calls.map((c) => c.role);
    expect(roles.indexOf("document")).toBeGreaterThan(roles.lastIndexOf("query"));
    expect(progress.at(-1)).toBe(100);
  });

  it("stops between batches when asked", async () => {
    let n = 0;
    const err = await calibrate(CFG, { embedFn: fakeEmbed(), shouldStop: () => ++n > 2 }).catch((e) => e);
    expect(err).toBeInstanceOf(CalibrationError);
    expect(err.kind).toBe("stopped");
  });

  it("reports a provider failure as an endpoint failure", async () => {
    const embedFn = vi.fn(async () => {
      throw new AiError("embeddings 401: bad key", 401, false);
    });
    const err = await calibrate(CFG, { embedFn }).catch((e) => e);
    expect(err.kind).toBe("endpoint");
    expect(err.message).toMatch(/401/);
  });

  it("refuses a model that places every text alike", async () => {
    const embedFn = vi.fn(async (_c: unknown, texts: string[]): Promise<EmbedResult> => ({ embeddings: texts.map(() => [1, 0, 0]), modelDims: 3, inputTokens: 0 }));
    const err = await calibrate(CFG, { embedFn }).catch((e) => e);
    expect(err.kind).toBe("inseparable");
  });
});

describe("calibrationKey", () => {
  const ollama = { ...CFG, embed: { ...CFG.embed, provider: "ollama" as const, baseUrl: "http://127.0.0.1:11434", model: "embeddinggemma-2:270m" } };

  it("changes with the service, its address, the model and the width asked for", () => {
    const k = calibrationKey(ollama);
    expect(calibrationKey({ ...ollama, embed: { ...ollama.embed, baseUrl: "http://10.0.0.2:11434" } })).not.toBe(k);
    expect(calibrationKey({ ...ollama, embed: { ...ollama.embed, model: "bge-m3" } })).not.toBe(k);
    expect(calibrationKey({ ...ollama, embed: { ...ollama.embed, provider: "openai" } })).not.toBe(k);
    // 384 asks EmbeddingGemma for 256 dimensions instead of its own 768.
    expect(calibrationKey({ ...ollama, embed: { ...ollama.embed, dims: 384 } })).not.toBe(k);
  });

  it("ignores the API key, and the column's width when only padding changes", () => {
    const k = calibrationKey(ollama);
    expect(calibrationKey({ ...ollama, embed: { ...ollama.embed, apiKey: "other" } })).toBe(k);
    expect(calibrationKey({ ...ollama, embed: { ...ollama.embed, dims: 1536 } })).toBe(k);
  });
});
