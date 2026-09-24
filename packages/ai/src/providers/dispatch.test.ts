/**
 * Name-based model-list filtering: `listModels` asks a provider's own
 * `/models` endpoint what it offers, then keeps only the ids that look like
 * the requested kind, since that endpoint carries no capability field —
 * OpenAI's `/v1/models` mixes text-embedding-3-small in with whisper-1,
 * tts-1 and every chat model.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiConfig, AiEndpoint } from "../config.js";
import { listModels, streamTurn } from "./dispatch.js";
import { openaiTextRound, streamOf, textRound } from "../test-helpers.js";

const EP: AiEndpoint = { provider: "openai", baseUrl: "https://api.example.test/v1", apiKey: "test-key" };

/** Chat ids (including a dated snapshot), two embedding ids, and one id per excluded non-chat family. */
const MIXED_MODELS = [
  "gpt-4.1",
  "gpt-4o-mini",
  "o3-mini",
  "gpt-4-0613",
  "text-embedding-3-small",
  "text-embedding-ada-002",
  "whisper-1",
  "tts-1",
  "dall-e-3",
  "davinci-002",
  "babbage-002",
  "text-moderation-latest",
  "gpt-4o-realtime-preview",
  "gpt-4o-transcribe",
  "gpt-image-1",
  "gpt-live-1",
];

function mockModelList(ids: string[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("listModels", () => {
  it("which='embed' keeps only the embedding ids", async () => {
    mockModelList(MIXED_MODELS);
    expect(await listModels(EP, "embed")).toEqual(["text-embedding-3-small", "text-embedding-ada-002"]);
  });

  it("which='chat' drops the embedding ids and every non-chat family", async () => {
    mockModelList(MIXED_MODELS);
    expect(await listModels(EP, "chat")).toEqual(["gpt-4.1", "gpt-4o-mini", "o3-mini", "gpt-4-0613"]);
  });

  it("puts the newest first where the service dates its models, undated ones after in the order given", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ data: [{ id: "old", created: 1_600_000_000 }, { id: "undated-a" }, { id: "newest", created: 1_760_000_000 }, { id: "undated-b" }, { id: "middle", created: 1_700_000_000 }] }),
          { status: 200 },
        ),
      ),
    );
    expect(await listModels(EP, "chat")).toEqual(["newest", "middle", "old", "undated-a", "undated-b"]);
  });

  it("reads Anthropic's and Ollama's dates as well", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "claude-a", created_at: "2025-02-01T00:00:00Z" }, { id: "claude-b", created_at: "2026-05-01T00:00:00Z" }] }), { status: 200 })),
    );
    expect(await listModels({ ...EP, provider: "anthropic" }, "chat")).toEqual(["claude-b", "claude-a"]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ models: [{ name: "llama3.1:8b", modified_at: "2025-01-01T00:00:00Z" }, { name: "qwen3:8b", modified_at: "2026-01-01T00:00:00Z" }] }), { status: 200 })),
    );
    expect(await listModels({ ...EP, provider: "ollama" }, "chat")).toEqual(["qwen3:8b", "llama3.1:8b"]);
  });

  it("knows the embedding families whose names do not say embed", async () => {
    const pulled = ["bge-m3:latest", "BAAI/bge-large-en-v1.5", "intfloat/multilingual-e5-large", "thenlper/gte-large", "all-minilm:l6-v2", "qwen3:8b", "llama3.1:8b", "gpt-4.5-preview"];
    mockModelList(pulled);
    expect(await listModels(EP, "embed")).toEqual(pulled.slice(0, 5));
    expect(await listModels(EP, "chat")).toEqual(["qwen3:8b", "llama3.1:8b", "gpt-4.5-preview"]);
  });
});

/** `streamTurn` dispatches to the endpoint listing the id and sends the id as the provider's model name. */
describe("streamTurn endpoint selection", () => {
  const TWO_ENDPOINT_CFG: AiConfig = {
    enabled: true,
    chat: {
      enabled: true,
      defaultModel: "claude-sonnet-4-6",
      endpoints: [
        {
          id: "anthro",
          provider: "anthropic",
          baseUrl: "https://chat.example.test",
          apiKey: "a-key",
          models: [{ id: "claude-sonnet-4-6", name: "Sonnet" }],
        },
        {
          id: "moonshot",
          provider: "openai",
          baseUrl: "https://moonshot.example.test/v1",
          apiKey: "m-key",
          models: [{ id: "kimi-k3", name: "Kimi K3" }],
        },
      ],
    },
    embed: { enabled: false, provider: "ollama", baseUrl: "http://127.0.0.1:11434", model: "", dims: 1024, searchMaxDistance: 0.6, retrievalMaxDistance: 0.9 },
  };
  const USER = [{ role: "user" as const, content: [{ text: "hi" }] }];

  afterEach(() => vi.unstubAllGlobals());

  async function drain(gen: AsyncGenerator<string, unknown>): Promise<string> {
    let text = "";
    for await (const delta of gen) text += delta;
    return text;
  }

  it("routes a model id to the endpoint that lists it", async () => {
    const seenUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: unknown) => {
        seenUrls.push(String(url));
        const isAnthropic = String(url).startsWith("https://chat.example.test");
        return Promise.resolve(
          new Response(streamOf(isAnthropic ? textRound("hi") : openaiTextRound("hi")), { status: 200 }),
        );
      }),
    );

    await drain(streamTurn(TWO_ENDPOINT_CFG, { modelId: "kimi-k3", messages: USER }));
    expect(seenUrls[0]).toContain("moonshot.example.test");

    seenUrls.length = 0;
    await drain(streamTurn(TWO_ENDPOINT_CFG, { modelId: "claude-sonnet-4-6", messages: USER }));
    expect(seenUrls[0]).toContain("chat.example.test");
  });

  it("sends the listed id verbatim as the provider's model name", async () => {
    let sentModel = "";
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: unknown, init: unknown) => {
        sentModel = (JSON.parse((init as RequestInit).body as string) as { model: string }).model;
        return Promise.resolve(new Response(streamOf(textRound("ok")), { status: 200 }));
      }),
    );
    await drain(streamTurn(TWO_ENDPOINT_CFG, { modelId: "claude-sonnet-4-6", messages: USER }));
    expect(sentModel).toBe("claude-sonnet-4-6");
  });

  it("falls back to the first endpoint, id sent verbatim, for an id no endpoint lists", async () => {
    let sentModel = "";
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: unknown, init: unknown) => {
        sentModel = (JSON.parse((init as RequestInit).body as string) as { model: string }).model;
        return Promise.resolve(new Response(streamOf(textRound("ok")), { status: 200 }));
      }),
    );
    await drain(streamTurn(TWO_ENDPOINT_CFG, { modelId: "claude-opus-4-1", messages: USER }));
    expect(sentModel).toBe("claude-opus-4-1");
  });

  it("throws a clear error when chat.endpoints is empty", () => {
    const empty: AiConfig = { ...TWO_ENDPOINT_CFG, chat: { ...TWO_ENDPOINT_CFG.chat, endpoints: [] } };
    expect(() => streamTurn(empty, { modelId: "anything", messages: USER })).toThrow(/no chat endpoint is configured/);
  });
});
