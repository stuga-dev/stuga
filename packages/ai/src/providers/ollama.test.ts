/**
 * Ollama client tests: the /api/chat request shape, the newline-delimited JSON
 * stream, whole tool calls (arguments arrive as objects, ids are minted), and
 * the token counts on the final `done` line. Stubbed fetch throughout.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { ollamaStream, toOllamaMessages } from "./ollama.js";
import type { TokenUsage, ToolUse } from "../types.js";
import { drain, ndjson, ollamaTextRound, streamOf } from "../test-helpers.js";

const EP = { provider: "ollama" as const, baseUrl: "http://ollama.example.test:11434" };
const USER = [{ role: "user" as const, content: [{ text: "x" }] }];

function mockLines(chunks: unknown[]) {
  const fn = vi.fn(async () => new Response(streamOf(ndjson(chunks)), { status: 200 }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe("request shape", () => {
  it("posts to /api/chat with stream, num_predict and function tools, no auth header", async () => {
    const fn = vi.fn(async () => new Response(streamOf(ollamaTextRound("hi")), { status: 200 }));
    vi.stubGlobal("fetch", fn);
    await drain(
      ollamaStream(EP, {
        modelId: "llama3.1",
        system: "sys",
        messages: USER,
        maxTokens: 300,
        tools: [{ name: "search", description: "find", inputSchema: { json: { type: "object" } } }],
      }),
    );
    const [url, init] = fn.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("http://ollama.example.test:11434/api/chat");
    expect("authorization" in (init.headers as object)).toBe(false);
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("llama3.1");
    expect(body.stream).toBe(true);
    expect(body.options).toEqual({ num_predict: 300 });
    expect(body.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "x" },
    ]);
    expect(body.tools).toEqual([{ type: "function", function: { name: "search", description: "find", parameters: { type: "object" } } }]);
  });
});

describe("message translation", () => {
  it("puts images beside the text and tool results in their own tool message, named by the call", () => {
    const msgs = toOllamaMessages({
      modelId: "m",
      messages: [
        { role: "user", content: [{ image: { format: "png", source: { bytes: "AAA=" } } }, { text: "look" }] },
        { role: "assistant", content: [{ toolUse: { toolUseId: "c1", name: "search", input: { q: "x" } } }] },
        { role: "user", content: [{ toolResult: { toolUseId: "c1", content: [{ text: "result" }] } }] },
      ],
    });
    expect(msgs[0]).toEqual({ role: "user", content: "look", images: ["AAA="] });
    expect(msgs[1]).toEqual({ role: "assistant", content: "", tool_calls: [{ function: { name: "search", arguments: { q: "x" } } }] });
    expect(msgs[2]).toEqual({ role: "tool", content: "result", tool_name: "search" });
  });
});

describe("streaming", () => {
  it("yields content chunks, returns end_turn and reports the counts from the done line", async () => {
    mockLines([
      { message: { role: "assistant", content: "Hel" }, done: false },
      { message: { role: "assistant", content: "lo" }, done: false },
      { message: { role: "assistant", content: "" }, done: true, done_reason: "stop", prompt_eval_count: 11, eval_count: 3 },
    ]);
    let usage: TokenUsage | undefined;
    const { text, stopReason } = await drain(ollamaStream(EP, { modelId: "m", messages: USER }, (u) => (usage = u)));
    expect(text).toBe("Hello");
    expect(stopReason).toBe("end_turn");
    expect(usage).toEqual({ inputTokens: 11, outputTokens: 3, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 });
  });

  it("never yields thinking", async () => {
    mockLines([
      { message: { role: "assistant", content: "", thinking: "hmm" }, done: false },
      { message: { role: "assistant", content: "Answer." }, done: true, done_reason: "stop" },
    ]);
    const { text } = await drain(ollamaStream(EP, { modelId: "m", messages: USER }));
    expect(text).toBe("Answer.");
  });

  it("reports whole tool calls with minted ids and returns tool_use", async () => {
    mockLines([
      {
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            { function: { name: "search", arguments: { q: "deploys" } } },
            { function: { name: "read", arguments: '{"offset":1}' } },
          ],
        },
        done: false,
      },
      { message: { role: "assistant", content: "" }, done: true, done_reason: "stop", prompt_eval_count: 5, eval_count: 9 },
    ]);
    const tools: ToolUse[] = [];
    const { stopReason } = await drain(ollamaStream(EP, { modelId: "m", messages: USER }, { onToolUse: (t) => tools.push(t) }));
    expect(stopReason).toBe("tool_use");
    expect(tools).toEqual([
      { toolUseId: "call_1", name: "search", input: { q: "deploys" } },
      { toolUseId: "call_2", name: "read", input: { offset: 1 } },
    ]);
  });

  it("maps done_reason length to max_tokens", async () => {
    mockLines([{ message: { role: "assistant", content: "cut" }, done: true, done_reason: "length" }]);
    const { stopReason } = await drain(ollamaStream(EP, { modelId: "m", messages: USER }));
    expect(stopReason).toBe("max_tokens");
  });

  it("throws on an in-stream error line", async () => {
    mockLines([{ error: "model not found" }]);
    await expect(drain(ollamaStream(EP, { modelId: "m", messages: USER }))).rejects.toThrow(/ollama stream error: model not found/);
  });

  it("throws on a non-2xx", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no such model", { status: 404 })));
    await expect(drain(ollamaStream(EP, { modelId: "m", messages: USER }))).rejects.toThrow(/ollama chat 404: no such model/);
  });
});
