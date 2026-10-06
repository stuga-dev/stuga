// @vitest-environment jsdom
/**
 * Reject and revise while the co-author is mid-turn: the revision waits for the turn's receipt,
 * every revision queued meanwhile goes in one turn, and a Stop or a failure pauses them instead.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AiEditsPayload, AiRequest } from "@stuga/protocol/wire/doc-socket";
import type { StugaProvider } from "../sync/stuga-provider";
import { AiCoauthorProvider, useAiCoauthor } from "./ai-coauthor-context";

vi.mock("../editor/editor-context", () => ({ useSharedEditor: () => ({ editor: { state: { selection: { empty: true } } } }) }));

interface Handlers {
  onChunk: (c: string) => void;
  onDone: (e?: string) => void;
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
let ctx: ReturnType<typeof useAiCoauthor>;

function Probe() {
  ctx = useAiCoauthor();
  return null;
}

const receipt = (over: Partial<AiEditsPayload> = {}): AiEditsPayload => ({ staged: 1, applied: 0, run_id: "run_a", cross_docs: [], error: null, notice: null, ...over });

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
      <AiCoauthorProvider provider={provider} docId="d1" onRequestOpen={() => {}}>
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
    await endTurn({ notice: "Stopped." });
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
    await endTurn({ staged: 0, run_id: null, error: "The AI turn failed." });
    expect(ctx.revisionPaused).toBe(true);
    await act(async () => ctx.cancelRevisions());
    expect(ctx.queuedRevisions).toBe(0);
    expect(ctx.revisionPaused).toBe(false);
    expect(sent).toHaveLength(1);
  });
});
