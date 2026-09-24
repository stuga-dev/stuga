/** OpenAI-compatible chat-completions client (`POST {baseUrl}/chat/completions`, streaming SSE). */
import type { AiEndpoint } from "../config.js";
import { AiError, fetchWithRetry, joinUrl, jsonHeaders, readSseJson } from "./transport.js";
import {
  DEFAULT_MAX_TOKENS,
  normalizeHandlers,
  type StopReason,
  type TokenUsage,
  type ToolUse,
  type TurnHandlersArg,
  type TurnRequest,
} from "../types.js";

type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

interface OpenAiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | ContentPart[] | null;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
}

/**
 * Content is a string unless an image rides along (then a parts array with a
 * data URL). Each tool result becomes its own `role:"tool"` message after the
 * turn, and assistant tool calls move to `tool_calls` with JSON-string arguments.
 */
export function toOpenAiMessages(req: TurnRequest): OpenAiMessage[] {
  const out: OpenAiMessage[] = [];

  // No explicit prompt cache here: the cached prefix is folded into the system prompt.
  const systemText = [req.cachedPrefix, req.system].filter(Boolean).join("\n\n");
  if (systemText) out.push({ role: "system", content: systemText });

  for (const m of req.messages) {
    const text: string[] = [];
    const images: string[] = [];
    const toolCalls: NonNullable<OpenAiMessage["tool_calls"]> = [];
    const toolResults: OpenAiMessage[] = [];

    for (const block of m.content) {
      if ("text" in block) {
        text.push(block.text);
      } else if ("image" in block) {
        images.push(`data:image/${block.image.format};base64,${block.image.source.bytes}`);
      } else if ("toolUse" in block) {
        toolCalls.push({
          id: block.toolUse.toolUseId,
          type: "function",
          function: { name: block.toolUse.name, arguments: JSON.stringify(block.toolUse.input ?? {}) },
        });
      } else if ("toolResult" in block) {
        toolResults.push({
          role: "tool",
          tool_call_id: block.toolResult.toolUseId,
          content: block.toolResult.content.map((c) => c.text).join("\n"),
        });
      }
    }

    if (text.length || toolCalls.length || images.length) {
      const msg: OpenAiMessage = { role: m.role };
      if (images.length) {
        msg.content = [
          ...images.map((url) => ({ type: "image_url" as const, image_url: { url } })),
          ...(text.length ? [{ type: "text" as const, text: text.join("\n") }] : []),
        ];
      } else {
        msg.content = text.join("\n") || null;
      }
      if (toolCalls.length) msg.tool_calls = toolCalls;
      out.push(msg);
    }
    out.push(...toolResults);
  }

  return out;
}

function toStopReason(finish: string | null | undefined): StopReason | undefined {
  if (!finish) return undefined;
  if (finish === "tool_calls") return "tool_use";
  if (finish === "length") return "max_tokens";
  if (finish === "stop") return "end_turn";
  return finish;
}

function toUsage(u: Record<string, unknown> | undefined | null): TokenUsage {
  const n = (v: unknown) => (typeof v === "number" ? v : 0);
  const details = (u?.prompt_tokens_details ?? {}) as Record<string, unknown>;
  const cached = n(details.cached_tokens);
  // prompt_tokens includes cached tokens; the ledger records disjoint buckets.
  return {
    inputTokens: Math.max(0, n(u?.prompt_tokens) - cached),
    outputTokens: n(u?.completion_tokens),
    cacheReadInputTokens: cached,
    cacheWriteInputTokens: 0,
  };
}

/** Per endpoint+model departures from the format, learned from rejections. */
interface OpenAiQuirks {
  /** Send the output cap as `max_completion_tokens`, not `max_tokens`. */
  maxCompletionTokens?: boolean;
  /** Pin `reasoning_effort: "none"` on a turn that carries tools. */
  reasoningEffortNone?: boolean;
}

function buildOpenAiBody(req: TurnRequest, quirks: OpenAiQuirks = {}): Record<string, unknown> {
  const hasTools = !!req.tools && req.tools.length > 0;
  return {
    model: req.modelId,
    messages: toOpenAiMessages(req),
    [quirks.maxCompletionTokens ? "max_completion_tokens" : "max_tokens"]: req.maxTokens ?? DEFAULT_MAX_TOKENS,
    // Only with tools, the combination those endpoints refuse; tool-less turns keep their reasoning.
    ...(quirks.reasoningEffortNone && hasTools ? { reasoning_effort: "none" } : {}),
    stream: true,
    // Streamed responses omit usage unless asked.
    stream_options: { include_usage: true },
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

/**
 * Some OpenAI-compatible models refuse `max_tokens` (wanting
 * `max_completion_tokens`) or refuse tools under their default reasoning effort,
 * while most servers do not know either alternative. The endpoint cannot be
 * asked, so a 400 naming one is learned and the request resent. Keyed by base
 * URL and model: one host serves both kinds.
 */
const quirks = new Map<string, OpenAiQuirks>();

/** The not-yet-applied quirk a 400 names, or null for a real error; this is what ends the resend loop. */
function quirkFor(e: unknown, applied: OpenAiQuirks): keyof OpenAiQuirks | null {
  if (!(e instanceof AiError) || e.status !== 400) return null;
  const m = e.message;
  if (!applied.maxCompletionTokens && (m.includes("max_completion_tokens") || (m.includes("max_tokens") && /unsupported|not supported/i.test(m)))) {
    return "maxCompletionTokens";
  }
  if (!applied.reasoningEffortNone && m.includes("reasoning_effort")) return "reasoningEffortNone";
  return null;
}

interface StreamChoice {
  delta?: {
    content?: string | null;
    reasoning_content?: string | null;
    reasoning?: string | null;
    tool_calls?: Array<{
      index?: number;
      id?: string;
      function?: { name?: string; arguments?: string };
    }>;
  };
  finish_reason?: string | null;
}

/**
 * Stream one turn. Reasoning deltas are dropped (callers append every yielded
 * delta to the answer); tool-call arguments are concatenated per index before parsing.
 */
export async function* openaiStream(
  ep: AiEndpoint,
  req: TurnRequest,
  handlers?: TurnHandlersArg,
): AsyncGenerator<string, StopReason | undefined> {
  const h = normalizeHandlers(handlers);
  const key = `${ep.baseUrl}\u0000${req.modelId}`;
  const post = (applied: OpenAiQuirks) =>
    fetchWithRetry(
      "chat completions",
      (signal) =>
        fetch(joinUrl(ep.baseUrl, "/chat/completions"), {
          method: "POST",
          headers: jsonHeaders(ep.apiKey),
          body: JSON.stringify(buildOpenAiBody(req, applied)),
          signal,
        }),
      { signal: req.signal },
    );
  const applied: OpenAiQuirks = { ...quirks.get(key) };
  let res: Response;
  for (;;) {
    try {
      res = await post(applied);
      break;
    } catch (e) {
      const q = quirkFor(e, applied);
      if (!q) throw e;
      applied[q] = true;
      quirks.set(key, { ...applied });
    }
  }
  if (!res.body) throw new AiError("chat completions: empty body", res.status, true);

  let stopReason: StopReason | undefined;
  let usage: TokenUsage | null = null;
  const pending = new Map<number, { id: string; name: string; args: string }>();

  for await (const parsed of readSseJson<{ choices?: StreamChoice[]; usage?: Record<string, unknown> }>(res.body)) {
    if (parsed.usage) usage = toUsage(parsed.usage);

    const choice = parsed.choices?.[0];
    if (!choice) continue;

    for (const tc of choice.delta?.tool_calls ?? []) {
      const idx = tc.index ?? 0;
      const cur = pending.get(idx) ?? { id: "", name: "", args: "" };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.name = tc.function.name;
      if (tc.function?.arguments) cur.args += tc.function.arguments;
      pending.set(idx, cur);
    }

    if (choice.delta?.content) yield choice.delta.content;

    if (choice.finish_reason) stopReason = toStopReason(choice.finish_reason);
  }

  // Emitted before returning, so the caller has every ToolUse when it reads the stop reason.
  let seq = 0;
  for (const [, t] of [...pending].sort((a, b) => a[0] - b[0])) {
    if (!t.name) continue;
    let input: unknown = {};
    if (t.args.trim()) {
      try {
        input = JSON.parse(t.args);
      } catch {
        input = {};
      }
    }
    const tool: ToolUse = { toolUseId: t.id || `call_${++seq}`, name: t.name, input };
    h.onToolUse?.(tool);
  }
  // A model that called tools but reported a plain "stop" still wants them run.
  if (pending.size > 0 && stopReason !== "max_tokens") stopReason = "tool_use";

  if (usage && h.onUsage) h.onUsage(usage);
  return stopReason;
}
