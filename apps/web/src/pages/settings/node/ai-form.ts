/** The AI provider form: presets, the write-only key contract, and what a save sends. */
import type { NodeAiSettings, NodeAiSettingsInput } from "../../../api";
import type { SearchStrictness } from "@stuga/protocol/domain/search-strictness";
import { t } from "../../../i18n/i18n";
import { timeOfDay } from "../../../lib/format";

/** What each part is called and is for, the same in Settings and at first run. */
export const HALF_COPY = {
  chat: { title: t("node.ai.chat.title"), about: t("node.ai.chat.about") },
  search: { title: t("node.ai.search.title"), about: t("node.ai.search.about") },
  rerank: { title: t("node.ai.rerank.title"), about: t("node.ai.rerank.about") },
} as const;

export const PROVIDERS = [
  { value: "openai", label: t("node.ai.protocol.openaiCompatible") },
  { value: "anthropic", label: "Anthropic" }, // i18n-exempt: a vendor's name
  { value: "ollama", label: t("node.ai.preset.ollamaLocal") },
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
    { value: "openai", label: "OpenAI", provider: "openai", baseUrl: base.openai ?? "", embeddings: true }, // i18n-exempt: a vendor's name
    { value: "anthropic", label: "Anthropic (Claude)", provider: "anthropic", baseUrl: base.anthropic ?? "", embeddings: false }, // i18n-exempt: a vendor's name
    { value: "gemini", label: "Google Gemini", provider: "openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", embeddings: true }, // i18n-exempt: a vendor's name
    { value: "cerebras", label: "Cerebras", provider: "openai", baseUrl: "https://api.cerebras.ai/v1", embeddings: false }, // i18n-exempt: a vendor's name
    { value: "deepseek", label: "DeepSeek", provider: "openai", baseUrl: "https://api.deepseek.com/v1", embeddings: false }, // i18n-exempt: a vendor's name
    { value: "fireworks", label: "Fireworks", provider: "openai", baseUrl: "https://api.fireworks.ai/inference/v1", embeddings: true }, // i18n-exempt: a vendor's name
    { value: "groq", label: "Groq", provider: "openai", baseUrl: "https://api.groq.com/openai/v1", embeddings: false }, // i18n-exempt: a vendor's name
    { value: "minimax", label: "MiniMax", provider: "anthropic", baseUrl: "https://api.minimax.io/anthropic", embeddings: false }, // i18n-exempt: a vendor's name
    { value: "mistral", label: "Mistral", provider: "openai", baseUrl: "https://api.mistral.ai/v1", embeddings: true }, // i18n-exempt: a vendor's name
    { value: "moonshot", label: "Moonshot (Kimi)", provider: "openai", baseUrl: "https://api.moonshot.ai/v1", embeddings: false }, // i18n-exempt: a vendor's name
    { value: "openrouter", label: "OpenRouter", provider: "openai", baseUrl: "https://openrouter.ai/api/v1", embeddings: false }, // i18n-exempt: a vendor's name
    { value: "qwen", label: "Qwen (Alibaba Cloud)", provider: "openai", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", embeddings: true }, // i18n-exempt: a vendor's name
    { value: "together", label: "Together", provider: "openai", baseUrl: "https://api.together.ai/v1", embeddings: true }, // i18n-exempt: a vendor's name
    { value: "xai", label: "xAI (Grok)", provider: "openai", baseUrl: "https://api.x.ai/v1", embeddings: false }, // i18n-exempt: a vendor's name
    { value: "zai", label: "Z.ai (GLM)", provider: "openai", baseUrl: "https://api.z.ai/api/paas/v4", embeddings: false }, // i18n-exempt: a vendor's name
    { value: "ollama", label: t("node.ai.preset.ollamaLocal"), provider: "ollama", baseUrl: base.ollama ?? "", embeddings: true },
    { value: "custom", label: t("node.ai.preset.custom"), provider: "openai", baseUrl: "", embeddings: true },
  ];
}

export function presetFor(presets: Preset[], provider: string, baseUrl: string): string {
  return presets.find((p) => p.provider === provider && p.baseUrl === baseUrl)?.value ?? "custom";
}

/** The endpoint a choice resolves to, in one line under the picker. */
export function endpointSummary(base: BaseUrls, provider: string, baseUrl: string): string {
  return t("node.ai.endpointSummary", { address: baseUrl || base[provider] || "—", protocol: provider });
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
  /** The search box's level; null follows the node's default. */
  searchStrictness: SearchStrictness | null;
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
    searchStrictness: saved.searchStrictness,
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
    searchStrictness: s.embed.search_strictness,
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
      search_strictness: f.searchStrictness,
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

/**
 * A model Ollama could pull for semantic search at this width, for the hint when none is there.
 * EmbeddingGemma 300m returns 768 dimensions, shortens to 512, 256 or 128, and is padded to the
 * column. It retrieved text better than EmbeddingGemma 2 in Stuga's benchmark (multilingual
 * Wikipedia and StackOverflow), whose gains are in images, audio and code search.
 */
export function suggestedOllamaEmbedModel(width: number): string | null {
  return width >= 128 ? "embeddinggemma:300m" : null;
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
  if (/\b(401|403)\b|unauthori[sz]ed|invalid.{0,20}key|api key/i.test(message)) return t("node.ai.connect.keyRefused", { service: label });
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|timed? ?out|network/i.test(message)) return t("node.ai.connect.unreachable", { service: label });
  const short = message.length > 240 ? `${message.slice(0, 240)}…` : message;
  return t("node.ai.connect.answered", { service: label, message: short });
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

/** Where a System One ranker is served, and the model to ask for there. */
export const RERANK_PRESETS = [
  { value: "typesafe", label: "TypeSafe", baseUrl: "https://api.typesafe.ai/v1", model: "jev-latest" }, // i18n-exempt: a vendor's name
  { value: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", model: "~typesafe/jev-latest" }, // i18n-exempt: a vendor's name
  { value: "custom", label: t("node.ai.preset.custom"), baseUrl: "", model: "" },
];

export function rerankPresetFor(baseUrl: string): string {
  return RERANK_PRESETS.find((p) => p.value !== "custom" && p.baseUrl === baseUrl)?.value ?? "custom";
}

/** The ranker as the form edits it. The key is write-only, so it starts empty. */
export interface RerankForm {
  baseUrl: string;
  model: string;
  key: string;
}

/** The saved ranker, or TypeSafe's defaults when none is set up. */
export function rerankFormOf(s: NodeAiSettings): RerankForm {
  if (!s.rerank.model) return { baseUrl: RERANK_PRESETS[0]!.baseUrl, model: RERANK_PRESETS[0]!.model, key: "" };
  return { baseUrl: s.rerank.base_url, model: s.rerank.model, key: "" };
}

/** A save of the ranker alone; a blank key keeps the stored one, `clearKey` deletes it. */
export function rerankInput(f: RerankForm, opts: { clearKey?: boolean; enabled?: boolean } = {}): NodeAiSettingsInput {
  const rerank: NonNullable<NodeAiSettingsInput["rerank"]> = { base_url: f.baseUrl.trim(), model: f.model.trim() };
  if (opts.enabled !== undefined) rerank.enabled = opts.enabled;
  if (f.key) rerank.api_key = f.key;
  else if (opts.clearKey) rerank.api_key = "";
  return { rerank };
}

/** Each level, as it reads for the model in force. */
export const STRICTNESS_COPY: Record<SearchStrictness, { label: string; line: string }> = {
  strict: { label: t("node.ai.strictness.strict"), line: t("node.ai.strictness.strictLine") },
  balanced: { label: t("node.ai.strictness.balanced"), line: t("node.ai.strictness.balancedLine") },
  loose: { label: t("node.ai.strictness.loose"), line: t("node.ai.strictness.looseLine") },
  off: { label: t("node.ai.strictness.off"), line: t("node.ai.strictness.offLine") },
};

/** A measurement's progress, 0–100, as the fraction a percent message formats. */
const fraction = (progress: number | null | undefined) => (progress ?? 0) / 100;

/**
 * The small print under the control: the distance the chosen level puts in force for this model, or
 * where its measurement stands. `measureAgain` asks for the link.
 */
/** The form names another model, service or address than the one in force. */
function formChangesModel(settings: NodeAiSettings, form: Form): boolean {
  const e = settings.embed;
  return form.embedProvider !== e.provider || form.embedModel !== e.model || (!!form.embedBaseUrl && form.embedBaseUrl !== e.base_url);
}

export function strictnessNote(settings: NodeAiSettings, form: Form): { text: string; measureAgain: boolean } | null {
  const e = settings.embed;
  if (formChangesModel(settings, form)) return { text: t("node.ai.strictness.measuredOnSave"), measureAgain: false };
  const level = form.searchStrictness ?? settings.strictness_default;
  if (level === "off") return null;
  // A model is measured only while semantic search runs.
  if (!e.running) return { text: t("node.ai.strictness.measuredWhenOn"), measureAgain: false };
  const c = e.calibration;
  if (c?.state === "failed" && c.kind === "inseparable") return { text: t("node.ai.strictness.cannotMeasure"), measureAgain: false };
  const d = c?.levels?.short[level];
  const progress = fraction(c?.progress);
  if (d !== undefined) {
    if (c!.state === "running") return { text: t("node.ai.strictness.distanceRemeasuring", { distance: d, progress }), measureAgain: false };
    if (c!.state === "failed") return { text: t("node.ai.strictness.distanceRemeasureFailed", { distance: d }), measureAgain: true };
    return { text: t("node.ai.strictness.distance", { distance: d }), measureAgain: true };
  }
  if (c?.state === "running") return { text: t("node.ai.strictness.measuring", { progress }), measureAgain: false };
  return { text: t("node.ai.strictness.notMeasured"), measureAgain: true };
}

/** A strict level on a model whose related text often sits as far as unrelated text. */
export function strictnessWarning(settings: NodeAiSettings, form: Form): string | null {
  if (formChangesModel(settings, form)) return null;
  const level = form.searchStrictness ?? settings.strictness_default;
  const kept = settings.embed.calibration?.related_kept;
  return (level === "strict" || level === "balanced") && kept != null && kept < 0.9 ? t("node.ai.strictness.looseSuits") : null;
}

/** The level on the service row, and a measurement in progress or missing. */
export function searchServiceDetail(settings: NodeAiSettings): string | null {
  const cut = settings.embed.cutoff;
  if (!cut) return null;
  const level = cut.level === "off" ? t("node.ai.strictness.offDetail") : STRICTNESS_COPY[cut.level].label;
  const c = settings.embed.calibration;
  const state =
    cut.source === "measuring"
      ? t("node.ai.strictness.measuringDetail", { progress: fraction(c?.progress) })
      : cut.source === "unmeasured" && c?.state === "failed"
        ? t("node.ai.strictness.notMeasuredDetail")
        : null;
  return [level, state].filter(Boolean).join(" · ") || null;
}

/** A failed measurement with no result in force, as a banner outside Edit. */
export function calibrationBanner(settings: NodeAiSettings): { status: "warning" | "error"; title: string; description: string; retry: boolean } | null {
  const c = settings.embed.calibration;
  // Only while a level is waiting on it: Off does not need a measurement.
  if (!c || c.state !== "failed" || c.levels || settings.embed.cutoff?.source !== "unmeasured") return null;
  if (c.kind === "inseparable") {
    return {
      status: "error",
      title: t("node.ai.calibration.inseparableTitle", { model: c.model }),
      description: t("node.ai.calibration.inseparableBody"),
      retry: false,
    };
  }
  const reason = connectFailure(c.model, c.message ?? "");
  return {
    status: "warning",
    title: t("node.ai.calibration.failedTitle", { model: c.model }),
    description: c.next_attempt_at
      ? t("node.ai.calibration.failedBodyNext", { reason, time: timeOfDay(c.next_attempt_at) })
      : t("node.ai.calibration.failedBody", { reason }),
    retry: true,
  };
}
