import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiConfig } from "@stuga/ai";
import type { RetrieveArgs } from "./retrieve.js";

vi.mock("@stuga/db", async (orig) => ({
  ...(await orig<typeof import("@stuga/db")>()),
  askDocs: vi.fn(),
  insertAiUsage: vi.fn(),
}));

vi.mock("@stuga/ai", async (orig) => ({
  ...(await orig<typeof import("@stuga/ai")>()),
  embed: vi.fn(),
  rerankChunks: vi.fn(),
}));

const { askDocs, insertAiUsage } = await import("@stuga/db");
const { embed, rerankChunks } = await import("@stuga/ai");
const { retrieveAndRerank } = await import("./retrieve.js");

const mockAskDocs = askDocs as unknown as ReturnType<typeof vi.fn>;
const mockEmbed = embed as unknown as ReturnType<typeof vi.fn>;
const mockRerank = rerankChunks as unknown as ReturnType<typeof vi.fn>;
const mockUsage = insertAiUsage as unknown as ReturnType<typeof vi.fn>;

const ZERO = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 };

const AI = {
  enabled: true,
  chat: { enabled: true, defaultModel: "chat-1", endpoints: [{ id: "default", provider: "openai", baseUrl: "http://ai.test", models: [] }] },
  embed: { enabled: true, provider: "openai", baseUrl: "http://ai.test", model: "embed-model-1", dims: 4, searchMaxDistance: 0.6, retrievalMaxDistance: 0.9 },
} as unknown as AiConfig;

/** `spec` like "a a a a b c" → one chunk per token, doc_id = the token. */
function chunks(spec: string) {
  return spec.split(" ").map((docId, i) => ({
    doc_id: docId,
    title: docId.toUpperCase(),
    chunk_index: i,
    content: `content ${i}`,
    heading_path: null,
  }));
}

function args(overrides: Partial<RetrieveArgs> = {}): RetrieveArgs {
  return {
    sql: {} as never,
    aiCfg: AI,
    alias: "human-1",
    principals: ["user:human-1"],
    workspaceId: "ws1",
    query: "q",
    scopeDocIds: null,
    searchLanguages: () => [],
    embeddingDims: 4,
    topN: 4,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEmbed.mockResolvedValue({ embeddings: [[0.1]], inputTokens: 5 });
  mockUsage.mockResolvedValue(undefined);
  mockAskDocs.mockResolvedValue(chunks("a a a a a b c d"));
});

describe("retrieveAndRerank", () => {
  it("caps passages per document, then backfills to topN", async () => {
    mockRerank.mockResolvedValue({ chunks: chunks("a a a a a b c d"), usage: ZERO, degraded: false });
    const out = await retrieveAndRerank(args());

    expect(out.chunks).toHaveLength(4);
    const byDoc = out.chunks.filter((c) => c.doc_id === "a");
    expect(byDoc).toHaveLength(3); // MAX_PER_DOC
    expect(out.chunks.map((c) => c.doc_id)).toEqual(["a", "a", "a", "b"]);
  });

  it("still fills topN when everything comes from one document", async () => {
    mockRerank.mockResolvedValue({ chunks: chunks("a a a a a a"), usage: ZERO, degraded: false });
    const out = await retrieveAndRerank(args());
    expect(out.chunks).toHaveLength(4);
    expect(out.chunks.every((c) => c.doc_id === "a")).toBe(true);
  });

  it("keeps rank order within and across the cap", async () => {
    mockRerank.mockResolvedValue({ chunks: chunks("a b a b a b"), usage: ZERO, degraded: false });
    const out = await retrieveAndRerank(args({ topN: 6 }));
    expect(out.chunks.map((c) => c.doc_id)).toEqual(["a", "b", "a", "b", "a", "b"]);
  });

  it("honours an explicit maxPerDoc", async () => {
    mockRerank.mockResolvedValue({ chunks: chunks("a a a b c d"), usage: ZERO, degraded: false });
    const out = await retrieveAndRerank(args({ maxPerDoc: 1 }));
    expect(out.chunks.map((c) => c.doc_id)).toEqual(["a", "b", "c", "d"]);
  });

  it("over-fetches from the reranker so the cap has something to backfill with", async () => {
    mockRerank.mockResolvedValue({ chunks: chunks("a b c d"), usage: ZERO, degraded: false });
    await retrieveAndRerank(args({ topN: 4 }));
    expect(mockRerank).toHaveBeenCalledWith(expect.anything(), "q", expect.anything(), 8, "auto", { rankAbove: 4 });
  });

  it("filters the semantic leg by the configuration's retrieval cutoff", async () => {
    mockRerank.mockResolvedValue({ chunks: chunks("a"), usage: ZERO, degraded: false });
    await retrieveAndRerank(args({ aiCfg: { ...AI, embed: { ...AI.embed, retrievalMaxDistance: 1.25 } } }));
    expect(mockAskDocs).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ maxDistance: 1.25 }));
  });

  it("reports a failed embedding as degraded, and still returns keyword hits", async () => {
    mockEmbed.mockRejectedValue(new Error("embedding endpoint down"));
    mockRerank.mockResolvedValue({ chunks: chunks("a b"), usage: ZERO, degraded: false });
    const out = await retrieveAndRerank(args());

    expect(out.degraded).toBe(true);
    expect(out.rerankDegraded).toBe(false);
    expect(out.chunks).toHaveLength(2);
    expect(mockAskDocs).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ queryEmbedding: null }));
  });

  it("reports a failed rerank separately from a failed embedding", async () => {
    mockRerank.mockResolvedValue({ chunks: chunks("a b"), usage: ZERO, degraded: true });
    const out = await retrieveAndRerank(args());
    expect(out.degraded).toBe(false);
    expect(out.rerankDegraded).toBe(true);
  });

  it("attributes embedding and rerank tokens separately", async () => {
    mockRerank.mockResolvedValue({
      chunks: chunks("a b"),
      usage: { ...ZERO, inputTokens: 900, outputTokens: 40 },
      degraded: false,
      modelId: "judge-model-1",
    });
    await retrieveAndRerank(args());

    const kinds = mockUsage.mock.calls.map((c) => (c[1] as { kind: string }).kind);
    expect(kinds).toContain("embedding");
    expect(kinds).toContain("ask");
  });

  it("books the embedding against the configured embedding model", async () => {
    mockRerank.mockResolvedValue({ chunks: chunks("a b"), usage: ZERO, degraded: false });
    await retrieveAndRerank(args());
    const row = mockUsage.mock.calls.map((c) => c[1] as { kind: string; model: string }).find((r) => r.kind === "embedding");
    expect(row?.model).toBe("embed-model-1");
  });

  it("books the rerank against the model the reranker actually ran", async () => {
    mockRerank.mockResolvedValue({
      chunks: chunks("a b"),
      usage: { ...ZERO, inputTokens: 900, outputTokens: 40 },
      degraded: false,
      modelId: "judge-model-1",
    });
    await retrieveAndRerank(args());

    const ask = mockUsage.mock.calls.map((c) => c[1] as { kind: string; model: string }).find((r) => r.kind === "ask");
    expect(ask?.model).toBe("judge-model-1");
  });

  it("books a degraded rerank against its model too", async () => {
    mockRerank.mockResolvedValue({
      chunks: chunks("a b"),
      usage: { ...ZERO, inputTokens: 120, outputTokens: 0 },
      degraded: true,
      modelId: "judge-model-2",
    });
    await retrieveAndRerank(args());

    const ask = mockUsage.mock.calls.map((c) => c[1] as { kind: string; model: string }).find((r) => r.kind === "ask");
    expect(ask?.model).toBe("judge-model-2");
  });

  it("writes no rerank usage row when the reranker was never called", async () => {
    mockRerank.mockResolvedValue({ chunks: chunks("a b"), usage: ZERO, degraded: false, modelId: null });
    await retrieveAndRerank(args());
    const kinds = mockUsage.mock.calls.map((c) => (c[1] as { kind: string }).kind);
    expect(kinds).toEqual(["embedding"]);
  });
});
