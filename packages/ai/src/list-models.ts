/** A provider's own model listing, for the settings picker. */
import type { AiEndpoint } from "./config.js";
import { AiError, joinUrl, jsonHeaders } from "./transport.js";

/** The Messages API version the listing request names. */
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Ask a provider which models it offers, so an operator enters a key rather
 * than recalling an id. Model lists carry no capability field, so chat and
 * embedding ids are told apart by name; a model the heuristic misfiles can
 * still be typed by hand.
 */
export async function listModels(ep: AiEndpoint, which: "chat" | "embed"): Promise<string[]> {
  const models = await fetchModels(ep);
  return newestFirst(models)
    .map((m) => m.id)
    .filter((id) => (which === "embed" ? isEmbeddingModelId(id) : !isEmbeddingModelId(id) && !isNonChatModelId(id)));
}

/** A listed model and when the service dated it, if it did. */
interface ListedModel {
  id: string;
  /** Milliseconds since the epoch: release for a vendor, pull time for Ollama. */
  at: number | null;
}

/**
 * The newest first, so a picker leads with current models without naming any.
 * Undated models keep the service's order, after the dated ones.
 */
function newestFirst(models: ListedModel[]): ListedModel[] {
  return models
    .map((m, i) => ({ m, i }))
    .sort((a, b) => {
      if (a.m.at !== null && b.m.at !== null && a.m.at !== b.m.at) return b.m.at - a.m.at;
      if ((a.m.at === null) !== (b.m.at === null)) return a.m.at === null ? 1 : -1;
      return a.i - b.i;
    })
    .map(({ m }) => m);
}

/**
 * `text-embedding-*`, the "embed" naming most Ollama embedding models use, and
 * the families that name themselves otherwise: BGE (`bge-m3`), E5, GTE, MiniLM.
 */
function isEmbeddingModelId(id: string): boolean {
  return /embed|minilm|(^|[/:_-])(bge|e5|gte)([/:_-]|$)/i.test(id);
}

/**
 * OpenAI ids in the chat catalog that cannot take a chat-completions request.
 * Names trail new families, so the save's probe is what refuses one missed here.
 */
function isNonChatModelId(id: string): boolean {
  return /(whisper|tts-|dall-e|davinci-002|babbage-002|moderation|realtime|transcribe|gpt-image|(^|[-_])live($|[-_]))/i.test(id);
}

async function fetchModels(ep: AiEndpoint): Promise<ListedModel[]> {
  switch (ep.provider) {
    case "ollama":
      // Only pulled models can serve.
      return fetchListed(joinUrl(ep.baseUrl, "/api/tags"), jsonHeaders(ep.apiKey), (j: { models?: Array<{ name?: string; modified_at?: string }> }) =>
        (j.models ?? []).map((m) => ({ id: m.name, at: dateMs(m.modified_at) })),
      );
    case "anthropic":
      return fetchListed(joinUrl(ep.baseUrl, "/v1/models"), anthropicHeaders(ep.apiKey), (j: { data?: Array<{ id?: string; created_at?: string }> }) =>
        (j.data ?? []).map((m) => ({ id: m.id, at: dateMs(m.created_at) })),
      );
    case "openai":
      // `created` is in seconds; not every compatible server sends it.
      return fetchListed(joinUrl(ep.baseUrl, "/models"), jsonHeaders(ep.apiKey), (j: { data?: Array<{ id?: string; created?: number }> }) =>
        (j.data ?? []).map((m) => ({ id: m.id, at: typeof m.created === "number" && m.created > 0 ? m.created * 1000 : null })),
      );
  }
}

function dateMs(v: string | undefined): number | null {
  const t = v ? Date.parse(v) : NaN;
  return Number.isNaN(t) ? null : t;
}

async function fetchListed<T>(
  url: string,
  headers: Record<string, string>,
  extract: (json: T) => Array<{ id?: string; at: number | null }>,
): Promise<ListedModel[]> {
  const r = await fetch(url, { headers });
  if (!r.ok) throw new AiError(`models ${r.status}: ${await r.text()}`, r.status, false);
  return extract((await r.json()) as T).filter((m): m is ListedModel => !!m.id);
}

function anthropicHeaders(apiKey: string | undefined): Record<string, string> {
  return { "anthropic-version": ANTHROPIC_VERSION, ...(apiKey ? { "x-api-key": apiKey } : {}) };
}
