/**
 * A co-author turn's search scope: every cross-document call carries it to the
 * node, which bounds it, and a refusal reaches the model and the panel in the
 * node's words. `runAgentTurn` is mocked to drive the tools.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";

vi.mock("@stuga/ai", async (orig) => ({
  ...(await orig<typeof import("@stuga/ai")>()),
  runAgentTurn: vi.fn(),
}));

const { runAgentTurn } = await import("@stuga/ai");
const mockAgentTurn = vi.mocked(runAgentTurn);

import { decodeJson, encodeJson } from "@stuga/protocol/wire/frame";
import { Opcode } from "@stuga/protocol/wire/opcodes";
import type { AiEditsPayload } from "@stuga/protocol/wire/doc-socket";
import type { AiConfig, ToolRunner } from "@stuga/ai";
import { harness, makeActor, connect, disabledAi, frameBuffer, type Harness, type MemorySocket } from "../test/harness.js";

const DOC = "doc1";
const OUTSIDE = "that document is not in the selected collection";

/** AI on; the node answers like one bounding the turn to d_in. */
function scopedHarness(): Harness & { calls: Array<{ path: string; body: Record<string, unknown> }> } {
  const h = harness() as Harness & { calls: Array<{ path: string; body: Record<string, unknown> }> };
  h.calls = [];
  const base = disabledAi();
  const ai: AiConfig = { ...base, enabled: true, chat: { ...base.chat, enabled: true }, embed: { ...base.embed, enabled: true } };
  h.env.ai = () => ai;
  h.env.internal = {
    fetch: vi.fn(async (path: string, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      h.calls.push({ path, body });
      if (path === "/internal/editable-docs") return Response.json({ docs: [{ doc_id: "d_in", title: "Inside" }] });
      if (path === "/internal/doc-markdown") {
        return body.doc_id === "d_in"
          ? Response.json({ markdown: "# Inside", title: "Inside" })
          : Response.json({ error: "forbidden", message: OUTSIDE }, { status: 403 });
      }
      if (path === "/internal/propose-doc-edit") return Response.json({ kind: "error", message: OUTSIDE }, { status: 403 });
      return Response.json({ levels: [] });
    }),
  };
  return h;
}

function turnResult(docEdits: unknown[] = []) {
  return {
    prose: "done",
    strEdits: [],
    docEdits,
    usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 },
    modelId: "test-model",
    citations: [],
    rounds: 1,
    stopReason: "complete",
  } as never;
}

async function ask(h: Harness, collectionId: string | null): Promise<MemorySocket> {
  const dobj = makeActor(h);
  const ws = await connect(dobj, h, { docId: DOC, alias: "ada" });
  await dobj.webSocketMessage(
    ws,
    frameBuffer(encodeJson(Opcode.AI_REQUEST, { prompt: "sync the docs", selected_text: null, model: "auto", history: [], collection_id: collectionId })),
  );
  return ws;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("a co-author turn scoped to a collection", () => {
  it("sends the collection and the person on every cross-document call", async () => {
    let opened: Awaited<ReturnType<ToolRunner["openDocument"]>>[] = [];
    mockAgentTurn.mockImplementation(async (_cfg, _input, runner) => {
      await runner.listDocuments();
      opened = [await runner.openDocument("d_in"), await runner.openDocument("d_out")];
      return turnResult([{ docId: "d_out", title: "Outside", strEdits: [{ old_string: "a", new_string: "b" }], citations: [], baselineMarkdown: "a" }]);
    });
    const h = scopedHarness();
    const ws = await ask(h, "col_1");

    const crossDoc = h.calls.filter((c) => c.path !== "/internal/agent-instructions");
    expect(crossDoc.map((c) => c.path)).toEqual([
      "/internal/editable-docs",
      "/internal/doc-markdown",
      "/internal/doc-markdown",
      "/internal/propose-doc-edit",
    ]);
    for (const call of crossDoc) expect(call.body).toMatchObject({ collection_id: "col_1", alias: "ada" });

    expect(opened).toEqual([{ docId: "d_in", title: "Inside", markdown: "# Inside", instructions: [] }, { error: OUTSIDE }]);
    const edits = ws.frames().filter((f) => f.opcode === Opcode.AI_EDITS).map((f) => decodeJson<AiEditsPayload>(f.payload));
    expect(edits.at(-1)!.cross_docs).toEqual([{ doc_id: "d_out", title: "Outside", staged: 0, mode: "error", message: OUTSIDE }]);
  });

  it("offers the model no other documents when the panel scope is this document only, and says so to the node", async () => {
    mockAgentTurn.mockImplementation(async (_cfg, _input, runner) => {
      await runner.listDocuments();
      return turnResult();
    });
    const h = scopedHarness();
    await ask(h, null);
    expect(mockAgentTurn.mock.calls[0]![1]).toMatchObject({ collectionEnabled: false });
    expect(h.calls.find((c) => c.path === "/internal/editable-docs")!.body).toMatchObject({ collection_id: null });
  });
});
