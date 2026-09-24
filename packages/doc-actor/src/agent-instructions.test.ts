/**
 * The instructions for agents that apply to the document reach the co-author's
 * turn: the actor fetches the stack from the node for the session's principals
 * and passes it to `runAgentTurn` (mocked here), and another document the turn
 * opens brings its own stack along.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";

vi.mock("@stuga/ai", async (orig) => ({
  ...(await orig<typeof import("@stuga/ai")>()),
  runAgentTurn: vi.fn(),
}));

const { runAgentTurn } = await import("@stuga/ai");
const mockAgentTurn = vi.mocked(runAgentTurn);

import type { InstructionLevel } from "@stuga/protocol/domain/instructions";
import { encodeJson } from "@stuga/protocol/wire/frame";
import { Opcode } from "@stuga/protocol/wire/opcodes";
import type { AgentInput, AiConfig, ToolRunner } from "@stuga/ai";
import { DocActor } from "./doc-actor.js";
import { harness, makeActor, connect, disabledAi, frameBuffer, type Harness } from "../test/harness.js";

const DOC = "doc1";
const WS_ID = "ws1";
const WORKSPACE: InstructionLevel = { kind: "workspace", id: WS_ID, title: "Acme", text: "Daily notes go in Journal/." };
const FOLDER: InstructionLevel = { kind: "folder", id: "f1", title: "Journal", text: "Newest entry first." };

/** AI on, with an internal API whose instructions route is scripted per test. */
function aiHarness(instructions: () => Promise<Response>): Harness & { paths: string[]; bodies: unknown[] } {
  const h = harness() as Harness & { paths: string[]; bodies: unknown[] };
  h.paths = [];
  h.bodies = [];
  const base = disabledAi();
  const ai: AiConfig = { ...base, enabled: true, chat: { ...base.chat, enabled: true }, embed: { ...base.embed, enabled: true } };
  h.env.ai = () => ai;
  h.env.internal = {
    fetch: vi.fn(async (path: string, init?: RequestInit) => {
      h.paths.push(path);
      if (path === "/internal/agent-instructions") {
        h.bodies.push(JSON.parse(String(init?.body)));
        return instructions();
      }
      return Response.json({ docs: [] });
    }),
  };
  return h;
}

async function turn(h: Harness, params: Record<string, string | string[]> = {}): Promise<void> {
  const dobj = makeActor(h);
  await seed(dobj);
  const ws = await connect(dobj, h, { docId: DOC, alias: "alice", workspaceId: WS_ID, ...params });
  await dobj.webSocketMessage(
    ws,
    frameBuffer(
      encodeJson(Opcode.AI_REQUEST, {
        prompt: "add today's note",
        selected_text: null,
        model: "auto",
        history: [],
        collection_id: null,
      }),
    ),
  );
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

/** What a completed, edit-free turn looks like coming back from the agent loop. */
function emptyTurn() {
  return {
    prose: "done",
    strEdits: [],
    docEdits: [],
    usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 },
    modelId: "test-model",
    citations: [],
    stopReason: "complete",
    rounds: 1,
  } as never;
}

/** The AgentInput the actor built for the n-th turn. */
function inputOf(n = 0): AgentInput {
  return mockAgentTurn.mock.calls[n]![1];
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAgentTurn.mockResolvedValue(emptyTurn());
});

describe("instructions for agents on a co-author turn", () => {
  it("fetches the document's stack for the socket's tenant and principals and hands it to the turn", async () => {
    const h = aiHarness(async () => Response.json({ levels: [WORKSPACE, FOLDER] }));
    await turn(h, { principal: ["user:alice", "group:ops"] });

    expect(h.paths).toContain("/internal/agent-instructions");
    // Scoped to what was stamped on the socket at upgrade — never a client value.
    expect(h.bodies[0]).toEqual({ workspaceId: WS_ID, docId: DOC, principals: ["user:alice", "group:ops"] });
    expect(inputOf().instructions).toEqual([WORKSPACE, FOLDER]);
  });

  it("re-reads them every turn, so an edited instruction binds the next message", async () => {
    // The alternative — caching them at WS upgrade — would leave an open editor
    // following yesterday's rules until the tab was reloaded.
    let current = [WORKSPACE];
    const h = aiHarness(async () => Response.json({ levels: current }));
    const dobj = makeActor(h);
    await seed(dobj);
    const ws = await connect(dobj, h, { docId: DOC, alias: "alice", workspaceId: WS_ID });
    const ask = () =>
      dobj.webSocketMessage(
        ws,
        frameBuffer(
          encodeJson(Opcode.AI_REQUEST, {
            prompt: "note", selected_text: null, model: "auto", history: [], collection_id: null,
          }),
        ),
      );

    await ask();
    current = [WORKSPACE, FOLDER];
    await ask();

    expect(inputOf(0).instructions).toEqual([WORKSPACE]);
    expect(inputOf(1).instructions).toEqual([WORKSPACE, FOLDER]);
  });

  it("still runs the turn, without them, when the lookup fails", async () => {
    // Instructions are house style, not a security control.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = aiHarness(async () => {
      throw new Error("node unreachable");
    });
    await turn(h);
    expect(mockAgentTurn).toHaveBeenCalledTimes(1);
    expect(inputOf().instructions).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("treats a non-OK response as none rather than as text", async () => {
    const h = aiHarness(async () => new Response("forbidden", { status: 403 }));
    await turn(h);
    expect(inputOf().instructions).toEqual([]);
  });

  it("keeps only well-formed levels from the answer", async () => {
    const h = aiHarness(async () =>
      Response.json({ levels: [WORKSPACE, { kind: "shelf", id: "s", title: "S", text: "x" }, { kind: "folder", id: "f2", title: "T" }, "text", FOLDER] }),
    );
    await turn(h);
    expect(inputOf().instructions).toEqual([WORKSPACE, FOLDER]);
  });
});

describe("another document the turn opens", () => {
  const LEGAL: InstructionLevel = { kind: "folder", id: "f-legal", title: "Legal", text: "Never promise delivery dates." };

  it("brings that document's stack, as the node resolved it for the session", async () => {
    let opened: Awaited<ReturnType<ToolRunner["openDocument"]>> = null;
    mockAgentTurn.mockImplementation(async (_cfg, _input, runner) => {
      opened = await runner.openDocument("d_other");
      return emptyTurn();
    });
    const h = harness();
    const base = disabledAi();
    h.env.ai = () => ({ ...base, enabled: true, chat: { ...base.chat, enabled: true } });
    h.env.internal = {
      fetch: vi.fn(async (path: string) =>
        path === "/internal/doc-markdown"
          ? Response.json({ markdown: "# NDA", title: "NDA", instructions: [WORKSPACE, LEGAL, { kind: "folder" }] })
          : Response.json({ levels: [WORKSPACE] }),
      ),
    };
    const dobj = makeActor(h);
    await seed(dobj);
    const ws = await connect(dobj, h, { docId: DOC, alias: "alice", workspaceId: WS_ID });
    await dobj.webSocketMessage(
      ws,
      frameBuffer(encodeJson(Opcode.AI_REQUEST, { prompt: "sync", selected_text: null, model: "auto", history: [], collection_id: "__all__" })),
    );

    expect(opened).toEqual({ docId: "d_other", title: "NDA", markdown: "# NDA", instructions: [WORKSPACE, LEGAL] });
    expect(inputOf().instructions).toEqual([WORKSPACE]);
  });
});
