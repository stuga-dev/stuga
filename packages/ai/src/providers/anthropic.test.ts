/**
 * Anthropic Messages client tests. fetch is stubbed, so the targets are the
 * request shape (path, auth header, system array with its cache marker, tool
 * definitions), the server-sent-event parse (text deltas, split reads), tool-call
 * assembly from partial-JSON fragments, and the merged usage report.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { anthropicStream, ANTHROPIC_VERSION, toAnthropicMessages } from "./anthropic.js";
import type { TokenUsage, ToolUse } from "../types.js";
import { CFG, drain, sse, streamOf, textRound, toolRound } from "../test-helpers.js";

const EP = CFG.chat.endpoints[0]!;
const USER = [{ role: "user" as const, content: [{ text: "hi" }] }];

function mockFetch(impl: (url: string, init: RequestInit) => Response) {
  const fn = vi.fn((url: unknown, init: unknown) => Promise.resolve(impl(String(url), (init ?? {}) as RequestInit)));
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe("request shape", () => {
  it("posts to /v1/messages with the key + version headers, a system array and max_tokens", async () => {
    const fetchFn = mockFetch(() => new Response(streamOf(textRound("hi")), { status: 200 }));
    await drain(anthropicStream(EP, { modelId: "claude-sonnet-4-6", system: "be brief", messages: USER }));
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://chat.example.test/v1/messages");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("test-key");
    expect(headers["anthropic-version"]).toBe(ANTHROPIC_VERSION);
    expect(headers.authorization).toBeUndefined();
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe("claude-sonnet-4-6");
    expect(body.stream).toBe(true);
    expect(body.system).toEqual([{ type: "text", text: "be brief" }]);
    expect(body.max_tokens).toBe(2048);
    expect(body.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] }]);
    expect("temperature" in body).toBe(false);
  });

  it("does not double the slash when the base URL has a trailing one", async () => {
    const fetchFn = mockFetch(() => new Response(streamOf(textRound("hi")), { status: 200 }));
    await drain(anthropicStream({ ...EP, baseUrl: "https://chat.example.test/" }, { modelId: "m", messages: USER }));
    expect(fetchFn.mock.calls[0]![0]).toBe("https://chat.example.test/v1/messages");
  });

  it("marks the cachedPrefix with cache_control and leaves the per-turn system unmarked", async () => {
    const fetchFn = mockFetch(() => new Response(streamOf([]), { status: 200 }));
    await drain(anthropicStream(EP, { modelId: "m", cachedPrefix: "STABLE", system: "sys", messages: USER }));
    const body = JSON.parse((fetchFn.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.system).toEqual([
      { type: "text", text: "STABLE", cache_control: { type: "ephemeral" } },
      { type: "text", text: "sys" },
    ]);
  });

  it("marks the conversation's last block for caching and no earlier one", async () => {
    const fetchFn = mockFetch(() => new Response(streamOf([]), { status: 200 }));
    await drain(
      anthropicStream(EP, {
        modelId: "m",
        messages: [
          { role: "user", content: [{ text: "find it" }] },
          { role: "assistant", content: [{ toolUse: { toolUseId: "tu1", name: "search", input: {} } }] },
          { role: "user", content: [{ toolResult: { toolUseId: "tu1", content: [{ text: "a" }] } }, { text: "go on" }] },
        ],
      }),
    );
    const body = JSON.parse((fetchFn.mock.calls[0]![1] as RequestInit).body as string);
    const marked = body.messages.flatMap((m: { content: object[] }) => m.content).filter((b: object) => "cache_control" in b);
    expect(marked).toEqual([{ type: "text", text: "go on", cache_control: { type: "ephemeral" } }]);
  });

  it("sends tools as input_schema definitions when provided", async () => {
    const fetchFn = mockFetch(() => new Response(streamOf([]), { status: 200 }));
    await drain(
      anthropicStream(EP, {
        modelId: "m",
        messages: USER,
        tools: [{ name: "read_document", description: "read a range", inputSchema: { json: { type: "object" } } }],
      }),
    );
    const body = JSON.parse((fetchFn.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.tools).toEqual([{ name: "read_document", description: "read a range", input_schema: { type: "object" } }]);
  });

  it("translates images, tool calls and tool results into content blocks", () => {
    const msgs = toAnthropicMessages([
      { role: "user", content: [{ image: { format: "png", source: { bytes: "AAA=" } } }, { text: "what is this" }] },
      { role: "assistant", content: [{ toolUse: { toolUseId: "tu1", name: "search", input: { q: "x" } } }] },
      { role: "user", content: [{ toolResult: { toolUseId: "tu1", content: [{ text: "boom" }], status: "error" } }] },
    ]);
    expect(msgs[0]!.content[0]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "AAA=" } });
    expect(msgs[1]!.content[0]).toEqual({ type: "tool_use", id: "tu1", name: "search", input: { q: "x" } });
    expect(msgs[2]!.content[0]).toEqual({
      type: "tool_result",
      tool_use_id: "tu1",
      content: [{ type: "text", text: "boom" }],
      is_error: true,
    });
  });
});

describe("streaming", () => {
  it("yields text deltas, returns the stop reason and reports merged usage once", async () => {
    const events = [
      sse("message_start", {
        message: { usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 40, cache_creation_input_tokens: 5 } },
      }),
      sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
      sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: "The " } }),
      sse("ping", {}),
      sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: "ocean." } }),
      sse("content_block_stop", { index: 0 }),
      sse("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } }),
      sse("message_stop", {}),
    ];
    mockFetch(() => new Response(streamOf(events), { status: 200 }));
    const usages: TokenUsage[] = [];
    const { text, stopReason } = await drain(anthropicStream(EP, { modelId: "m", messages: USER }, (u) => usages.push(u)));
    expect(text).toBe("The ocean.");
    expect(stopReason).toBe("end_turn");
    expect(usages).toEqual([{ inputTokens: 100, outputTokens: 7, cacheReadInputTokens: 40, cacheWriteInputTokens: 5 }]);
  });

  it("reassembles events split across arbitrary read boundaries", async () => {
    const whole = textRound("reassembled").join("");
    const cuts = [3, 40, 41, 150, whole.length - 2];
    const chunks: string[] = [];
    let prev = 0;
    for (const c of cuts) {
      chunks.push(whole.slice(prev, c));
      prev = c;
    }
    chunks.push(whole.slice(prev));
    mockFetch(() => new Response(streamOf(chunks), { status: 200 }));
    const { text } = await drain(anthropicStream(EP, { modelId: "m", messages: USER }));
    expect(text).toBe("reassembled");
  });

  it("never yields thinking deltas", async () => {
    const events = [
      sse("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } }),
      sse("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "let me think" } }),
      sse("content_block_stop", { index: 0 }),
      sse("content_block_start", { index: 1, content_block: { type: "text", text: "" } }),
      sse("content_block_delta", { index: 1, delta: { type: "text_delta", text: "Answer." } }),
      sse("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }),
    ];
    mockFetch(() => new Response(streamOf(events), { status: 200 }));
    const { text } = await drain(anthropicStream(EP, { modelId: "m", messages: USER }));
    expect(text).toBe("Answer.");
  });

  it("throws on an error event instead of ending silently", async () => {
    const events = [
      sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: "partial" } }),
      sse("error", { error: { type: "overloaded_error", message: "Overloaded" } }),
    ];
    mockFetch(() => new Response(streamOf(events), { status: 200 }));
    await expect(drain(anthropicStream(EP, { modelId: "m", messages: USER }))).rejects.toThrow(/anthropic stream error: Overloaded/);
  });

  it("throws on a non-2xx before streaming, with the body", async () => {
    mockFetch(() => new Response("nope", { status: 400 }));
    await expect(drain(anthropicStream(EP, { modelId: "m", messages: USER }))).rejects.toThrow(/anthropic messages 400: nope/);
  });
});

describe("tool use", () => {
  it("assembles a tool call from partial-JSON fragments and reports tool_use", async () => {
    const tools: ToolUse[] = [];
    const events = [
      sse("content_block_start", { index: 0, content_block: { type: "tool_use", id: "tu_1", name: "read_document", input: {} } }),
      sse("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: '{"start' } }),
      sse("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: '":10,"en' } }),
      sse("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: 'd":20}' } }),
      sse("content_block_stop", { index: 0 }),
      sse("message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } }),
    ];
    mockFetch(() => new Response(streamOf(events), { status: 200 }));
    const { stopReason } = await drain(
      anthropicStream(EP, { modelId: "m", messages: USER, tools: [{ name: "read_document", description: "d", inputSchema: { json: {} } }] }, {
        onToolUse: (t) => tools.push(t),
      }),
    );
    expect(stopReason).toBe("tool_use");
    expect(tools).toEqual([{ toolUseId: "tu_1", name: "read_document", input: { start: 10, end: 20 } }]);
  });

  it("interleaves text and a tool call in one turn", async () => {
    const tools: ToolUse[] = [];
    mockFetch(() => new Response(streamOf(toolRound("search_collection", { query: "revenue" }, { text: "Let me check. ", id: "tu_2" })), { status: 200 }));
    const { text, stopReason } = await drain(anthropicStream(EP, { modelId: "m", messages: USER }, { onToolUse: (t) => tools.push(t) }));
    expect(text).toBe("Let me check. ");
    expect(stopReason).toBe("tool_use");
    expect(tools).toEqual([{ toolUseId: "tu_2", name: "search_collection", input: { query: "revenue" } }]);
  });

  it("a plain text turn returns end_turn and fires no tool", async () => {
    const tools: ToolUse[] = [];
    mockFetch(() => new Response(streamOf(textRound("done")), { status: 200 }));
    const { text, stopReason } = await drain(anthropicStream(EP, { modelId: "m", messages: USER }, { onToolUse: (t) => tools.push(t) }));
    expect(text).toBe("done");
    expect(stopReason).toBe("end_turn");
    expect(tools).toHaveLength(0);
  });

  it("tolerates malformed tool JSON (empty object, no throw)", async () => {
    const tools: ToolUse[] = [];
    const events = [
      sse("content_block_start", { index: 0, content_block: { type: "tool_use", id: "tu_3", name: "read_document", input: {} } }),
      sse("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: '{"start": NOT_JSON' } }),
      sse("content_block_stop", { index: 0 }),
      sse("message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } }),
    ];
    mockFetch(() => new Response(streamOf(events), { status: 200 }));
    const { stopReason } = await drain(anthropicStream(EP, { modelId: "m", messages: USER }, { onToolUse: (t) => tools.push(t) }));
    expect(stopReason).toBe("tool_use");
    expect(tools[0]!.input).toEqual({});
  });
});
