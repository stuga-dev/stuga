/**
 * Chat requests through Pi's protocol clients: the stream the agent loop runs
 * on, a single text completion, and the probe a settings save makes.
 */
import { normalizeContext, type Api, type AssistantMessage, type Model, type ProviderStreams, type SimpleStreamOptions, type TranscriptContext } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import type { AiConfig } from "./config.js";
import { chatTarget, resolveModel } from "./models.js";
import { usageOf, ZERO_USAGE, type TokenUsage } from "./types.js";

/** Loaded on first request, so a node that never chats never loads a vendor SDK. */
const APIS: Record<string, ProviderStreams> = {
  "anthropic-messages": anthropicMessagesApi(),
  "openai-completions": openAICompletionsApi(),
  "openai-responses": openAIResponsesApi(),
};

/** Retries after the first attempt, for 408/409/429/5xx and network faults. */
const MAX_RETRIES = 3;
/** Time to response headers per attempt; a long streamed answer is not cut. */
const RESPONSE_START_TIMEOUT_MS = 60_000;

/** Stream one request through the Pi client for the model's protocol. */
export function streamChat(model: Model<Api>, context: TranscriptContext, options: SimpleStreamOptions) {
  const api = APIS[model.api];
  if (!api) throw new Error(`no client for protocol ${model.api}`);
  return api.streamSimple(model, context, { maxRetries: MAX_RETRIES, timeoutMs: RESPONSE_START_TIMEOUT_MS, ...options });
}

export interface TextCompletion {
  text: string;
  usage: TokenUsage;
  /** The model that ran, or null when none could be resolved. */
  modelId: string | null;
  /** Why the request failed; the usage still counts what was billed. */
  error?: string;
}

/** One request with no tools, answered as text. Never throws. */
export async function completeText(
  cfg: AiConfig,
  req: { model?: string; system?: string; prompt: string; maxTokens: number; signal?: AbortSignal },
): Promise<TextCompletion> {
  const modelId = resolveModel(cfg, req.model);
  let message: AssistantMessage;
  try {
    const { model, apiKey } = chatTarget(cfg, modelId);
    const context = normalizeContext({
      ...(req.system ? { systemPrompt: req.system } : {}),
      messages: [{ role: "user", content: req.prompt, timestamp: Date.now() }],
    });
    message = await streamChat(model, context, { apiKey, maxTokens: req.maxTokens, signal: req.signal }).result();
  } catch (e) {
    return { text: "", usage: { ...ZERO_USAGE }, modelId: null, error: e instanceof Error ? e.message : String(e) };
  }
  const usage = usageOf(message.usage);
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    return { text: "", usage, modelId, error: message.errorMessage ?? "the model request failed" };
  }
  const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  return { text, usage, modelId };
}

/** Prove endpoint, key and model with the smallest answer a provider accepts; the failure, or null. */
export async function probeChat(cfg: AiConfig, modelId: string): Promise<string | null> {
  const out = await completeText(cfg, { model: modelId, prompt: "ping", maxTokens: 16 });
  return out.error ?? null;
}
