/**
 * Embeddings over an OpenAI-compatible `/embeddings` or Ollama `/api/embed`
 * endpoint. Every vector leaves here as wide as the `vector(N)` column: a model
 * that returns fewer dimensions is padded with zeros, which leaves every cosine
 * distance as it was, and one that returns more is asked to shorten its vectors
 * (Matryoshka models can). A vector wider than the column fails here, not at insert.
 */
import { EMBEDDING_DIMS } from "@stuga/protocol/domain/limits";
import type { AiConfig, AiEndpoint, AiProvider } from "../config.js";
import { AiError, fetchWithRetry, joinUrl, jsonHeaders } from "../transport.js";
import { type EmbedProfile, type EmbedRole, embedProfile } from "./embed-profile.js";

export interface EmbedResult {
  /** One vector per input text, in input order, each as wide as the column. */
  embeddings: number[][];
  /** The width the model returned, before padding. */
  modelDims: number;
  /** Tokens the endpoint reported consuming (0 when it reports none). */
  inputTokens: number;
}

/** Per-text input cap, behind the chunker's own limits. */
const MAX_INPUT_CHARS = 50_000;

export function embedDims(cfg: AiConfig): number {
  const d = cfg.embed.dims;
  return Number.isInteger(d) && d > 0 ? d : EMBEDDING_DIMS;
}

/** Embed `texts` in one request, with the model's own prompt for `role`. An empty list makes no call. */
export async function embed(cfg: AiConfig, texts: string[], role: EmbedRole): Promise<EmbedResult> {
  if (texts.length === 0) return { embeddings: [], modelDims: 0, inputTokens: 0 };
  const ep = cfg.embed;
  const profile = embedProfile(ep.model);
  const prompt = profile[role];
  const inputs = texts.map((t) => prompt + t.slice(0, MAX_INPUT_CHARS));
  const dims = embedDims(cfg);
  const ask = requestedDims(profile, dims, ep.provider);
  const out = ep.provider === "ollama" ? await ollamaEmbed(ep, ep.model, inputs, ask) : await openaiEmbed(ep, ep.model, inputs, ask);
  if (out.embeddings.length !== inputs.length) {
    throw new AiError(`embed: expected ${inputs.length} vectors, got ${out.embeddings.length}`, 0, false);
  }
  const modelDims = out.embeddings[0]!.length;
  const embeddings = out.embeddings.map((v) => {
    if (v.length !== modelDims) throw new AiError(`embed: model ${ep.model} returned vectors of different widths`, 0, false);
    if (v.length > dims) {
      throw new AiError(`embed: model ${ep.model} returned ${v.length} dimensions, more than the ${dims} this node stores`, 0, false);
    }
    // Cosine distance to a zero vector is undefined, and a non-finite one poisons every comparison.
    if (!v.every(Number.isFinite) || v.every((x) => x === 0)) {
      throw new AiError(`embed: model ${ep.model} returned an unusable vector`, 0, false);
    }
    return v.length === dims ? v : [...v, ...Array.from({ length: dims - v.length }, () => 0)];
  });
  return { embeddings, modelDims, inputTokens: out.inputTokens };
}

/**
 * The width to ask for, or null for none. Only a model known to be wider than the
 * column is asked to shorten, to the widest it can that fits, since Ollama and some
 * compatible servers refuse a width beyond the model's own or outside its list. An
 * unknown model behind an OpenAI-compatible endpoint is asked for the column's
 * width, which OpenAI's own models need.
 */
function requestedDims(profile: EmbedProfile, column: number, provider: AiProvider): number | null {
  if (profile.dims === null) return provider === "ollama" ? null : column;
  if (profile.dims <= column) return null;
  return profile.shortens ? (profile.shortens.find((d) => d <= column) ?? null) : column;
}

/** Vectors as the endpoint returned them. */
type RawEmbeddings = Omit<EmbedResult, "modelDims">;

async function openaiEmbed(ep: AiEndpoint, model: string, input: string[], dims: number | null): Promise<RawEmbeddings> {
  if (ep.provider === "anthropic") {
    throw new AiError("embed: the anthropic provider serves no embeddings endpoint; point embed at an OpenAI-compatible or Ollama endpoint", 0, false);
  }
  const res = await fetchWithRetry("embeddings", (signal) =>
    fetch(joinUrl(ep.baseUrl, "/embeddings"), {
      method: "POST",
      headers: jsonHeaders(ep.apiKey),
      body: JSON.stringify(dims === null ? { model, input } : { model, input, dimensions: dims }),
      signal,
    }),
  );
  const json = (await res.json()) as {
    data?: Array<{ embedding?: number[]; index?: number }>;
    usage?: { prompt_tokens?: number };
  };
  if (!Array.isArray(json.data)) throw new AiError("embeddings: no data in response", res.status, false);
  const ordered = [...json.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const embeddings = ordered.map((d) => {
    if (!Array.isArray(d.embedding)) throw new AiError("embeddings: item without an embedding", res.status, false);
    return d.embedding;
  });
  return { embeddings, inputTokens: json.usage?.prompt_tokens ?? 0 };
}

async function ollamaEmbed(ep: AiEndpoint, model: string, input: string[], dims: number | null): Promise<RawEmbeddings> {
  const res = await fetchWithRetry("ollama embed", (signal) =>
    fetch(joinUrl(ep.baseUrl, "/api/embed"), {
      method: "POST",
      headers: jsonHeaders(ep.apiKey),
      body: JSON.stringify(dims === null ? { model, input } : { model, input, dimensions: dims }),
      signal,
    }),
  );
  const json = (await res.json()) as { embeddings?: number[][]; prompt_eval_count?: number };
  if (!Array.isArray(json.embeddings)) throw new AiError("ollama embed: no embeddings in response", res.status, false);
  return { embeddings: json.embeddings, inputTokens: json.prompt_eval_count ?? 0 };
}
