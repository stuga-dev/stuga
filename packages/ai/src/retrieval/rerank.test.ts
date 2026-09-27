/** rerankChunks against stubbed endpoints: which judge runs, how its scores rank, and how it degrades. */
import { describe, it, expect, vi, afterEach } from "vitest";
import type { AiConfig } from "../config.js";
import { rerankChunks, type RerankCandidate } from "./rerank.js";
import { resolveModel } from "../models.js";
import { CFG, mockStreamFromText } from "../test-helpers.js";

function mockScores(json: string) {
  mockStreamFromText(json, { inputTokens: 50, outputTokens: 20 });
}

function cands(n: number): RerankCandidate[] {
  return Array.from({ length: n }, (_, i) => ({ doc_id: `d${i}`, title: `T${i}`, chunk_index: i, content: `content ${i}` }));
}

const WITH_RERANKER: AiConfig = { ...CFG, rerank: { ...CFG.rerank, enabled: true } };

/** A System One endpoint answering each question with the given probability; records every request. */
function mockSystemOne(probabilities: number[], model = "jev-1.13.0") {
  const seen: Array<{ url: string; headers: Headers; body: { model: string; state: { query: string; passages: Record<string, unknown> }; questions: Record<string, unknown> } }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      seen.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
      const answers = Object.fromEntries(probabilities.map((p, i) => [`p${i}`, { type: "noul", noul: p }]));
      return new Response(JSON.stringify({ model, answers, usage: { input_tokens: 900, output_tokens: 20 } }), { status: 200 });
    }),
  );
  return seen;
}

afterEach(() => vi.unstubAllGlobals());

describe("rerankChunks with the chat model as judge", () => {
  it("reorders by judge score and keeps top-N", async () => {
    mockScores('[{"i":0,"score":6},{"i":1,"score":1},{"i":2,"score":2},{"i":3,"score":9},{"i":4,"score":0}]');
    const out = await rerankChunks(CFG, "q", cands(5), 2);
    expect(out.degraded).toBe(false);
    expect(out.chunks.map((c) => c.doc_id)).toEqual(["d3", "d0"]);
    expect(out.usage).toMatchObject({ inputTokens: 50, outputTokens: 20 });
    expect(out.modelId).toBe(resolveModel(CFG, "auto"));
  });

  it("keeps the top N by score however low, ties in similarity order", async () => {
    mockScores('[{"i":0,"score":1},{"i":1,"score":0},{"i":2,"score":2},{"i":3,"score":1}]');
    const out = await rerankChunks(CFG, "q", cands(4), 2);
    expect(out.chunks.map((c) => c.doc_id)).toEqual(["d2", "d0"]);
  });

  it("degrades to similarity order on unparseable output", async () => {
    mockScores("sorry, I cannot comply");
    const out = await rerankChunks(CFG, "q", cands(5), 3);
    expect(out.degraded).toBe(true);
    expect(out.chunks.map((c) => c.doc_id)).toEqual(["d0", "d1", "d2"]);
  });

  // A 400 fails on the first attempt; a 5xx would wait out the client's retry backoff.
  it("degrades on a model error and still reports the model, since the request was made", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("boom", { status: 400 }))));
    const out = await rerankChunks(CFG, "q", cands(4), 2);
    expect(out.degraded).toBe(true);
    expect(out.chunks.map((c) => c.doc_id)).toEqual(["d0", "d1"]);
    expect(out.modelId).toBe(resolveModel(CFG, "auto"));
  });

  // A failed judge degrades silently, so a misrouted call would be invisible without this.
  it("sends the judge to the configured chat provider with the default model", async () => {
    const seen: Array<{ url: string; model: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init: RequestInit) => {
        seen.push({ url: String(url), model: (JSON.parse(String(init.body)) as { model: string }).model });
        return Promise.resolve(new Response("nope", { status: 400 }));
      }),
    );
    await rerankChunks(CFG, "q", cands(4), 2);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url.startsWith(`${CFG.chat.endpoints[0]!.baseUrl}/v1/messages`)).toBe(true);
    expect(seen[0]!.model).toBe(resolveModel(CFG, "auto"));
  });

  it("makes no call while chat is off, and says nothing degraded", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const out = await rerankChunks({ ...CFG, chat: { ...CFG.chat, enabled: false } }, "q", cands(5), 2);
    expect(spy).not.toHaveBeenCalled();
    expect(out).toMatchObject({ degraded: false, modelId: null });
    expect(out.chunks.map((c) => c.doc_id)).toEqual(["d0", "d1"]);
  });
});

describe("rerankChunks with a System One reranker", () => {
  it("asks every candidate as one question in a single request, and ranks by probability", async () => {
    const seen = mockSystemOne([0.1, 0.95, 0.4, 0.8]);
    const out = await rerankChunks(WITH_RERANKER, "which clause?", cands(4), 3);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://rerank.example.test/v1/systemone");
    expect(seen[0]!.headers.get("authorization")).toBe("Bearer rerank-key");
    expect(seen[0]!.body.model).toBe("jev-latest");
    expect(seen[0]!.body.state.query).toBe("which clause?");
    expect(Object.keys(seen[0]!.body.state.passages)).toEqual(["p0", "p1", "p2", "p3"]);
    expect(Object.keys(seen[0]!.body.questions)).toEqual(["p0", "p1", "p2", "p3"]);
    expect(out.chunks.map((c) => c.doc_id)).toEqual(["d1", "d3", "d2"]);
    expect(out).toMatchObject({ degraded: false, modelId: "jev-1.13.0", usage: { inputTokens: 900, outputTokens: 0 } });
  });

  it("is preferred to the chat model, and runs while chat is off", async () => {
    const seen = mockSystemOne([0.2, 0.9]);
    const out = await rerankChunks({ ...WITH_RERANKER, chat: { ...CFG.chat, enabled: false } }, "q", cands(2), 1, { rankAbove: 1 });
    expect(seen).toHaveLength(1);
    expect(out.chunks.map((c) => c.doc_id)).toEqual(["d1"]);
  });

  it("degrades to similarity order when an answer is missing", async () => {
    mockSystemOne([0.9]);
    const out = await rerankChunks(WITH_RERANKER, "q", cands(3), 2);
    expect(out).toMatchObject({ degraded: true, modelId: "jev-latest" });
    expect(out.chunks.map((c) => c.doc_id)).toEqual(["d0", "d1"]);
  });

  it("degrades to similarity order when the endpoint refuses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad key", { status: 401 })));
    const out = await rerankChunks(WITH_RERANKER, "q", cands(3), 2);
    expect(out.degraded).toBe(true);
    expect(out.chunks.map((c) => c.doc_id)).toEqual(["d0", "d1"]);
  });
});

describe("rerankChunks skips the judge", () => {
  it("when candidates already fit topN", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const out = await rerankChunks(CFG, "q", cands(3), 5);
    expect(spy).not.toHaveBeenCalled();
    expect(out).toMatchObject({ degraded: false, modelId: null });
    expect(out.chunks).toHaveLength(3);
  });

  // A caller that narrows further asks for more than topN and still needs the ranking.
  it("only at or below rankAbove", async () => {
    mockScores('[{"i":0,"score":1},{"i":1,"score":9},{"i":2,"score":2},{"i":3,"score":8}]');
    const ranked = await rerankChunks(CFG, "q", cands(4), 16, { rankAbove: 2 });
    expect(ranked.chunks.map((c) => c.doc_id)).toEqual(["d1", "d3", "d2", "d0"]);

    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const out = await rerankChunks(CFG, "q", cands(2), 16, { rankAbove: 2 });
    expect(spy).not.toHaveBeenCalled();
    expect(out.chunks).toHaveLength(2);
  });

  it("for no candidates", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    expect(await rerankChunks(CFG, "q", [], 5)).toMatchObject({ chunks: [], modelId: null });
    expect(spy).not.toHaveBeenCalled();
  });
});
