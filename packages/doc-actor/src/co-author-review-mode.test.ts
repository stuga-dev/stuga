/**
 * A co-author turn follows the document's own setting, as any agent does: on a
 * document set to apply agent changes at once its edits land when the turn
 * ends, and anything short of a clear `auto` from the node waits for review.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";

vi.mock("@stuga/ai", async (orig) => ({
  ...(await orig<typeof import("@stuga/ai")>()),
  runAgentTurn: vi.fn(),
}));

const { runAgentTurn } = await import("@stuga/ai");
const mockAgentTurn = runAgentTurn as unknown as ReturnType<typeof vi.fn>;

import type { AiEditsPayload, AiRequest } from "@stuga/protocol/wire/doc-socket";
import { decodeJson, encodeJson } from "@stuga/protocol/wire/frame";
import { Opcode } from "@stuga/protocol/wire/opcodes";
import type { AiConfig } from "@stuga/ai";
import type { DocActor } from "./doc-actor.js";
import { harness, makeActor, connect, disabledAi, frameBuffer, type Harness, type MemorySocket } from "../test/harness.js";

const DOC = "doc1";
const WS_ID = "ws1";

type Mode = "auto" | "review" | "fail";

/** AI on, and a node that answers the review-mode read with the current `mode`, or fails it. */
function aiHarness(initial: Mode): Harness & { reviewCalls: unknown[]; setMode(mode: Mode): void } {
  let mode = initial;
  const h = harness();
  const base = disabledAi();
  const ai: AiConfig = { ...base, enabled: true, chat: { ...base.chat, enabled: true }, embed: { ...base.embed, enabled: true } };
  h.env.ai = () => ai;
  const reviewCalls: unknown[] = [];
  h.env.internal = {
    fetch: vi.fn(async (path: string, init?: RequestInit) => {
      if (path !== "/internal/review-mode") return Response.json({ levels: [] });
      reviewCalls.push(JSON.parse(String(init?.body)));
      if (mode === "fail") throw new Error("node unreachable");
      return Response.json({ mode });
    }),
  };
  return Object.assign(h, { reviewCalls, setMode: (next: Mode) => void (mode = next) });
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

async function markdown(dobj: DocActor): Promise<string> {
  const res = await dobj.fetch(new Request(`http://actor/markdown?docId=${DOC}`));
  return ((await res.json()) as { markdown: string }).markdown;
}

function askAi(dobj: DocActor, ws: MemorySocket, extra: Partial<AiRequest> = {}): Promise<void> {
  const req: AiRequest = { prompt: "fix the intro", selected_text: null, model: "auto", history: [], collection_id: null, ...extra };
  return dobj.webSocketMessage(ws, frameBuffer(encodeJson(Opcode.AI_REQUEST, req)));
}

function lastEdits(ws: MemorySocket): AiEditsPayload {
  const frames = ws.frames().filter((f) => f.opcode === Opcode.AI_EDITS);
  return decodeJson<AiEditsPayload>(frames.at(-1)!.payload);
}

/** A turn that rewrites "Alpha." as the loop would report it. */
function editTurn() {
  return {
    prose: "Rewrote it.",
    strEdits: [{ old_string: "Alpha.", new_string: "Alpha, rewritten." }],
    docEdits: [],
    usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 },
    modelId: "test-model",
    citations: [],
    rounds: 1,
    stopReason: "complete",
  };
}

const notifications = (h: Harness) => h.queued.filter((m) => (m as { kind?: string }).kind === "notify");

beforeEach(() => {
  vi.clearAllMocks();
  mockAgentTurn.mockResolvedValue(editTurn());
});

describe("a co-author turn follows the document's setting", () => {
  it("applies at once on a document set to `auto`, and says so", async () => {
    const h = aiHarness("auto");
    const dobj = makeActor(h);
    await seed(dobj);
    const ws = await connect(dobj, h, { docId: DOC, alias: "alice", workspaceId: WS_ID });

    await askAi(dobj, ws);

    expect(h.reviewCalls).toEqual([{ workspaceId: WS_ID, docId: DOC, principals: expect.arrayContaining(["user:alice"]) }]);
    expect(mockAgentTurn.mock.calls[0]![1]).toMatchObject({ applyAtOnce: true });
    expect(lastEdits(ws)).toMatchObject({ staged: 0, applied: 1, run_id: expect.any(String), error: null });
    expect(await markdown(dobj)).toContain("Alpha, rewritten.");
    // The person watched it land; no notification.
    expect(notifications(h)).toHaveLength(0);
    const audit = h.queued.find((m) => (m as { kind?: string }).kind === "audit") as { detail?: Record<string, unknown> } | undefined;
    expect(audit?.detail).toMatchObject({ mode: "auto_applied", review: "auto" });
  });

  it("waits for review on a document that is not", async () => {
    const h = aiHarness("review");
    const dobj = makeActor(h);
    await seed(dobj);
    const ws = await connect(dobj, h, { docId: DOC, alias: "alice", workspaceId: WS_ID });

    await askAi(dobj, ws);

    expect(mockAgentTurn.mock.calls[0]![1]).toMatchObject({ applyAtOnce: false });
    expect(lastEdits(ws)).toMatchObject({ staged: 1, applied: 0 });
    expect(await markdown(dobj)).toContain("Alpha.");
    expect(await markdown(dobj)).not.toContain("rewritten");
    expect(notifications(h)).toHaveLength(0);
  });

  it("waits for review when the node cannot say", async () => {
    const h = aiHarness("fail");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dobj = makeActor(h);
    await seed(dobj);
    const ws = await connect(dobj, h, { docId: DOC, alias: "alice", workspaceId: WS_ID });

    await askAi(dobj, ws);

    expect(lastEdits(ws)).toMatchObject({ staged: 1, applied: 0 });
    expect(await markdown(dobj)).not.toContain("rewritten");
    warn.mockRestore();
  });

  it("reads the setting every turn, and holds a turn back on `auto` while an earlier one is undecided", async () => {
    const h = aiHarness("review");
    const dobj = makeActor(h);
    await seed(dobj);
    const ws = await connect(dobj, h, { docId: DOC, alias: "alice", workspaceId: WS_ID });
    await askAi(dobj, ws);

    // The owner switches the document to `auto` with that turn still waiting.
    h.setMode("auto");
    mockAgentTurn.mockResolvedValue({ ...editTurn(), strEdits: [{ old_string: "# Notes", new_string: "# Notes, renamed" }] });
    await askAi(dobj, ws);

    // Asked again, told the truth up front, and parked behind the undecided turn.
    expect(h.reviewCalls).toHaveLength(2);
    expect(mockAgentTurn.mock.calls[1]![1]).toMatchObject({ ownPending: [{ old_string: "Alpha.", new_string: "Alpha, rewritten." }] });
    expect(mockAgentTurn.mock.calls[0]![1]).toMatchObject({ ownPending: [] });
    expect(mockAgentTurn.mock.calls[1]![1]).toMatchObject({ applyAtOnce: false });
    expect(lastEdits(ws)).toMatchObject({ applied: 0, staged: 2 });
    expect(await markdown(dobj)).not.toContain("renamed");
  });
});

describe("a co-author turn hears what the user rejected", () => {
  it("hands the next turn the rejected edit and the note, once", async () => {
    const h = aiHarness("review");
    const dobj = makeActor(h);
    await seed(dobj);
    const ws = await connect(dobj, h, { docId: DOC, alias: "alice", workspaceId: WS_ID });

    await askAi(dobj, ws);
    expect(mockAgentTurn.mock.calls[0]![1]).toMatchObject({ feedback: [] });
    const runId = lastEdits(ws).run_id!;
    const decided = await dobj.fetch(
      new Request(`http://actor/runs/decide?docId=${DOC}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ run_id: runId, decision: "reject", decided_by: "alice", note: "Shorter, please." }),
      }),
    );
    expect(decided.status).toBe(200);

    await askAi(dobj, ws);
    expect(mockAgentTurn.mock.calls[1]![1]).toMatchObject({
      feedback: [{ run_id: runId, note: "Shorter, please.", changes: [{ old_string: "Alpha.", new_string: "Alpha, rewritten." }] }],
    });
    await askAi(dobj, ws);
    expect(mockAgentTurn.mock.calls[2]![1]).toMatchObject({ feedback: [] });
  });

  it("scopes Revise now to that rejection's hunks, and hands feedback over only after a turn that ran", async () => {
    const h = aiHarness("review");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dobj = makeActor(h);
    await seed(dobj);
    const ws = await connect(dobj, h, { docId: DOC, alias: "alice", workspaceId: WS_ID });

    await askAi(dobj, ws);
    const runId = lastEdits(ws).run_id!;
    const decided = (await (
      await dobj.fetch(
        new Request(`http://actor/runs/decide?docId=${DOC}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ run_id: runId, decision: "reject", decided_by: "alice", note: "Shorter." }),
        }),
      )
    ).json()) as { run: { hunks: Array<{ feedback: { id: string } }> } };
    const feedbackId = decided.run.hunks[0]!.feedback.id;

    // A turn that fails before the model sees anything leaves the feedback for the next one.
    mockAgentTurn.mockRejectedValueOnce(new Error("model down"));
    await askAi(dobj, ws);
    await askAi(dobj, ws, { revise: { run_id: runId, feedback_id: feedbackId } });
    expect(mockAgentTurn.mock.calls[2]![1]).toMatchObject({
      feedback: [{ run_id: runId, note: "Shorter." }],
      revise: { regions: [{ old_string: "Alpha.", new_string: "Alpha, rewritten." }] },
    });
    await askAi(dobj, ws);
    expect(mockAgentTurn.mock.calls[3]![1]).toMatchObject({ feedback: [] });
    expect(mockAgentTurn.mock.calls[3]![1]).not.toHaveProperty("revise", expect.anything());
    warn.mockRestore();
  });
});
