/**
 * PUT /api/node/ai-settings validation: model ids are one namespace across endpoints, so a shared id
 * or a default model no endpoint lists is refused before anything is written, and the semantic match
 * cutoffs are range-checked and put in force on save. A save that would run a provider is sent with
 * that half switched off, so no probe makes an outbound request.
 */
import { mkdtempSync, rmSync } from "node:fs";
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
}));

const { getNodeAiSettings, upsertNodeAiSettings } = await import("@stuga/db");
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
  embed: { enabled: false, provider: "ollama", baseUrl: "http://127.0.0.1:11434", model: "bge-m3", dims: 1024, searchMaxDistance: 0.6, retrievalMaxDistance: 0.9 },
};

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
      aiSettings: {
        current: () => ai,
        refresh: async () => {},
        secrets: () => ({ chat: {}, embed: { set: false, fingerprint: null, stale: false } }),
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

describe("PUT /api/node/ai-settings: semantic match cutoffs", () => {
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
        search_max_distance: input.searchMaxDistance,
        retrieval_max_distance: input.retrievalMaxDistance,
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

  it.each([0, -0.2, 2.5, "0.7", true])("refuses a cutoff of %j with 400 and writes nothing", async (value) => {
    for (const field of ["search_max_distance", "retrieval_max_distance"]) {
      const res = await saveEmbed({ [field]: value });
      expect(res?.status).toBe(400);
      const body = (await res?.json()) as { error: string };
      expect(body.error).toContain(`embed.${field}`);
    }
    expect(upsert).not.toHaveBeenCalled();
  });

  it("serves an unset cutoff as null beside the defaults, and keeps it unset through a save that sends it back", async () => {
    const get = async () =>
      (await (await routeWorkspaceRequest(admin(), new Request("http://node.test/api/node/ai-settings")))!.json()) as {
        embed: Record<string, unknown>;
        max_distance_defaults: unknown;
      };
    const first = await get();
    expect(first.embed).toMatchObject({ search_max_distance: null, retrieval_max_distance: null });
    expect(first.max_distance_defaults).toEqual({ search: 0.6, retrieval: 0.9 });

    await saveEmbed({ search_max_distance: first.embed.search_max_distance, retrieval_max_distance: first.embed.retrieval_max_distance });
    expect(row).toMatchObject({ search_max_distance: null, retrieval_max_distance: null });
    expect((await get()).embed).toMatchObject({ search_max_distance: null, retrieval_max_distance: null });
  });

  it("puts a saved cutoff in force at once and serves it with the defaults", async () => {
    expect(store.current().embed).toMatchObject({ searchMaxDistance: 0.6, retrievalMaxDistance: 0.9 });

    const res = await saveEmbed({ search_max_distance: 1.2, retrieval_max_distance: 2 });
    expect(res?.status).toBe(200);
    expect(upsert.mock.calls[0]?.[1]).toMatchObject({ searchMaxDistance: 1.2, retrievalMaxDistance: 2 });
    expect(store.current().embed).toMatchObject({ searchMaxDistance: 1.2, retrievalMaxDistance: 2 });

    const got = (await (await routeWorkspaceRequest(admin(), new Request("http://node.test/api/node/ai-settings")))!.json()) as {
      embed: Record<string, unknown>;
      max_distance_defaults: unknown;
    };
    expect(got.embed).toMatchObject({ search_max_distance: 1.2, retrieval_max_distance: 2 });
    expect(got.max_distance_defaults).toEqual({ search: 0.6, retrieval: 0.9 });
  });

  it("keeps a stored cutoff the request leaves out, and restores the default for null", async () => {
    await saveEmbed({ search_max_distance: 1.2, retrieval_max_distance: 1.5 });

    await saveEmbed({});
    await put(admin(), { chat: { endpoints: [] } });
    expect(store.current().embed).toMatchObject({ searchMaxDistance: 1.2, retrievalMaxDistance: 1.5 });

    await saveEmbed({ search_max_distance: null });
    expect(store.current().embed).toMatchObject({ searchMaxDistance: 0.6, retrievalMaxDistance: 1.5 });
    expect(row).toMatchObject({ search_max_distance: null, retrieval_max_distance: 1.5 });
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
        search_max_distance: input.searchMaxDistance,
        retrieval_max_distance: input.retrievalMaxDistance,
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
});
