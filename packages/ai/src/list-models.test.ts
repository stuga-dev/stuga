/**
 * Name-based model-list filtering: `listModels` asks a provider's own
 * `/models` endpoint what it offers, then keeps only the ids that look like
 * the requested kind, since that endpoint carries no capability field —
 * OpenAI's `/v1/models` mixes text-embedding-3-small in with whisper-1,
 * tts-1 and every chat model.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiEndpoint } from "./config.js";
import { listModels } from "./list-models.js";

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
