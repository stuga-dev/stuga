/**
 * The co-author's front gates: the socket must belong to a human and AI must be
 * switched on. `runAgentTurn` is the only way to a model, so "not called" means
 * nothing was spent.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";

vi.mock("@stuga/ai", async (orig) => ({
  ...(await orig<typeof import("@stuga/ai")>()),
  runAgentTurn: vi.fn(),
}));

const { runAgentTurn } = await import("@stuga/ai");
const mockAgentTurn = runAgentTurn as unknown as ReturnType<typeof vi.fn>;

import { encodeJson, decodeJson } from "@stuga/protocol/wire/frame";
import { Opcode } from "@stuga/protocol/wire/opcodes";
import type { AiConfig } from "@stuga/ai";
import { DocActor } from "./doc-actor.js";
import { harness, makeActor, connect, disabledAi, frameBuffer, type Harness, type MemorySocket } from "../test/harness.js";

const DOC = "doc1";
const WS_ID = "ws1";

/** A harness with AI switched ON and a stubbed internal API that counts its calls. */
function aiHarness(): Harness & { apiCalls: number; ai: AiConfig } {
  const h = harness() as Harness & { apiCalls: number; ai: AiConfig };
  h.apiCalls = 0;
  const base = disabledAi();
  h.ai = { ...base, enabled: true, chat: { ...base.chat, enabled: true }, embed: { ...base.embed, enabled: true } };
  h.env.ai = () => h.ai;
  h.env.internal = {
    fetch: vi.fn(async () => {
      h.apiCalls += 1;
      return Response.json({ docs: [] });
    }),
  };
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

async function askAi(dobj: DocActor, ws: MemorySocket): Promise<void> {
  const frame = encodeJson(Opcode.AI_REQUEST, {
    prompt: "rewrite the intro",
    selected_text: null,
    model: "auto",
    history: [],
    collection_id: null,
  });
  await dobj.webSocketMessage(ws, frameBuffer(frame));
}

function payloads<T>(ws: MemorySocket, opcode: number): T[] {
  return ws
    .frames()
    .filter((f) => f.opcode === opcode)
    .map((f) => decodeJson<T>(f.payload));
}

/** Drive one co-author turn against a harness and return what the socket saw. */
async function turn(h: Harness): Promise<{ error?: string; editsError?: string }> {
  const dobj = makeActor(h);
  await seed(dobj);
  const ws = await connect(dobj, h, { docId: DOC, alias: "alice", workspaceId: WS_ID });
  await askAi(dobj, ws);
  const responses = payloads<{ done: boolean; error?: string }>(ws, Opcode.AI_RESPONSE);
  const edits = payloads<{ error?: string }>(ws, Opcode.AI_EDITS);
  return { error: responses.at(-1)?.error, editsError: edits.at(-1)?.error };
}

/** What a completed, edit-free turn looks like coming back from the agent loop. */
function emptyTurn() {
  return {
    prose: "done",
    strEdits: [],
    docEdits: [],
    usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 },
    modelId: "test-model",
    citations: [],
    activity: [],
    stopReason: "end_turn",
    rounds: 1,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("the andon cord", () => {
  it("refuses every turn while AI is disabled, and never reaches a model", async () => {
    const h = harness(); // ai.enabled === false
    const out = await turn(h);

    expect(out.error).toBe("AI chat is disabled on this node");
    expect(mockAgentTurn).not.toHaveBeenCalled();
    // No usage row is enqueued for a turn that never ran — a phantom ledger
    // entry would make a refused turn look like a spending one.
    expect(h.queued.filter((m) => m.kind === "ai_usage")).toHaveLength(0);
  });

  it("ALSO sends an AI_EDITS frame carrying the message", async () => {
    // Load-bearing, and easy to "tidy" away: the panel ignores the error
    // argument on onDone and reads the message off the AI_EDITS payload
    // (`proposeError`). Stop sending this frame and the co-author fails SILENTLY
    // — a blank panel, no explanation.
    const h = harness();
    const out = await turn(h);
    expect(out.editsError).toBe("AI chat is disabled on this node");
  });

  it("runs the turn once AI is enabled, against the configured endpoints", async () => {
    // The control: same frame, cord not pulled, and the model IS reached —
    // proving the refusal above is about the switch, not a broken request.
    mockAgentTurn.mockResolvedValue(emptyTurn());
    const h = aiHarness();
    const out = await turn(h);
    expect(out.error).toBeUndefined();
    expect(mockAgentTurn).toHaveBeenCalledTimes(1);
    // The operator's AiConfig is what the turn is handed — nothing is resolved
    // from the environment behind its back.
    expect(mockAgentTurn.mock.calls[0]![0]).toBe(h.ai);
    // …and the turn is attributed to the requester + tenant in the usage ledger.
    const usage = h.queued.find((m) => m.kind === "ai_usage");
    expect(usage).toMatchObject({ kind: "ai_usage", alias: "alice", workspaceId: WS_ID, docId: DOC, model: "test-model" });
  });

  it("records a failed turn without tokens, and still ends it with AI_EDITS", async () => {
    mockAgentTurn.mockRejectedValue(new Error("endpoint unreachable"));
    const h = aiHarness();
    const out = await turn(h);
    expect(out.error).toBe("endpoint unreachable");
    expect(out.editsError).toBe("endpoint unreachable");
    expect(h.queued.find((m) => m.kind === "ai_usage")).toMatchObject({ status: "error", model: "auto" });
  });
});

describe("gate ordering is preserved", () => {
  it("refuses an agent socket before anything else runs", async () => {
    mockAgentTurn.mockResolvedValue(emptyTurn());
    const h = aiHarness();
    const dobj = makeActor(h);
    await seed(dobj);
    const agentWs = await connect(dobj, h, { docId: DOC, alias: "alice", agent: "claude", agentAuth: "1", workspaceId: WS_ID });
    await askAi(dobj, agentWs);

    const replies = payloads<{ error?: string }>(agentWs, Opcode.AI_RESPONSE);
    expect(replies.at(-1)?.error).toMatch(/MCP tools/);
    expect(h.apiCalls).toBe(0);
    expect(mockAgentTurn).not.toHaveBeenCalled();
  });

  it("reports the disabled switch on a human socket before any internal call", async () => {
    const h = harness();
    const internal = vi.fn(async () => new Response("not found", { status: 404 }));
    h.env.internal = { fetch: internal };
    const out = await turn(h);
    expect(out.error).toBe("AI chat is disabled on this node");
    expect(internal).not.toHaveBeenCalled();
    expect(mockAgentTurn).not.toHaveBeenCalled();
  });
});
