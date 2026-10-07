/**
 * Embedding dispatcher tests: the OpenAI-compatible and Ollama request shapes,
 * result ordering, the model's prompts, vectors padded to the column and
 * refused when wider, and the anthropic provider refused up front (it serves
 * no embeddings endpoint).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { EMBEDDING_DIMS } from "@stuga/protocol/domain/limits";
import { embed, embedDims } from "./embed.js";
import { AiError } from "../transport.js";
import { CFG } from "../test-helpers.js";

const vec = (n: number, fill = 0.1) => Array.from({ length: n }, () => fill);

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! ** 2;
    nb += b[i]! ** 2;
  }
  return dot / Math.sqrt(na * nb);
}

function mockJson(payload: unknown, status = 200) {
  const fn = vi.fn(async () => new Response(JSON.stringify(payload), { status }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

function body(fn: ReturnType<typeof vi.fn>, n = 0): Record<string, unknown> {
  return JSON.parse((fn.mock.calls[n]! as unknown as [string, RequestInit])[1].body as string) as Record<string, unknown>;
}

afterEach(() => vi.unstubAllGlobals());

describe("embedDims", () => {
  it("reads the configured width and falls back to the default for an unusable one", () => {
    expect(embedDims(CFG)).toBe(1024);
    expect(embedDims({ ...CFG, embed: { ...CFG.embed, dims: 768 } })).toBe(768);
    expect(embedDims({ ...CFG, embed: { ...CFG.embed, dims: 0 } })).toBe(EMBEDDING_DIMS);
    expect(embedDims({ ...CFG, embed: { ...CFG.embed, dims: Number.NaN } })).toBe(EMBEDDING_DIMS);
  });
});

describe("embed (OpenAI-compatible)", () => {
  it("posts {model, input[], dimensions} to /embeddings with the key and returns vectors in input order", async () => {
    const fn = mockJson({
      data: [
        { index: 1, embedding: vec(1024, 0.2) },
        { index: 0, embedding: vec(1024, 0.1) },
      ],
      usage: { prompt_tokens: 42 },
    });
    const out = await embed(CFG, ["first", "second"], "document");
    const [url, init] = fn.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://embed.example.test/v1/embeddings");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer embed-key");
    expect(body(fn)).toEqual({ model: "text-embedding-3-large", input: ["first", "second"], dimensions: 1024 });
    expect(out.inputTokens).toBe(42);
    expect(out.embeddings).toHaveLength(2);
    expect(out.embeddings[0]![0]).toBe(0.1); // index 0 first, even though it arrived second
    expect(out.embeddings[1]![0]).toBe(0.2);
  });

  it("rejects a vector wider than the column", async () => {
    const cfg = { ...CFG, embed: { ...CFG.embed, dims: 768 } };
    mockJson({ data: [{ index: 0, embedding: vec(1024) }] });
    await expect(embed(cfg, ["x"], "document")).rejects.toThrow(/returned 1024 dimensions, more than the 768 this node stores/);
  });

  it("pads a narrower vector with zeros, keeping every cosine distance", async () => {
    const a = [0.3, -0.2, 0.9];
    const b = [0.1, 0.5, -0.4];
    mockJson({ data: [{ index: 0, embedding: a }, { index: 1, embedding: b }] });
    const out = await embed(CFG, ["a", "b"], "document");
    expect(out.modelDims).toBe(3);
    expect(out.embeddings[0]).toHaveLength(1024);
    expect(out.embeddings[0]!.slice(0, 3)).toEqual(a);
    expect(out.embeddings[0]!.slice(3).every((x) => x === 0)).toBe(true);
    expect(cosine(out.embeddings[0]!, out.embeddings[1]!)).toBeCloseTo(cosine(a, b), 12);
  });

  it("asks a known narrower model for no width, and adds its query and document prompts", async () => {
    const cfg = { ...CFG, embed: { ...CFG.embed, model: "google/embeddinggemma-2" } };
    const fn = mockJson({ data: [{ index: 0, embedding: vec(768) }] });
    await embed(cfg, ["red wine"], "query");
    expect(body(fn)).toEqual({ model: "google/embeddinggemma-2", input: ["task: search result | query: red wine"] });
    await embed(cfg, ["Bordeaux is red."], "document");
    expect(body(fn, 1)).toEqual({ model: "google/embeddinggemma-2", input: ["title: none | text: Bordeaux is red."] });
  });

  it("refuses a zero or non-finite vector", async () => {
    mockJson({ data: [{ index: 0, embedding: vec(1024, 0) }] });
    await expect(embed(CFG, ["x"], "document")).rejects.toThrow(/unusable vector/);
    mockJson({ data: [{ index: 0, embedding: [Number.NaN, ...vec(1023)] }] });
    // JSON has no NaN: it arrives as null.
    await expect(embed(CFG, ["x"], "document")).rejects.toThrow(/unusable vector/);
  });

  it("refuses vectors of different widths in one response", async () => {
    mockJson({ data: [{ index: 0, embedding: vec(768) }, { index: 1, embedding: vec(512) }] });
    await expect(embed(CFG, ["a", "b"], "document")).rejects.toThrow(/different widths/);
  });

  it("rejects a response with the wrong number of vectors", async () => {
    mockJson({ data: [{ index: 0, embedding: vec(1024) }] });
    await expect(embed(CFG, ["a", "b"], "document")).rejects.toThrow(/expected 2 vectors, got 1/);
  });

  it("makes no call for an empty list", async () => {
    const fn = mockJson({});
    expect(await embed(CFG, [], "document")).toEqual({ embeddings: [], modelDims: 0, inputTokens: 0 });
    expect(fn).not.toHaveBeenCalled();
  });

  it("caps each input's length", async () => {
    const fn = mockJson({ data: [{ index: 0, embedding: vec(1024) }] });
    await embed(CFG, ["x".repeat(60_000)], "document");
    expect((body(fn).input as string[])[0]!.length).toBe(50_000);
  });

  it("refuses the anthropic provider with a non-retryable error", async () => {
    const fn = mockJson({});
    const cfg = { ...CFG, embed: { ...CFG.embed, provider: "anthropic" as const } };
    const err = await embed(cfg, ["x"], "document").catch((e) => e);
    expect(err).toBeInstanceOf(AiError);
    expect((err as AiError).retryable).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("embed (Ollama)", () => {
  const cfg = { ...CFG, embed: { enabled: true, provider: "ollama" as const, baseUrl: "http://ollama.example.test:11434", model: "nomic", dims: 768, searchCutoff: null, retrievalMaxDistance: null } };

  it("posts {model, input[]} to /api/embed and reads embeddings + prompt_eval_count", async () => {
    const fn = mockJson({ embeddings: [vec(768), vec(768)], prompt_eval_count: 9 });
    const out = await embed(cfg, ["a", "b"], "document");
    expect((fn.mock.calls[0]! as unknown as [string])[0]).toBe("http://ollama.example.test:11434/api/embed");
    expect(body(fn)).toEqual({ model: "nomic", input: ["a", "b"] });
    expect(out.embeddings).toHaveLength(2);
    expect(out.inputTokens).toBe(9);
  });

  it("rejects a vector wider than the column", async () => {
    mockJson({ embeddings: [vec(1024)] });
    await expect(embed(cfg, ["a"], "document")).rejects.toThrow(/more than the 768 this node stores/);
  });

  it("asks a model with a fixed list of widths for the widest that fits, and pads it", async () => {
    const fn = mockJson({ embeddings: [vec(256)] });
    const narrow = { ...cfg, embed: { ...cfg.embed, model: "embeddinggemma-2:270m", dims: 384 } };
    const out = await embed(narrow, ["a"], "document");
    expect(body(fn)).toMatchObject({ dimensions: 256 });
    expect(out.embeddings[0]).toHaveLength(384);
  });

  it("asks a known wider model to shorten its vectors to the column", async () => {
    const fn = mockJson({ embeddings: [vec(1024)] });
    const wide = { ...cfg, embed: { ...cfg.embed, model: "qwen3-embedding:4b", dims: 1024 } };
    await embed(wide, ["a"], "query");
    expect(body(fn)).toEqual({
      model: "qwen3-embedding:4b",
      input: ["Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:a"],
      dimensions: 1024,
    });
  });

  it("throws when the response carries no embeddings", async () => {
    mockJson({ model: "nomic" });
    await expect(embed(cfg, ["a"], "document")).rejects.toThrow(/no embeddings/);
  });
});
