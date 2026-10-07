/**
 * The AI configuration in force: the node_ai_settings row, its key files, and
 * the provider defaults for whatever the row leaves unset.
 */
import { type AiConfig, type AiProvider, type CalibrationResult, type ChatEndpoint, type SearchCutoff, calibrationKey, levelCutoff } from "@stuga/ai";
import { type EmbedCalibrationRow, getNodeAiSettings, listEmbedCalibrations, type Sql, type StoredChatEndpoint } from "@stuga/db";
import { DEFAULT_SEARCH_STRICTNESS, type SearchStrictness } from "@stuga/protocol/domain/search-strictness";
import { readSecretFile } from "../secrets.js";
import { createSettingsStore, type SettingsStore } from "./store.js";

/** Filenames under <DATA_DIR>/secrets. */
export const EMBED_KEY_FILE = "ai-embed";
export const RERANK_KEY_FILE = "ai-rerank";

export function chatKeyFile(endpointId: string): string {
  return `ai-chat-${endpointId}`;
}

/** Id of the blank Ollama endpoint a node offers before any is stored. */
const BOOTSTRAP_CHAT_ENDPOINT_ID = "default";

export type ProviderBaseUrls = Readonly<Record<AiProvider, string>>;

interface KeyState {
  set: boolean;
  fingerprint: string | null;
  /** The row records a key but the file is gone: restored without its data directory. */
  stale: boolean;
}

interface AiSecretState {
  /** Per stored chat endpoint id. */
  chat: Record<string, KeyState>;
  embed: KeyState;
  rerank: KeyState;
}

export type AiSettingsStore = SettingsStore<AiConfig, AiSecretState>;

/** What the settings row supplies, already parsed, with keys read from their files. Null means "not set". */
export interface AiStoredSettings {
  /** False switches chat off while its providers stay saved. */
  chatEnabled?: boolean | null;
  /** False switches semantic search off while its model stays set. */
  embedEnabled?: boolean | null;
  chatDefaultModel?: string | null;
  chatEndpoints?: ChatEndpoint[] | null;
  embedProvider?: AiProvider | null;
  embedBaseUrl?: string | null;
  embedApiKey?: string | null;
  embedModel?: string | null;
  /** The search box's level. */
  searchStrictness?: SearchStrictness | null;
  /** False switches the reranker off while it stays set up. */
  rerankEnabled?: boolean | null;
  rerankBaseUrl?: string | null;
  rerankModel?: string | null;
  rerankApiKey?: string | null;
}

const trimSlash = (s: string): string => s.replace(/\/+$/, "");

/** Where the search box's cutoff comes from right now. */
export type CutoffSource = "measured" | "off" | "measuring" | "unmeasured";

/**
 * The search box's cutoff in force: the level's distances from the measurement of the model in
 * force, or nothing. An earlier result stays in force while the same model is measured again; with
 * none, nothing is dropped by distance, rather than borrowing another model's number.
 */
export function searchCutoffInForce(
  strictness: SearchStrictness | null | undefined,
  calibration: EmbedCalibrationRow | null | undefined,
): { level: SearchStrictness; source: CutoffSource; cutoff: SearchCutoff | null } {
  const level = strictness ?? DEFAULT_SEARCH_STRICTNESS;
  if (level === "off") return { level, source: "off", cutoff: null };
  if (calibration?.result) return { level, source: "measured", cutoff: levelCutoff(calibration.result as unknown as CalibrationResult, level) };
  return { level, source: calibration?.state === "running" ? "measuring" : "unmeasured", cutoff: null };
}

/**
 * Settle the configuration in force: stored row, then provider default, per
 * field. `embeddingDims` is the database column's width, never a configured
 * number, so no save can disagree with the column.
 */
export function resolveAi(
  stored: AiStoredSettings | null,
  embeddingDims: number,
  baseUrls: ProviderBaseUrls,
  calibrations: ReadonlyMap<string, EmbedCalibrationRow> = new Map(),
): AiConfig {
  const st = stored ?? {};

  // Each half runs once it is configured, and its own switch turns it off while
  // keeping it: a provider that offers a model runs chat, an embedding model runs
  // semantic search. Either runs alone (chat against a vendor with no embeddings,
  // or embeddings alone for an outside agent on MCP).
  const chatSwitch = st.chatEnabled ?? true;
  const embedSwitch = st.embedEnabled ?? true;

  // The bootstrap endpoint offers no models, so a node nobody has configured
  // sends nothing anywhere.
  const saved = st.chatEndpoints && st.chatEndpoints.length > 0 ? st.chatEndpoints : null;
  const endpoints: ChatEndpoint[] = saved ?? [{ id: BOOTSTRAP_CHAT_ENDPOINT_ID, provider: "ollama", baseUrl: baseUrls.ollama, models: [] }];

  // A default no endpoint offers any more falls back to the first that one does.
  const offered = endpoints.flatMap((e) => e.models.map((m) => m.id));
  const defaultModel = st.chatDefaultModel && offered.includes(st.chatDefaultModel) ? st.chatDefaultModel : (offered[0] ?? "");

  if (chatSwitch && saved && !defaultModel) {
    console.warn(`[node] a chat provider is saved but offers no model; chat is off until one does`);
  }
  const chat: AiConfig["chat"] = { enabled: chatSwitch && defaultModel !== "", defaultModel, endpoints };

  // Embeddings follow the first chat endpoint when its protocol can serve them;
  // Anthropic cannot, so they fall back to a local Ollama.
  const primaryChat = endpoints[0];
  const embedFallback: AiProvider = primaryChat?.provider === "anthropic" ? "ollama" : (primaryChat?.provider ?? "ollama");
  const embedProvider = st.embedProvider ?? embedFallback;
  const sameAsChat = !!primaryChat && embedProvider === primaryChat.provider;
  const embedBaseUrl = trimSlash(st.embedBaseUrl ?? (sameAsChat ? primaryChat!.baseUrl : baseUrls[embedProvider]));
  const embedApiKey = st.embedApiKey ?? (sameAsChat ? primaryChat!.apiKey : undefined);
  const embedModel = st.embedModel ?? "";
  // Embedding against an empty model id would burn every chunk's bounded
  // embed_attempts on a request that cannot work.
  const embedRuns = embedSwitch && embedModel !== "";
  const embed: AiConfig["embed"] = {
    enabled: embedRuns,
    provider: embedProvider,
    baseUrl: embedBaseUrl,
    model: embedModel,
    dims: embeddingDims,
    searchCutoff: null,
  };
  if (embedApiKey !== undefined) embed.apiKey = embedApiKey;
  if (embedRuns) {
    embed.searchCutoff = searchCutoffInForce(st.searchStrictness, calibrations.get(calibrationKey({ embed }))).cutoff;
  }

  // The reranker is set up by a model and where to reach it; without one the chat model reranks.
  const rerankBaseUrl = trimSlash(st.rerankBaseUrl ?? "");
  const rerankModel = st.rerankModel ?? "";
  const rerank: AiConfig["rerank"] = {
    enabled: (st.rerankEnabled ?? true) && rerankModel !== "" && rerankBaseUrl !== "",
    baseUrl: rerankBaseUrl,
    model: rerankModel,
  };
  if (st.rerankApiKey) rerank.apiKey = st.rerankApiKey;

  // Derived "any AI at all"; each surface gates on its own part.
  return { enabled: chat.enabled || embed.enabled, chat, embed, rerank };
}

export function createAiSettingsStore(deps: {
  sql: Sql;
  dataDir: string;
  embeddingDims: number;
  baseUrls: ProviderBaseUrls;
}): Promise<AiSettingsStore> {
  return createSettingsStore(async () => {
    // A failed read rejects, so a refresh keeps the last good snapshot rather than switching AI off.
    const row = await getNodeAiSettings(deps.sql);
    const calibrations = new Map((await listEmbedCalibrations(deps.sql)).map((c) => [c.config_key, c]));

    // The key file is the truth; the column holds only a fingerprint label.
    const storedRows: StoredChatEndpoint[] = row?.chat_endpoints ?? [];
    const chat: Record<string, KeyState> = {};
    const chatEndpoints: ChatEndpoint[] = [];
    for (const e of storedRows) {
      const key = readSecretFile(deps.dataDir, chatKeyFile(e.id));
      chat[e.id] = { set: key !== null, fingerprint: e.apiKeyFp ?? null, stale: !!e.apiKeyFp && key === null };
      // Only the AI settings route writes this column, and it validates the provider.
      const ep: ChatEndpoint = { id: e.id, provider: e.provider as AiProvider, baseUrl: e.baseUrl, models: e.models };
      if (key !== null) ep.apiKey = key;
      chatEndpoints.push(ep);
    }
    const embedKey = readSecretFile(deps.dataDir, EMBED_KEY_FILE);
    const rerankKey = readSecretFile(deps.dataDir, RERANK_KEY_FILE);
    const keyState = (key: string | null, fingerprint: string | null | undefined): KeyState => ({
      set: key !== null,
      fingerprint: fingerprint ?? null,
      stale: !!fingerprint && key === null,
    });
    const secrets: AiSecretState = {
      chat,
      embed: keyState(embedKey, row?.embed_api_key_fp),
      rerank: keyState(rerankKey, row?.rerank_api_key_fp),
    };
    const staleChat = Object.values(chat).some((k) => k.stale);
    if (staleChat || secrets.embed.stale || secrets.rerank.stale) {
      console.warn("[node] an AI provider key is recorded in the database but missing from DATA_DIR/secrets", {
        chat: staleChat,
        embed: secrets.embed.stale,
        rerank: secrets.rerank.stale,
      });
    }

    const value = resolveAi(
      {
        chatEnabled: row?.chat_enabled ?? null,
        embedEnabled: row?.embed_enabled ?? null,
        chatDefaultModel: row?.chat_default_model ?? null,
        chatEndpoints: chatEndpoints.length > 0 ? chatEndpoints : null,
        embedProvider: (row?.embed_provider as AiProvider | null | undefined) ?? null,
        embedBaseUrl: row?.embed_base_url ?? null,
        embedApiKey: embedKey,
        embedModel: row?.embed_model ?? null,
        searchStrictness: row?.search_strictness ?? null,
        rerankEnabled: row?.rerank_enabled ?? null,
        rerankBaseUrl: row?.rerank_base_url ?? null,
        rerankModel: row?.rerank_model ?? null,
        rerankApiKey: rerankKey,
      },
      deps.embeddingDims,
      deps.baseUrls,
      calibrations,
    );
    return { value, secrets };
  });
}
