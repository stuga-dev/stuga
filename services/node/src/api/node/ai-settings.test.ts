/**
 * PUT /api/node/ai-settings validation: model ids are one namespace across endpoints, so a shared id
 * or a default model no endpoint lists is refused before anything is written, and the search box's
 * strictness level is checked and stored on save. A save that
 * would run a provider is sent with that half switched off, so no probe makes an outbound request.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiConfig } from "@stuga/ai";
import type { NodeAiSettingsRow } from "@stuga/db";

vi.mock("@stuga/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@stuga/db")>()),
  isNodeAdminAlias: vi.fn(async () => true),
  getNodeAiSettings: vi.fn(async () => null),
  upsertNodeAiSettings: vi.fn(async () => {}),
  listEmbedCalibrations: vi.fn(async () => []),
  getEmbedCalibration: vi.fn(async () => null),
  clearEmbedCalibrations: vi.fn(async () => {}),
  clearNodeAiSettings: vi.fn(async () => {}),
  clearAllChunkEmbeddings: vi.fn(async () => 0),
  armEmbeddingBackfillAll: vi.fn(async () => 0),
}));

const { clearEmbedCalibrations, getNodeAiSettings, upsertNodeAiSettings } = await import("@stuga/db");
const { routeWorkspaceRequest } = await import("../../http/dispatch.js");
const { createAiSettingsStore } = await import("../../config/settings/ai.js");
import type { Ctx } from "../../auth/context.js";
import type { AiSettingsStore } from "../../config/settings/ai.js";

const upsert = upsertNodeAiSettings as unknown as ReturnType<typeof vi.fn>;
const getRow = getNodeAiSettings as unknown as ReturnType<typeof vi.fn>;

const BASE_URLS = { anthropic: "https://api.anthropic.com", openai: "https://api.openai.com/v1", ollama: "http://ollama.lan:11434" };

const EMPTY_AI: AiConfig = {
  enabled: false,
  chat: { enabled: false, defaultModel: "", endpoints: [] },
  embed: { enabled: false, provider: "ollama", baseUrl: "http://127.0.0.1:11434", model: "bge-m3", dims: 1024, searchCutoff: null },
  rerank: { enabled: false, baseUrl: "", model: "" },
};

/** The background measurement, recorded rather than run. */
const calibrator = { ensure: vi.fn(async (_opts?: { alias?: string; force?: boolean }) => {}), progress: () => null, stop: async () => {} };

/** A node administrator, with nothing configured yet. */
function ctx(ai: AiConfig = EMPTY_AI): Ctx {
  return {
    sql: {},
    alias: "admin-1",
    isAgent: false,
    principals: ["user:admin-1"],
    env: {
      publicOrigin: "http://node.test",
      dataDir: "/tmp/stuga-test",
      embeddingDims: 1024,
      aiProviderBaseUrls: BASE_URLS,
      calibrator,
      aiSettings: {
        current: () => ai,
        refresh: async () => {},
        secrets: () => ({ chat: {}, embed: { set: false, fingerprint: null, stale: false }, rerank: { set: false, fingerprint: null, stale: false } }),
      },
    },
  } as unknown as Ctx;
}

function put(c: Ctx, body: unknown): Promise<Response | null> {
  const req = new Request("http://node.test/api/node/ai-settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return routeWorkspaceRequest(c, req);
}

const OPENAI = { provider: "openai", base_url: "https://api.openai.test/v1" };

describe("PUT /api/node/ai-settings: chat.endpoints validation", () => {
  beforeEach(() => upsert.mockClear());

  it("rejects two endpoints that share a model id, naming both endpoints", async () => {
    const res = await put(ctx(), {
      chat: {
        enabled: false,
        endpoints: [
          { id: "ep1", ...OPENAI, models: [{ id: "shared", name: "Shared" }] },
          { id: "ep2", ...OPENAI, models: [{ id: "shared", name: "Shared" }] },
        ],
      },
    });
    expect(res?.status).toBe(400);
    const body = (await res?.json()) as { error: string };
    expect(body.error).toContain('"shared"');
    expect(body.error).toContain("ep1");
    expect(body.error).toContain("ep2");
    expect(upsert).not.toHaveBeenCalled();
  });

  it("rejects a default_model that no endpoint's models list contains", async () => {
    const res = await put(ctx(), {
      chat: {
        default_model: "nope",
        endpoints: [{ id: "ep1", ...OPENAI, models: [{ id: "real", name: "Real" }] }],
      },
    });
    expect(res?.status).toBe(400);
    const body = (await res?.json()) as { error: string };
    expect(body.error).toContain('"nope"');
    expect(upsert).not.toHaveBeenCalled();
  });

  it("accepts a model id whose earlier endpoint this request removes", async () => {
    const res = await put(ctx(), {
      chat: {
        enabled: false, // keeps probeEndpoints from making an outbound request
        endpoints: [{ id: "ep2", ...OPENAI, models: [{ id: "shared", name: "Shared" }] }],
      },
    });
    expect(res?.status).toBe(200);
    expect(upsert).toHaveBeenCalledTimes(1);
    const written = upsert.mock.calls[0]?.[1] as { chatEndpoints: Array<{ id: string; models: Array<{ id: string }> }> };
    expect(written.chatEndpoints).toEqual([expect.objectContaining({ id: "ep2", models: [{ id: "shared", name: "Shared" }] })]);
  });

  it("does not record an embed key fingerprint for a key inherited from chat", async () => {
    const withChatKey: AiConfig = {
      ...EMPTY_AI,
      embed: { ...EMPTY_AI.embed, provider: "openai", baseUrl: "https://api.openai.test/v1", apiKey: "sk-chat-key" },
    };
    const res = await put(ctx(withChatKey), {
      chat: { enabled: false, endpoints: [{ id: "ep1", ...OPENAI, models: [{ id: "m", name: "M" }], api_key: "sk-chat-key" }] },
    });
    expect(res?.status).toBe(200);
    const written = upsert.mock.calls[0]?.[1] as { embedApiKeyFp: string | null };
    expect(written.embedApiKeyFp).toBeNull();
  });

  it("refuses a provider that offers no model, since it could run nothing", async () => {
    const res = await put(ctx(), { chat: { endpoints: [{ id: "ep1", ...OPENAI, models: [] }] } });
    expect(res?.status).toBe(400);
    const body = (await res!.json()) as { error: string };
    expect(body.error).toContain("at least one model");
    expect(upsert).not.toHaveBeenCalled();
  });

  it("refuses a body that carries nothing to save", async () => {
    const res = await put(ctx(), {});
    expect(res?.status).toBe(400);
    expect(upsert).not.toHaveBeenCalled();
  });
});

describe("GET /api/node/ai-settings", () => {
  it("serves the provider base URLs the page offers as defaults", async () => {
    const req = new Request("http://node.test/api/node/ai-settings");
    const res = await routeWorkspaceRequest(ctx(), req);
    const body = (await res?.json()) as Record<string, unknown>;
    expect(body.provider_base_urls).toEqual(BASE_URLS);
  });
});

describe("PUT /api/node/ai-settings: search strictness", () => {
  let dataDir: string;
  let row: NodeAiSettingsRow | null;
  let store: AiSettingsStore;

  /** A node administrator whose settings store reads the row the route writes. */
  const admin = (): Ctx => {
    const c = ctx();
    (c.env as { aiSettings: AiSettingsStore }).aiSettings = store;
    (c.env as { dataDir: string }).dataDir = dataDir;
    return c;
  };
  /** Embeddings stay off, so a save makes no outbound probe. */
  const saveEmbed = (fields: Record<string, unknown>) =>
    put(admin(), { embed: { provider: "ollama", base_url: "", model: "", ...fields } });

  beforeEach(async () => {
    upsert.mockClear();
    dataDir = mkdtempSync(join(tmpdir(), "stuga-ai-cutoffs-"));
    row = null;
    getRow.mockImplementation(async () => row);
    upsert.mockImplementation(async (_sql: unknown, input: Record<string, unknown>) => {
      row = {
        chat_enabled: input.chatEnabled,
        embed_enabled: input.embedEnabled,
        chat_default_model: input.chatDefaultModel,
        chat_endpoints: input.chatEndpoints,
        embed_provider: input.embedProvider,
        embed_base_url: input.embedBaseUrl,
        embed_model: input.embedModel,
        embed_api_key_fp: input.embedApiKeyFp,
        search_strictness: input.searchStrictness,
        rerank_enabled: input.rerankEnabled,
        rerank_base_url: input.rerankBaseUrl,
        rerank_model: input.rerankModel,
        rerank_api_key_fp: input.rerankApiKeyFp,
        updated_by: input.updatedBy,
        updated_at: new Date(),
      } as NodeAiSettingsRow;
    });
    store = await createAiSettingsStore({ sql: {} as never, dataDir, embeddingDims: 1024, baseUrls: BASE_URLS });
  });
  afterEach(() => {
    getRow.mockImplementation(async () => null);
    upsert.mockImplementation(async () => {});
    rmSync(dataDir, { recursive: true, force: true });
  });

  it.each(["medium", "custom", 3, true])("refuses a strictness of %j", async (value) => {
    const res = await saveEmbed({ search_strictness: value });
    expect(res?.status).toBe(400);
    expect(((await res!.json()) as { error: string }).error).toBe("embed.search_strictness must be strict, balanced, loose or off");
    expect(upsert).not.toHaveBeenCalled();
  });

  it("serves an unset level as null beside the default, and keeps it unset through a save that sends it back", async () => {
    const get = async () =>
      (await (await routeWorkspaceRequest(admin(), new Request("http://node.test/api/node/ai-settings")))!.json()) as {
        embed: Record<string, unknown>;
        strictness_default: unknown;
      };
    const first = await get();
    expect(first.embed).toMatchObject({ search_strictness: null, cutoff: null, calibration: null });
    expect(first.embed).not.toHaveProperty("search_max_distance");
    expect(first.embed).not.toHaveProperty("retrieval_max_distance");
    expect(first.strictness_default).toBe("balanced");

    await saveEmbed({ search_strictness: first.embed.search_strictness });
    expect(row).toMatchObject({ search_strictness: null });
  });

  it("stores a level, keeps it through a save that leaves it out, and restores the default for null", async () => {
    await saveEmbed({ search_strictness: "loose" });
    expect(row).toMatchObject({ search_strictness: "loose" });
    await saveEmbed({});
    await put(admin(), { chat: { endpoints: [] } });
    expect(row).toMatchObject({ search_strictness: "loose" });
    await saveEmbed({ search_strictness: null });
    expect(row).toMatchObject({ search_strictness: null });
  });

  it("starts measuring after a save of semantic search, as the admin who saved", async () => {
    calibrator.ensure.mockClear();
    await saveEmbed({ search_strictness: "strict" });
    expect(calibrator.ensure).toHaveBeenCalledWith({ alias: "admin-1" });
    calibrator.ensure.mockClear();
    await put(admin(), { chat: { endpoints: [] } });
    expect(calibrator.ensure).not.toHaveBeenCalled();
  });
});

describe("POST /api/node/ai-settings/calibrate and Reset", () => {
  const call = (c: Ctx, method: string, path: string) => routeWorkspaceRequest(c, new Request(`http://node.test${path}`, { method }));

  it("measures again on request, and says so when semantic search is off", async () => {
    calibrator.ensure.mockClear();
    const off = await call(ctx(), "POST", "/api/node/ai-settings/calibrate");
    expect(off?.status).toBe(409);
    expect(calibrator.ensure).not.toHaveBeenCalled();

    const on = await call(ctx({ ...EMPTY_AI, enabled: true, embed: { ...EMPTY_AI.embed, enabled: true } }), "POST", "/api/node/ai-settings/calibrate");
    expect(on?.status).toBe(202);
    expect(calibrator.ensure).toHaveBeenCalledWith({ alias: "admin-1", force: true });
  });

  it("forgets every measurement on Reset", async () => {
    const clear = clearEmbedCalibrations as unknown as ReturnType<typeof vi.fn>;
    clear.mockClear();
    const res = await call(ctx(), "DELETE", "/api/node/ai-settings");
    expect(res?.status).toBe(200);
    expect(clear).toHaveBeenCalledTimes(1);
  });
});

describe("each half's switch", () => {
  let dataDir: string;
  let row: NodeAiSettingsRow | null;
  let store: AiSettingsStore;

  const admin = (): Ctx => {
    const c = ctx();
    (c.env as { aiSettings: AiSettingsStore }).aiSettings = store;
    (c.env as { dataDir: string }).dataDir = dataDir;
    return c;
  };
  const get = async () =>
    (await (await routeWorkspaceRequest(admin(), new Request("http://node.test/api/node/ai-settings")))!.json()) as {
      chat: { enabled: boolean; running: boolean; default_model: string; endpoints: Array<{ id: string }> };
      embed: { enabled: boolean; running: boolean };
      rerank: { enabled: boolean; running: boolean; base_url: string; model: string; api_key_set: boolean };
    };

  beforeEach(async () => {
    upsert.mockClear();
    dataDir = mkdtempSync(join(tmpdir(), "stuga-ai-pause-"));
    row = null;
    getRow.mockImplementation(async () => row);
    upsert.mockImplementation(async (_sql: unknown, input: Record<string, unknown>) => {
      row = {
        chat_enabled: input.chatEnabled,
        embed_enabled: input.embedEnabled,
        chat_default_model: input.chatDefaultModel,
        chat_endpoints: input.chatEndpoints,
        embed_provider: input.embedProvider,
        embed_base_url: input.embedBaseUrl,
        embed_model: input.embedModel,
        embed_api_key_fp: input.embedApiKeyFp,
        search_strictness: input.searchStrictness,
        rerank_enabled: input.rerankEnabled,
        rerank_base_url: input.rerankBaseUrl,
        rerank_model: input.rerankModel,
        rerank_api_key_fp: input.rerankApiKeyFp,
        updated_by: input.updatedBy,
        updated_at: new Date(),
      } as NodeAiSettingsRow;
    });
    store = await createAiSettingsStore({ sql: {} as never, dataDir, embeddingDims: 1024, baseUrls: BASE_URLS });
  });
  afterEach(() => {
    getRow.mockImplementation(async () => null);
    upsert.mockImplementation(async () => {});
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("serves a node nobody configured with both halves switched on and neither running", async () => {
    expect(await get()).toMatchObject({
      chat: { enabled: true, running: false, default_model: "", endpoints: [] },
      embed: { enabled: true, running: false },
    });
  });

  it("switches chat off and on with its providers kept, never probing an unchanged one", async () => {
    const provider = { id: "ep1", ...OPENAI, models: [{ id: "m", name: "M" }] };
    expect((await put(admin(), { chat: { enabled: false, default_model: "m", endpoints: [provider] } }))?.status).toBe(200);
    expect(await get()).toMatchObject({ chat: { enabled: false, running: false, default_model: "m", endpoints: [{ id: "ep1" }] } });

    expect((await put(admin(), { chat: { enabled: true, default_model: "m", endpoints: [provider] } }))?.status).toBe(200);
    expect(row).toMatchObject({ chat_enabled: true, chat_default_model: "m" });
    expect(await get()).toMatchObject({ chat: { enabled: true, running: true, default_model: "m" } });
  });

  it("forgets a half's switch when the half is removed, so setting it up again turns it on", async () => {
    const provider = { id: "ep1", ...OPENAI, models: [{ id: "m", name: "M" }] };
    await put(admin(), { chat: { enabled: false, default_model: "m", endpoints: [provider] } });
    expect((await put(admin(), { chat: { enabled: false, endpoints: [] } }))?.status).toBe(200);
    expect(row).toMatchObject({ chat_enabled: null });
    expect((await get()).chat).toMatchObject({ enabled: true, endpoints: [] });

    expect((await put(admin(), { embed: { enabled: false, provider: "ollama", base_url: "", model: "" } }))?.status).toBe(200);
    expect(row).toMatchObject({ embed_enabled: null, embed_model: null });
  });

  it("deletes a removed provider's key and keeps the others'", async () => {
    const one = { id: "ep1", ...OPENAI, models: [{ id: "m1", name: "M1" }] };
    const two = { id: "ep2", ...OPENAI, models: [{ id: "m2", name: "M2" }] };
    const keyFile = (id: string) => join(dataDir, "secrets", `ai-chat-${id}`);
    await put(admin(), { chat: { enabled: false, default_model: "m1", endpoints: [{ ...one, api_key: "k1" }, { ...two, api_key: "k2" }] } });
    expect(existsSync(keyFile("ep1"))).toBe(true);

    expect((await put(admin(), { chat: { enabled: false, default_model: "m2", endpoints: [two] } }))?.status).toBe(200);
    expect(existsSync(keyFile("ep1"))).toBe(false);
    expect(readFileSync(keyFile("ep2"), "utf8").trim()).toBe("k2");

    // A save that leaves chat out leaves its keys alone. (Embeddings follow the first chat provider.)
    expect((await put(admin(), { embed: { enabled: false, provider: "openai", base_url: "", model: "" } }))?.status).toBe(200);
    expect(existsSync(keyFile("ep2"))).toBe(true);
  });

  describe("the reranker", () => {
    const JEV = { base_url: "https://api.typesafe.test/v1", model: "jev-latest" };
    /** A System One endpoint that answers, or refuses with `status`; records each request. */
    const systemOne = (status = 200) => {
      const calls: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          calls.push(String(url));
          return status === 200
            ? new Response(JSON.stringify({ model: "jev-1.13.0", answers: { ok: { type: "noul", noul: 0.9 } } }), { status })
            : new Response("invalid api key", { status });
        }),
      );
      return calls;
    };
    afterEach(() => vi.unstubAllGlobals());

    it("is set up by a model, where to reach it and a key, probed before it is saved", async () => {
      const calls = systemOne();
      expect((await put(admin(), { rerank: { ...JEV, api_key: "ts-key" } }))?.status).toBe(200);
      expect(calls).toEqual(["https://api.typesafe.test/v1/systemone"]);
      expect(row).toMatchObject({ rerank_enabled: null, rerank_model: "jev-latest", rerank_base_url: JEV.base_url });
      expect(row?.rerank_api_key_fp).toMatch(/^[0-9a-f]{8}$/);
      expect(readFileSync(join(dataDir, "secrets", "ai-rerank"), "utf8").trim()).toBe("ts-key");
      expect((await get()).rerank).toMatchObject({ enabled: true, running: true, model: "jev-latest", api_key_set: true });
      expect(store.current().rerank).toMatchObject({ enabled: true, apiKey: "ts-key" });
    });

    it("refuses a model with nowhere to reach it", async () => {
      const res = await put(admin(), { rerank: { model: "jev-latest", api_key: "ts-key" } });
      expect(res?.status).toBe(400);
      expect(upsert).not.toHaveBeenCalled();
    });

    it("writes nothing when the probe fails", async () => {
      systemOne(401);
      const res = await put(admin(), { rerank: { ...JEV, api_key: "wrong" } });
      expect(res?.status).toBe(422);
      expect(await res?.json()).toMatchObject({ stage: "rerank", message: expect.stringContaining("invalid api key") });
      expect(upsert).not.toHaveBeenCalled();
    });

    it("switches off with its setup kept, without probing it again", async () => {
      systemOne();
      await put(admin(), { rerank: { ...JEV, api_key: "ts-key" } });
      const calls = systemOne();
      expect((await put(admin(), { rerank: { ...JEV, enabled: false } }))?.status).toBe(200);
      expect(calls).toEqual([]);
      expect((await get()).rerank).toMatchObject({ enabled: false, running: false, model: "jev-latest", api_key_set: true });
    });

    it("is removed by clearing its model, which forgets its key", async () => {
      systemOne();
      await put(admin(), { rerank: { ...JEV, api_key: "ts-key" } });
      expect((await put(admin(), { rerank: { model: "" } }))?.status).toBe(200);
      expect(row).toMatchObject({ rerank_enabled: null, rerank_model: null, rerank_base_url: null, rerank_api_key_fp: null });
      expect(existsSync(join(dataDir, "secrets", "ai-rerank"))).toBe(false);
      expect((await get()).rerank).toMatchObject({ enabled: true, running: false, api_key_set: false });
    });
  });
});
