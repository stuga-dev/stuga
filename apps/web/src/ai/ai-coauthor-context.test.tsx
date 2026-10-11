// @vitest-environment jsdom
/**
 * Reject and revise while the co-author is mid-turn: the revision waits for the turn's receipt,
 * every revision queued meanwhile goes in one turn, and a Stop or a failure pauses them instead.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { CoauthorActivity, CoauthorError } from "@stuga/protocol/api/ai-turn";
import type { AiEditsPayload, AiRequest } from "@stuga/protocol/wire/doc-socket";
import type { StugaProvider } from "../sync/stuga-provider";
import { AiCoauthorProvider, useAiCoauthor } from "./ai-coauthor-context";

vi.mock("../editor/editor-context", () => ({ useSharedEditor: () => ({ editor: { state: { selection: { empty: true } } } }) }));

interface Handlers {
  onChunk: (c: string) => void;
  onStatus: (a: CoauthorActivity) => void;
  onDone: (e?: CoauthorError) => void;
  onEdits: (p: AiEditsPayload) => void;
}

let sent: AiRequest[];
let handlers: Handlers | null;
let cancelled: number;
const provider = {
  sendAiRequest: (req: AiRequest, h: Handlers) => {
    sent.push(req);
    handlers = h;
  },
  cancelAiRequest: () => {
    cancelled++;
  },
} as unknown as StugaProvider;

let root: Root;
let container: HTMLDivElement;
/** A conversation is kept per document for the tab, so each test opens its own. */
let docSeq = 0;
let ctx: ReturnType<typeof useAiCoauthor>;

function Probe() {
  ctx = useAiCoauthor();
  return null;
}

const receipt = (over: Partial<AiEditsPayload> = {}): AiEditsPayload => ({ staged: 1, applied: 0, run_id: "run_a", cross_docs: [], error: null, notices: [], ...over });

/** The turn in flight ends: "done", then its receipt, as the provider delivers them. */
async function endTurn(over: Partial<AiEditsPayload> = {}) {
  const h = handlers!;
  await act(async () => {
    h.onDone();
    h.onEdits(receipt(over));
  });
}

beforeEach(async () => {
  sent = [];
  handlers = null;
  cancelled = 0;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <AiCoauthorProvider provider={provider} docId={`d${++docSeq}`} onRequestOpen={() => {}}>
        <Probe />
      </AiCoauthorProvider>,
    );
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("Reject and revise", () => {
  it("starts a scoped revision at once while the co-author is idle", async () => {
    await act(async () => ctx.revise("Shorter.", { runId: "run_a", feedbackId: "fb_1" }));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.revise).toEqual([{ run_id: "run_a", feedback_id: "fb_1" }]);
    expect(sent[0]!.prompt).toContain("Shorter.");
  });

  it("waits for the turn in flight, then answers every queued note in one turn", async () => {
    await act(async () => ctx.send("Tighten the intro."));
    await act(async () => ctx.revise("Shorter.", { runId: "run_a", feedbackId: "fb_1" }));
    await act(async () => ctx.revise("Keep the date.", { runId: "run_a", feedbackId: "fb_2" }));
    expect(sent).toHaveLength(1);
    expect(ctx.queuedRevisions).toBe(2);

    await endTurn();
    expect(sent).toHaveLength(2);
    expect(sent[1]!.revise).toEqual([
      { run_id: "run_a", feedback_id: "fb_1" },
      { run_id: "run_a", feedback_id: "fb_2" },
    ]);
    expect(sent[1]!.prompt).toContain("- Shorter.\n- Keep the date.");
    // The finished turn is in the revision's history.
    expect(sent[1]!.history.map((h) => h.role)).toEqual(["user", "assistant"]);
    expect(ctx.queuedRevisions).toBe(0);
  });

  it("shows the person’s notes in the transcript and sends the model its English prompt", async () => {
    await act(async () => ctx.revise("Shorter.", { runId: "run_a", feedbackId: "fb_1" }));
    const turn = ctx.turns.at(-2)!;
    expect(turn.shown).toBe("Revise the rejected edits as my note says:\nShorter.");
    expect(turn.text).toBe(sent[0]!.prompt);
    await endTurn();
    await act(async () => ctx.send("Insert the attached image.", ""));
    expect(ctx.turns.at(-2)!.shown).toBe("");
    expect(sent[1]!.history[0]!.content).toBe(sent[0]!.prompt);
  });

  it("queues behind a turn whose prose is done but whose receipt hasn't arrived", async () => {
    await act(async () => ctx.send("Tighten the intro."));
    await act(async () => handlers!.onDone());
    expect(ctx.streaming).toBe(false);
    await act(async () => ctx.revise("Shorter.", { runId: "run_a", feedbackId: "fb_1" }));
    expect(sent).toHaveLength(1);
    await act(async () => handlers!.onEdits(receipt()));
    expect(sent).toHaveLength(2);
  });

  it("pauses after a Stop, and Revise now sends them", async () => {
    await act(async () => ctx.send("Tighten the intro."));
    await act(async () => ctx.revise("Shorter.", { runId: "run_a", feedbackId: "fb_1" }));
    await act(async () => ctx.stop());
    expect(cancelled).toBe(1);
    await endTurn({ notices: [{ code: "stopped", kept: "staged" }] });
    expect(ctx.turns.at(-1)!.notice).toBe("Stopped. The changes it had already suggested are waiting for review.");
    expect(sent).toHaveLength(1);
    expect(ctx.revisionPaused).toBe(true);

    // A message sent meanwhile leaves the paused revision alone.
    await act(async () => ctx.send("Something else."));
    await endTurn();
    expect(sent).toHaveLength(2);
    expect(ctx.revisionPaused).toBe(true);

    await act(async () => ctx.reviseNow());
    expect(sent).toHaveLength(3);
    expect(sent[2]!.revise).toEqual([{ run_id: "run_a", feedback_id: "fb_1" }]);
    expect(ctx.queuedRevisions).toBe(0);
  });

  it("pauses after a failed turn, and Cancel drops the queue", async () => {
    await act(async () => ctx.send("Tighten the intro."));
    await act(async () => ctx.revise("Shorter.", { runId: "run_a", feedbackId: "fb_1" }));
    await endTurn({ staged: 0, run_id: null, error: { code: "failed", failure: "rate_limit" } });
    expect(ctx.turns.at(-1)!.proposeError).toBe("The AI provider is limiting requests. Try again in a minute.");
    expect(ctx.revisionPaused).toBe(true);
    await act(async () => ctx.cancelRevisions());
    expect(ctx.queuedRevisions).toBe(0);
    expect(ctx.revisionPaused).toBe(false);
    expect(sent).toHaveLength(1);
  });
});

describe("what the turn reports", () => {
  it("words the activity and every notice of the receipt", async () => {
    await act(async () => ctx.send("Add the chart."));
    await act(async () => handlers!.onStatus({ kind: "searching", query: "Q3 revenue" }));
    expect(ctx.turns.at(-1)!.status).toBe("Searching for “Q3 revenue”…");

    await endTurn({
      notices: [
        { code: "max_rounds", rounds: 1 },
        { code: "image_not_downloaded", url: "https://e.test/x.png", reason: "HTTP 404" },
      ],
    });
    expect(ctx.turns.at(-1)!.notice).toBe(
      "Stopped after 1 round of work. Ask me to continue if there’s more to do. Couldn’t download https://e.test/x.png (HTTP 404), so its link was left as-is.",
    );
  });
});

describe("the conversation outlives the page", () => {
  async function remount(docId: string) {
    act(() => root.unmount());
    root = createRoot(container);
    await act(async () => {
      root.render(
        <AiCoauthorProvider provider={provider} docId={docId} onRequestOpen={() => {}}>
          <Probe />
        </AiCoauthorProvider>,
      );
    });
  }

  it("finds the chat again after leaving the document and coming back", async () => {
    await remount("kept-1");
    await act(async () => ctx.send("Tighten the intro."));
    await endTurn({ hunk_ids: ["h1", "h2"] });
    expect(ctx.turns.at(-1)).toMatchObject({ runId: "run_a", hunkIds: ["h1", "h2"] });

    await remount("kept-other");
    expect(ctx.turns).toEqual([]);
    await remount("kept-1");
    expect(ctx.turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
    expect(ctx.turns[0]!.text).toBe("Tighten the intro.");
  });

  it("says when the person left before the answer finished", async () => {
    await remount("kept-2");
    await act(async () => ctx.send("Tighten the intro."));
    await remount("kept-2");
    expect(ctx.turns.at(-1)).toMatchObject({
      role: "assistant",
      status: undefined,
      notice: "You left before this answer finished. Anything it suggested is in the document.",
    });
  });

  it("starts clean after New chat", async () => {
    await remount("kept-3");
    await act(async () => ctx.send("Tighten the intro."));
    await endTurn();
    await act(async () => ctx.newChat());
    await remount("kept-3");
    expect(ctx.turns).toEqual([]);
  });
});
