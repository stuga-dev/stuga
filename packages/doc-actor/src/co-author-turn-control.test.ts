/**
 * How a co-author turn ends when it does not run to completion — refused at the
 * gate, stopped by the user, or handed more transcript than the model should
 * see. The panel ends a turn on AI_EDITS, so every path must send AI_RESPONSE
 * `done` and an AI_EDITS frame.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";

vi.mock("@stuga/ai", async (orig) => ({
  ...(await orig<typeof import("@stuga/ai")>()),
  runAgentTurn: vi.fn(),
}));

const { runAgentTurn } = await import("@stuga/ai");
const mockAgentTurn = runAgentTurn as unknown as ReturnType<typeof vi.fn>;

import type { AiEditsPayload, AiRequest, AiResponseChunk, WriteRejectedPayload } from "@stuga/protocol/wire/doc-socket";
import { encodeBinary, encodeEmpty, encodeJson, decodeJson } from "@stuga/protocol/wire/frame";
import { Opcode } from "@stuga/protocol/wire/opcodes";
import type { AgentInput, AiConfig } from "@stuga/ai";
import type { DocActor } from "./doc-actor.js";
import { MAX_AI_HISTORY_CHARS, MAX_AI_HISTORY_TURNS, MAX_AI_PROMPT_CHARS } from "./coauthor/inputs.js";
import { harness, makeActor, connect, disabledAi, frameBuffer, type Harness, type MemorySocket } from "../test/harness.js";

const DOC = "doc1";
const WS_ID = "ws1";

/** A harness with AI switched ON and a stubbed internal API. */
function aiHarness(): Harness {
  const h = harness();
  const base = disabledAi();
  const ai: AiConfig = { ...base, enabled: true, chat: { ...base.chat, enabled: true }, embed: { ...base.embed, enabled: true } };
  h.env.ai = () => ai;
  h.env.internal = { fetch: vi.fn(async () => Response.json({ docs: [] })) };
  return h;
}

async function seed(dobj: DocActor): Promise<void> {
  await dobj.fetch(
    new Request(`http://actor/apply-edits?docId=${DOC}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ str_edits: [{ old_string: "", new_string: "# Notes\n\nAlpha.\n" }], agent: "seed" }),
    }),
  );
}

function aiRequest(overrides: Partial<AiRequest> = {}): AiRequest {
  return {
    prompt: "rewrite the intro",
    selected_text: null,
    model: "auto",
    history: [],
    collection_id: null,
    ...overrides,
  };
}

function askAi(dobj: DocActor, ws: MemorySocket, overrides: Partial<AiRequest> = {}): Promise<void> {
  return dobj.webSocketMessage(ws, frameBuffer(encodeJson(Opcode.AI_REQUEST, aiRequest(overrides))));
}

function payloads<T>(ws: MemorySocket, opcode: number): T[] {
  return ws
    .frames()
    .filter((f) => f.opcode === opcode)
    .map((f) => decodeJson<T>(f.payload));
}

/** What the socket saw of a turn's end: the refusal kinds, and the two closing frames. */
function ending(ws: MemorySocket) {
  return {
    refusals: payloads<WriteRejectedPayload>(ws, Opcode.WRITE_REJECTED).map((p) => p.kind),
    done: payloads<AiResponseChunk>(ws, Opcode.AI_RESPONSE).at(-1),
    edits: payloads<AiEditsPayload>(ws, Opcode.AI_EDITS),
  };
}

/** A completed, edit-free turn as the agent loop reports it. */
function emptyTurn() {
  return {
    prose: "done",
    strEdits: [],
    docEdits: [],
    usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 },
    modelId: "test-model",
    citations: [],
    rounds: 1,
    stopReason: "complete",
  };
}

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
}

beforeEach(() => vi.clearAllMocks());

describe("a refusal at the gate ends the turn on the panel, not only on the page", () => {
  it("locked document: WRITE_REJECTED for the page, done + AI_EDITS for the panel", async () => {
    const h = aiHarness();
    const dobj = makeActor(h);
    await seed(dobj);
    await dobj.fetch(new Request(`http://actor/set-locked?docId=${DOC}&locked=1`));
    const ws = await connect(dobj, h, { docId: DOC, alias: "alice", workspaceId: WS_ID });

    await askAi(dobj, ws);

    const end = ending(ws);
    expect(end.refusals).toEqual(["locked"]);
    expect(end.done).toMatchObject({ done: true, error: expect.stringContaining("locked") });
    expect(end.edits).toHaveLength(1);
    expect(end.edits[0]!.error).toContain("locked");
    expect(mockAgentTurn).not.toHaveBeenCalled();
  });

  it("view-only holder: the same pair, and no model call", async () => {
    const h = aiHarness();
    const dobj = makeActor(h);
    await seed(dobj);
    const bob = await connect(dobj, h, { docId: DOC, alias: "bob", write: "0", principal: ["user:bob"], workspaceId: WS_ID });

    await askAi(dobj, bob);

    const end = ending(bob);
    expect(end.refusals).toEqual(["acl"]);
    expect(end.done).toMatchObject({ done: true, error: expect.stringContaining("view-only") });
    expect(end.edits.map((e) => e.error)).toEqual([expect.stringContaining("view-only")]);
    expect(mockAgentTurn).not.toHaveBeenCalled();
  });

  it("per-connection budget: every request ends, the eleventh with the rate-limit refusal", async () => {
    // AI is off in the plain harness, so the first ten end in the andon-cord
    // refusal; the eleventh trips the per-socket window. Each of the eleven must
    // still close its turn — the panel blocks a second send while one is open,
    // so one turn left hanging would have been the last the user could start.
    const h = harness();
    const dobj = makeActor(h);
    await seed(dobj);
    const ws = await connect(dobj, h, { docId: DOC, alias: "alice", workspaceId: WS_ID });

    for (let i = 0; i < 11; i++) await askAi(dobj, ws);

    const end = ending(ws);
    expect(end.refusals).toEqual(["rate-limit"]);
    expect(end.edits).toHaveLength(11);
    expect(end.edits.at(-1)!.error).toContain("Too many AI requests");
  });
});

describe("AI_CANCEL", () => {
  it("is taken ahead of the queue, stops the turn, and the turn still proposes what it had", async () => {
    // The loop stands in for a model mid-stream: it returns only once its
    // signal aborts, reporting an edit an earlier round had already staged.
    mockAgentTurn.mockImplementation(async (_cfg: AiConfig, input: AgentInput) => {
      await new Promise<void>((resolve) => input.signal!.addEventListener("abort", () => resolve(), { once: true }));
      return { ...emptyTurn(), stopReason: "aborted", prose: "Fixing. ", strEdits: [{ old_string: "Alpha.", new_string: "Beta." }] };
    });
    const h = aiHarness();
    const dobj = makeActor(h);
    await seed(dobj);
    const ws = await connect(dobj, h, { docId: DOC, alias: "alice", workspaceId: WS_ID });

    const turn = askAi(dobj, ws);
    await until(() => mockAgentTurn.mock.calls.length === 1);
    // The host hands AI_CANCEL to interceptWebSocketMessage while the turn holds
    // the lock — that is the only way it can arrive before the turn is over.
    expect(dobj.interceptWebSocketMessage(ws, frameBuffer(encodeEmpty(Opcode.AI_CANCEL)))).toBe(true);
    await turn;

    const end = ending(ws);
    expect(end.done).toMatchObject({ done: true });
    expect(end.done!.error).toBeUndefined();
    expect(end.edits).toHaveLength(1);
    // Stopped is not failed: the edit the finished round staged was proposed.
    expect(end.edits[0]).toMatchObject({ staged: 1, error: null, notice: expect.stringContaining("Stopped") });
    expect(end.edits[0]!.notice).toContain("staged for review");
    // The spend was real and is attributed like any other turn's.
    expect(h.queued.find((m) => m.kind === "ai_usage")).toMatchObject({ alias: "alice", model: "test-model" });
  });

  it("with nothing to stop is consumed and harmless; other frames are left to the queue", async () => {
    const h = aiHarness();
    const dobj = makeActor(h);
    const ws = await connect(dobj, h, { docId: DOC, alias: "alice", workspaceId: WS_ID });
    const handshake = ws.frames().length; // the epoch + sync frames every connection gets

    expect(dobj.interceptWebSocketMessage(ws, frameBuffer(encodeEmpty(Opcode.AI_CANCEL)))).toBe(true);
    expect(dobj.interceptWebSocketMessage(ws, frameBuffer(encodeJson(Opcode.AI_REQUEST, aiRequest())))).toBe(false);
    expect(dobj.interceptWebSocketMessage(ws, "ping")).toBe(false);
    // The hook only signals: nothing was sent, nothing was handled.
    expect(ws.frames()).toHaveLength(handshake);
    expect(mockAgentTurn).not.toHaveBeenCalled();
  });
});

describe("what the loop is handed", () => {
  it("clamps the prompt and the transcript, and drops a malformed transcript item", async () => {
    mockAgentTurn.mockResolvedValue(emptyTurn());
    const h = aiHarness();
    const dobj = makeActor(h);
    await seed(dobj);
    const ws = await connect(dobj, h, { docId: DOC, alias: "alice", workspaceId: WS_ID });

    const long = "x".repeat(MAX_AI_HISTORY_CHARS + 1000);
    const history = Array.from({ length: MAX_AI_HISTORY_TURNS + 2 }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `${i}:${long}`,
    }));
    await askAi(dobj, ws, {
      prompt: "p".repeat(MAX_AI_PROMPT_CHARS + 1000),
      history: [...history, { role: "system", content: 1 } as unknown as (typeof history)[number]],
    });

    expect(mockAgentTurn).toHaveBeenCalledTimes(1);
    const input = mockAgentTurn.mock.calls[0]![1] as AgentInput;
    expect(input.prompt).toHaveLength(MAX_AI_PROMPT_CHARS);
    expect(input.history).toHaveLength(MAX_AI_HISTORY_TURNS);
    // The most recent turns survive, each cut to the cap.
    expect(input.history.map((t) => t.content.slice(0, 2))).toEqual(history.slice(-MAX_AI_HISTORY_TURNS).map((t) => t.content.slice(0, 2)));
    for (const t of input.history) expect(t.content).toHaveLength(MAX_AI_HISTORY_CHARS);
  });

  it("an empty prompt ends the turn without a model call", async () => {
    const h = aiHarness();
    const dobj = makeActor(h);
    await seed(dobj);
    const ws = await connect(dobj, h, { docId: DOC, alias: "alice", workspaceId: WS_ID });

    await askAi(dobj, ws, { prompt: "   " });

    expect(mockAgentTurn).not.toHaveBeenCalled();
    expect(ending(ws).edits.map((e) => e.error)).toEqual([expect.stringMatching(/what you'd like/)]);
  });

  it("an unreadable payload ends the turn rather than taking the actor down", async () => {
    const h = aiHarness();
    const dobj = makeActor(h);
    await seed(dobj);
    const ws = await connect(dobj, h, { docId: DOC, alias: "alice", workspaceId: WS_ID });

    await dobj.webSocketMessage(ws, frameBuffer(encodeBinary(Opcode.AI_REQUEST, new TextEncoder().encode("not json"))));

    expect(mockAgentTurn).not.toHaveBeenCalled();
    expect(ending(ws).edits.map((e) => e.error)).toEqual([expect.stringContaining("could not be read")]);
  });
});
