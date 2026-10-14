/**
 * The co-author asking the person in a comment: the question is anchored where the quote sits in
 * the live document and posted at once, every frame of the turn says what it asked, and a person
 * who left before the turn ended is notified. `runAgentTurn` is mocked to drive the tool.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";

vi.mock("@stuga/ai", async (orig) => ({
  ...(await orig<typeof import("@stuga/ai")>()),
  runAgentTurn: vi.fn(),
}));

const { runAgentTurn } = await import("@stuga/ai");
const mockAgentTurn = vi.mocked(runAgentTurn);

import type { ToolRunner } from "@stuga/ai";
import { decodeRelPos } from "@stuga/crdt-ops";
import type { AiEditsPayload, AiRequest, AiResponseChunk } from "@stuga/protocol/wire/doc-socket";
import { decodeJson, encodeEmpty, encodeJson } from "@stuga/protocol/wire/frame";
import { Opcode } from "@stuga/protocol/wire/opcodes";
import type { DocActor } from "./doc-actor.js";
import { harness, makeActor, connect, frameBuffer, WORKSPACE, type Harness, type MemorySocket } from "../test/harness.js";
import { threadNode, type ThreadNode } from "../test/thread-node.js";

const DOC = "doc1";
const LIV = "liv";
const QUESTION = "Built-in or freestanding?";
const NOT_ONCE = "that text is not in the document exactly once as it reads now; quote a short exact phrase of existing text.";
const IN_EDIT =
  "that quote is in text an edit of yours changes (one from this turn, or one still waiting for the user's review), " +
  "so the comment would lose its place. Quote a phrase you are leaving as it is.";
const SEEDED = "# Bathroom\n\nThe **bathtub** is built-in.\n\nTiles: white.\n\nGrout: white.\n";

function turnResult(over: Record<string, unknown> = {}) {
  const prose = (over.prose as string | undefined) ?? "I asked about the bathtub.";
  return {
    prose,
    answer: prose,
    strEdits: [],
    docEdits: [],
    usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 },
    modelId: "test-model",
    citations: [],
    rounds: 1,
    stopReason: "complete",
    ...over,
  } as never;
}

interface Setup {
  h: Harness;
  node: ThreadNode;
  dobj: DocActor;
  ws: MemorySocket;
}

async function setup(): Promise<Setup> {
  const h = harness();
  const node = threadNode(h);
  const dobj = makeActor(h);
  await dobj.fetch(
    new Request(`http://actor/apply-edits?docId=${DOC}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        str_edits: [{ old_string: "", new_string: SEEDED }],
        agent: "seed",
      }),
    }),
  );
  const ws = await connect(dobj, h, { docId: DOC, alias: LIV });
  return { h, node, dobj, ws };
}

/** A hunk in Liv's co-author run that no turn of this document staged, as another document's turn proposes one. */
async function proposePanel(s: Setup, find: string, replace: string): Promise<string> {
  const res = await s.dobj.fetch(
    new Request(`http://actor/runs/propose?docId=${DOC}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "str_replace",
        find,
        replace,
        source: "panel",
        agent: "AI co-author",
        agent_alias: `panel:${LIV}`,
        reviewer: LIV,
        workspace_id: WORKSPACE,
        doc_title: "",
      }),
    }),
  );
  return ((await res.json()) as { run: { id: string } }).run.id;
}

function askAi(s: Setup, extra: Partial<AiRequest> = {}): Promise<void> {
  const req: AiRequest = { prompt: "tidy the checklist", selected_text: null, model: "auto", history: [], collection_id: null, ...extra };
  return s.dobj.webSocketMessage(s.ws, frameBuffer(encodeJson(Opcode.AI_REQUEST, req)));
}

/**
 * Run a turn whose model calls ask_in_comment once with `quote`, then ends as `after` says. Its
 * working copy is the document it was shown, as `edit` leaves it when given: an edit it staged first.
 */
function asking(
  quote: string,
  after: () => unknown = () => turnResult(),
  edit: (working: string) => string = (working) => working,
): { answer: Promise<unknown> } {
  const out: { answer: Promise<unknown> } = { answer: Promise.resolve() };
  mockAgentTurn.mockImplementation(async (_cfg, input, runner) => {
    out.answer = runner.askInComment!({ quote, question: QUESTION, working: edit(input.docText) }).catch((e: Error) => e);
    await out.answer;
    return after() as never;
  });
  return out;
}

function payloads<T>(ws: MemorySocket, opcode: number): T[] {
  return ws
    .frames()
    .filter((f) => f.opcode === opcode)
    .map((f) => decodeJson<T>(f.payload));
}

const receipt = (ws: MemorySocket) => payloads<AiEditsPayload>(ws, Opcode.AI_EDITS).at(-1)!;
const posted = (node: ThreadNode) => node.bodies("/internal/comment");
const notified = (node: ThreadNode) => node.bodies("/internal/coauthor-asked");

beforeEach(() => vi.clearAllMocks());

describe("ask_in_comment", () => {
  it("posts the question on the quoted words, tells every open page, and lists it on the receipt", async () => {
    const s = await setup();
    const bob = await connect(s.dobj, s.h, { docId: DOC, alias: "bob" });
    const run = asking("bathtub is built-in");

    await askAi(s);

    expect(await run.answer).toEqual(expect.stringContaining("The user has not answered"));
    const [comment] = posted(s.node);
    expect(comment).toEqual({
      workspaceId: WORKSPACE,
      principals: [`user:${LIV}`],
      alias: LIV,
      doc_id: DOC,
      body: QUESTION,
      anchor_start: expect.any(String),
      anchor_end: expect.any(String),
      anchor_quote: "bathtub is built-in",
    });
    expect(decodeRelPos(comment!.anchor_start as string)).not.toBeNull();
    expect(bob.has(Opcode.COMMENTS_CHANGED)).toBe(true);
    const edits = receipt(s.ws);
    expect(edits).toMatchObject({ error: null, asked: [1] });
    expect(edits).not.toHaveProperty("replied");
    // Liv is on the page and sees it there.
    expect(notified(s.node)).toEqual([]);
  });

  it("refuses a quote that is not in the document exactly once, in words for the model", async () => {
    for (const quote of ["white.", "marble"]) {
      const s = await setup();
      const run = asking(quote);

      await askAi(s);

      expect(await run.answer).toEqual(new Error(NOT_ONCE));
      expect(posted(s.node)).toEqual([]);
      expect(receipt(s.ws).asked).toEqual([]);
    }
  });

  it("refuses a quote across a mark whose words an edit staged this turn changes", async () => {
    const s = await setup();
    const run = asking("bathtub is built-in", undefined, (doc) => doc.replace("The **bathtub** is built-in.", "The **bathtub** is freestanding."));

    await askAi(s);

    expect(await run.answer).toEqual(new Error(IN_EDIT));
    expect(posted(s.node)).toEqual([]);
    expect(receipt(s.ws).asked).toEqual([]);
  });

  it("refuses a quote on words its waiting edit changes, though the live document still has them", async () => {
    const s = await setup();
    // An earlier turn's hunk, still waiting: the next turn is shown the text it leaves.
    mockAgentTurn.mockResolvedValueOnce(turnResult({ strEdits: [{ old_string: "The **bathtub** is built-in.", new_string: "The bathtub is gone." }] }));
    await askAi(s);
    const run = asking("bathtub is built-in");

    await askAi(s);

    expect(mockAgentTurn.mock.calls[1]![1].docText).toContain("The bathtub is gone.");
    expect(await run.answer).toEqual(new Error(IN_EDIT));
    expect(posted(s.node)).toEqual([]);
  });

  it("asks on a quote across two paragraphs that the edits leave as it is", async () => {
    const s = await setup();
    const run = asking("built-in. Tiles: white", undefined, (doc) => doc.replace("Grout: white.", "Grout: **grey**."));

    await askAi(s);

    expect(await run.answer).toEqual(expect.stringContaining("The user has not answered"));
    expect(posted(s.node)).toEqual([expect.objectContaining({ anchor_quote: "built-in. Tiles: white", anchor_start: expect.any(String) })]);
    expect(receipt(s.ws).asked).toEqual([1]);
  });

  it("passes on the node's refusal, and asks nothing", async () => {
    const s = await setup();
    s.node.refusePosts = 403;
    const run = asking("bathtub is built-in");

    await askAi(s);

    expect(String(await run.answer)).toContain("could not be posted: no comment access");
    expect(receipt(s.ws).asked).toEqual([]);
  });

  it("refuses after Stop", async () => {
    const s = await setup();
    mockAgentTurn.mockImplementation(async (_cfg, _input, runner) => {
      s.dobj.interceptWebSocketMessage(s.ws, frameBuffer(encodeEmpty(Opcode.AI_CANCEL)));
      await expect(runner.askInComment!({ quote: "bathtub is built-in", question: QUESTION, working: SEEDED })).rejects.toThrow(/stopped/);
      return turnResult({ stopReason: "aborted" });
    });

    await askAi(s);

    expect(mockAgentTurn).toHaveBeenCalledTimes(1);
    expect(posted(s.node)).toEqual([]);
  });

  it("is offered only to a turn that could not read another document, in this chat or this turn", async () => {
    const offered: boolean[] = [];
    mockAgentTurn.mockImplementation(async (_cfg, _input, runner: ToolRunner) => {
      offered.push(typeof runner.askInComment === "function");
      return turnResult();
    });
    const s = await setup();

    await askAi(s);
    await askAi(s, { collection_id: "col_1" });
    await askAi(s, { history_scoped: true });

    expect(offered).toEqual([true, false, false]);
  });

  it("counts a question as output: a model error after it ends the turn early, not failed", async () => {
    const s = await setup();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    asking("bathtub is built-in", () => turnResult({ prose: "", stopReason: "error", failure: { kind: "unavailable" } }));

    await askAi(s);
    warn.mockRestore();

    expect(payloads<AiResponseChunk>(s.ws, Opcode.AI_RESPONSE).at(-1)).toEqual({ done: true });
    expect(receipt(s.ws)).toMatchObject({ error: null, notices: [{ code: "ended_early", failure: "unavailable" }], asked: [1] });
  });

  it("keeps the question on the receipt of a turn that threw after asking", async () => {
    const s = await setup();
    asking("bathtub is built-in", () => {
      throw new Error("stream reset");
    });

    await askAi(s);

    expect(receipt(s.ws)).toMatchObject({ error: { code: "failed", detail: "stream reset" }, asked: [1] });
  });

  it("notifies the person of the questions when their page closed before the turn ended", async () => {
    const s = await setup();
    // Neither another person's page nor an agent's socket in Liv's name is Liv on the page.
    await connect(s.dobj, s.h, { docId: DOC, alias: "bob" });
    await connect(s.dobj, s.h, { docId: DOC, alias: LIV, agent: "claude", agentAuth: "1" });
    asking("bathtub is built-in", () => {
      s.ws.close(1001, "tab closed");
      return turnResult();
    });

    await askAi(s);

    expect(notified(s.node)).toEqual([{ workspaceId: WORKSPACE, principals: [`user:${LIV}`], alias: LIV, doc_id: DOC, nums: [1] }]);
  });
});

describe("waiting edits that may hold text from other documents", () => {
  const TILES = { old_string: "Tiles: white.", new_string: "Tiles: grey." };
  const GROUT = { old_string: "Grout: white.", new_string: "Grout: white, matte." };

  /** Whether each turn was offered ask_in_comment; each stages `edits`, the next pair on each call. */
  function offering(edits: Array<Array<{ old_string: string; new_string: string }>>): boolean[] {
    const offered: boolean[] = [];
    mockAgentTurn.mockImplementation(async (_cfg, _input, runner: ToolRunner) => {
      offered.push(typeof runner.askInComment === "function");
      return turnResult({ strEdits: edits.shift() ?? [] });
    });
    return offered;
  }

  async function decideAll(s: Setup, decision: "accept" | "reject" = "accept"): Promise<void> {
    const runId = payloads<AiEditsPayload>(s.ws, Opcode.AI_EDITS).filter((r) => r.run_id).at(-1)!.run_id;
    await s.dobj.fetch(
      new Request(`http://actor/runs/decide?docId=${DOC}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ run_id: runId, decision, decided_by: LIV }),
      }),
    );
  }

  it("hold back questions and thread answers, in a fresh chat too, until they are decided", async () => {
    const s = await setup();
    s.node.add({ parent_num: null, author: LIV, body: "Which grout?", anchor_quote: "Grout: white." });
    s.node.add({ parent_num: 1, author: LIV, body: "Keep it white." });
    const offered = offering([[TILES], [], [GROUT]]);

    // A turn that could read other documents stages a hunk; then a new chat, unscoped.
    await askAi(s, { collection_id: "col_1" });
    await askAi(s, { history_scoped: false, history: [] });
    expect(receipt(s.ws)).toMatchObject({ staged: 0, asked: [] });
    // A thread turn still stages, but its answer stays in the panel.
    await askAi(s, { thread: { num: 1, reply_num: 2 } });

    expect(offered).toEqual([false, false, false]);
    expect(receipt(s.ws)).toMatchObject({ hunk_ids: [expect.any(String)], error: null, notices: [{ code: "reply_withheld" }], replied: null });
    expect(posted(s.node)).toEqual([]);

    await decideAll(s);
    await askAi(s);
    expect(offered.at(-1)).toBe(true);
  });

  it("are no bar when a turn that saw only this document staged them", async () => {
    const s = await setup();
    s.node.add({ parent_num: null, author: LIV, body: "Which grout?", anchor_quote: "Grout: white." });
    s.node.add({ parent_num: 1, author: LIV, body: "Keep it white." });
    const offered = offering([[TILES], [], [GROUT]]);

    await askAi(s);
    await askAi(s);
    await askAi(s, { thread: { num: 1, reply_num: 2 } });
    await askAi(s);

    expect(offered).toEqual([true, true, false, true]);
    expect(receipt(s.ws)).toMatchObject({ staged: 0, asked: [] });
    expect(posted(s.node)).toEqual([expect.objectContaining({ parent_num: 1, body: "I asked about the bathtub." })]);
  });

  it("hold back questions while one came from elsewhere, even under a number a decided hunk had", async () => {
    const s = await setup();
    const offered = offering([[TILES]]);
    await askAi(s);
    await decideAll(s);
    // Another document's turn proposes into Liv's co-author run here: a new run, whose first hunk has the same id.
    await proposePanel(s, "Grout: white.", "Grout: grey.");

    await askAi(s);

    expect(offered).toEqual([true, false]);
  });

  it("hold back questions for the turn that hears them rejected, since a rejection still carries their text", async () => {
    const s = await setup();
    const offered = offering([[TILES]]);
    await askAi(s, { collection_id: "col_1" });
    const runId = receipt(s.ws).run_id;
    await s.dobj.fetch(
      new Request(`http://actor/runs/decide?docId=${DOC}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ run_id: runId, decision: "reject", decided_by: LIV, note: "Keep the tiles white." }),
      }),
    );

    // A fresh, unscoped chat: the first turn is shown the rejection; the next one is not.
    await askAi(s, { history_scoped: false, history: [] });
    await askAi(s, { history_scoped: false, history: [] });

    expect(offered).toEqual([false, false, true]);
  });

  it("hold back questions when it cannot be told where they came from", async () => {
    const s = await setup();
    const storage = s.h.state.storage;
    const get = storage.get.bind(storage);
    vi.spyOn(storage, "get").mockImplementation((async (key: string) => {
      if (key.startsWith("coauthor-clean:")) throw new Error("disk error");
      return get(key);
    }) as never);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const offered = offering([]);

    await askAi(s);
    warn.mockRestore();

    expect(offered).toEqual([false]);
  });
});
