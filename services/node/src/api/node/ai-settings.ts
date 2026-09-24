/** `/api/node/ai-settings`: the model endpoints and keys, their probes, and provider model lists. */
import {
  type AiConfig,
  type AiModelChoice,
  type AiProvider,
  type ChatEndpoint,
  embed,
  listModels,
  resolveModel,
  streamTurn,
} from "@stuga/ai";
import { sha256Hex } from "@stuga/auth";
import {
  type StoredChatEndpoint,
  armEmbeddingBackfillAll,
  clearAllChunkEmbeddings,
  clearNodeAiSettings,
  getNodeAiSettings,
  upsertNodeAiSettings,
} from "@stuga/db";
import { nodeAuditCtx, recordAudit } from "../../audit/record.js";
import type { Ctx } from "../../auth/context.js";
import { readSecretFile, removeSecretFile, writeSecretFile } from "../../config/secrets.js";
import {
  type AiStoredSettings,
  EMBED_KEY_FILE,
  MAX_DISTANCE_DEFAULTS,
  chatKeyFile,
  isMaxDistance,
  resolveAi,
} from "../../config/settings/ai.js";
import { error, json } from "../../http/respond.js";
import type { WorkspaceCall } from "../../http/router.js";

interface CandidateBody {
  candidate: AiConfig;
  stored: AiStoredSettings;
  /** Per chat endpoint id, the same 3-state key contract embed has:
   *  undefined = leave the stored key alone, null = delete it, a string = replace it. */
  chatKeys: Array<{ id: string; key: string | null | undefined }>;
  embedKey: string | null | undefined;
  /** Which halves the request carried; an omitted half is left exactly as stored. */
  sent: { chat: boolean; embed: boolean };
}

const PROVIDERS = new Set<AiProvider>(["anthropic", "openai", "ollama"]);

/** An absolute http(s) base URL without trailing slashes; the path (`/v1`) is kept. Undefined when invalid. */
function cleanBaseUrl(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || (typeof v === "string" && v.trim() === "")) return null;
  if (typeof v !== "string") return undefined;
  try {
    const u = new URL(v.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
  } catch {
    return undefined;
  }
  return v.trim().replace(/\/+$/, "");
}

function cleanModels(v: unknown): AiModelChoice[] | null {
  if (!Array.isArray(v)) return null;
  const seen = new Set<string>();
  const out: AiModelChoice[] = [];
  for (const raw of v) {
    const o = raw as { id?: unknown; name?: unknown };
    const id = typeof o?.id === "string" ? o.id.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: (typeof o?.name === "string" && o.name.trim()) || id });
  }
  return out;
}

function str(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || (typeof v === "string" && v.trim() === "")) return null;
  return typeof v === "string" ? v.trim() : undefined;
}

/**
 * Shape-check the body and merge it into the configuration it WOULD produce, so
 * the probes below run against exactly what a save would put in force.
 */
async function parseCandidate(ctx: Ctx, req: Request): Promise<CandidateBody | { error: string; status: number }> {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return { error: "expected a JSON object", status: 400 };
  // An omitted half is taken from the stored row, never reset to provider defaults.
  const sent = { chat: body.chat !== undefined, embed: body.embed !== undefined };
  if (!sent.chat && !sent.embed) return { error: "nothing to save: send chat, embed, or both", status: 400 };
  const chat = (body.chat ?? {}) as Record<string, unknown>;
  const embed_ = (body.embed ?? {}) as Record<string, unknown>;

  const embedProvider = str(embed_.provider);
  if (embedProvider && !PROVIDERS.has(embedProvider as AiProvider)) {
    return { error: `unknown embed provider "${embedProvider}"`, status: 400 };
  }
  if (embedProvider === "anthropic") {
    return {
      error: "the anthropic provider serves no embeddings endpoint; point embed at an OpenAI-compatible or Ollama endpoint",
      status: 400,
    };
  }
  const embedBaseUrl = cleanBaseUrl(embed_.base_url);
  if (embedBaseUrl === undefined && embed_.base_url !== undefined) return { error: "embed.base_url must be an absolute http(s) URL", status: 400 };
  // A cutoff left out keeps the stored one, and null restores the default.
  for (const field of ["search_max_distance", "retrieval_max_distance"]) {
    const v = embed_[field];
    if (v !== undefined && v !== null && !isMaxDistance(v)) {
      return { error: `embed.${field} must be a number greater than 0 and at most 2`, status: 400 };
    }
  }

  // ---- chat: a list of endpoints, each validated on its own ----
  const rawEndpoints = Array.isArray(chat.endpoints) ? chat.endpoints : [];
  const parsedEndpoints: Array<{ id: string; provider: AiProvider; baseUrl: string; models: AiModelChoice[]; apiKey: string | null | undefined }> = [];
  for (let i = 0; i < rawEndpoints.length; i++) {
    const o = rawEndpoints[i] as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id.trim() : "";
    if (!id) return { error: `chat.endpoints[${i}] is missing an id`, status: 400 };
    const provider = str(o.provider);
    if (!provider || !PROVIDERS.has(provider as AiProvider)) {
      return { error: `chat.endpoints[${i}]: unknown provider "${provider}"`, status: 400 };
    }
    const baseUrl = cleanBaseUrl(o.base_url);
    if (baseUrl === undefined && o.base_url !== undefined) return { error: `chat.endpoints[${i}].base_url must be an absolute http(s) URL`, status: 400 };
    if (!baseUrl) return { error: `chat.endpoints[${i}].base_url is required`, status: 400 };
    const models = cleanModels(o.models) ?? [];
    parsedEndpoints.push({ id, provider: provider as AiProvider, baseUrl, models, apiKey: o.api_key === undefined ? undefined : str(o.api_key) });
  }

  // Model ids are one namespace across endpoints: the picker sends only the id.
  const owner = new Map<string, string>();
  for (const ep of parsedEndpoints) {
    for (const m of ep.models) {
      const clash = owner.get(m.id);
      if (clash && clash !== ep.id) {
        return {
          error: `model id "${m.id}" is offered by more than one chat endpoint (${clash} and ${ep.id}) — model ids must be unique across every endpoint`,
          status: 400,
        };
      }
      owner.set(m.id, ep.id);
    }
  }

  // No providers is how chat is disconnected, so only a saved provider needs a model.
  const defaultModel = parsedEndpoints.length > 0 ? str(chat.default_model) : null;
  const chatWillRun = sent.chat && chat.enabled !== false && parsedEndpoints.length > 0;
  const anyModel = parsedEndpoints.some((e) => e.models.length > 0);
  if (chatWillRun && !anyModel) {
    return { error: "a chat provider must offer at least one model", status: 400 };
  }
  if (chatWillRun && defaultModel && !owner.has(defaultModel)) {
    return { error: `the default model "${defaultModel}" is not offered by any configured endpoint`, status: 400 };
  }

  // undefined = leave the stored key alone; null = delete it; a string = replace.
  const embedKey = !sent.embed || embed_.api_key === undefined ? undefined : str(embed_.api_key);
  const chatKeys = parsedEndpoints.map((e) => ({ id: e.id, key: e.apiKey }));

  const row = await getNodeAiSettings(ctx.sql);
  // "Keep" means the key file: the resolved config may carry a key inherited from the first chat endpoint.
  const keptEmbed = embedKey === undefined ? readSecretFile(ctx.env.dataDir, EMBED_KEY_FILE) : embedKey;

  // The live endpoints, with their keys: what "keep this key" and an omitted chat half keep.
  const liveChat = ctx.env.aiSettings.current().chat.endpoints;
  const liveChatById = new Map(liveChat.map((e) => [e.id, e]));
  const finalEndpoints: ChatEndpoint[] = parsedEndpoints.map((e) => {
    const keptKey = e.apiKey === undefined ? liveChatById.get(e.id)?.apiKey ?? null : e.apiKey;
    const ep: ChatEndpoint = { id: e.id, provider: e.provider, baseUrl: e.baseUrl, models: e.models };
    if (keptKey) ep.apiKey = keptKey;
    return ep;
  });
  // Null when nothing is stored, so an embed-only save never writes the bootstrap endpoint.
  const untouchedChatEndpoints: ChatEndpoint[] | null = row?.chat_endpoints && row.chat_endpoints.length > 0 ? liveChat : null;

  // No providers is how chat is removed, and no model how semantic search is. A
  // removed half has no switch to leave off: it runs again once set up again.
  const embedModel = sent.embed ? (str(embed_.model) ?? null) : (row?.embed_model ?? null);
  const stored: AiStoredSettings = {
    chatEnabled: sent.chat
      ? parsedEndpoints.length === 0
        ? null
        : typeof chat.enabled === "boolean"
          ? chat.enabled
          : (row?.chat_enabled ?? null)
      : (row?.chat_enabled ?? null),
    chatDefaultModel: sent.chat ? (defaultModel ?? null) : (row?.chat_default_model ?? null),
    chatEndpoints: sent.chat ? finalEndpoints : untouchedChatEndpoints,

    embedEnabled: sent.embed
      ? !embedModel
        ? null
        : typeof embed_.enabled === "boolean"
          ? embed_.enabled
          : (row?.embed_enabled ?? null)
      : (row?.embed_enabled ?? null),
    embedProvider: sent.embed ? ((embedProvider as AiProvider | null) ?? null) : ((row?.embed_provider as AiProvider | null) ?? null),
    embedBaseUrl: sent.embed ? (embedBaseUrl ?? null) : (row?.embed_base_url ?? null),
    embedApiKey: keptEmbed,
    embedModel,
    searchMaxDistance:
      embed_.search_max_distance === undefined ? (row?.search_max_distance ?? null) : (embed_.search_max_distance as number | null),
    retrievalMaxDistance:
      embed_.retrieval_max_distance === undefined ? (row?.retrieval_max_distance ?? null) : (embed_.retrieval_max_distance as number | null),
  };

  // The width is the column's, never the request's.
  const candidate = resolveAi(stored, ctx.env.embeddingDims, ctx.env.aiProviderBaseUrls);
  return { candidate, stored, chatKeys, embedKey, sent };
}

interface ChatEndpointProbeResult {
  id: string;
  ok: boolean;
  model?: string;
  latency_ms?: number;
  message?: string;
  skipped?: boolean;
}

interface ProbeResult {
  ok: boolean;
  chat: ChatEndpointProbeResult[];
  embed: { ok: boolean; model?: string; dims?: number; message?: string; skipped?: boolean };
}

/** Which parts of the configuration a save is actually changing. */
interface Changed {
  /** ids of chat endpoints this save adds or modifies in a probe-relevant way
   *  (provider, base URL, or key) — an untouched or removed endpoint is
   *  absent, since there is nothing new to verify about it. */
  chatEndpointIds: string[];
  embed: boolean;
}

function whatChanged(before: AiConfig, after: AiConfig): Changed {
  const beforeById = new Map(before.chat.endpoints.map((e) => [e.id, e]));
  const chatEndpointIds = after.chat.endpoints
    .filter((e) => {
      const b = beforeById.get(e.id);
      return !b || b.provider !== e.provider || b.baseUrl !== e.baseUrl || b.apiKey !== e.apiKey;
    })
    .map((e) => e.id);
  return {
    chatEndpointIds,
    embed:
      before.embed.provider !== after.embed.provider ||
      before.embed.baseUrl !== after.embed.baseUrl ||
      before.embed.model !== after.embed.model ||
      before.embed.apiKey !== after.embed.apiKey,
  };
}

/**
 * Call every endpoint that needs verifying. The embed probe relies on embed()
 * asserting each vector against the column width, so a model whose vectors the
 * column would reject is refused before it is saved.
 */
async function probeEndpoints(
  candidate: AiConfig,
  only: Changed = { chatEndpointIds: candidate.chat.endpoints.map((e) => e.id), embed: true },
): Promise<ProbeResult> {
  const out: ProbeResult = { ok: false, chat: [], embed: { ok: false } };
  if (!candidate.embed.enabled) out.embed = { ok: true, skipped: true, message: "embeddings are off" };
  const probeEmbed = only.embed && candidate.embed.enabled;
  if (!candidate.enabled) return { ...out, ok: true };

  // Only what `only` names: an untouched endpoint is in force either way, and
  // must not block an unrelated save. "Test connection" probes everything.
  if (!candidate.chat.enabled) {
    out.chat = candidate.chat.endpoints.map((e) => ({ id: e.id, ok: true, skipped: true, message: "chat is off" }));
  } else {
    for (const ep of candidate.chat.endpoints) {
      if (!only.chatEndpointIds.includes(ep.id)) {
        out.chat.push({ id: ep.id, ok: true, skipped: true });
        continue;
      }
      if (ep.models.length === 0) {
        out.chat.push({ id: ep.id, ok: true, skipped: true, message: "no models configured for this endpoint yet" });
        continue;
      }
      // A single-endpoint config, so one broken endpoint never fails another's probe.
      const probeCfg: AiConfig = { ...candidate, chat: { enabled: true, defaultModel: ep.models[0]!.id, endpoints: [ep] } };
      const started = Date.now();
      try {
        const gen = streamTurn(probeCfg, {
          modelId: resolveModel(probeCfg),
          messages: [{ role: "user", content: [{ text: "ping" }] }],
          maxTokens: 1,
        });
        // One delta proves endpoint, key and model; the generator is closed, not drained.
        await gen.next();
        await gen.return(undefined as never).catch(() => undefined);
        out.chat.push({ id: ep.id, ok: true, model: ep.models[0]!.id, latency_ms: Date.now() - started });
      } catch (e) {
        out.chat.push({ id: ep.id, ok: false, model: ep.models[0]!.id, message: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  if (!probeEmbed) {
    if (candidate.embed.enabled) out.embed = { ok: true, skipped: true, model: candidate.embed.model };
  } else {
    try {
      const res = await embed(candidate, ["stuga embedding width probe"]);
      const dims = res.embeddings[0]?.length ?? 0;
      out.embed = { ok: true, model: candidate.embed.model, dims };
    } catch (e) {
      // No `dims`: the width was not observed, and @stuga/ai's message names both numbers.
      out.embed = { ok: false, model: candidate.embed.model, message: e instanceof Error ? e.message : String(e) };
    }
  }

  out.ok = out.chat.every((c) => c.ok) && out.embed.ok;
  return out;
}

function fingerprint(key: string): string {
  return sha256Hex(key).slice(0, 8);
}

async function aiSettingsResponse(ctx: Ctx): Promise<Response> {
  const row = await getNodeAiSettings(ctx.sql);
  const ai = ctx.env.aiSettings.current();
  const keys = ctx.env.aiSettings.secrets();

  // Each switch reads back as saved; `running` is what is in force.
  const savedEndpoints = (row?.chat_endpoints?.length ?? 0) > 0;
  return json({
    chat: {
      enabled: row?.chat_enabled !== false,
      running: ai.chat.enabled,
      default_model: ai.chat.defaultModel,
      // Only saved providers: the bootstrap endpoint is a default, not a connection.
      endpoints: (savedEndpoints ? ai.chat.endpoints : []).map((e) => ({
        id: e.id,
        provider: e.provider,
        base_url: e.baseUrl,
        models: e.models,
        api_key_set: keys.chat[e.id]?.set ?? false,
        api_key_fingerprint: keys.chat[e.id]?.fingerprint ?? null,
        api_key_stale: keys.chat[e.id]?.stale ?? false,
      })),
    },
    embed: {
      enabled: row?.embed_enabled !== false,
      running: ai.embed.enabled,
      provider: ai.embed.provider,
      base_url: ai.embed.baseUrl,
      model: ai.embed.model,
      api_key_set: keys.embed.set,
      api_key_fingerprint: keys.embed.fingerprint,
      api_key_stale: keys.embed.stale,
      // What is stored, so a form that sends it back leaves an unset cutoff following the default.
      search_max_distance: row?.search_max_distance ?? null,
      retrieval_max_distance: row?.retrieval_max_distance ?? null,
    },
    embedding_column_dims: ctx.env.embeddingDims,
    // What each cutoff is when none is stored.
    max_distance_defaults: MAX_DISTANCE_DEFAULTS,
    // Where each provider listens when a base URL is left empty.
    provider_base_urls: ctx.env.aiProviderBaseUrls,
    updated_by: row?.updated_by ?? null,
    updated_at: row?.updated_at ?? null,
  });
}

async function saveAiSettings(ctx: Ctx, req: Request): Promise<Response> {
  const parsed = await parseCandidate(ctx, req);
  if ("error" in parsed) return error(parsed.status, parsed.error);
  const { candidate, stored, chatKeys, embedKey, sent } = parsed;

  const before = ctx.env.aiSettings.current();
  const changed = whatChanged(before, candidate);
  const probe = await probeEndpoints(candidate, {
    chatEndpointIds: sent.chat ? changed.chatEndpointIds : [],
    embed: sent.embed && changed.embed,
  });
  if (!probe.ok) {
    // Nothing has been written yet.
    const failedChat = probe.chat.find((c) => !c.ok);
    const stage = failedChat ? "chat" : "embed";
    const detail = failedChat ?? probe.embed;
    return json(
      {
        error: "probe_failed",
        stage,
        endpoint_id: failedChat?.id,
        message: detail.message ?? "the endpoint did not respond as expected",
        detail: { expected_dims: ctx.env.embeddingDims, got_dims: probe.embed.dims ?? null },
      },
      { status: 422 },
    );
  }

  for (const { id, key } of chatKeys) {
    if (key === undefined) continue;
    if (key === null) removeSecretFile(ctx.env.dataDir, chatKeyFile(id));
    else writeSecretFile(ctx.env.dataDir, chatKeyFile(id), key);
  }
  // A removed endpoint's key file is left behind, inert.
  if (embedKey !== undefined) {
    if (embedKey === null) removeSecretFile(ctx.env.dataDir, EMBED_KEY_FILE);
    else writeSecretFile(ctx.env.dataDir, EMBED_KEY_FILE, embedKey);
  }

  await upsertNodeAiSettings(ctx.sql, {
    chatEnabled: stored.chatEnabled ?? null,
    embedEnabled: stored.embedEnabled ?? null,
    chatDefaultModel: stored.chatDefaultModel ?? null,
    chatEndpoints: (stored.chatEndpoints ?? []).map(
      (e): StoredChatEndpoint => ({
        id: e.id,
        provider: e.provider,
        baseUrl: e.baseUrl,
        models: e.models,
        apiKeyFp: e.apiKey ? fingerprint(e.apiKey) : null,
      }),
    ),
    embedProvider: stored.embedProvider ?? null,
    embedBaseUrl: stored.embedBaseUrl ?? null,
    embedModel: stored.embedModel ?? null,
    embedApiKeyFp: stored.embedApiKey ? fingerprint(stored.embedApiKey) : null,
    searchMaxDistance: stored.searchMaxDistance ?? null,
    retrievalMaxDistance: stored.retrievalMaxDistance ?? null,
    updatedBy: ctx.alias,
  });
  await ctx.env.aiSettings.refresh();

  // A new embedding endpoint invalidates every vector. `embed_hash` covers the
  // input, not the model, so old vectors would otherwise be reused as-is.
  const after = ctx.env.aiSettings.current();
  const embedChanged =
    sent.embed &&
    (before.embed.model !== after.embed.model ||
      before.embed.baseUrl !== after.embed.baseUrl ||
      before.embed.provider !== after.embed.provider);
  let reembed: { armed: boolean; chunks_cleared: number; workspaces: number } | null = null;
  if (embedChanged) {
    const cleared = await clearAllChunkEmbeddings(ctx.sql);
    // A removed model leaves nothing to embed with.
    const armed = after.embed.model !== "";
    const workspaces = armed ? await armEmbeddingBackfillAll(ctx.sql) : 0;
    reembed = { armed, chunks_cleared: cleared, workspaces };
  }

  recordAudit(nodeAuditCtx(ctx), {
    action: "node.ai_settings.update",
    targetKind: "node",
    targetId: ctx.env.publicOrigin,
    detail: {
      saved: [sent.chat ? "chat" : null, sent.embed ? "embed" : null].filter(Boolean),
      switched_on: { chat: stored.chatEnabled !== false, embed: stored.embedEnabled !== false },
      // Full base URLs, both sides: a repoint to a proxy would receive every prompt. No keys or fingerprints.
      chat_base_urls: { before: before.chat.endpoints.map((e) => e.baseUrl), after: after.chat.endpoints.map((e) => e.baseUrl) },
      embed_base_url: { before: before.embed.baseUrl, after: after.embed.baseUrl },
      chat_model: { before: before.chat.defaultModel, after: after.chat.defaultModel },
      embed_model: { before: before.embed.model, after: after.embed.model },
      search_max_distance: { before: before.embed.searchMaxDistance, after: after.embed.searchMaxDistance },
      retrieval_max_distance: { before: before.embed.retrievalMaxDistance, after: after.embed.retrievalMaxDistance },
      key_changed: { chat: chatKeys.filter((k) => k.key !== undefined).map((k) => k.id), embed: embedKey !== undefined },
      reembed,
    },
  });

  const settings = await (await aiSettingsResponse(ctx)).json();
  return json({ settings, probe, reembed });
}

async function resetAiSettings(ctx: Ctx): Promise<Response> {
  const before = ctx.env.aiSettings.current();
  await clearNodeAiSettings(ctx.sql);
  for (const ep of before.chat.endpoints) removeSecretFile(ctx.env.dataDir, chatKeyFile(ep.id));
  removeSecretFile(ctx.env.dataDir, EMBED_KEY_FILE);
  await ctx.env.aiSettings.refresh();
  recordAudit(nodeAuditCtx(ctx), {
    action: "node.ai_settings.reset",
    targetKind: "node",
    targetId: ctx.env.publicOrigin,
    detail: {},
  });
  return aiSettingsResponse(ctx);
}

export async function testAiSettings({ ctx, req }: WorkspaceCall): Promise<Response> {
  const parsed = await parseCandidate(ctx, req);
  if ("error" in parsed) return error(parsed.status, parsed.error);
  const probe = await probeEndpoints(parsed.candidate);
  recordAudit(nodeAuditCtx(ctx), {
    action: "node.ai_settings.test",
    targetKind: "node",
    targetId: ctx.env.publicOrigin,
    // An outbound request to URLs of the caller's choosing is recorded like a change.
    detail: {
      chat_base_urls: parsed.candidate.chat.endpoints.map((e) => e.baseUrl),
      embed_base_url: parsed.candidate.embed.baseUrl,
      ok: probe.ok,
    },
  });
  // A failed probe answers the question the button asked: 200 with ok:false.
  return json(probe);
}

/** The models a provider endpoint offers, so an administrator need not recall exact ids. */
export async function listProviderModels({ ctx, req }: WorkspaceCall): Promise<Response> {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return error(400, "expected a JSON object");
  const provider = typeof body.provider === "string" ? body.provider : "";
  if (!PROVIDERS.has(provider as AiProvider)) return error(400, `unknown provider "${provider}"`);
  const baseUrl = cleanBaseUrl(body.base_url);
  if (baseUrl === undefined && body.base_url !== undefined) {
    return error(400, "base_url must be an absolute http(s) URL");
  }
  const live = ctx.env.aiSettings.current();
  const kind: "chat" | "embed" = body.which === "embed" ? "embed" : "chat";
  const resolvedBaseUrl = baseUrl ?? ctx.env.aiProviderBaseUrls[provider as AiProvider];
  // No endpoint id is sent: a chat lookup reuses the key of the saved endpoint with this provider and base URL.
  const fallbackKey =
    kind === "embed" ? live.embed.apiKey : live.chat.endpoints.find((e) => e.provider === provider && e.baseUrl === resolvedBaseUrl)?.apiKey;
  const key = typeof body.api_key === "string" && body.api_key.trim() ? body.api_key.trim() : fallbackKey;
  try {
    const models = await listModels(
      {
        provider: provider as AiProvider,
        baseUrl: resolvedBaseUrl,
        ...(key ? { apiKey: key } : {}),
      },
      kind,
    );
    return json({ models });
  } catch (e) {
    // Not every OpenAI-compatible server lists models; the id can still be typed.
    return json({ models: [], message: e instanceof Error ? e.message : String(e) });
  }
}

export async function getAiSettingsRoute({ ctx }: WorkspaceCall): Promise<Response> {
  return aiSettingsResponse(ctx);
}

export async function saveAiSettingsRoute({ ctx, req }: WorkspaceCall): Promise<Response> {
  return saveAiSettings(ctx, req);
}

export async function resetAiSettingsRoute({ ctx }: WorkspaceCall): Promise<Response> {
  return resetAiSettings(ctx);
}
