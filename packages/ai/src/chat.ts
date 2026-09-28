/**
 * Chat requests through Pi's protocol clients: the stream the agent loop runs
 * on, a single text completion, and the probe a settings save makes.
 */
import { clampThinkingLevel, normalizeContext, type Api, type AssistantMessage, type Model, type ModelThinkingLevel, type ProviderStreams, type SimpleStreamOptions, type TranscriptContext } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import type { AiConfig } from "./config.js";
import { requestFailure, type ModelFailure } from "./failure.js";
import { chatTarget, resolveModel, type ChatTarget } from "./models.js";
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

/** A request's output cap, within what the model can write when the catalog says. */
export function outputCap(model: Model<Api>, maxTokens: number): number {
  return model.maxTokens > 0 ? Math.min(maxTokens, model.maxTokens) : maxTokens;
}

export interface TextCompletion {
  text: string;
  usage: TokenUsage;
  /** The model that ran, or null when none could be resolved. */
  modelId: string | null;
  /** The protocol it was asked over, or null when no endpoint could be resolved. */
  protocol: string | null;
  /** The answer stopped at `maxTokens`. */
  cutOff: boolean;
  /** Set when the request failed; the usage still counts what was billed. */
  failure?: ModelFailure;
}

/** One request with no tools, answered as text. Never throws. */
export async function completeText(
  cfg: AiConfig,
  req: {
    model?: string;
    system?: string;
    prompt: string;
    maxTokens: number;
    signal?: AbortSignal;
    /** Reasoning, clamped to the levels the model offers; omitted, the provider's default. */
    thinking?: ModelThinkingLevel;
  },
): Promise<TextCompletion> {
  const modelId = resolveModel(cfg, req.model);
  const none = { text: "", usage: { ...ZERO_USAGE }, modelId: null, protocol: null, cutOff: false };
  let target: ChatTarget;
  try {
    target = chatTarget(cfg, modelId);
  } catch (e) {
    return { ...none, failure: requestFailure(null, modelId, e instanceof Error ? e.message : String(e)) };
  }
  const { model, apiKey } = target;
  const thinking = req.thinking && clampThinkingLevel(model, req.thinking);
  let message: AssistantMessage;
  try {
    const context = normalizeContext({
      ...(req.system ? { systemPrompt: req.system } : {}),
      messages: [{ role: "user", content: req.prompt, timestamp: Date.now() }],
    });
    message = await streamChat(model, context, {
      apiKey,
      maxTokens: outputCap(model, req.maxTokens),
      signal: req.signal,
      ...(thinking && thinking !== "off" ? { reasoning: thinking } : {}),
    }).result();
  } catch (e) {
    return { ...none, protocol: model.api, failure: requestFailure(model.api, modelId, e instanceof Error ? e.message : String(e), { key: apiKey }) };
  }
  const usage = usageOf(message.usage);
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    const failure = requestFailure(model.api, modelId, message.errorMessage ?? "the model request failed", { key: apiKey });
    return { ...none, usage, modelId, protocol: model.api, failure };
  }
  const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  return { text, usage, modelId, protocol: model.api, cutOff: message.stopReason === "length" };
}

/** Prove endpoint, key and model with the smallest answer a provider accepts; the failure, or null. */
export async function probeChat(cfg: AiConfig, modelId: string): Promise<string | null> {
  const out = await completeText(cfg, { model: modelId, prompt: "ping", maxTokens: 16 });
  return out.failure?.message ?? null;
}
