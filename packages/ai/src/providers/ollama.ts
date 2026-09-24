/** Ollama client (`POST {baseUrl}/api/chat`, streaming newline-delimited JSON). */
import type { AiEndpoint } from "../config.js";
import { AiError, fetchWithRetry, joinUrl, jsonHeaders, readNdjson } from "./transport.js";
import {
  DEFAULT_MAX_TOKENS,
  normalizeHandlers,
  type StopReason,
  type ToolUse,
  type TurnHandlersArg,
  type TurnRequest,
} from "../types.js";

interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  images?: string[];
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
  /** On a `tool` message: which tool produced the content. */
  tool_name?: string;
}

/** Ollama keys a tool result by tool name, not call id, so names are looked up from earlier calls. */
export function toOllamaMessages(req: TurnRequest): OllamaMessage[] {
  const out: OllamaMessage[] = [];
  const systemText = [req.cachedPrefix, req.system].filter(Boolean).join("\n\n");
  if (systemText) out.push({ role: "system", content: systemText });

  const nameOf = new Map<string, string>();
  for (const m of req.messages) {
    const text: string[] = [];
    const images: string[] = [];
    const toolCalls: NonNullable<OllamaMessage["tool_calls"]> = [];
    const toolResults: OllamaMessage[] = [];

    for (const block of m.content) {
      if ("text" in block) {
        text.push(block.text);
      } else if ("image" in block) {
        images.push(block.image.source.bytes);
      } else if ("toolUse" in block) {
        nameOf.set(block.toolUse.toolUseId, block.toolUse.name);
        toolCalls.push({
          function: {
            name: block.toolUse.name,
            arguments: (block.toolUse.input && typeof block.toolUse.input === "object"
              ? block.toolUse.input
              : {}) as Record<string, unknown>,
          },
        });
      } else if ("toolResult" in block) {
        const r: OllamaMessage = { role: "tool", content: block.toolResult.content.map((c) => c.text).join("\n") };
        const name = nameOf.get(block.toolResult.toolUseId);
        if (name) r.tool_name = name;
        toolResults.push(r);
      }
    }

    if (text.length || toolCalls.length || images.length) {
      const msg: OllamaMessage = { role: m.role, content: text.join("\n") };
      if (images.length) msg.images = images;
      if (toolCalls.length) msg.tool_calls = toolCalls;
      out.push(msg);
    }
    out.push(...toolResults);
  }
  return out;
}

function buildOllamaBody(req: TurnRequest): Record<string, unknown> {
  return {
    model: req.modelId,
    messages: toOllamaMessages(req),
    stream: true,
    options: { num_predict: req.maxTokens ?? DEFAULT_MAX_TOKENS },
    ...(req.tools && req.tools.length
      ? {
          tools: req.tools.map((t) => ({
            type: "function" as const,
            function: { name: t.name, description: t.description, parameters: t.inputSchema.json },
          })),
        }
      : {}),
  };
}

interface StreamChunk {
  message?: {
    content?: string;
    thinking?: string;
    tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }>;
  };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

/**
 * Stream one turn. The `done` chunk carries the stop reason and token counts;
 * `thinking` is never yielded. Tool calls arrive whole and get sequential ids
 * when the wire carries none.
 */
export async function* ollamaStream(
  ep: AiEndpoint,
  req: TurnRequest,
  handlers?: TurnHandlersArg,
): AsyncGenerator<string, StopReason | undefined> {
  const h = normalizeHandlers(handlers);
  const res = await fetchWithRetry(
    "ollama chat",
    (signal) =>
      fetch(joinUrl(ep.baseUrl, "/api/chat"), {
        method: "POST",
        headers: jsonHeaders(ep.apiKey),
        body: JSON.stringify(buildOllamaBody(req)),
        signal,
      }),
    { signal: req.signal },
  );
  if (!res.body) throw new AiError("ollama chat: empty body", res.status, true);

  const tools: ToolUse[] = [];
  let doneReason: string | undefined;
  let usage: { inputTokens: number; outputTokens: number } | null = null;

  for await (const chunk of readNdjson<StreamChunk>(res.body)) {
    if (chunk.error) throw new AiError(`ollama stream error: ${chunk.error}`, 0, false);
    const msg = chunk.message;
    for (const tc of msg?.tool_calls ?? []) {
      const name = tc.function?.name;
      if (!name) continue;
      let input: unknown = tc.function?.arguments ?? {};
      if (typeof input === "string") {
        try {
          input = JSON.parse(input);
        } catch {
          input = {};
        }
      }
      tools.push({ toolUseId: tc.id || `call_${tools.length + 1}`, name, input });
    }
    if (msg?.content) yield msg.content;
    if (chunk.done) {
      doneReason = chunk.done_reason;
      usage = {
        inputTokens: typeof chunk.prompt_eval_count === "number" ? chunk.prompt_eval_count : 0,
        outputTokens: typeof chunk.eval_count === "number" ? chunk.eval_count : 0,
      };
    }
  }

  for (const t of tools) h.onToolUse?.(t);
  if (usage && h.onUsage) h.onUsage({ ...usage, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 });

  if (doneReason === "length") return "max_tokens";
  if (tools.length > 0) return "tool_use";
  return doneReason === undefined ? undefined : "end_turn";
}
