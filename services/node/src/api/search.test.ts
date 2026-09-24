import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiConfig } from "@stuga/ai";

vi.mock("@stuga/db", async (orig) => ({
  ...(await orig<typeof import("@stuga/db")>()),
  searchDocs: vi.fn(async () => []),
  insertAiUsage: vi.fn(async () => {}),
}));
vi.mock("@stuga/ai", async (orig) => ({
  ...(await orig<typeof import("@stuga/ai")>()),
  embed: vi.fn(async () => ({ embeddings: [[0.1, 0.2]], inputTokens: 3 })),
}));

const { searchDocs } = await import("@stuga/db");
const { searchDocuments } = await import("./search.js");
import type { Ctx } from "../auth/context.js";

const mockSearch = searchDocs as unknown as ReturnType<typeof vi.fn>;

const AI: AiConfig = {
  enabled: true,
  chat: { enabled: false, defaultModel: "", endpoints: [] },
  embed: { enabled: true, provider: "ollama", baseUrl: "http://ai.test", model: "embed-1", dims: 2, searchMaxDistance: 0.6, retrievalMaxDistance: 0.9 },
};

describe("searchDocuments", () => {
  beforeEach(() => mockSearch.mockClear());

  it("passes the search cutoff in force at each query, so a saved change applies to the next one", async () => {
    let current = AI;
    const ctx = {
      sql: {},
      alias: "user-1",
      principals: ["user:user-1"],
      workspaceId: "ws1",
      env: { embeddingDims: 2, searchLanguages: [], aiSettings: { current: () => current } },
    } as unknown as Ctx;

    await searchDocuments(ctx, { q: "paraphrase" });
    current = { ...AI, embed: { ...AI.embed, searchMaxDistance: 1.1 } };
    await searchDocuments(ctx, { q: "paraphrase" });

    expect(mockSearch.mock.calls.map((c) => (c[1] as { maxDistance: number }).maxDistance)).toEqual([0.6, 1.1]);
  });

  it("withholds the raw BM25 score, whose IDF counts documents the caller cannot read", async () => {
    const hit = { doc_id: "d1", title: "Probe", page_of: null, page_row: null, snippet: "⟦probe⟧", kw_rank: 4.79, sem_score: 0, score: 1 / 61 };
    mockSearch.mockResolvedValueOnce([hit]);
    const ctx = {
      sql: {},
      alias: "user-1",
      principals: ["user:user-1"],
      workspaceId: "ws1",
      env: { embeddingDims: 2, searchLanguages: [], aiSettings: { current: () => AI } },
    } as unknown as Ctx;

    const answer = await searchDocuments(ctx, { q: "probe" });

    const { kw_rank: _, ...visible } = hit;
    expect(answer).toMatchObject({ results: [visible] });
    expect(answer).not.toHaveProperty(["results", 0, "kw_rank"]);
  });
});
