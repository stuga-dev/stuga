/** One-shot chat requests through Pi: endpoint routing, the text they return, and the probe. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { completeText, probeChat } from "./chat.js";
import type { AiConfig } from "./config.js";
import { CFG, mockStreamFromText, openaiTextRound, streamOf, textRound } from "./test-helpers.js";

const TWO_ENDPOINTS: AiConfig = {
  ...CFG,
  chat: {
    enabled: true,
    defaultModel: "claude-sonnet-4-6",
    endpoints: [
      { id: "anthro", provider: "anthropic", baseUrl: "https://chat.example.test", apiKey: "a-key", models: [{ id: "claude-sonnet-4-6", name: "Sonnet" }] },
      { id: "moonshot", provider: "openai", baseUrl: "https://moonshot.example.test/v1", apiKey: "m-key", models: [{ id: "kimi-k3", name: "Kimi K3" }] },
    ],
  },
};

/** Serve each request in the protocol its URL implies, recording URL and model. */
function mockBoth(): Array<{ url: string; model: string }> {
  const seen: Array<{ url: string; model: string }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init: RequestInit) => {
      seen.push({ url: String(url), model: (JSON.parse(String(init.body)) as { model: string }).model });
      const anthropic = String(url).startsWith("https://chat.example.test");
      return new Response(streamOf(anthropic ? textRound("hi") : openaiTextRound("hi")), { status: 200 });
    }),
  );
  return seen;
}

afterEach(() => vi.unstubAllGlobals());

describe("completeText", () => {
  it("routes a model id to the endpoint that lists it, and sends the id verbatim", async () => {
    const seen = mockBoth();
    await completeText(TWO_ENDPOINTS, { model: "kimi-k3", prompt: "hi", maxTokens: 64 });
    await completeText(TWO_ENDPOINTS, { model: "claude-sonnet-4-6", prompt: "hi", maxTokens: 64 });
    expect(seen.map((s) => [new URL(s.url).host, s.model])).toEqual([
      ["moonshot.example.test", "kimi-k3"],
      ["chat.example.test", "claude-sonnet-4-6"],
    ]);
  });

  it("sends an id no endpoint lists to the first endpoint, verbatim", async () => {
    const seen = mockBoth();
    await completeText(TWO_ENDPOINTS, { model: "claude-opus-4-1", prompt: "hi", maxTokens: 64 });
    expect(seen[0]).toMatchObject({ model: "claude-opus-4-1" });
    expect(seen[0]!.url.startsWith("https://chat.example.test")).toBe(true);
  });

  it("returns the text, usage and model", async () => {
    mockStreamFromText("ranked", { inputTokens: 30, outputTokens: 4 });
    const out = await completeText(CFG, { prompt: "rank", maxTokens: 64 });
    expect(out).toEqual({ text: "ranked", usage: { inputTokens: 30, outputTokens: 4, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 }, modelId: "sonnet" });
  });

  it("reports a refusal as an error, never throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad key", { status: 401 })));
    const out = await completeText(CFG, { prompt: "rank", maxTokens: 64 });
    expect(out.error).toContain("bad key");
    expect(out.text).toBe("");
  });

  it("reports a node with no endpoint as an error", async () => {
    const out = await completeText({ ...CFG, chat: { ...CFG.chat, endpoints: [] } }, { prompt: "rank", maxTokens: 64 });
    expect(out).toMatchObject({ modelId: null, error: "no chat endpoint is configured" });
  });
});

describe("probeChat", () => {
  it("answers null when the model answers", async () => {
    mockStreamFromText("pong");
    expect(await probeChat(CFG, "sonnet")).toBeNull();
  });

  it("answers with the provider's refusal", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"error":{"message":"model not found"}}', { status: 404 })));
    expect(await probeChat(CFG, "sonnet")).toContain("model not found");
  });
});
