/** One-shot chat requests through Pi: endpoint routing, the text they return, and the probe. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { completeText, probeChat } from "./chat.js";
import type { AiConfig } from "./config.js";
import { CFG, mockStreamFromText, openaiTextRound, sentBody, streamOf, textRound } from "./test-helpers.js";

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

/** Kimi K3 cannot switch reasoning off; GPT-6 Sol can. Both are catalogued at their vendor's own URL. */
const VENDORS: AiConfig = {
  ...CFG,
  chat: {
    enabled: true,
    defaultModel: "kimi-k3",
    endpoints: [
      { id: "kimi", provider: "openai", baseUrl: "https://api.moonshot.ai/v1", apiKey: "k", models: [{ id: "kimi-k3", name: "Kimi K3" }] },
      { id: "oai", provider: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "o", models: [{ id: "gpt-6-sol", name: "GPT-6 Sol" }] },
    ],
  },
};

/** Only the request matters, so every one is refused. */
const refuseAll = () => vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 400 })));

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
    expect(out).toEqual({
      text: "ranked",
      usage: { inputTokens: 30, outputTokens: 4, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 },
      modelId: "sonnet",
      protocol: "anthropic-messages",
      cutOff: false,
    });
  });

  it("reports a refusal as a classified failure, never throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad key", { status: 401 })));
    const out = await completeText(CFG, { prompt: "rank", maxTokens: 64 });
    expect(out.failure).toMatchObject({ kind: "auth", protocol: "anthropic-messages", model: "sonnet", message: expect.stringContaining("bad key") });
    expect(out.text).toBe("");
  });

  it("keeps the endpoint's key out of a message that echoes it", async () => {
    const cfg: AiConfig = { ...CFG, chat: { ...CFG.chat, endpoints: [{ ...CFG.chat.endpoints[0]!, apiKey: "sk-live-0123456789" }] } };
    vi.stubGlobal("fetch", vi.fn(async () => new Response("key sk-live-0123456789 is not valid", { status: 400 })));
    const out = await completeText(cfg, { prompt: "rank", maxTokens: 64 });
    expect(out.failure!.message).not.toContain("sk-live-0123456789");
  });

  it("reports a node with no endpoint as a failure", async () => {
    const out = await completeText({ ...CFG, chat: { ...CFG.chat, endpoints: [] } }, { prompt: "rank", maxTokens: 64 });
    expect(out).toMatchObject({ modelId: null, protocol: null, failure: { kind: "error", message: "no chat endpoint is configured" } });
  });

  it("says when the answer stopped at the cap", async () => {
    const round = openaiTextRound('[{"i":0,"sco', { inputTokens: 9, outputTokens: 64 }, "length");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(streamOf(round), { status: 200 })));
    const out = await completeText(TWO_ENDPOINTS, { model: "kimi-k3", prompt: "rank", maxTokens: 64 });
    expect(out).toMatchObject({ text: '[{"i":0,"sco', cutOff: true });
    expect(out.failure).toBeUndefined();
  });
});

describe("completeText's reasoning", () => {
  it("asks for the lowest level where reasoning cannot be switched off", async () => {
    refuseAll();
    await completeText(VENDORS, { model: "kimi-k3", prompt: "rank", maxTokens: 64, thinking: "off" });
    expect(sentBody()).toMatchObject({ reasoning_effort: "low" });
  });

  it("switches reasoning off where it can be", async () => {
    refuseAll();
    await completeText(VENDORS, { model: "gpt-6-sol", prompt: "rank", maxTokens: 64, thinking: "off" });
    expect(sentBody()).toMatchObject({ reasoning: { effort: "none" } });
  });

  it("leaves reasoning to the provider unless asked", async () => {
    refuseAll();
    await completeText(VENDORS, { model: "kimi-k3", prompt: "rank", maxTokens: 64 });
    expect(sentBody()).not.toHaveProperty("reasoning_effort");
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

  it("leaves reasoning to the provider", async () => {
    refuseAll();
    await probeChat(VENDORS, "kimi-k3");
    expect(sentBody()).toMatchObject({ max_tokens: 16 });
    expect(sentBody()).not.toHaveProperty("reasoning_effort");
  });
});
