/** Anthropic Messages API client (`POST {baseUrl}/v1/messages`, streaming SSE). */
import type { AiEndpoint } from "../config.js";
import { AiError, fetchWithRetry, joinUrl, readSseJson } from "./transport.js";
import {
  DEFAULT_MAX_TOKENS,
  normalizeHandlers,
  type ContentBlock,
  type StopReason,
  type TokenUsage,
  type TurnHandlersArg,
  type TurnMessage,
  type TurnRequest,
} from "../types.js";

export const ANTHROPIC_VERSION = "2023-06-01";

type CacheControl = { cache_control?: { type: "ephemeral" } };

type WireBlock = (
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: Array<{ type: "text"; text: string }>; is_error?: boolean }
) & CacheControl;

type SystemBlock = { type: "text"; text: string } & CacheControl;

function toWireBlock(b: ContentBlock): WireBlock {
  if ("text" in b) return { type: "text", text: b.text };
  if ("image" in b) {
    return {
      type: "image",
      source: { type: "base64", media_type: `image/${b.image.format}`, data: b.image.source.bytes },
    };
  }
  if ("toolUse" in b) return { type: "tool_use", id: b.toolUse.toolUseId, name: b.toolUse.name, input: b.toolUse.input ?? {} };
  return {
    type: "tool_result",
    tool_use_id: b.toolResult.toolUseId,
    content: b.toolResult.content.map((c) => ({ type: "text" as const, text: c.text })),
    ...(b.toolResult.status === "error" ? { is_error: true } : {}),
  };
}

export function toAnthropicMessages(messages: TurnMessage[]): Array<{ role: "user" | "assistant"; content: WireBlock[] }> {
  return messages.map((m) => ({ role: m.role, content: m.content.map(toWireBlock) }));
}

/** The cached prefix goes first with the cache marker, so the per-turn system text after it is never cached. */
function buildAnthropicSystem(req: TurnRequest): SystemBlock[] | undefined {
  const blocks: SystemBlock[] = [];
  if (req.cachedPrefix) blocks.push({ type: "text", text: req.cachedPrefix, cache_control: { type: "ephemeral" } });
  if (req.system) blocks.push({ type: "text", text: req.system });
  return blocks.length ? blocks : undefined;
}

/**
 * A second, rolling cache marker on the conversation's last block: each round of
 * a turn resends every earlier tool result, and with the marker the next round
 * reads that prefix from the cache instead of paying for it again. A prefix
 * under the model's minimum is simply not cached.
 */
function markConversationTail(messages: Array<{ content: WireBlock[] }>): void {
  const last = messages.at(-1)?.content.at(-1);
  if (last) last.cache_control = { type: "ephemeral" };
}

function buildAnthropicBody(req: TurnRequest): Record<string, unknown> {
  const system = buildAnthropicSystem(req);
  const messages = toAnthropicMessages(req.messages);
  markConversationTail(messages);
  return {
    model: req.modelId,
    max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
    stream: true,
    ...(system ? { system } : {}),
    messages,
    ...(req.tools && req.tools.length
      ? { tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema.json })) }
      : {}),
  };
}

export function anthropicHeaders(ep: AiEndpoint): Record<string, string> {
  return {
    "content-type": "application/json",
    "anthropic-version": ANTHROPIC_VERSION,
    ...(ep.apiKey ? { "x-api-key": ep.apiKey } : {}),
  };
}

interface WireUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** One streamed event, narrowed to the fields this client reads. */
interface StreamEvent {
  type: string;
  index?: number;
  message?: { usage?: WireUsage };
  content_block?: { type: string; id?: string; name?: string; text?: string };
  delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string | null };
  usage?: WireUsage;
  error?: { type?: string; message?: string };
}

/**
 * Stream one turn. Tool input arrives as `input_json_delta` fragments per block
 * index, parsed at `content_block_stop`. Usage is split across `message_start`
 * and `message_delta`, so it is merged and reported once at the end.
 */
export async function* anthropicStream(
  ep: AiEndpoint,
  req: TurnRequest,
  handlers?: TurnHandlersArg,
): AsyncGenerator<string, StopReason | undefined> {
  const h = normalizeHandlers(handlers);
  const res = await fetchWithRetry(
    "anthropic messages",
    (signal) =>
      fetch(joinUrl(ep.baseUrl, "/v1/messages"), {
        method: "POST",
        headers: anthropicHeaders(ep),
        body: JSON.stringify(buildAnthropicBody(req)),
        signal,
      }),
    { signal: req.signal },
  );
  if (!res.body) throw new AiError("anthropic messages: empty body", res.status, true);

  const pendingTools = new Map<number, { id: string; name: string; json: string }>();
  let stopReason: StopReason | undefined;
  let usage: TokenUsage | null = null;
  const mergeUsage = (u: WireUsage | undefined) => {
    if (!u) return;
    const n = (v: unknown) => (typeof v === "number" ? v : undefined);
    const cur = usage ?? { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 };
    usage = {
      inputTokens: n(u.input_tokens) ?? cur.inputTokens,
      outputTokens: n(u.output_tokens) ?? cur.outputTokens,
      cacheReadInputTokens: n(u.cache_read_input_tokens) ?? cur.cacheReadInputTokens,
      cacheWriteInputTokens: n(u.cache_creation_input_tokens) ?? cur.cacheWriteInputTokens,
    };
  };

  for await (const ev of readSseJson<StreamEvent>(res.body)) {
    switch (ev.type) {
      case "message_start":
        mergeUsage(ev.message?.usage);
        break;
      case "content_block_start": {
        const cb = ev.content_block;
        if (cb?.type === "tool_use") {
          pendingTools.set(ev.index ?? 0, { id: cb.id ?? "", name: cb.name ?? "", json: "" });
        } else if (cb?.type === "text" && cb.text) {
          yield cb.text;
        }
        break;
      }
      case "content_block_delta": {
        const d = ev.delta;
        if (!d) break;
        if (d.type === "input_json_delta" && typeof d.partial_json === "string") {
          const t = pendingTools.get(ev.index ?? 0);
          if (t) t.json += d.partial_json;
        } else if (d.type === "text_delta" && d.text) {
          yield d.text;
        }
        // Thinking deltas never reach the caller, which appends every yielded delta to the answer.
        break;
      }
      case "content_block_stop": {
        const idx = ev.index ?? 0;
        const t = pendingTools.get(idx);
        if (!t) break;
        pendingTools.delete(idx);
        let input: unknown = {};
        if (t.json.trim()) {
          try {
            input = JSON.parse(t.json);
          } catch {
            input = {};
          }
        }
        h.onToolUse?.({ toolUseId: t.id, name: t.name, input });
        break;
      }
      case "message_delta":
        if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
        mergeUsage(ev.usage);
        break;
      case "error":
        throw new AiError(`anthropic stream error: ${ev.error?.message ?? ev.error?.type ?? "unknown"}`, 0, false);
      default:
        break;
    }
  }

  if (usage && h.onUsage) h.onUsage(usage);
  return stopReason;
}
