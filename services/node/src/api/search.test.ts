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

const { searchDocs, insertAiUsage } = await import("@stuga/db");
const { embed } = await import("@stuga/ai");
const { searchDocuments } = await import("./search.js");
import { agentCtx, fixed, personCtx } from "../testing/ctx.js";

const mockSearch = searchDocs as unknown as ReturnType<typeof vi.fn>;
const mockEmbed = vi.mocked(embed);
const mockUsage = vi.mocked(insertAiUsage);

const AI: AiConfig = {
  enabled: true,
  chat: { enabled: false, defaultModel: "", endpoints: [] },
  embed: { enabled: true, provider: "ollama", baseUrl: "http://ai.test", model: "embed-1", dims: 2, searchCutoff: { short: 0.6, question: 0.5 }, retrievalMaxDistance: null },
  rerank: { enabled: false, baseUrl: "", model: "" },
};

const searcher = (aiSettings: { current: () => AiConfig }) =>
  personCtx({ alias: "user-1", principals: ["user:user-1"], env: { embeddingDims: 2, searchLanguages: fixed([]), aiSettings } });

describe("searchDocuments", () => {
  beforeEach(() => {
    mockSearch.mockClear();
    mockEmbed.mockClear();
    mockUsage.mockClear();
  });

  // Each test searches its own words: query vectors outlive a test.

  it("answers a keyword-only request without the provider, as working rather than degraded", async () => {
    const answer = await searchDocuments(searcher(fixed(AI)), { q: "keyword first", keyword_only: true });
    expect(mockEmbed).not.toHaveBeenCalled();
    expect(mockSearch.mock.calls[0]?.[1]).toMatchObject({ queryEmbedding: null });
    expect(answer).toMatchObject({ degraded: false, semantic: false });
  });

  it("embeds a repeated query once, and records usage for that call only", async () => {
    const ctx = searcher(fixed(AI));
    await searchDocuments(ctx, { q: "repeated words" });
    await searchDocuments(ctx, { q: "repeated words" });
    expect(mockEmbed).toHaveBeenCalledTimes(1);
    expect(mockUsage).toHaveBeenCalledTimes(1);
    expect(mockSearch.mock.calls.map((c) => (c[1] as { queryEmbedding: number[] }).queryEmbedding)).toEqual([[0.1, 0.2], [0.1, 0.2]]);
  });

  it("embeds the same query again for another workspace, or after a model change", async () => {
    await searchDocuments(searcher(fixed(AI)), { q: "kept apart" });
    await searchDocuments(personCtx({ alias: "user-1", principals: ["user:user-1"], workspaceId: "ws-other", env: { embeddingDims: 2, searchLanguages: fixed([]), aiSettings: fixed(AI) } }), { q: "kept apart" });
    await searchDocuments(searcher(fixed({ ...AI, embed: { ...AI.embed, model: "embed-2" } })), { q: "kept apart" });
    expect(mockEmbed).toHaveBeenCalledTimes(3);
  });

  it("keeps a query vector for its caller only, so a fast answer tells nobody what someone else searched", async () => {
    const env = { embeddingDims: 2, searchLanguages: fixed([]), aiSettings: fixed(AI) };
    const liv = personCtx({ alias: "liv", env });
    // Both at once, so a call in flight is not shared across callers either.
    await Promise.all([searchDocuments(liv, { q: "acme layoffs" }), searchDocuments(personCtx({ alias: "guest-1", env }), { q: "acme layoffs" })]);
    // Liv's own key is narrower than Liv, so it does not share her vectors.
    await searchDocuments(agentCtx({ onBehalfOf: "liv", scope: { folders: ["f1"], readOnly: true, credentialId: "k1" }, env }), { q: "acme layoffs" });
    expect(mockEmbed).toHaveBeenCalledTimes(3);

    await searchDocuments(liv, { q: "acme layoffs" });
    expect(mockEmbed).toHaveBeenCalledTimes(3);
  });

  it("does not keep a failed embedding: the next search asks the provider again", async () => {
    const ctx = searcher(fixed(AI));
    mockEmbed.mockRejectedValueOnce(new Error("provider down"));
    const failed = await searchDocuments(ctx, { q: "flaky provider" });
    expect(failed).toMatchObject({ degraded: true });
    const recovered = await searchDocuments(ctx, { q: "flaky provider" });
    expect(recovered).toMatchObject({ degraded: false, semantic: true });
    expect(mockEmbed).toHaveBeenCalledTimes(2);
  });

  it("passes the cutoff in force for the query's style at each query, so a saved change applies to the next one", async () => {
    let current = AI;
    const ctx = searcher({ current: () => current });

    await searchDocuments(ctx, { q: "paraphrase" });
    await searchDocuments(ctx, { q: "which document explains the paraphrase rules?" });
    current = { ...AI, embed: { ...AI.embed, searchCutoff: { short: 1.1, question: 1 } } };
    await searchDocuments(ctx, { q: "paraphrase" });
    current = { ...AI, embed: { ...AI.embed, searchCutoff: null } };
    await searchDocuments(ctx, { q: "paraphrase" });

    expect(mockSearch.mock.calls.map((c) => (c[1] as { maxDistance: number | null }).maxDistance)).toEqual([0.6, 0.5, 1.1, null]);
  });

  it("withholds the raw BM25 score, whose IDF counts documents the caller cannot read", async () => {
    const hit = { doc_id: "d1", title: "Probe", page_of: null, page_row: null, snippet: "⟦probe⟧", kw_rank: 4.79, sem_score: 0, score: 1 / 61 };
    mockSearch.mockResolvedValueOnce([hit]);
    const ctx = searcher(fixed(AI));

    const answer = await searchDocuments(ctx, { q: "probe" });

    const { kw_rank: _, ...visible } = hit;
    expect(answer).toMatchObject({ results: [visible] });
    expect(answer).not.toHaveProperty(["results", 0, "kw_rank"]);
  });
});
