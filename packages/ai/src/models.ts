/**
 * From a client-facing model id to the Pi model that serves it: "auto" to the
 * configured default, the id to the endpoint that lists it, and the endpoint to
 * a Pi model. A model Pi's catalog lists at the same base URL brings what the
 * catalog knows about it: vision, reasoning, and the wire quirks of its vendor
 * (token field names, reasoning replay). Any other id gets plain defaults on the
 * endpoint's protocol.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import type { AiConfig, AiProvider, ChatEndpoint } from "./config.js";
import { joinUrl } from "./transport.js";

/** "auto", empty and missing mean the configured default; any other id passes through. */
export function resolveModel(cfg: AiConfig, requestedId?: string | null): string {
  const id = (requestedId ?? "").trim();
  return !id || id === "auto" ? cfg.chat.defaultModel : id;
}

/** The endpoint listing `modelId`; an id no endpoint lists goes to the first endpoint. */
export function resolveEndpoint(cfg: AiConfig, modelId: string): ChatEndpoint {
  const owner = cfg.chat.endpoints.find((ep) => ep.models.some((m) => m.id === modelId));
  if (owner) return owner;
  const fallback = cfg.chat.endpoints[0];
  if (!fallback) throw new Error("no chat endpoint is configured");
  return fallback;
}

/** A model id resolved to a Pi model and the key of the endpoint that serves it. */
export interface ChatTarget {
  model: Model<Api>;
  apiKey: string;
}

/**
 * Pi's clients require a key; a local server ignores one. The OpenAI-compatible
 * client sends it as a bearer token.
 */
const KEYLESS = "unused";

/** Resolve `modelId`, already past "auto", on the endpoint that lists it. */
export function chatTarget(cfg: AiConfig, modelId: string): ChatTarget {
  const ep = resolveEndpoint(cfg, modelId);
  const name = ep.models.find((m) => m.id === modelId)?.name ?? modelId;
  const known = catalogEntry(ep, modelId);
  const model: Model<Api> = known ? { ...known, name, baseUrl: ep.baseUrl } : defaultModel(ep, modelId, name);
  return { model, apiKey: ep.apiKey || KEYLESS };
}

/** Whether the model takes image input; an uncatalogued one is assumed to. */
export function acceptsImages(cfg: AiConfig, modelId: string): boolean {
  return chatTarget(cfg, modelId).model.input.includes("image");
}

/** The wire protocols each endpoint kind speaks; a catalog entry on another one is not used. */
const PROTOCOLS: Record<AiProvider, Api[]> = {
  anthropic: ["anthropic-messages"],
  openai: ["openai-completions", "openai-responses"],
  ollama: ["openai-completions"],
};

let catalog: Map<string, Model<Api>> | undefined;

/** A trailing /v1 is ignored: a vendor serves its OpenAI-compatible routes under either, and requests keep the configured URL. */
function catalogKey(baseUrl: string, id: string): string {
  return `${baseUrl.trim().toLowerCase().replace(/\/+$/, "").replace(/\/v1$/, "")} ${id}`;
}

function catalogEntry(ep: ChatEndpoint, id: string): Model<Api> | undefined {
  catalog ??= new Map(
    getBuiltinProviders().flatMap((p) => getBuiltinModels(p).map((m): [string, Model<Api>] => [catalogKey(m.baseUrl, m.id), m])),
  );
  const entry = catalog.get(catalogKey(ep.baseUrl, id));
  return entry && PROTOCOLS[ep.provider].includes(entry.api) ? entry : undefined;
}

/**
 * An uncatalogued model: no reasoning controls sent, images passed through for
 * the provider to accept or refuse, and no context-window clamp.
 */
function defaultModel(ep: ChatEndpoint, id: string, name: string): Model<Api> {
  const base = {
    id,
    name,
    provider: `stuga-${ep.provider}`,
    reasoning: false,
    input: ["text", "image"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 0,
    maxTokens: 0,
  };
  switch (ep.provider) {
    case "anthropic":
      return { ...base, api: "anthropic-messages", baseUrl: ep.baseUrl };
    case "openai":
      return { ...base, api: "openai-completions", baseUrl: ep.baseUrl };
    case "ollama":
      // Ollama's OpenAI-compatible surface takes neither the developer role nor reasoning_effort.
      return {
        ...base,
        api: "openai-completions",
        baseUrl: joinUrl(ep.baseUrl, "/v1"),
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
      } as Model<"openai-completions">;
  }
}
