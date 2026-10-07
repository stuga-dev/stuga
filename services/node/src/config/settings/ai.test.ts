import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatEndpoint } from "@stuga/ai";
import type { Sql } from "@stuga/db";
import { describe, expect, it, vi } from "vitest";
import { calibrationKey } from "@stuga/ai";
import type { EmbedCalibrationRow } from "@stuga/db";
import { createAiSettingsStore, isMaxDistance, resolveAi, searchCutoffInForce, type AiStoredSettings } from "./ai.js";

const BASE_URLS = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com/v1",
  ollama: "http://127.0.0.1:11434",
} as const;

const resolve = (stored: AiStoredSettings | null) => resolveAi(stored, 1024, BASE_URLS);

const endpoint = (e: Partial<ChatEndpoint>): ChatEndpoint => ({ id: "ep1", provider: "openai", baseUrl: "https://api.openai.test/v1", models: [], ...e });

describe("resolveAi: the reranker", () => {
  const JEV = { rerankBaseUrl: "https://api.typesafe.test/v1/", rerankModel: "jev-latest", rerankApiKey: "ts-key" };

  it("runs once a model and where to reach it are set, with its key", () => {
    expect(resolve(JEV).rerank).toEqual({ enabled: true, baseUrl: "https://api.typesafe.test/v1", model: "jev-latest", apiKey: "ts-key" });
  });

  it("stays off while it is not set up, and when switched off", () => {
    expect(resolve(null).rerank).toMatchObject({ enabled: false, model: "" });
    expect(resolve({ rerankModel: "jev-latest" }).rerank.enabled).toBe(false);
    expect(resolve({ ...JEV, rerankEnabled: false }).rerank).toMatchObject({ enabled: false, model: "jev-latest" });
  });
});

describe("resolveAi", () => {
  const ollama = (models: string[]) =>
    endpoint({ provider: "ollama", baseUrl: BASE_URLS.ollama, models: models.map((id) => ({ id, name: id })) });

  it("leaves AI off until a provider is configured, and says nothing about it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ai = resolve(null);
    expect(ai.enabled).toBe(false);
    expect(ai.chat.enabled).toBe(false);
    expect(ai.embed.enabled).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("derives the default Ollama and the embed endpoint, with no model chosen for either", () => {
    const ai = resolve(null);
    expect(ai.chat.defaultModel).toBe("");
    expect(ai.chat.endpoints).toEqual([{ id: "default", provider: "ollama", baseUrl: "http://127.0.0.1:11434", models: [] }]);
    expect(ai.embed).toMatchObject({ provider: "ollama", baseUrl: "http://127.0.0.1:11434", model: "", dims: 1024 });
  });

  it("uses the packaging's Ollama address for the bootstrap endpoint and the embed fallback", () => {
    const ai = resolveAi(null, 1024, { ...BASE_URLS, ollama: "http://ollama.lan:11434" });
    expect(ai.chat.endpoints[0]!.baseUrl).toBe("http://ollama.lan:11434");
    expect(ai.embed.baseUrl).toBe("http://ollama.lan:11434");
  });

  it("runs each half once it is configured, with no switch to turn on first", () => {
    const ai = resolve({ chatEndpoints: [ollama(["llama3.1"])], embedModel: "bge-m3" });
    expect(ai.enabled).toBe(true);
    expect(ai.chat.enabled).toBe(true);
    expect(ai.chat.defaultModel).toBe("llama3.1");
    expect(ai.embed).toMatchObject({ provider: "ollama", model: "bge-m3", enabled: true });
  });

  it("falls back to the first offered model when the stored default is offered no longer", () => {
    expect(resolve({ chatEndpoints: [ollama(["qwen3", "llama3.1"])], chatDefaultModel: "gone" }).chat.defaultModel).toBe("qwen3");
  });

  it("keeps chat off, and says so, when a saved provider offers no model", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolve({ chatEndpoints: [ollama([])] }).chat.enabled).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("offers no model"));
    warn.mockRestore();
  });

  it("turns off only the half with no model, and never embeds through anthropic", () => {
    const anthropic = endpoint({ provider: "anthropic", baseUrl: "https://api.anthropic.com" });
    const partial = resolve({ chatEndpoints: [anthropic], embedModel: "bge-m3" });
    expect(partial.chat.enabled).toBe(false);
    expect(partial.embed.enabled).toBe(true);
    expect(partial.enabled).toBe(true);

    const ai = resolve({ chatEndpoints: [{ ...anthropic, apiKey: "sk-test", models: [{ id: "claude", name: "Claude" }] }] });
    expect(ai.chat.defaultModel).toBe("claude");
    // Embeddings fall back to a local Ollama and never inherit the chat key.
    expect(ai.embed.provider).toBe("ollama");
    expect(ai.embed.baseUrl).toBe("http://127.0.0.1:11434");
    expect(ai.embed.apiKey).toBeUndefined();
  });

  it("embeds through the first chat endpoint, key included, when it speaks the same protocol", () => {
    const ai = resolve({ chatEndpoints: [endpoint({ apiKey: "sk-chat" })], embedModel: "text-embedding-3-small" });
    expect(ai.embed).toMatchObject({ provider: "openai", baseUrl: "https://api.openai.test/v1", apiKey: "sk-chat", enabled: true });
  });

  it("takes stored values over the defaults, field by field", () => {
    const ai = resolve({
      chatEndpoints: [endpoint({ models: [{ id: "a", name: "A" }, { id: "b", name: "B" }] })],
      chatDefaultModel: "b",
      embedProvider: "ollama",
      embedBaseUrl: "http://gpu.lan:11434/",
      embedApiKey: "k",
      embedModel: "nomic",
    });
    expect(ai.chat.defaultModel).toBe("b");
    expect(ai.embed).toMatchObject({ provider: "ollama", baseUrl: "http://gpu.lan:11434", apiKey: "k", model: "nomic" });
  });
});

describe("search strictness", () => {
  const LEVELS = { strict: 0.27, balanced: 0.34, loose: 0.39 };
  const measured = (state: EmbedCalibrationRow["state"], result = true, kind: EmbedCalibrationRow["error_kind"] = null): EmbedCalibrationRow => ({
    config_key: "a".repeat(64),
    model: "m",
    state,
    result: result ? { levels: { short: LEVELS, question: { strict: 0.25, balanced: 0.31, loose: 0.36 } } } : null,
    error: state === "failed" ? "down" : null,
    error_kind: kind,
    attempts: 0,
    next_attempt_at: null,
    triggered_by: "system",
    started_at: new Date(),
    finished_at: null,
  });

  it("takes the level's distances from the measurement of the model, Balanced by default", () => {
    expect(searchCutoffInForce(null, null, measured("ready"))).toEqual({ level: "balanced", source: "measured", cutoff: { short: 0.34, question: 0.31 } });
    expect(searchCutoffInForce("strict", null, measured("ready")).cutoff).toEqual({ short: 0.27, question: 0.25 });
    expect(searchCutoffInForce("loose", null, measured("ready")).cutoff).toEqual({ short: 0.39, question: 0.36 });
  });

  it("keeps an earlier result in force while measuring again or after an endpoint failure", () => {
    expect(searchCutoffInForce(null, null, measured("running")).source).toBe("measured");
    expect(searchCutoffInForce(null, null, measured("failed", true, "endpoint")).source).toBe("measured");
  });

  it("drops nothing by distance without a measurement, for Off, and for a model that cannot be measured", () => {
    expect(searchCutoffInForce(null, null, null)).toEqual({ level: "balanced", source: "unmeasured", cutoff: null });
    expect(searchCutoffInForce(null, null, measured("running", false))).toEqual({ level: "balanced", source: "measuring", cutoff: null });
    expect(searchCutoffInForce(null, null, measured("failed", false, "inseparable")).cutoff).toBeNull();
    expect(searchCutoffInForce("off", null, measured("ready"))).toEqual({ level: "off", source: "off", cutoff: null });
  });

  it("uses a custom distance for every query", () => {
    expect(searchCutoffInForce("custom", 0.7, measured("ready"))).toEqual({ level: "custom", source: "custom", cutoff: { short: 0.7, question: 0.7 } });
  });

  it("resolves the measurement of the configuration in force, only while semantic search runs", () => {
    const st: AiStoredSettings = { embedProvider: "ollama", embedBaseUrl: "http://gpu.lan:11434", embedModel: "embeddinggemma-2:270m" };
    const key = calibrationKey(resolve(st));
    const rows = new Map([[key, { ...measured("ready"), config_key: key }]]);
    expect(resolveAi(st, 1024, BASE_URLS, rows).embed.searchCutoff).toEqual({ short: 0.34, question: 0.31 });
    expect(resolveAi({ ...st, embedEnabled: false }, 1024, BASE_URLS, rows).embed.searchCutoff).toBeNull();
    expect(resolveAi({ ...st, embedModel: "bge-m3" }, 1024, BASE_URLS, rows).embed.searchCutoff).toBeNull();
  });

  it("sets no cutoff for Ask and agents unless one was stored", () => {
    expect(resolve(null).embed.retrievalMaxDistance).toBeNull();
    expect(resolve({ retrievalMaxDistance: 1.4 }).embed.retrievalMaxDistance).toBe(1.4);
  });

  it.each([
    [0.01, true],
    [2, true],
    [0, false],
    [2.0001, false],
    [Number.NaN, false],
    ["1", false],
  ])("accepts %s as a cutoff: %s", (value, ok) => {
    expect(isMaxDistance(value)).toBe(ok);
  });
});

describe("each half's own switch", () => {
  const chatReady: AiStoredSettings = { chatEndpoints: [endpoint({ models: [{ id: "m", name: "m" }] })] };

  it("runs chat without semantic search", () => {
    const ai = resolve(chatReady);
    expect(ai.chat.enabled).toBe(true);
    expect(ai.embed.enabled).toBe(false);
    expect(ai.enabled).toBe(true);
  });

  it("runs semantic search without chat, as for an outside agent on MCP", () => {
    const ai = resolve({ embedProvider: "ollama", embedModel: "bge-m3" });
    expect(ai.chat.enabled).toBe(false);
    expect(ai.embed.enabled).toBe(true);
    expect(ai.enabled).toBe(true);
  });

  it("switches chat off with its providers kept, leaving semantic search running", () => {
    const ai = resolve({ ...chatReady, chatEnabled: false, embedModel: "bge-m3" });
    expect(ai.chat).toMatchObject({ enabled: false, defaultModel: "m" });
    expect(ai.embed.enabled).toBe(true);
  });

  it("switches semantic search off with its model kept, leaving chat running", () => {
    const ai = resolve({ ...chatReady, embedEnabled: false, embedModel: "bge-m3" });
    expect(ai.embed).toMatchObject({ enabled: false, model: "bge-m3" });
    expect(ai.chat.enabled).toBe(true);
  });

  it("keeps semantic search off while it has no model, whatever its switch says", () => {
    const ai = resolve({ embedEnabled: true });
    expect(ai.embed.enabled).toBe(false);
    expect(ai.enabled).toBe(false);
  });

  it("reports `enabled` as any-AI, never as a gate for a specific surface", () => {
    expect(resolve({ ...chatReady, chatEnabled: false, embedEnabled: false, embedModel: "bge-m3" }).enabled).toBe(false);
  });
});

describe("createAiSettingsStore", () => {
  it("keeps AI as configured when a refresh cannot read the row", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "stuga-ai-settings-"));
    try {
      const chatEndpoints = [{ id: "ep1", provider: "ollama", baseUrl: BASE_URLS.ollama, models: [{ id: "llama3.1", name: "llama3.1" }], apiKeyFp: null }];
      let answer: () => Promise<unknown[]> = async () => [{ chat_default_model: "llama3.1", chat_endpoints: chatEndpoints }];
      const sql = ((..._query: unknown[]) => answer()) as unknown as Sql;
      const store = await createAiSettingsStore({ sql, dataDir, embeddingDims: 1024, baseUrls: BASE_URLS });
      expect(store.current().chat.enabled).toBe(true);

      answer = async () => Promise.reject(new Error("connection terminated"));
      await expect(store.refresh()).rejects.toThrow("connection terminated");
      expect(store.current().chat).toMatchObject({ enabled: true, defaultModel: "llama3.1" });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
