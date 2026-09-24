/**
 * Embeddings over an OpenAI-compatible `/embeddings` or Ollama `/api/embed`
 * endpoint. The width must equal the `vector(N)` column; it is requested where
 * supported and checked on every response, so a mismatch fails here, not at insert.
 */
import { EMBEDDING_DIMS } from "@stuga/protocol/domain/limits";
import type { AiConfig, AiEndpoint } from "../config.js";
import { AiError, fetchWithRetry, joinUrl, jsonHeaders } from "../providers/transport.js";

export interface EmbedResult {
  /** One vector per input text, in input order. */
  embeddings: number[][];
  /** Tokens the endpoint reported consuming (0 when it reports none). */
  inputTokens: number;
}

/** Per-text input cap, behind the chunker's own limits. */
const MAX_INPUT_CHARS = 50_000;

export function embedDims(cfg: AiConfig): number {
  const d = cfg.embed.dims;
  return Number.isInteger(d) && d > 0 ? d : EMBEDDING_DIMS;
}

/** Embed `texts` in one request. An empty list makes no call. */
export async function embed(cfg: AiConfig, texts: string[]): Promise<EmbedResult> {
  if (texts.length === 0) return { embeddings: [], inputTokens: 0 };
  const inputs = texts.map((t) => t.slice(0, MAX_INPUT_CHARS));
  const dims = embedDims(cfg);
  const ep = cfg.embed;
  const out = ep.provider === "ollama" ? await ollamaEmbed(ep, ep.model, inputs) : await openaiEmbed(ep, ep.model, inputs, dims);
  if (out.embeddings.length !== inputs.length) {
    throw new AiError(`embed: expected ${inputs.length} vectors, got ${out.embeddings.length}`, 0, false);
  }
  for (const v of out.embeddings) {
    if (v.length !== dims) {
      throw new AiError(`embed: model ${ep.model} returned ${v.length} dimensions; the configured width is ${dims}`, 0, false);
    }
  }
  return out;
}

async function openaiEmbed(ep: AiEndpoint, model: string, input: string[], dims: number): Promise<EmbedResult> {
  if (ep.provider === "anthropic") {
    throw new AiError("embed: the anthropic provider serves no embeddings endpoint; point embed at an OpenAI-compatible or Ollama endpoint", 0, false);
  }
  const res = await fetchWithRetry("embeddings", (signal) =>
    fetch(joinUrl(ep.baseUrl, "/embeddings"), {
      method: "POST",
      headers: jsonHeaders(ep.apiKey),
      body: JSON.stringify({ model, input, dimensions: dims }),
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

async function ollamaEmbed(ep: AiEndpoint, model: string, input: string[]): Promise<EmbedResult> {
  const res = await fetchWithRetry("ollama embed", (signal) =>
    fetch(joinUrl(ep.baseUrl, "/api/embed"), {
      method: "POST",
      headers: jsonHeaders(ep.apiKey),
      body: JSON.stringify({ model, input }),
      signal,
    }),
  );
  const json = (await res.json()) as { embeddings?: number[][]; prompt_eval_count?: number };
  if (!Array.isArray(json.embeddings)) throw new AiError("ollama embed: no embeddings in response", res.status, false);
  return { embeddings: json.embeddings, inputTokens: json.prompt_eval_count ?? 0 };
}
