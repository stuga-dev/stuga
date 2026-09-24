import { describe, expect, it } from "vitest";
import type { NodeAiSettings } from "../../../api";
import { chatInputWith, connectFailure, suggestedOllamaEmbedModel, withConnectedProvider } from "./ai-form";

const BASE = { openai: "https://api.openai.com/v1", anthropic: "https://api.anthropic.com", ollama: "http://127.0.0.1:11434" };

const provider = (id: string, models: string[]) => ({
  id,
  provider: "openai" as const,
  base_url: "https://api.openai.com/v1",
  models: models.map((m) => ({ id: m, name: m })),
  api_key_set: true,
  api_key_fingerprint: "abcd1234",
  api_key_stale: false,
});

const settings = (endpoints: ReturnType<typeof provider>[], defaultModel = endpoints[0]?.models[0]?.id ?? ""): NodeAiSettings => ({
  chat: { enabled: true, running: endpoints.length > 0, default_model: defaultModel, endpoints },
  embed: {
    enabled: true,
    running: false,
    provider: "ollama",
    base_url: BASE.ollama,
    model: "",
    api_key_set: false,
    api_key_fingerprint: null,
    api_key_stale: false,
    search_max_distance: null,
    retrieval_max_distance: null,
  },
  embedding_column_dims: 1024,
  max_distance_defaults: { search: 0.6, retrieval: 0.9 },
  provider_base_urls: BASE,
  updated_by: null,
  updated_at: null,
});

describe("suggestedOllamaEmbedModel", () => {
  it("names a model Ollama could pull that returns the column's width", () => {
    expect(suggestedOllamaEmbedModel(1024)).toBe("bge-m3");
    expect(suggestedOllamaEmbedModel(768)).toBe("nomic-embed-text");
    expect(suggestedOllamaEmbedModel(1536)).toBeNull();
  });
});

describe("withConnectedProvider", () => {
  const added = { id: "anthropic-x", provider: "anthropic", baseUrl: BASE.anthropic, key: "sk-ant" };

  it("offers the chosen model and makes the first provider's the default, keeping chat's switch as saved", () => {
    const input = withConnectedProvider(settings([]), added, "claude-new", BASE);
    expect(input).toEqual({
      chat: {
        enabled: true,
        default_model: "claude-new",
        endpoints: [{ id: "anthropic-x", provider: "anthropic", base_url: BASE.anthropic, models: [{ id: "claude-new", name: "claude-new" }], api_key: "sk-ant" }],
      },
    });
  });

  it("keeps the default and every saved provider, their keys untouched, when another joins", () => {
    const input = withConnectedProvider(settings([provider("openai-1", ["gpt-4.1"])]), added, "claude-new", BASE);
    expect(input.chat!.default_model).toBe("gpt-4.1");
    expect(input.chat!.endpoints.map((e) => e.id)).toEqual(["openai-1", "anthropic-x"]);
    expect(input.chat!.endpoints[0]).not.toHaveProperty("api_key");
  });
});

describe("chatInputWith", () => {
  const two = settings([provider("a", ["m1"]), provider("b", ["m2"])], "m2");

  it("drops a removed provider and leaves a default it took with it for the node to settle", () => {
    const input = chatInputWith(two, { removeId: "b" }, BASE);
    expect(input.chat!.endpoints.map((e) => e.id)).toEqual(["a"]);
    expect(input.chat!.default_model).toBe("");
  });

  it("disconnects chat when the last provider goes", () => {
    expect(chatInputWith(settings([provider("a", ["m1"])]), { removeId: "a" }, BASE).chat).toEqual({ enabled: true, default_model: "", endpoints: [] });
  });

  it("flips chat's switch with the providers sent back as saved", () => {
    const off = chatInputWith(two, { enabled: false }, BASE);
    expect(off.chat).toMatchObject({ enabled: false, default_model: "m2" });
    expect(off.chat!.endpoints.map((e) => e.id)).toEqual(["a", "b"]);
    expect(off.chat!.endpoints.some((e) => "api_key" in e)).toBe(false);
  });

  it("changes the default among offered models, and deletes a key only when asked", () => {
    expect(chatInputWith(two, { defaultModel: "m1" }, BASE).chat!.default_model).toBe("m1");
    const cleared = chatInputWith(two, { edit: { id: "a", provider: "openai", baseUrl: BASE.openai, models: "m1", key: "" }, clearKeyOf: "a" }, BASE);
    expect(cleared.chat!.endpoints[0]).toMatchObject({ id: "a", api_key: "" });
    expect(cleared.chat!.endpoints[1]).not.toHaveProperty("api_key");
    expect(cleared).not.toHaveProperty("embed");
  });
});

describe("connectFailure", () => {
  it("names a refused key and an unreachable server in words, and quotes anything else", () => {
    expect(connectFailure("OpenAI", 'models 401: {"error":{"message":"Incorrect API key provided"}}')).toBe("OpenAI didn’t accept that key.");
    expect(connectFailure("Ollama (local)", "fetch failed")).toContain("Couldn’t reach Ollama (local)");
    expect(connectFailure("Groq", "models 500: overloaded")).toBe("Groq answered: models 500: overloaded");
  });
});
