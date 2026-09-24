/** rerankChunks against a stubbed model endpoint. */
import { describe, it, expect, vi, afterEach } from "vitest";
import { rerankChunks, type RerankCandidate } from "./rerank.js";
import { resolveModel } from "../models.js";
import { CFG, mockStreamFromText } from "../test-helpers.js";

function mockScores(json: string) {
  mockStreamFromText(json, { inputTokens: 50, outputTokens: 20 });
}

function cands(n: number): RerankCandidate[] {
  return Array.from({ length: n }, (_, i) => ({ doc_id: `d${i}`, title: `T${i}`, chunk_index: i, content: `content ${i}` }));
}

afterEach(() => vi.unstubAllGlobals());

describe("rerankChunks", () => {
  it("reorders by judge score and keeps top-N", async () => {
    // 5 candidates; make index 3 the most relevant, then 0.
    mockScores('[{"i":0,"score":6},{"i":1,"score":1},{"i":2,"score":2},{"i":3,"score":9},{"i":4,"score":0}]');
    const out = await rerankChunks(CFG, "q", cands(5), 2, "sonnet");
    expect(out.degraded).toBe(false);
    expect(out.chunks.map((c) => c.doc_id)).toEqual(["d3", "d0"]);
    expect(out.usage).toMatchObject({ inputTokens: 50, outputTokens: 20 });
  });

  it("skips the LLM when candidates already fit topN (no fetch)", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const out = await rerankChunks(CFG, "q", cands(3), 5);
    expect(spy).not.toHaveBeenCalled();
    expect(out.chunks).toHaveLength(3);
    expect(out.degraded).toBe(false);
  });

  it("degrades to similarity order (identity top-N) on unparseable output", async () => {
    mockScores("sorry, I cannot comply");
    const out = await rerankChunks(CFG, "q", cands(5), 3, "sonnet");
    expect(out.degraded).toBe(true);
    expect(out.chunks.map((c) => c.doc_id)).toEqual(["d0", "d1", "d2"]); // original order
  });

  it("degrades on model error (never throws, never empty)", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("boom", { status: 500 }))));
    const out = await rerankChunks(CFG, "q", cands(4), 2, "sonnet");
    expect(out.degraded).toBe(true);
    expect(out.chunks.map((c) => c.doc_id)).toEqual(["d0", "d1"]);
  });

  it("fills up to N even when everything scores below the keep threshold", async () => {
    // All scores < 3, but topN=2 must still be filled (the score-OR-len rule).
    mockScores('[{"i":0,"score":1},{"i":1,"score":0},{"i":2,"score":2},{"i":3,"score":1}]');
    const out = await rerankChunks(CFG, "q", cands(4), 2, "sonnet");
    expect(out.chunks).toHaveLength(2);
    // Highest of the low scores first (index 2 = score 2, then a tie at 1 → lower index 0).
    expect(out.chunks.map((c) => c.doc_id)).toEqual(["d2", "d0"]);
  });

  // A caller that narrows further asks for more than topN and still needs the ranking.
  it("still ranks a set larger than rankAbove but smaller than topN", async () => {
    mockScores('[{"i":0,"score":1},{"i":1,"score":9},{"i":2,"score":2},{"i":3,"score":8}]');
    const out = await rerankChunks(CFG, "q", cands(4), 16, "sonnet", { rankAbove: 2 });
    expect(out.degraded).toBe(false);
    expect(out.chunks.map((c) => c.doc_id)).toEqual(["d1", "d3", "d2", "d0"]);
  });

  it("skips the call at or below rankAbove", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const out = await rerankChunks(CFG, "q", cands(2), 16, "sonnet", { rankAbove: 2 });
    expect(spy).not.toHaveBeenCalled();
    expect(out.chunks).toHaveLength(2);
  });

  it("empty candidates → empty result, no call", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const out = await rerankChunks(CFG, "q", [], 5);
    expect(out.chunks).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("reports the model it resolved, matching resolveModel", async () => {
    mockScores('[{"i":0,"score":5},{"i":1,"score":1},{"i":2,"score":2},{"i":3,"score":9}]');
    const out = await rerankChunks(CFG, "q", cands(4), 2, "sonnet");
    expect(out.modelId).toBe(resolveModel(CFG, "sonnet"));
  });

  it("reports the model on a degraded call, since the tokens were still spent", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("boom", { status: 400 }))));
    const out = await rerankChunks(CFG, "q", cands(4), 2, "sonnet");
    expect(out.degraded).toBe(true);
    expect(out.modelId).toBe(resolveModel(CFG, "sonnet"));
  });

  it("reports a null model when the judge was skipped", async () => {
    vi.stubGlobal("fetch", vi.fn());
    expect((await rerankChunks(CFG, "q", cands(3), 5)).modelId).toBeNull();
    expect((await rerankChunks(CFG, "q", [], 5)).modelId).toBeNull();
  });

  // A failed judge degrades silently, so a misrouted call would be invisible without this.
  it("sends the default rerank to the configured chat provider with the resolved model", async () => {
    const seen: Array<{ url: string; model: string }> = [];
    vi.stubGlobal(
      "fetch",
      // 400, not 500: a 5xx is retryable, so the client would make four attempts
      // and the call count would stop being a useful assertion.
      vi.fn((url: string, init: RequestInit) => {
        seen.push({ url: String(url), model: (JSON.parse(String(init.body)) as { model: string }).model });
        return Promise.resolve(new Response("nope", { status: 400 }));
      }),
    );
    await rerankChunks(CFG, "q", cands(4), 2);
    expect(seen).toHaveLength(1);
    const defaultEndpoint = CFG.chat.endpoints[0]!;
    expect(seen[0]!.url).toBe(`${defaultEndpoint.baseUrl}/v1/messages`);
    expect(seen[0]!.model).toBe(resolveModel(CFG, "auto"));

    seen.length = 0;
    const openaiCfg = {
      ...CFG,
      chat: { ...CFG.chat, endpoints: [{ ...defaultEndpoint, provider: "openai" as const, baseUrl: "https://llm.example.test/v1" }] },
    };
    await rerankChunks(openaiCfg, "q", cands(4), 2);
    expect(seen[0]!.url).toBe("https://llm.example.test/v1/chat/completions");
  });
});
