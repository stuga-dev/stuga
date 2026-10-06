/**
 * One undo history for a reviewer's own actions on a document: their typing and their accept or
 * reject decisions, in the order they happened. Typing is still undone by the editor's Yjs
 * UndoManager and a decision by the server; this decides which comes next. Collaborators' edits
 * never enter it, and neither does a decision made in another tab.
 */
import type { Decision } from "./run-ledger";

/** A decision as the history holds it: Accept all is one entry with every hunk it decided. */
export interface DecisionEntry {
  kind: "decision";
  runId: string;
  hunkIds: string[];
  decision: Decision;
}

type Entry = { kind: "local"; item: object } | DecisionEntry;

/**
 * How taking a decision back (or making it again) went. `refused`: it never can, so it leaves the
 * history; `failed`: it might next time, so it stays.
 */
export type Outcome = "done" | "refused" | "failed";

/** The part of a Y.UndoManager the history reads. */
export interface LocalUndoManager {
  undoStack: object[];
  redoStack: object[];
  redoing: boolean;
  stopCapturing(): void;
  clear(clearUndoStack?: boolean, clearRedoStack?: boolean): void;
  on(event: string, f: (event: never) => void): void;
  off(event: string, f: (event: never) => void): void;
}

interface StackEvent {
  stackItem: object;
  type: "undo" | "redo";
}

export interface DecisionOps {
  undo(entry: DecisionEntry): Promise<Outcome>;
  redo(entry: DecisionEntry): Promise<Outcome>;
}

/** Most entries kept per stack; the oldest go first. */
const HISTORY_MAX = 200;

export class ReviewHistory {
  private undoEntries: Entry[] = [];
  private redoEntries: Entry[] = [];
  /** A decision is being taken back or made again; Mod-Z waits for it rather than overlapping. */
  private busy = false;
  /** Set while redo makes a decision again, so `record` doesn't count it as a new one. */
  private replaying = false;
  private readonly detach: () => void;

  constructor(
    private readonly manager: LocalUndoManager | null,
    private readonly ops: DecisionOps,
  ) {
    if (!manager) {
      this.detach = () => {};
      return;
    }
    // Typing from before the history existed is still the oldest, in order.
    this.undoEntries = manager.undoStack.map((item) => ({ kind: "local", item }));
    this.redoEntries = manager.redoStack.map((item) => ({ kind: "local", item }));
    const added = ({ stackItem, type }: StackEvent) => {
      if (type === "redo") {
        // Undone typing.
        this.push(this.redoEntries, { kind: "local", item: stackItem });
        return;
      }
      this.push(this.undoEntries, { kind: "local", item: stackItem });
      // Fresh typing ends the redo branch, decisions on it included; Yjs drops its own half itself.
      if (!manager.redoing) this.redoEntries = [];
    };
    const popped = ({ stackItem, type }: StackEvent) => {
      const list = type === "undo" ? this.undoEntries : this.redoEntries;
      const at = list.findIndex((e) => e.kind === "local" && e.item === stackItem);
      if (at >= 0) list.splice(at, 1);
    };
    const cleared = ({ undoStackCleared, redoStackCleared }: { undoStackCleared: boolean; redoStackCleared: boolean }) => {
      if (undoStackCleared) this.undoEntries = this.undoEntries.filter((e) => e.kind !== "local");
      if (redoStackCleared) this.redoEntries = this.redoEntries.filter((e) => e.kind !== "local");
    };
    manager.on("stack-item-added", added as (e: never) => void);
    manager.on("stack-item-popped", popped as (e: never) => void);
    manager.on("stack-cleared", cleared as (e: never) => void);
    this.detach = () => {
      manager.off("stack-item-added", added as (e: never) => void);
      manager.off("stack-item-popped", popped as (e: never) => void);
      manager.off("stack-cleared", cleared as (e: never) => void);
    };
  }

  dispose(): void {
    this.detach();
  }

  /** A decision this reviewer just made here. It ends the redo branch, as typing does. */
  record(entry: Omit<DecisionEntry, "kind">): void {
    if (this.replaying) return;
    // Typing after the decision starts its own undo step instead of joining one from before it.
    this.manager?.stopCapturing();
    this.push(this.undoEntries, { kind: "decision", ...entry });
    this.redoEntries = [];
    this.manager?.clear(false, true);
  }

  /** A decision undone out of order (from its toast): it leaves the history, and the redo branch ends. */
  forget(runId: string, hunkIds: string[]): void {
    const key = hunkIds.join(",");
    this.undoEntries = this.undoEntries.filter((e) => e.kind !== "decision" || e.runId !== runId || e.hunkIds.join(",") !== key);
    this.redoEntries = [];
    this.manager?.clear(false, true);
  }

  canUndo(): boolean {
    return this.undoEntries.length > 0;
  }

  canRedo(): boolean {
    return this.redoEntries.length > 0;
  }

  /**
   * Take back the latest action. False when it is typing, which the editor's own undo handles (or
   * nothing is left); true when a decision is being undone, or one still is.
   */
  undo(): boolean {
    if (this.busy) return true;
    const top = this.undoEntries[this.undoEntries.length - 1];
    if (!top || top.kind === "local") return false;
    void this.settle(top, "undo", this.ops.undo(top), () => this.push(this.redoEntries, top));
    return true;
  }

  /** Make the latest undone action again; false leaves it to the editor's own redo, as `undo` does. */
  redo(): boolean {
    if (this.busy) return true;
    const top = this.redoEntries[this.redoEntries.length - 1];
    if (!top || top.kind === "local") return false;
    this.replaying = true;
    void this.settle(top, "redo", this.ops.redo(top), () => this.push(this.undoEntries, top));
    return true;
  }

  /** The entry moves only once the server agreed; a refusal drops it, a failure leaves it to try again. */
  private async settle(entry: DecisionEntry, from: "undo" | "redo", outcome: Promise<Outcome>, done: () => void): Promise<void> {
    this.busy = true;
    try {
      const result = await outcome.catch((): Outcome => "failed");
      if (result === "failed") return;
      // Looked up now: typing meanwhile may have replaced the list.
      const list = from === "undo" ? this.undoEntries : this.redoEntries;
      const at = list.indexOf(entry);
      if (at >= 0) list.splice(at, 1);
      if (result === "done") done();
    } finally {
      this.busy = false;
      this.replaying = false;
    }
  }

  private push(list: Entry[], entry: Entry): void {
    list.push(entry);
    if (list.length > HISTORY_MAX) list.splice(0, list.length - HISTORY_MAX);
  }
}
