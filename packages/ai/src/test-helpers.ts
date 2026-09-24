/** Unit-test harness: a config on fake hosts and scripted streamed turns; tests stub `fetch`. */
import { vi } from "vitest";
import type { AiConfig } from "./config.js";

/** Chat on the Anthropic provider, embeddings on an OpenAI-compatible endpoint. */
export const CFG: AiConfig = {
  enabled: true,
  chat: {
    enabled: true,
    defaultModel: "sonnet",
    endpoints: [
      {
        id: "default",
        provider: "anthropic",
        baseUrl: "https://chat.example.test",
        apiKey: "test-key",
        models: [
          { id: "sonnet", name: "Sonnet" },
          { id: "fast", name: "Fast" },
        ],
      },
    ],
  },
  embed: {
    enabled: true,
    provider: "openai",
    baseUrl: "https://embed.example.test/v1",
    apiKey: "embed-key",
    model: "text-embedding-3-large",
    dims: 1024,
    searchMaxDistance: 0.6,
    retrievalMaxDistance: 0.9,
  },
};

const te = new TextEncoder();

/** A ReadableStream that serves the given text chunks in order, then closes. */
export function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(c) {
      if (i < chunks.length) c.enqueue(te.encode(chunks[i++]!));
      else c.close();
    },
  });
}

/** One server-sent event: `event:` line, `data:` line, blank separator. */
export function sse(type: string, payload: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}

/** The events that open every streamed message (with the input-side usage). */
function messageStart(usage: { inputTokens: number; outputTokens: number }): string {
  return sse("message_start", {
    message: { id: "msg_1", role: "assistant", usage: { input_tokens: usage.inputTokens, output_tokens: 1 } },
  });
}

/** The events that close every streamed message (stop reason + output usage). */
function messageEnd(stopReason: string, usage: { inputTokens: number; outputTokens: number }): string {
  return (
    sse("message_delta", { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: usage.outputTokens } }) +
    sse("message_stop", {})
  );
}

const DEFAULT_USAGE = { inputTokens: 12, outputTokens: 7 };

/** A text-only round that ends the turn. */
export function textRound(text: string, usage = DEFAULT_USAGE): string[] {
  return [
    messageStart(usage),
    sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
    sse("content_block_delta", { index: 0, delta: { type: "text_delta", text } }),
    sse("content_block_stop", { index: 0 }),
    messageEnd("end_turn", usage),
  ];
}

/** A round cut off by the output-token cap before any usable tool call. */
export function maxTokensRound(text: string): string[] {
  return [
    messageStart(DEFAULT_USAGE),
    sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
    sse("content_block_delta", { index: 0, delta: { type: "text_delta", text } }),
    sse("content_block_stop", { index: 0 }),
    messageEnd("max_tokens", DEFAULT_USAGE),
  ];
}

/**
 * A max_tokens round with NO emitted text — thinking exhausted the budget before
 * any visible delta or tool input (the "zero emitted" case). Leaves roundText "".
 */
export function maxTokensEmptyRound(): string[] {
  return [messageStart(DEFAULT_USAGE), messageEnd("max_tokens", DEFAULT_USAGE)];
}

/** A round that emits optional prose then requests one tool. */
export function toolRound(name: string, input: unknown, opts?: { text?: string; id?: string }): string[] {
  const idx = opts?.text ? 1 : 0;
  const ev: string[] = [messageStart(DEFAULT_USAGE)];
  if (opts?.text) {
    ev.push(sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } }));
    ev.push(sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: opts.text } }));
    ev.push(sse("content_block_stop", { index: 0 }));
  }
  ev.push(sse("content_block_start", { index: idx, content_block: { type: "tool_use", id: opts?.id ?? "tu", name, input: {} } }));
  ev.push(sse("content_block_delta", { index: idx, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } }));
  ev.push(sse("content_block_stop", { index: idx }));
  ev.push(messageEnd("tool_use", DEFAULT_USAGE));
  return ev;
}

/** Mock fetch that serves one scripted round per call (the last round repeats). */
export function mockRounds(rounds: string[][]): () => number {
  let call = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      const ev = rounds[Math.min(call, rounds.length - 1)]!;
      call++;
      return Promise.resolve(new Response(streamOf(ev), { status: 200 }));
    }),
  );
  return () => call;
}

/** Mock fetch that answers every call with one text reply and the given usage. */
export function mockStreamFromText(text: string, usage = DEFAULT_USAGE): void {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(streamOf(textRound(text, usage)), { status: 200 }))));
}

/** The parsed JSON body of the n-th (default first) request the stubbed fetch saw. */
export function sentBody<T = Record<string, unknown>>(n = 0): T {
  const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[n]!;
  return JSON.parse((call[1] as RequestInit).body as string) as T;
}

/** Drain a stream generator, collecting its text and RETURN value. */
export async function drain(gen: AsyncGenerator<string, string | undefined>): Promise<{ text: string; stopReason?: string }> {
  let text = "";
  let r = await gen.next();
  while (!r.done) {
    text += r.value;
    r = await gen.next();
  }
  return { text, stopReason: r.value };
}

// ---- Other wire formats, for the tests that point the config elsewhere ------

/** An OpenAI-compatible SSE body from chunk objects, terminated by `[DONE]`. */
export function openaiSse(chunks: unknown[]): string[] {
  return [...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`), "data: [DONE]\n\n"];
}

/** One chat-completions delta chunk. */
export function openaiDelta(delta: unknown, finish: string | null = null): unknown {
  return { choices: [{ delta, finish_reason: finish }] };
}

/** A complete chat-completions text reply with usage. */
export function openaiTextRound(text: string, usage = DEFAULT_USAGE): string[] {
  return openaiSse([
    openaiDelta({ content: text }),
    openaiDelta({}, "stop"),
    { choices: [], usage: { prompt_tokens: usage.inputTokens, completion_tokens: usage.outputTokens } },
  ]);
}

/** A newline-delimited JSON body from chunk objects. */
export function ndjson(chunks: unknown[]): string[] {
  return chunks.map((c) => `${JSON.stringify(c)}\n`);
}

/** A complete Ollama text reply: content chunks, then the `done` line with counts. */
export function ollamaTextRound(text: string, usage = DEFAULT_USAGE): string[] {
  return ndjson([
    { message: { role: "assistant", content: text }, done: false },
    {
      message: { role: "assistant", content: "" },
      done: true,
      done_reason: "stop",
      prompt_eval_count: usage.inputTokens,
      eval_count: usage.outputTokens,
    },
  ]);
}
