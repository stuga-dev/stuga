/**
 * Name-based model-list filtering: `listModels` asks a provider's own
 * `/models` endpoint what it offers, then keeps only the ids that look like
 * the requested kind, since that endpoint carries no capability field —
 * OpenAI's `/v1/models` mixes text-embedding-3-small in with whisper-1,
 * tts-1 and every chat model.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiEndpoint } from "./config.js";
import { listModels, listSystemOneModels } from "./list-models.js";

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

  it("lists a model Ollama names twice once, where it first sorts", async () => {
    // As Ollama 0.40 lists it: one name under two digests.
    const pulled = [
      { name: "embeddinggemma:300m", digest: "3a2d262bdb75", modified_at: "2026-10-01T00:00:00Z" },
      { name: "bge-m3:latest", digest: "790764642607", modified_at: "2026-09-01T00:00:00Z" },
      { name: "embeddinggemma:300m", digest: "5265a4c1d1e7", modified_at: "2026-10-01T00:00:00Z" },
    ];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ models: pulled }), { status: 200 })));
    expect(await listModels({ ...EP, provider: "ollama" }, "embed")).toEqual(["embeddinggemma:300m", "bge-m3:latest"]);
  });

  it("knows the embedding families whose names do not say embed", async () => {
    const pulled = ["bge-m3:latest", "BAAI/bge-large-en-v1.5", "intfloat/multilingual-e5-large", "thenlper/gte-large", "all-minilm:l6-v2", "qwen3:8b", "llama3.1:8b", "gpt-4.5-preview"];
    mockModelList(pulled);
    expect(await listModels(EP, "embed")).toEqual(pulled.slice(0, 5));
    expect(await listModels(EP, "chat")).toEqual(["qwen3:8b", "llama3.1:8b", "gpt-4.5-preview"]);
  });
});

describe("listModels on Amazon Bedrock", () => {
  const BEDROCK: AiEndpoint = { provider: "bedrock", baseUrl: "https://bedrock-runtime.eu-west-3.amazonaws.com", apiKey: "bedrock-key" };
  const PROFILES = {
    inferenceProfileSummaries: [
      { inferenceProfileId: "eu.anthropic.claude-haiku-5-5", type: "SYSTEM_DEFINED", status: "ACTIVE", createdAt: "2026-03-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" },
      { inferenceProfileId: "global.anthropic.claude-sonnet-5-5", type: "SYSTEM_DEFINED", status: "ACTIVE", createdAt: "2026-08-01T00:00:00Z" },
      { inferenceProfileId: "eu.anthropic.claude-old", type: "SYSTEM_DEFINED", status: "INACTIVE", createdAt: "2026-09-30T00:00:00Z" },
      {
        inferenceProfileId: "a1b2c3",
        inferenceProfileArn: "arn:aws:bedrock:eu-west-3:123456789012:application-inference-profile/a1b2c3",
        type: "APPLICATION",
        status: "ACTIVE",
        createdAt: "2026-05-01T00:00:00Z",
      },
    ],
  };
  const FOUNDATION = {
    modelSummaries: [
      { modelId: "mistral.pixtral-large-2502-v1:0", inferenceTypesSupported: ["ON_DEMAND"], outputModalities: ["TEXT"], modelLifecycle: { status: "ACTIVE" } },
      // Served only through an inference profile, which the profile listing names.
      { modelId: "anthropic.claude-sonnet-5-5", inferenceTypesSupported: ["INFERENCE_PROFILE"], outputModalities: ["TEXT"], modelLifecycle: { status: "ACTIVE" } },
      { modelId: "amazon.titan-text-old", inferenceTypesSupported: ["ON_DEMAND"], outputModalities: ["TEXT"], modelLifecycle: { status: "LEGACY" } },
      { modelId: "amazon.nova-canvas-v1:0", inferenceTypesSupported: ["ON_DEMAND"], outputModalities: ["IMAGE"], modelLifecycle: { status: "ACTIVE" } },
      { modelId: "amazon.nova-pro-v1:0", inferenceTypesSupported: ["ON_DEMAND", "INFERENCE_PROFILE"], outputModalities: ["TEXT"], modelLifecycle: { status: "ACTIVE" } },
    ],
  };

  /** The control plane, answering each listing with its body, or refusing it with `refuse`'s status. */
  function controlPlane(refuse: { profiles?: number; foundation?: number } = {}) {
    const fn = vi.fn(async (url: string) => {
      const profiles = new URL(url).pathname === "/inference-profiles";
      const status = (profiles ? refuse.profiles : refuse.foundation) ?? 200;
      if (status !== 200) return new Response("AccessDeniedException", { status });
      return new Response(JSON.stringify(profiles ? PROFILES : FOUNDATION), { status: 200 });
    });
    vi.stubGlobal("fetch", fn);
    return fn;
  }

  it("asks the Region's control plane with the key as a bearer token", async () => {
    const fn = controlPlane();
    await listModels(BEDROCK, "chat");
    const calls = fn.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls.map(([url]) => url).sort()).toEqual([
      "https://bedrock.eu-west-3.amazonaws.com/foundation-models?byOutputModality=TEXT&byInferenceType=ON_DEMAND",
      "https://bedrock.eu-west-3.amazonaws.com/inference-profiles?maxResults=1000",
    ]);
    for (const [, init] of calls) expect((init.headers as Record<string, string>).authorization).toBe("Bearer bedrock-key");
  });

  it("lists the profiles in service newest first, an account's own by ARN, then the text models callable on demand", async () => {
    controlPlane();
    expect(await listModels(BEDROCK, "chat")).toEqual([
      "global.anthropic.claude-sonnet-5-5",
      "arn:aws:bedrock:eu-west-3:123456789012:application-inference-profile/a1b2c3",
      "eu.anthropic.claude-haiku-5-5",
      "mistral.pixtral-large-2502-v1:0",
      "amazon.nova-pro-v1:0",
    ]);
  });

  it("keeps the listing the key may read when the other is refused, and fails when both are", async () => {
    controlPlane({ foundation: 403 });
    expect(await listModels(BEDROCK, "chat")).toHaveLength(3);
    controlPlane({ profiles: 403, foundation: 403 });
    await expect(listModels(BEDROCK, "chat")).rejects.toThrow(/models 403/);
  });

  it("lists no embedding models, and asks nothing for them", async () => {
    const fn = controlPlane();
    expect(await listModels(BEDROCK, "embed")).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  it("asks nowhere for an address that is not Bedrock's", async () => {
    const fn = controlPlane();
    await expect(listModels({ ...BEDROCK, baseUrl: "https://proxy.example.test" }, "chat")).rejects.toThrow(/not an Amazon Bedrock runtime address/);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("listSystemOneModels", () => {
  it("reads TypeSafe's listing, newest first, asking with the key", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ models: [{ name: "jev-latest", release_date: "2026-09-10T18:38:01Z" }, { name: "jev-preview", release_date: "2026-09-10T18:39:06Z" }] }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchFn);
    expect(await listSystemOneModels({ baseUrl: "https://api.typesafe.example/v1", apiKey: "k" })).toEqual(["jev-preview", "jev-latest"]);
    const [url, init] = fetchFn.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://api.typesafe.example/v1/models?output_modalities=decisions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer k");
  });

  it("keeps only decision models from a listing in OpenAI's shape", async () => {
    const decisions = { output_modalities: ["decisions"] };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: [
                { id: "~typesafe/jev-latest", created: 1_789_689_685, architecture: decisions },
                { id: "some/chat-model", created: 1_791_000_000, architecture: { output_modalities: ["text"] } },
                { id: "microsoft/microsoft-decision-1", created: 1_791_584_978, architecture: decisions },
                { id: "local-ranker" },
              ],
            }),
            { status: 200 },
          ),
      ),
    );
    expect(await listSystemOneModels({ baseUrl: "https://router.example/api/v1" })).toEqual(["microsoft/microsoft-decision-1", "~typesafe/jev-latest", "local-ranker"]);
  });

  it("throws the service's refusal", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad key", { status: 401 })));
    await expect(listSystemOneModels({ baseUrl: "https://api.typesafe.example/v1" })).rejects.toThrow(/401/);
  });
});
