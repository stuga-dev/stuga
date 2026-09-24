/** Routes a streamed turn to the configured endpoint that owns its model, and lists a provider's models. */
import type { AiConfig, AiEndpoint, ChatEndpoint } from "../config.js";
import type { StopReason, TurnHandlersArg, TurnRequest } from "../types.js";
import { anthropicHeaders, anthropicStream } from "./anthropic.js";
import { ollamaStream } from "./ollama.js";
import { openaiStream } from "./openai.js";
import { AiError, joinUrl, jsonHeaders } from "./transport.js";

/** The endpoint listing `modelId`; an id no endpoint lists goes to the first endpoint. */
function resolveEndpoint(cfg: AiConfig, modelId: string): ChatEndpoint {
  const owner = cfg.chat.endpoints.find((ep) => ep.models.some((m) => m.id === modelId));
  if (owner) return owner;
  const fallback = cfg.chat.endpoints[0];
  if (!fallback) throw new Error("no chat endpoint is configured");
  return fallback;
}

export function streamTurn(
  cfg: AiConfig,
  req: TurnRequest,
  handlers?: TurnHandlersArg,
): AsyncGenerator<string, StopReason | undefined> {
  const endpoint = resolveEndpoint(cfg, req.modelId);
  switch (endpoint.provider) {
    case "anthropic":
      return anthropicStream(endpoint, req, handlers);
    case "openai":
      return openaiStream(endpoint, req, handlers);
    case "ollama":
      return ollamaStream(endpoint, req, handlers);
    default: {
      const p: never = endpoint.provider;
      throw new Error(`unknown AI provider: ${String(p)}`);
    }
  }
}

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
      return fetchListed(joinUrl(ep.baseUrl, "/v1/models"), anthropicHeaders(ep), (j: { data?: Array<{ id?: string; created_at?: string }> }) =>
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
