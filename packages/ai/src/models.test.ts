/** Model ids resolved to endpoints and Pi models: catalog metadata at a matching base URL, defaults elsewhere. */
import { describe, it, expect } from "vitest";
import type { AiConfig, ChatEndpoint } from "./config.js";
import { CFG } from "./test-helpers.js";
import { acceptsImages, chatTarget, resolveEndpoint, resolveModel } from "./models.js";

function cfgWith(endpoint: Omit<ChatEndpoint, "id">): AiConfig {
  return { ...CFG, chat: { ...CFG.chat, endpoints: [{ id: "ep", ...endpoint }] } };
}

describe("chatTarget", () => {
  it("takes a catalogued model's protocol, reasoning and vendor quirks, keeping the configured URL and name", () => {
    const cfg = cfgWith({ provider: "openai", baseUrl: "https://api.moonshot.ai/v1/", apiKey: "k", models: [{ id: "kimi-k3", name: "Kimi" }] });
    const { model, apiKey } = chatTarget(cfg, "kimi-k3");
    expect(model).toMatchObject({ api: "openai-completions", reasoning: true, name: "Kimi", baseUrl: "https://api.moonshot.ai/v1/" });
    expect(model.compat).toMatchObject({ requiresReasoningContentOnAssistantMessages: true });
    expect(apiKey).toBe("k");
  });

  it("matches a vendor's base URL with or without /v1", () => {
    const cfg = cfgWith({ provider: "openai", baseUrl: "https://api.moonshot.ai", apiKey: "k", models: [{ id: "kimi-k3", name: "Kimi" }] });
    expect(chatTarget(cfg, "kimi-k3").model.reasoning).toBe(true);
  });

  it("gives an uncatalogued id defaults on the endpoint's protocol", () => {
    const { model } = chatTarget(CFG, "sonnet");
    expect(model).toMatchObject({ api: "anthropic-messages", reasoning: false, baseUrl: "https://chat.example.test", contextWindow: 0 });
  });

  it("ignores a catalog entry on a protocol the endpoint does not speak", () => {
    // Pi's own entry at this URL and id is on the Anthropic protocol.
    const cfg = cfgWith({ provider: "openai", baseUrl: "https://api.anthropic.com", apiKey: "k", models: [{ id: "claude-opus-5", name: "Opus" }] });
    expect(chatTarget(cfg, "claude-opus-5").model).toMatchObject({ api: "openai-completions", reasoning: false });
  });

  it("serves Ollama on its OpenAI-compatible routes, keyless", () => {
    const cfg = cfgWith({ provider: "ollama", baseUrl: "http://127.0.0.1:11434/", models: [{ id: "qwen3:8b", name: "Qwen" }] });
    const { model, apiKey } = chatTarget(cfg, "qwen3:8b");
    expect(model).toMatchObject({ api: "openai-completions", baseUrl: "http://127.0.0.1:11434/v1" });
    expect(model.compat).toMatchObject({ supportsDeveloperRole: false, supportsReasoningEffort: false });
    expect(apiKey).toBe("unused");
  });

  it("routes an id to the endpoint that lists it", () => {
    const cfg: AiConfig = {
      ...CFG,
      chat: {
        ...CFG.chat,
        endpoints: [
          CFG.chat.endpoints[0]!,
          { id: "kimi", provider: "openai", baseUrl: "https://api.moonshot.ai/v1", apiKey: "kimi-key", models: [{ id: "kimi-k3", name: "Kimi" }] },
        ],
      },
    };
    expect(chatTarget(cfg, "kimi-k3").apiKey).toBe("kimi-key");
    expect(chatTarget(cfg, "sonnet").apiKey).toBe("test-key");
  });
});

describe("acceptsImages", () => {
  it("assumes an uncatalogued model can see, so images still reach it", () => {
    expect(acceptsImages(CFG, "sonnet")).toBe(true);
  });

  it("follows the catalog for a known model", () => {
    const kimi = cfgWith({ provider: "openai", baseUrl: "https://api.moonshot.ai/v1", apiKey: "k", models: [{ id: "kimi-k3", name: "Kimi" }] });
    expect(acceptsImages(kimi, "kimi-k3")).toBe(true);
    // DeepSeek's preset URL carries /v1; Pi's catalog entry does not.
    const deepseek = cfgWith({ provider: "openai", baseUrl: "https://api.deepseek.com/v1", apiKey: "k", models: [{ id: "deepseek-v4-pro", name: "DeepSeek" }] });
    expect(acceptsImages(deepseek, "deepseek-v4-pro")).toBe(false);
  });
});

describe("resolveModel", () => {
  it("maps auto, empty and missing to the configured default", () => {
    expect(resolveModel(CFG, "auto")).toBe(CFG.chat.defaultModel);
    expect(resolveModel(CFG, "")).toBe(CFG.chat.defaultModel);
    expect(resolveModel(CFG, "  ")).toBe(CFG.chat.defaultModel);
    expect(resolveModel(CFG, null)).toBe(CFG.chat.defaultModel);
    expect(resolveModel(CFG)).toBe(CFG.chat.defaultModel);
  });

  it("passes any other id through verbatim", () => {
    expect(resolveModel(CFG, "sonnet")).toBe("sonnet");
    expect(resolveModel(CFG, "claude-opus-4-1")).toBe("claude-opus-4-1");
  });
});

describe("resolveEndpoint", () => {
  it("falls back to the first endpoint for an id none lists", () => {
    expect(resolveEndpoint(CFG, "claude-opus-4-1").id).toBe("default");
  });

  it("throws a clear error when no endpoint is configured", () => {
    const empty: AiConfig = { ...CFG, chat: { ...CFG.chat, endpoints: [] } };
    expect(() => resolveEndpoint(empty, "anything")).toThrow(/no chat endpoint is configured/);
  });
});
