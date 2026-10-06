/**
 * The review history over a real Y.UndoManager: typing and decisions undo and redo in the order
 * they happened. `editorUndo` stands in for the editor's own Mod-Z, which runs when `undo()` says false.
 */
import { describe, it, expect, vi } from "vitest";
import * as Y from "yjs";
import { ReviewHistory, type DecisionEntry, type LocalUndoManager, type Outcome } from "./review-history";

const LOCAL = { local: true };

function setup(outcomes: { undo?: Outcome; redo?: Outcome } = {}) {
  const doc = new Y.Doc();
  const text = doc.getText("t");
  const manager = new Y.UndoManager(text, { trackedOrigins: new Set([LOCAL]), captureTimeout: 0 });
  const calls: string[] = [];
  const ops = {
    undo: vi.fn(async (e: DecisionEntry) => {
      calls.push(`undo ${e.decision} ${e.hunkIds.join(",")}`);
      return outcomes.undo ?? "done";
    }),
    redo: vi.fn(async (e: DecisionEntry) => {
      calls.push(`redo ${e.decision} ${e.hunkIds.join(",")}`);
      // A redo decides again, which reports back as a new decision.
      history.record({ runId: e.runId, hunkIds: e.hunkIds, decision: e.decision });
      return outcomes.redo ?? "done";
    }),
  };
  const history = new ReviewHistory(manager as unknown as LocalUndoManager, ops);
  const type = (s: string) => doc.transact(() => text.insert(text.length, s), LOCAL);
  const decide = (id: string, decision: "accept" | "reject" = "accept") => history.record({ runId: "run_a", hunkIds: [id], decision });
  /** Mod-Z as the keymap runs it: the history first, the editor's undo when it declines. */
  const undo = async () => {
    if (!history.undo()) manager.undo();
    await Promise.resolve();
    await Promise.resolve();
  };
  const redo = async () => {
    if (!history.redo()) manager.redo();
    await Promise.resolve();
    await Promise.resolve();
  };
  return { text, history, calls, ops, type, decide, undo, redo };
}

describe("one history for typing and decisions", () => {
  it("undoes them in the order they happened", async () => {
    const h = setup();
    h.type("A");
    h.decide("h1");
    h.type("B");

    await h.undo();
    expect(h.text.toString()).toBe("A");
    expect(h.calls).toEqual([]);

    await h.undo();
    expect(h.calls).toEqual(["undo accept h1"]);
    expect(h.text.toString()).toBe("A");

    await h.undo();
    expect(h.text.toString()).toBe("");
    expect(h.history.canUndo()).toBe(false);
  });

  it("redoes in reverse, making the decision again without counting it as new", async () => {
    const h = setup();
    h.type("A");
    h.decide("h1", "reject");
    await h.undo();
    await h.undo();
    expect(h.text.toString()).toBe("");

    await h.redo();
    expect(h.text.toString()).toBe("A");
    await h.redo();
    expect(h.calls).toEqual(["undo reject h1", "redo reject h1"]);
    expect(h.history.canRedo()).toBe(false);
    // Undo again reaches the same decision, once.
    await h.undo();
    expect(h.calls).toEqual(["undo reject h1", "redo reject h1", "undo reject h1"]);
  });

  it("ends the redo branch, decisions included, when the reviewer types or decides afresh", async () => {
    const h = setup();
    h.decide("h1");
    await h.undo();
    expect(h.history.canRedo()).toBe(true);
    h.type("X");
    expect(h.history.canRedo()).toBe(false);

    h.decide("h2");
    await h.undo();
    h.decide("h3");
    expect(h.history.canRedo()).toBe(false);
  });

  it("drops a decision the server refuses to undo, so the next Mod-Z moves on", async () => {
    const h = setup({ undo: "refused" });
    h.type("A");
    h.decide("h1");
    await h.undo();
    expect(h.calls).toEqual(["undo accept h1"]);
    await h.undo();
    expect(h.calls).toHaveLength(1);
    expect(h.text.toString()).toBe("");
  });

  it("keeps a decision whose undo failed for a reason that may pass", async () => {
    const h = setup({ undo: "failed" });
    h.decide("h1");
    await h.undo();
    await h.undo();
    expect(h.calls).toEqual(["undo accept h1", "undo accept h1"]);
  });

  it("waits out a decision in flight instead of undoing past it", async () => {
    const h = setup();
    let finish: (o: Outcome) => void = () => {};
    h.ops.undo.mockImplementationOnce(() => new Promise<Outcome>((r) => (finish = r)));
    h.type("A");
    h.decide("h1");
    expect(h.history.undo()).toBe(true);
    // A second Mod-Z while the server works neither repeats the request nor undoes the typing.
    expect(h.history.undo()).toBe(true);
    expect(h.ops.undo).toHaveBeenCalledTimes(1);
    expect(h.text.toString()).toBe("A");
    finish("done");
    await Promise.resolve();
    await Promise.resolve();
    expect(h.history.undo()).toBe(false);
  });

  it("forgets a decision undone from its toast, keeping the rest in order", async () => {
    const h = setup();
    h.decide("h1");
    h.type("A");
    h.decide("h2");
    h.history.forget("run_a", ["h2"]);
    await h.undo();
    expect(h.text.toString()).toBe("");
    await h.undo();
    expect(h.calls).toEqual(["undo accept h1"]);
  });
});
