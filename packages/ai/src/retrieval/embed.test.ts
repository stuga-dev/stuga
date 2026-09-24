/**
 * Embedding dispatcher tests: the OpenAI-compatible and Ollama request shapes,
 * result ordering, the configured width enforced on every vector, and the
 * anthropic provider refused up front (it serves no embeddings endpoint).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { EMBEDDING_DIMS } from "@stuga/protocol/domain/limits";
import { embed, embedDims } from "./embed.js";
import { AiError } from "../providers/transport.js";
import { CFG } from "../test-helpers.js";

const vec = (n: number, fill = 0.1) => Array.from({ length: n }, () => fill);

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
    const out = await embed(CFG, ["first", "second"]);
    const [url, init] = fn.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://embed.example.test/v1/embeddings");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer embed-key");
    expect(body(fn)).toEqual({ model: "text-embedding-3-large", input: ["first", "second"], dimensions: 1024 });
    expect(out.inputTokens).toBe(42);
    expect(out.embeddings).toHaveLength(2);
    expect(out.embeddings[0]![0]).toBe(0.1); // index 0 first, even though it arrived second
    expect(out.embeddings[1]![0]).toBe(0.2);
  });

  it("sends the configured width and rejects a vector of another width", async () => {
    const cfg = { ...CFG, embed: { ...CFG.embed, dims: 768 } };
    mockJson({ data: [{ index: 0, embedding: vec(1024) }] });
    await expect(embed(cfg, ["x"])).rejects.toThrow(/returned 1024 dimensions; the configured width is 768/);
  });

  it("rejects a response with the wrong number of vectors", async () => {
    mockJson({ data: [{ index: 0, embedding: vec(1024) }] });
    await expect(embed(CFG, ["a", "b"])).rejects.toThrow(/expected 2 vectors, got 1/);
  });

  it("makes no call for an empty list", async () => {
    const fn = mockJson({});
    expect(await embed(CFG, [])).toEqual({ embeddings: [], inputTokens: 0 });
    expect(fn).not.toHaveBeenCalled();
  });

  it("caps each input's length", async () => {
    const fn = mockJson({ data: [{ index: 0, embedding: vec(1024) }] });
    await embed(CFG, ["x".repeat(60_000)]);
    expect((body(fn).input as string[])[0]!.length).toBe(50_000);
  });

  it("refuses the anthropic provider with a non-retryable error", async () => {
    const fn = mockJson({});
    const cfg = { ...CFG, embed: { ...CFG.embed, provider: "anthropic" as const } };
    const err = await embed(cfg, ["x"]).catch((e) => e);
    expect(err).toBeInstanceOf(AiError);
    expect((err as AiError).retryable).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("embed (Ollama)", () => {
  const cfg = { ...CFG, embed: { enabled: true, provider: "ollama" as const, baseUrl: "http://ollama.example.test:11434", model: "nomic", dims: 768, searchMaxDistance: 0.6, retrievalMaxDistance: 0.9 } };

  it("posts {model, input[]} to /api/embed and reads embeddings + prompt_eval_count", async () => {
    const fn = mockJson({ embeddings: [vec(768), vec(768)], prompt_eval_count: 9 });
    const out = await embed(cfg, ["a", "b"]);
    expect((fn.mock.calls[0]! as unknown as [string])[0]).toBe("http://ollama.example.test:11434/api/embed");
    expect(body(fn)).toEqual({ model: "nomic", input: ["a", "b"] });
    expect(out.embeddings).toHaveLength(2);
    expect(out.inputTokens).toBe(9);
  });

  it("rejects a vector of another width", async () => {
    mockJson({ embeddings: [vec(1024)] });
    await expect(embed(cfg, ["a"])).rejects.toThrow(/configured width is 768/);
  });

  it("throws when the response carries no embeddings", async () => {
    mockJson({ model: "nomic" });
    await expect(embed(cfg, ["a"])).rejects.toThrow(/no embeddings/);
  });
});
