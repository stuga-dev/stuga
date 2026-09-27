/** The agent loop against scripted streamed rounds: stop reasons, prose, usage, nudges, and what Pi adds on the wire. */
import { describe, it, expect, vi, afterEach } from "vitest";
import { Type } from "@earendil-works/pi-ai";
import type { AiConfig } from "../config.js";
import {
  CFG,
  maxTokensEmptyRound,
  mockRounds,
  openaiDelta,
  openaiSse,
  sentBody,
  streamOf,
  textRound,
  toolRound,
} from "../test-helpers.js";
import { filterCited, filterHistory, runAgentLoop, textTool, type AgentLoopSpec } from "./loop.js";

afterEach(() => vi.unstubAllGlobals());

/** A tool the scripted rounds call; `run` decides its answer. */
function look(run: () => Promise<string> = async () => "ok") {
  return textTool("look", "Look around.", Type.Object({}), run);
}

function spec(over: Partial<AgentLoopSpec> = {}): AgentLoopSpec {
  return {
    cfg: CFG,
    modelId: "sonnet",
    system: "system",
    tools: [look()],
    maxRounds: 5,
    maxTokens: 1024,
    history: [],
    seed: "go",
    onChunk: () => {},
    ...over,
  };
}

describe("runAgentLoop", () => {
  it("ends 'complete' when the model ends its own turn", async () => {
    mockRounds([textRound("All set.")]);
    const r = await runAgentLoop(spec());
    expect(r).toMatchObject({ stopReason: "complete", rounds: 1, prose: "All set." });
    expect(r.error).toBeUndefined();
  });

  it("resolves 'error' with nothing when the first round fails, so the caller can fail the turn", async () => {
    // A 400, since a 5xx or a network error would wait out the retry backoff.
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("endpoint down", { status: 400 }))));
    const r = await runAgentLoop(spec());
    expect(r.stopReason).toBe("error");
    expect(r.error).toContain("endpoint down");
    expect(r.prose).toBe("");
  });

  it("breaks between rounds so one round's prose can't run into the next", async () => {
    mockRounds([toolRound("look", {}, { text: "Let me look." }), textRound("Found it.")]);
    const chunks: string[] = [];
    const r = await runAgentLoop(spec({ onChunk: (t) => chunks.push(t) }));
    expect(r.prose).toBe("Let me look.\n\nFound it.");
    expect(chunks.join("")).toBe(r.prose);
  });

  it("sums usage across rounds", async () => {
    mockRounds([toolRound("look", {}), textRound("Done.", { inputTokens: 30, outputTokens: 5 })]);
    const r = await runAgentLoop(spec());
    expect(r.usage).toMatchObject({ inputTokens: 12 + 30, outputTokens: 7 + 5 });
  });

  it("reports a tool that throws to the model as an error result and keeps going", async () => {
    mockRounds([toolRound("look", {}, { id: "t1" }), textRound("Recovered.")]);
    const r = await runAgentLoop(spec({ tools: [look(async () => { throw new Error("nothing there"); })] }));
    expect(r.stopReason).toBe("complete");
    const result = (sentBody<{ messages: Array<{ content: unknown }> }>(1).messages.at(-1)!.content as Array<Record<string, unknown>>)[0]!;
    expect(result).toMatchObject({ type: "tool_result", tool_use_id: "t1", is_error: true });
    expect(JSON.stringify(result)).toContain("error: nothing there");
  });

  it("ends 'max_rounds' at the cap after running that round's tools", async () => {
    const getCalls = mockRounds([toolRound("look", {})]);
    const run = vi.fn(async () => "ok");
    const r = await runAgentLoop(spec({ maxRounds: 2, tools: [look(run)] }));
    expect(r).toMatchObject({ stopReason: "max_rounds", rounds: 2 });
    expect(getCalls()).toBe(2);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("stops with 'budget' when the round hook refuses, before the next model call", async () => {
    const getCalls = mockRounds([toolRound("look", {})]);
    const r = await runAgentLoop(spec({ beforeRound: async () => "over budget" }));
    expect(r).toMatchObject({ stopReason: "budget", error: "over budget", rounds: 1 });
    expect(getCalls()).toBe(1);
  });

  it("nudges with a stand-in answer after a round that emitted nothing", async () => {
    mockRounds([maxTokensEmptyRound(), textRound("Here it is.")]);
    let nudged = false;
    const r = await runAgentLoop(
      spec({
        onFinishAttempt: (ctx) => {
          if (nudged) return { action: "accept" };
          nudged = true;
          expect(ctx.stopReason).toBe("max_tokens");
          return { action: "nudge", message: "You were cut off; try again.", placeholder: "(response was cut off)" };
        },
      }),
    );
    expect(r).toMatchObject({ stopReason: "complete", rounds: 2, prose: "Here it is." });
    const roles = sentBody<{ messages: Array<{ role: string }> }>(1).messages.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "user"]);
    expect(JSON.stringify(sentBody(1))).toContain("(response was cut off)");
  });

  it("resets the prose when a nudge asks it to", async () => {
    mockRounds([textRound("Draft answer."), textRound("Final answer.")]);
    let nudged = false;
    const onResetProse = vi.fn();
    const r = await runAgentLoop(
      spec({
        onFinishAttempt: () => (nudged ? { action: "accept" } : ((nudged = true), { action: "nudge", message: "Again.", resetProse: true })),
        onResetProse,
      }),
    );
    expect(r.prose).toBe("Final answer.");
    expect(onResetProse).toHaveBeenCalledOnce();
  });

  it("ends 'aborted' when Stop cuts the stream, keeping the prose streamed so far", async () => {
    const ctrl = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        const events = textRound("Partial");
        let i = 0;
        const body = new ReadableStream<Uint8Array>({
          pull(c) {
            if (i < 3) c.enqueue(new TextEncoder().encode(events[i++]!));
            else {
              ctrl.abort();
              init?.signal?.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError")));
            }
          },
        });
        return Promise.resolve(new Response(body, { status: 200 }));
      }),
    );
    const r = await runAgentLoop(spec({ signal: ctrl.signal }));
    expect(r.stopReason).toBe("aborted");
    expect(r.prose).toBe("Partial");
  });

  it("counts no round for a request Stop cut before it was sent", async () => {
    mockRounds([toolRound("look", {}), textRound("never")]);
    const ctrl = new AbortController();
    const r = await runAgentLoop(
      spec({
        signal: ctrl.signal,
        tools: [
          look(async () => {
            ctrl.abort();
            return "ok";
          }),
        ],
      }),
    );
    expect(r).toMatchObject({ stopReason: "aborted", rounds: 1 });
  });

  it("makes no model call when the signal is already aborted", async () => {
    const getCalls = mockRounds([textRound("never")]);
    const ctrl = new AbortController();
    ctrl.abort();
    const r = await runAgentLoop(spec({ signal: ctrl.signal }));
    expect(r).toMatchObject({ stopReason: "aborted", rounds: 0 });
    expect(getCalls()).toBe(0);
  });

  it("replays history as the model's own turns", async () => {
    mockRounds([textRound("ok")]);
    await runAgentLoop(spec({ history: [{ role: "user", content: "earlier" }, { role: "assistant", content: "answer" }, { role: "assistant", content: " " }] }));
    const messages = sentBody<{ messages: Array<{ role: string }> }>(0).messages;
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });
});

/** Kimi K3 on its OpenAI-compatible endpoint: what the catalog entry changes on the wire. */
describe("runAgentLoop on a catalogued reasoning model", () => {
  const KIMI: AiConfig = {
    ...CFG,
    chat: {
      ...CFG.chat,
      endpoints: [{ id: "kimi", provider: "openai", baseUrl: "https://api.moonshot.ai/v1", apiKey: "kimi-key", models: [{ id: "kimi-k3", name: "Kimi K3" }] }],
    },
  };

  it("asks for low reasoning effort and replays reasoning_content with the tool call", async () => {
    const rounds = [
      openaiSse([
        openaiDelta({ reasoning_content: "I should look first." }),
        openaiDelta({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "look", arguments: "{}" } }] }),
        openaiDelta({}, "tool_calls"),
        { choices: [], usage: { prompt_tokens: 20, completion_tokens: 9 } },
      ]),
      openaiSse([openaiDelta({ content: "Seen it." }), openaiDelta({}, "stop"), { choices: [], usage: { prompt_tokens: 40, completion_tokens: 3 } }]),
    ];
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(streamOf(rounds[Math.min(call++, 1)]!), { status: 200 }))));

    const r = await runAgentLoop(spec({ cfg: KIMI, modelId: "kimi-k3" }));
    expect(r).toMatchObject({ stopReason: "complete", prose: "Seen it.", rounds: 2 });

    const first = sentBody<Record<string, unknown>>(0);
    expect(first).toMatchObject({ model: "kimi-k3", reasoning_effort: "low", max_tokens: 1024 });
    const second = sentBody<{ messages: Array<Record<string, unknown>> }>(1);
    const assistant = second.messages.find((m) => m.role === "assistant")!;
    expect(assistant).toMatchObject({ reasoning_content: "I should look first." });
    const [url, init] = vi.mocked(fetch).mock.calls[0]! as unknown as [string | URL | Request, RequestInit];
    expect(String(url instanceof Request ? url.url : url)).toBe("https://api.moonshot.ai/v1/chat/completions");
    expect(new Headers(url instanceof Request ? url.headers : init.headers).get("authorization")).toBe("Bearer kimi-key");
  });
});

describe("textTool", () => {
  it("refuses a call missing a required argument before running the tool", async () => {
    mockRounds([toolRound("find", {}, { id: "t1" }), textRound("ok")]);
    const run = vi.fn(async () => "found");
    const tool = textTool("find", "Find.", Type.Object({ query: Type.String() }), run);
    await runAgentLoop(spec({ tools: [tool] }));
    expect(run).not.toHaveBeenCalled();
    const result = sentBody<{ messages: Array<{ content: unknown }> }>(1).messages.at(-1)!.content as Array<Record<string, unknown>>;
    expect(result[0]).toMatchObject({ type: "tool_result", is_error: true });
  });

  it("coerces a number the model sent as a string", async () => {
    mockRounds([toolRound("read", { offset: "120" }), textRound("ok")]);
    const run = vi.fn(async (_args: { offset?: number }) => "text");
    await runAgentLoop(spec({ tools: [textTool("read", "Read.", Type.Object({ offset: Type.Optional(Type.Integer()) }), run)] }));
    expect(run).toHaveBeenCalledWith({ offset: 120 });
  });
});

describe("filterHistory", () => {
  it("drops blank turns", () => {
    const kept = filterHistory([
      { role: "user", content: "real question" },
      { role: "assistant", content: "" },
      { role: "user", content: "   " },
      { role: "assistant", content: "\n\t " },
      { role: "assistant", content: "real answer" },
    ]);
    expect(kept.map((h) => h.content)).toEqual(["real question", "real answer"]);
  });

  it("preserves order and does not trim surviving content", () => {
    const kept = filterHistory([
      { role: "user", content: "  padded  " },
      { role: "assistant", content: "b" },
    ]);
    expect(kept).toEqual([
      { role: "user", content: "  padded  " },
      { role: "assistant", content: "b" },
    ]);
  });

  it("returns nothing for an all-blank history", () => {
    expect(filterHistory([{ role: "user", content: "" }])).toEqual([]);
  });
});

describe("filterCited", () => {
  const cites = [
    { n: 1, doc_id: "a" },
    { n: 2, doc_id: "b" },
    { n: 3, doc_id: "c" },
  ];

  it("keeps only referenced sources, in their original order", () => {
    expect(filterCited("Facts [^3] and more [^1].", cites)).toEqual([
      { n: 1, doc_id: "a" },
      { n: 3, doc_id: "c" },
    ]);
  });

  it("accepts both [n] and [^n]", () => {
    expect(filterCited("plain [2] and caret [^1]", cites).map((c) => c.n)).toEqual([1, 2]);
  });

  it("drops everything when the prose cites nothing", () => {
    expect(filterCited("No markers at all.", cites)).toEqual([]);
  });

  it("ignores markers that match no source", () => {
    expect(filterCited("Invented [^9].", cites)).toEqual([]);
  });

  it("counts a repeated marker once", () => {
    expect(filterCited("[^1] and again [^1]", cites)).toEqual([{ n: 1, doc_id: "a" }]);
  });
});
