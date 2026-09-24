/**
 * A co-author proposal on the open document is recorded in the audit ledger; it
 * never passes the node's routes, where every other agent edit is recorded.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";

vi.mock("@stuga/ai", async (orig) => ({
  ...(await orig<typeof import("@stuga/ai")>()),
  runAgentTurn: vi.fn(),
}));

const { runAgentTurn } = await import("@stuga/ai");
const mockAgentTurn = runAgentTurn as unknown as ReturnType<typeof vi.fn>;

import { encodeJson } from "@stuga/protocol/wire/frame";
import { Opcode } from "@stuga/protocol/wire/opcodes";
import type { IndexMessage } from "@stuga/protocol/internal/jobs";
import type { AiConfig } from "@stuga/ai";
import { DocActor } from "./doc-actor.js";
import { harness, makeActor, connect, disabledAi, frameBuffer, type Harness, type MemorySocket } from "../test/harness.js";

const DOC = "doc1";
const WS_ID = "ws1";
const HUMAN = "alice";

/** A harness with AI switched on; the model itself is the mock above. */
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

async function askAi(dobj: DocActor, ws: MemorySocket): Promise<void> {
  await dobj.webSocketMessage(
    ws,
    frameBuffer(
      encodeJson(Opcode.AI_REQUEST, {
        prompt: "rewrite the intro",
        selected_text: null,
        model: "auto",
        history: [],
        collection_id: null,
      }),
    ),
  );
}

/** A completed turn carrying one edit the document can actually take. */
function turnWithEdit(strEdits: Array<{ old_string: string; new_string: string }>) {
  return {
    prose: "done",
    strEdits,
    docEdits: [],
    usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 },
    modelId: "test-model",
    citations: [],
    activity: [],
    stopReason: "end_turn",
    rounds: 1,
  };
}

type AuditMessage = Extract<IndexMessage, { kind: "audit" }>;

const audits = (h: Harness): AuditMessage[] => h.queued.filter((m): m is AuditMessage => m.kind === "audit");

async function panelTurn(h: Harness): Promise<DocActor> {
  const dobj = makeActor(h);
  await seed(dobj);
  const ws = await connect(dobj, h, { docId: DOC, alias: HUMAN, workspaceId: WS_ID });
  await askAi(dobj, ws);
  return dobj;
}

beforeEach(() => vi.clearAllMocks());

describe("a co-author proposal", () => {
  it("is recorded as the human's agent acting on their behalf", async () => {
    const h = aiHarness();
    mockAgentTurn.mockResolvedValue(turnWithEdit([{ old_string: "Alpha.", new_string: "Beta." }]));

    await panelTurn(h);

    const rows = audits(h);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workspaceId: WS_ID,
      // The server-minted panel identity, not the human's own alias: the edit is
      // reviewable work done by an agent, and the ledger has to say so.
      actor: `panel:${HUMAN}`,
      actorKind: "agent",
      onBehalfOf: HUMAN,
      source: "ws",
      action: "doc.propose",
      targetKind: "doc",
      targetId: DOC,
    });
    expect(rows[0]!.detail).toMatchObject({ mode: "proposed", edit: "cited_edits", review: "review" });
    expect(typeof rows[0]!.detail!.run_id).toBe("string");
  });

  it("carries no name for the document it touched", async () => {
    // The actor holds the document's text, not its title. A label derived from
    // the body would put content in a table that workspace admins read and
    // export, whoever the document's ACL admits.
    const h = aiHarness();
    mockAgentTurn.mockResolvedValue(turnWithEdit([{ old_string: "Alpha.", new_string: "Beta." }]));

    await panelTurn(h);

    expect(audits(h)[0]!.targetLabel).toBeUndefined();
  });

  it("counts what the turn staged", async () => {
    const h = aiHarness();
    mockAgentTurn.mockResolvedValue(
      turnWithEdit([
        { old_string: "Alpha.", new_string: "Beta." },
        { old_string: "# Notes", new_string: "# Minutes" },
      ]),
    );

    await panelTurn(h);

    expect(audits(h)[0]!.detail).toMatchObject({ pending: 2 });
  });

  it("records nothing for a turn that proposed nothing", async () => {
    // A turn that answers in prose alone spends tokens and stages no edit. A row
    // for it would say a document was touched when none was.
    const h = aiHarness();
    mockAgentTurn.mockResolvedValue(turnWithEdit([]));

    await panelTurn(h);

    expect(audits(h)).toHaveLength(0);
  });

  it("leaves the node's own propose route to record itself", async () => {
    // The other caller of proposeRunEdit is the node, over HTTP, and the node
    // writes the row for it. A row from here as well would be the second row for
    // one edit.
    const h = aiHarness();
    const dobj = makeActor(h);
    await seed(dobj);

    const res = await dobj.fetch(
      new Request(`http://actor/runs/propose?docId=${DOC}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "str_replace",
          find: "Alpha.",
          replace: "Gamma.",
          source: "stdio",
          doc_title: "Notes",
          review: "review",
          agent: "Claude Desktop",
          agent_alias: "agent-1",
          reviewer: HUMAN,
          workspace_id: WS_ID,
        }),
      }),
    );

    expect(res.status).toBe(200);
    expect(audits(h)).toHaveLength(0);
  });
});
