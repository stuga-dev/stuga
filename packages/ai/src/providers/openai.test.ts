/**
 * OpenAI-compatible chat-completions client tests. The risky parts are the
 * TRANSLATIONS, not the transport: neutral content blocks → chat messages, and
 * the SSE stream → the package's yield/return contract. Stubbed fetch throughout.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { openaiStream, toOpenAiMessages } from "./openai.js";
import type { TokenUsage, ToolUse } from "../types.js";
import { CFG, drain, openaiDelta as delta, openaiSse, streamOf } from "../test-helpers.js";

const EP = { ...CFG.chat.endpoints[0]!, provider: "openai" as const, baseUrl: "https://llm.example.test/v1", apiKey: "sk-test" };
const USER = [{ role: "user" as const, content: [{ text: "x" }] }];

function mockSse(chunks: unknown[]) {
  const fn = vi.fn(async () => new Response(streamOf(openaiSse(chunks)), { status: 200 }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe("request shape", () => {
  it("posts to {baseUrl}/chat/completions with a bearer token, stream + usage opt-in", async () => {
    const fn = mockSse([delta({ content: "hi" }), delta({}, "stop")]);
    await drain(openaiStream(EP, { modelId: "gpt-x", system: "sys", messages: USER, maxTokens: 512 }));
    const [url, init] = fn.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://llm.example.test/v1/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-test");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("gpt-x");
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.max_tokens).toBe(512);
    expect(body.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "x" },
    ]);
  });

  it("sends tools as function definitions", async () => {
    const fn = mockSse([delta({}, "stop")]);
    await drain(
      openaiStream(EP, {
        modelId: "m",
        messages: USER,
        tools: [{ name: "search", description: "find", inputSchema: { json: { type: "object", properties: {} } } }],
      }),
    );
    const body = JSON.parse((fn.mock.calls[0]! as unknown as [string, RequestInit])[1].body as string);
    expect(body.tools).toEqual([
      { type: "function", function: { name: "search", description: "find", parameters: { type: "object", properties: {} } } },
    ]);
  });

  it("omits the authorization header when no key is configured (a local proxy)", async () => {
    const fn = mockSse([delta({}, "stop")]);
    await drain(openaiStream({ ...EP, apiKey: undefined }, { modelId: "m", messages: USER }));
    expect("authorization" in ((fn.mock.calls[0]! as unknown as [string, RequestInit])[1].headers as object)).toBe(false);
  });
});

describe("message translation", () => {
  it("folds system + cachedPrefix into one system message", () => {
    const msgs = toOpenAiMessages({ modelId: "m", system: "sys", cachedPrefix: "doc", messages: [{ role: "user", content: [{ text: "hi" }] }] });
    expect(msgs[0]).toEqual({ role: "system", content: "doc\n\nsys" });
    expect(msgs[1]).toEqual({ role: "user", content: "hi" });
  });

  it("moves a toolResult out of the user turn into its own tool message", () => {
    const msgs = toOpenAiMessages({
      modelId: "m",
      messages: [
        { role: "assistant", content: [{ toolUse: { toolUseId: "c1", name: "search", input: { q: "x" } } }] },
        { role: "user", content: [{ toolResult: { toolUseId: "c1", content: [{ text: "result" }] } }] },
      ],
    });
    expect(msgs[0]!.tool_calls).toEqual([{ id: "c1", type: "function", function: { name: "search", arguments: '{"q":"x"}' } }]);
    // The result must be role:"tool" keyed by tool_call_id, NOT user content —
    // a user message here would break the pairing.
    expect(msgs[1]).toEqual({ role: "tool", tool_call_id: "c1", content: "result" });
    expect(msgs.some((m) => m.role === "user")).toBe(false);
  });

  it("renders an image as a data-URL part ahead of the text", () => {
    const msgs = toOpenAiMessages({
      modelId: "m",
      messages: [{ role: "user", content: [{ image: { format: "png", source: { bytes: "AAA=" } } }, { text: "look" }] }],
    });
    expect(msgs[0]!.content).toEqual([
      { type: "image_url", image_url: { url: "data:image/png;base64,AAA=" } },
      { type: "text", text: "look" },
    ]);
  });
});

describe("streaming", () => {
  it("yields content deltas and returns the mapped stop reason", async () => {
    mockSse([delta({ content: "Hello" }), delta({ content: " world" }), delta({}, "stop")]);
    const { text, stopReason } = await drain(openaiStream(EP, { modelId: "m", messages: USER }));
    expect(text).toBe("Hello world");
    expect(stopReason).toBe("end_turn");
  });

  it("NEVER yields reasoning_content — chain-of-thought must not reach the document", async () => {
    mockSse([
      delta({ reasoning_content: "The user wants me to" }),
      delta({ reasoning_content: " think about this" }),
      delta({ content: "Answer." }),
      delta({}, "stop"),
    ]);
    const { text } = await drain(openaiStream(EP, { modelId: "m", messages: USER }));
    expect(text).toBe("Answer.");
  });

  it("assembles fragmented tool-call arguments and reports tool_use", async () => {
    mockSse([
      delta({ tool_calls: [{ index: 0, id: "c1", function: { name: "search_collection" } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: '{"que' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: 'ry":"deploys"}' } }] }),
      delta({}, "tool_calls"),
    ]);
    const tools: ToolUse[] = [];
    const { stopReason } = await drain(openaiStream(EP, { modelId: "m", messages: USER }, { onToolUse: (t) => tools.push(t) }));
    // The loop compares against the package's vocabulary, not the provider's.
    expect(stopReason).toBe("tool_use");
    expect(tools).toEqual([{ toolUseId: "c1", name: "search_collection", input: { query: "deploys" } }]);
  });

  it("assembles two parallel tool calls by index, in order", async () => {
    mockSse([
      delta({ tool_calls: [{ index: 0, id: "a", function: { name: "read", arguments: "{}" } }] }),
      delta({ tool_calls: [{ index: 1, id: "b", function: { name: "search", arguments: '{"q":"x"}' } }] }),
      delta({}, "tool_calls"),
    ]);
    const tools: ToolUse[] = [];
    await drain(openaiStream(EP, { modelId: "m", messages: USER }, { onToolUse: (t) => tools.push(t) }));
    expect(tools.map((t) => t.toolUseId)).toEqual(["a", "b"]);
    expect(tools[1]!.input).toEqual({ q: "x" });
  });

  it("treats a tool call finished with a plain 'stop' as tool_use", async () => {
    mockSse([delta({ tool_calls: [{ index: 0, id: "c1", function: { name: "read", arguments: "{}" } }] }), delta({}, "stop")]);
    const { stopReason } = await drain(openaiStream(EP, { modelId: "m", messages: USER }, {}));
    expect(stopReason).toBe("tool_use");
  });

  it("splits cached tokens out of prompt_tokens so cached input isn't counted twice", async () => {
    mockSse([
      delta({ content: "x" }),
      delta({}, "stop"),
      { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 30 } } },
    ]);
    let usage: TokenUsage | undefined;
    await drain(openaiStream(EP, { modelId: "m", messages: USER }, (u) => (usage = u)));
    expect(usage).toEqual({ inputTokens: 70, outputTokens: 20, cacheReadInputTokens: 30, cacheWriteInputTokens: 0 });
  });

  it("maps a truncated turn to max_tokens so the agent's recovery nudge fires", async () => {
    mockSse([delta({ content: "cut" }), delta({}, "length")]);
    const { stopReason } = await drain(openaiStream(EP, { modelId: "m", messages: USER }));
    expect(stopReason).toBe("max_tokens");
  });

  it("surfaces a non-retryable endpoint error instead of hanging", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"error":"Invalid model"}', { status: 400 })));
    await expect(drain(openaiStream(EP, { modelId: "m", messages: USER }))).rejects.toThrow(/chat completions 400/);
  });
});

/** Quirks learned from 400 rejections. */
describe("quirks learned from a rejection", () => {
  const CAP_REJECTION =
    '{"error":{"message":"Unsupported parameter: \'max_tokens\' is not supported with this model. Use \'max_completion_tokens\' instead.","type":"invalid_request_error","param":"max_tokens","code":"unsupported_parameter"}}';
  const TOOLS_REJECTION =
    '{"error":{"message":"Function tools with reasoning_effort are not supported for gpt-5.6-terra in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to \'none\'.","type":"invalid_request_error","param":"reasoning_effort","code":null}}';

  const TOOLS = [{ name: "search", description: "find", inputSchema: { json: { type: "object", properties: {} } } }];

  /** Refuses each named quirk until the body carries its adjustment. */
  function mockDemanding(want: { cap?: boolean; effort?: boolean }, chunks: unknown[]) {
    const fn = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      if (want.cap && "max_tokens" in body) return new Response(CAP_REJECTION, { status: 400 });
      if (want.effort && body.tools && body.reasoning_effort !== "none") return new Response(TOOLS_REJECTION, { status: 400 });
      return new Response(streamOf(openaiSse(chunks)), { status: 200 });
    });
    vi.stubGlobal("fetch", fn);
    return fn;
  }

  it("resends under max_completion_tokens when the model refuses max_tokens", async () => {
    const fn = mockDemanding({ cap: true }, [delta({ content: "hi" }), delta({}, "stop")]);
    const { text } = await drain(openaiStream(EP, { modelId: "o-series-1", messages: USER, maxTokens: 512 }));
    expect(text).toBe("hi");
    const bodies = fn.mock.calls.map((c) => JSON.parse((c[1] as RequestInit).body as string));
    expect(bodies[0]!.max_tokens).toBe(512);
    expect(bodies[1]!.max_completion_tokens).toBe(512);
    expect("max_tokens" in bodies[1]!).toBe(false);
  });

  it("pins reasoning_effort to none when the model refuses tools alongside it", async () => {
    const fn = mockDemanding({ effort: true }, [delta({ content: "ok" }), delta({}, "stop")]);
    const { text } = await drain(openaiStream(EP, { modelId: "reasoner-1", messages: USER, tools: TOOLS }));
    expect(text).toBe("ok");
    const bodies = fn.mock.calls.map((c) => JSON.parse((c[1] as RequestInit).body as string));
    expect(bodies[0]!.reasoning_effort).toBeUndefined();
    expect(bodies[1]!.reasoning_effort).toBe("none");
  });

  /** Suppressing reasoning costs answer quality, so it is applied only in the
   *  combination the endpoint actually refuses — never to a plain turn. */
  it("leaves a tool-less turn's reasoning alone even once the quirk is known", async () => {
    const fn = mockDemanding({ effort: true }, [delta({}, "stop")]);
    await drain(openaiStream(EP, { modelId: "reasoner-2", messages: USER, tools: TOOLS }));
    expect(JSON.parse((fn.mock.calls[1]![1] as RequestInit).body as string).reasoning_effort).toBe("none");
    await drain(openaiStream(EP, { modelId: "reasoner-2", messages: USER }));
    expect(JSON.parse((fn.mock.calls[2]![1] as RequestInit).body as string).reasoning_effort).toBeUndefined();
  });

  it("learns both in one turn when a model needs both", async () => {
    const fn = mockDemanding({ cap: true, effort: true }, [delta({ content: "y" }), delta({}, "stop")]);
    const { text } = await drain(openaiStream(EP, { modelId: "reasoner-3", messages: USER, tools: TOOLS, maxTokens: 64 }));
    expect(text).toBe("y");
    expect(fn.mock.calls).toHaveLength(3);
    const final = JSON.parse((fn.mock.calls[2]![1] as RequestInit).body as string);
    expect(final.max_completion_tokens).toBe(64);
    expect(final.reasoning_effort).toBe("none");
  });

  it("remembers, so the same model does not pay for the rejection twice", async () => {
    const fn = mockDemanding({ cap: true }, [delta({}, "stop")]);
    await drain(openaiStream(EP, { modelId: "o-series-2", messages: USER }));
    expect(fn.mock.calls).toHaveLength(2);
    await drain(openaiStream(EP, { modelId: "o-series-2", messages: USER }));
    expect(fn.mock.calls).toHaveLength(3);
    expect("max_completion_tokens" in JSON.parse((fn.mock.calls[2]![1] as RequestInit).body as string)).toBe(true);
  });

  /** The recovery is scoped to the rejections it knows: any other 400 is a
   *  real error and must reach the caller unchanged rather than be retried. */
  it("does not retry a 400 that is about anything else", async () => {
    const fn = vi.fn(async () => new Response('{"error":"Invalid model"}', { status: 400 }));
    vi.stubGlobal("fetch", fn);
    await expect(drain(openaiStream(EP, { modelId: "o-series-3", messages: USER }))).rejects.toThrow(/Invalid model/);
    expect(fn.mock.calls).toHaveLength(1);
  });

  /** An endpoint that keeps refusing must fail, not loop: each quirk is applied
   *  at most once, so the second identical rejection is a real error. */
  it("gives up rather than retrying forever when the adjustment does not help", async () => {
    const fn = vi.fn(async () => new Response(TOOLS_REJECTION, { status: 400 }));
    vi.stubGlobal("fetch", fn);
    await expect(drain(openaiStream(EP, { modelId: "stubborn", messages: USER, tools: TOOLS }))).rejects.toThrow(/reasoning_effort/);
    expect(fn.mock.calls).toHaveLength(2);
  });
});
