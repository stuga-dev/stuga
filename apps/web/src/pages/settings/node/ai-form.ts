/** The AI provider form: presets, the write-only key contract, and what a save sends. */
import type { NodeAiSettings, NodeAiSettingsInput } from "../../../api";

/** What each half is called and is for, the same in Settings and at first run. */
export const HALF_COPY = {
  chat: { title: "Built-in AI", about: "The co-author, Ask and the table assistant, for every member, on your API key." },
  search: { title: "Search by meaning", about: "Finds text by meaning, not only exact words, for search, Ask and agents." },
} as const;

export const PROVIDERS = [
  { value: "openai", label: "OpenAI-compatible" },
  { value: "anthropic", label: "Anthropic" },
  { value: "ollama", label: "Ollama (local)" },
];

/** Where each protocol listens when a base URL is left empty, as the node reports it. */
export type BaseUrls = Record<string, string>;

/**
 * A vendor shortcut: it fills in one of the three wire protocols and a base URL.
 * Vendors stay out of the protocol enum. `embeddings: false` marks a chat-only vendor.
 */
export interface Preset {
  value: string;
  label: string;
  provider: string;
  baseUrl: string;
  embeddings: boolean;
}

/** The protocol entries take the node's own defaults, so a packaged node's Ollama address shows as the preset. */
export function presetsFor(base: BaseUrls): Preset[] {
  return [
    { value: "openai", label: "OpenAI", provider: "openai", baseUrl: base.openai ?? "", embeddings: true },
    { value: "anthropic", label: "Anthropic (Claude)", provider: "anthropic", baseUrl: base.anthropic ?? "", embeddings: false },
    { value: "gemini", label: "Google Gemini", provider: "openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", embeddings: true },
    { value: "cerebras", label: "Cerebras", provider: "openai", baseUrl: "https://api.cerebras.ai/v1", embeddings: false },
    { value: "deepseek", label: "DeepSeek", provider: "openai", baseUrl: "https://api.deepseek.com/v1", embeddings: false },
    { value: "fireworks", label: "Fireworks", provider: "openai", baseUrl: "https://api.fireworks.ai/inference/v1", embeddings: true },
    { value: "groq", label: "Groq", provider: "openai", baseUrl: "https://api.groq.com/openai/v1", embeddings: false },
    { value: "minimax", label: "MiniMax", provider: "anthropic", baseUrl: "https://api.minimax.io/anthropic", embeddings: false },
    { value: "mistral", label: "Mistral", provider: "openai", baseUrl: "https://api.mistral.ai/v1", embeddings: true },
    { value: "moonshot", label: "Moonshot (Kimi)", provider: "openai", baseUrl: "https://api.moonshot.ai/v1", embeddings: false },
    { value: "openrouter", label: "OpenRouter", provider: "openai", baseUrl: "https://openrouter.ai/api/v1", embeddings: false },
    { value: "qwen", label: "Qwen (Alibaba Cloud)", provider: "openai", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", embeddings: true },
    { value: "together", label: "Together", provider: "openai", baseUrl: "https://api.together.ai/v1", embeddings: true },
    { value: "xai", label: "xAI (Grok)", provider: "openai", baseUrl: "https://api.x.ai/v1", embeddings: false },
    { value: "zai", label: "Z.ai (GLM)", provider: "openai", baseUrl: "https://api.z.ai/api/paas/v4", embeddings: false },
    { value: "ollama", label: "Ollama (local)", provider: "ollama", baseUrl: base.ollama ?? "", embeddings: true },
    { value: "custom", label: "Something else…", provider: "openai", baseUrl: "", embeddings: true },
  ];
}

export function presetFor(presets: Preset[], provider: string, baseUrl: string): string {
  return presets.find((p) => p.provider === provider && p.baseUrl === baseUrl)?.value ?? "custom";
}

/** The endpoint a choice resolves to, in one line under the picker. */
export function endpointSummary(base: BaseUrls, provider: string, baseUrl: string): string {
  return `${baseUrl || base[provider] || "—"} · ${provider} protocol`;
}

/** The discovered models plus any selected one that fell out of that list, so it stays selectable. */
export function modelOptions(discovered: string[], current: string | string[]): Array<{ value: string; label: string }> {
  const currentIds = Array.isArray(current) ? current : current ? [current] : [];
  const missing = currentIds.filter((id) => !discovered.includes(id));
  return [...missing, ...discovered].map((id) => ({ value: id, label: id }));
}

/** A chat provider as the form edits it. The key is write-only, so it starts empty. */
export interface ChatEndpointForm {
  id: string;
  provider: string;
  baseUrl: string;
  /** Raw `id=Display Name` pairs: the models this endpoint offers users. */
  models: string;
  key: string;
}

/** The editable form. Keys are write-only and start empty. */
export interface Form {
  /** Each half's switch, as saved. */
  chatEnabled: boolean;
  embedEnabled: boolean;
  /** Resolved against every endpoint's models. */
  chatDefaultModel: string;
  chatEndpoints: ChatEndpointForm[];
  embedProvider: string;
  embedBaseUrl: string;
  embedModel: string;
  embedKey: string;
  /** Null follows the node's default. */
  searchMaxDistance: number | null;
  retrievalMaxDistance: number | null;
}

/** The form after one half is saved: that half as the server now has it, the other half's draft untouched. */
export function withSavedHalf(draft: Form, saved: Form, which: "chat" | "embed"): Form {
  if (which === "chat") {
    return { ...draft, chatEnabled: saved.chatEnabled, chatDefaultModel: saved.chatDefaultModel, chatEndpoints: saved.chatEndpoints };
  }
  return {
    ...draft,
    embedEnabled: saved.embedEnabled,
    embedProvider: saved.embedProvider,
    embedBaseUrl: saved.embedBaseUrl,
    embedModel: saved.embedModel,
    embedKey: saved.embedKey,
    searchMaxDistance: saved.searchMaxDistance,
    retrievalMaxDistance: saved.retrievalMaxDistance,
  };
}

export function toForm(s: NodeAiSettings): Form {
  return {
    chatEnabled: s.chat.enabled,
    embedEnabled: s.embed.enabled,
    chatDefaultModel: s.chat.default_model,
    chatEndpoints: s.chat.endpoints.map((e) => ({
      id: e.id,
      provider: e.provider,
      baseUrl: e.base_url,
      models: e.models.map((m) => (m.id === m.name ? m.id : `${m.id}=${m.name}`)).join(", "),
      key: "",
    })),
    embedProvider: s.embed.provider,
    embedBaseUrl: s.embed.base_url,
    embedModel: s.embed.model ?? "",
    embedKey: "",
    searchMaxDistance: s.embed.search_max_distance,
    retrievalMaxDistance: s.embed.retrieval_max_distance,
  };
}

/** Short and preset-derived, so it reads sensibly in the audit ledger. */
export function newEndpointId(preset: string): string {
  return `${preset}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Comma-separated `id=Display Name` pairs; a bare id names itself. */
function parseModels(raw: string, fallback: string): Array<{ id: string; name: string }> {
  const out: Array<{ id: string; name: string }> = [];
  const seen = new Set<string>();
  for (const entry of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const eq = entry.indexOf("=");
    const id = (eq === -1 ? entry : entry.slice(0, eq)).trim();
    const name = (eq === -1 ? entry : entry.slice(eq + 1)).trim() || id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name });
  }
  if (out.length === 0 && fallback) out.push({ id: fallback, name: fallback });
  return out;
}

export function modelIds(raw: string): string[] {
  return parseModels(raw, "").map((m) => m.id);
}

/** The raw string after a multi-select change; a display name survives while its id stays selected. */
export function withSelectedModels(raw: string, ids: string[]): string {
  const existingNames = new Map(parseModels(raw, "").map((m) => [m.id, m.name]));
  return ids
    .map((id) => {
      const name = existingNames.get(id);
      return name && name !== id ? `${id}=${name}` : id;
    })
    .join(", ");
}

/** A blank key keeps the stored one, a cleared key deletes it, a typed key replaces it. */
export function toInput(
  f: Form,
  clearedKeys: { chat: Record<string, boolean>; embed: boolean },
  base: BaseUrls,
  only: "chat" | "embed" | "both" = "both",
): NodeAiSettingsInput {
  const input: NodeAiSettingsInput = {
    chat: {
      enabled: f.chatEnabled,
      default_model: f.chatDefaultModel,
      endpoints: f.chatEndpoints.map((e) => {
        const out: { id: string; provider: string; base_url: string; models: Array<{ id: string; name: string }>; api_key?: string } = {
          id: e.id,
          provider: e.provider,
          base_url: e.baseUrl || base[e.provider] || "",
          models: parseModels(e.models, ""),
        };
        if (e.key) out.api_key = e.key;
        else if (clearedKeys.chat[e.id]) out.api_key = "";
        return out;
      }),
    },
    embed: {
      enabled: f.embedEnabled,
      provider: f.embedProvider,
      base_url: f.embedBaseUrl || base[f.embedProvider] || "",
      model: f.embedModel,
      search_max_distance: f.searchMaxDistance,
      retrieval_max_distance: f.retrievalMaxDistance,
    },
  };
  if (input.embed) {
    if (f.embedKey) input.embed.api_key = f.embedKey;
    else if (clearedKeys.embed) input.embed.api_key = "";
  }
  // The server leaves an absent half alone, so one half's save cannot disturb or be blocked by the other.
  if (only === "chat") delete input.embed;
  if (only === "embed") delete input.chat;
  return input;
}

/** Every model the endpoints offer, not every model a fetch found: the default must be an offered one. */
export function allChatModelIds(endpoints: ChatEndpointForm[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const ep of endpoints) {
    for (const id of modelIds(ep.models)) {
      if (!seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
  }
  return out;
}

/** The default, kept only while some endpoint still offers it. */
export function keptDefault(endpoints: ChatEndpointForm[], current: string): string {
  return allChatModelIds(endpoints).includes(current) ? current : "";
}

/** The matching preset's name, else the base URL, for probe rows. */
export function endpointLabel(presets: Preset[], provider: string, baseUrl: string): string {
  return presets.find((p) => p.provider === provider && p.baseUrl === baseUrl)?.label ?? baseUrl;
}

/** Nothing to delete: what a save that clears no key passes to toInput. */
export const NO_CLEARED_KEYS = { chat: {}, embed: false } as const;

/** Local embedding models by the width they return, for the hint when Ollama has none: it cannot shorten a vector to fit the column. */
const OLLAMA_EMBED_BY_WIDTH: Record<number, string[]> = {
  1024: ["bge-m3", "mxbai-embed-large", "snowflake-arctic-embed2"],
  768: ["nomic-embed-text"],
  384: ["all-minilm"],
};

/** A model Ollama could pull for semantic search at this width, for the hint when none is there. */
export function suggestedOllamaEmbedModel(width: number): string | null {
  return OLLAMA_EMBED_BY_WIDTH[width]?.[0] ?? null;
}

/**
 * The chat half with one more provider offering the model chosen for it: the
 * others as saved, and the default kept, or set by the first provider.
 */
export function withConnectedProvider(
  saved: NodeAiSettings,
  provider: { id: string; provider: string; baseUrl: string; key: string },
  model: string,
  base: BaseUrls,
): NodeAiSettingsInput {
  const form = toForm(saved);
  const next: Form = {
    ...form,
    chatEndpoints: [...form.chatEndpoints, { id: provider.id, provider: provider.provider, baseUrl: provider.baseUrl, models: model, key: provider.key }],
    chatDefaultModel: saved.chat.default_model || model,
  };
  return toInput(next, NO_CLEARED_KEYS, base, "chat");
}

/** A failed connection in words: a refused key and an unreachable server read differently from anything else. */
export function connectFailure(label: string, message: string): string {
  if (/\b(401|403)\b|unauthori[sz]ed|invalid.{0,20}key|api key/i.test(message)) return `${label} didn’t accept that key.`;
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|timed? ?out|network/i.test(message)) return `Couldn’t reach ${label}. Check the address and that the service is running.`;
  const short = message.length > 240 ? `${message.slice(0, 240)}…` : message;
  return `${label} answered: ${short}`;
}

/**
 * The chat half as saved, with one provider replaced by its edited draft or
 * dropped, another default chosen, or its switch flipped. A default no provider
 * offers any more is left for the node to settle on the first offered model.
 */
export function chatInputWith(
  saved: NodeAiSettings,
  change: { edit?: ChatEndpointForm; removeId?: string; defaultModel?: string; clearKeyOf?: string; enabled?: boolean },
  base: BaseUrls,
): NodeAiSettingsInput {
  const form = toForm(saved);
  let endpoints = form.chatEndpoints;
  if (change.edit) endpoints = endpoints.map((e) => (e.id === change.edit!.id ? change.edit! : e));
  if (change.removeId) endpoints = endpoints.filter((e) => e.id !== change.removeId);
  const next: Form = {
    ...form,
    chatEnabled: change.enabled ?? form.chatEnabled,
    chatEndpoints: endpoints,
    chatDefaultModel: keptDefault(endpoints, change.defaultModel ?? form.chatDefaultModel),
  };
  return toInput(next, { chat: change.clearKeyOf ? { [change.clearKeyOf]: true } : {}, embed: false }, base, "chat");
}

