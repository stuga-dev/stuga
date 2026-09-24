/**
 * The review ledger's state model, shared by document runs (hunks) and database
 * runs (ops). A REST snapshot and live socket frames race on every mount, so a
 * run is keyed by id with a last-write-wins `updated_at` guard.
 */

type LedgerItemStatus = "pending" | "accepted" | "rejected" | "conflict" | "auto_applied";

export interface LedgerItem {
  id: string;
  status: LedgerItemStatus;
}

export interface LedgerRun {
  id: string;
  /** Display name of the proposing agent. */
  agent: string;
  /** Alias of the human who reviews. */
  reviewer: string;
  status: "open" | "applied" | "rejected" | "expired";
  acknowledged: boolean;
  auto_applied: boolean;
  reverted?: boolean;
  created_at: number;
  updated_at: number;
}

/** How a run kind exposes its reviewable items. */
export interface RunShape<R extends LedgerRun, I extends LedgerItem> {
  items: (run: R) => I[];
  withItems: (run: R, items: I[]) => R;
  /** The server elided the item list; the run is still open for whole-run decisions. */
  elided: (run: R) => boolean;
}

export type Decision = "accept" | "reject";

export interface LedgerState<R> {
  runs: Map<string, R>;
}

export type LedgerAction<R> =
  /** Navigated to another item. */
  | { type: "reset" }
  /** The REST snapshot, replacing everything. */
  | { type: "loaded"; runs: R[] }
  /** A live frame, or the run a REST call returned; ignored when older than what is held. */
  | { type: "updated"; run: R }
  /** Replace a run unconditionally (a fetched detail of the same version). */
  | { type: "replaced"; run: R }
  | { type: "acked"; runId: string }
  /** A decision was posted; `updated_at` stays put so the server's answer still wins. */
  | { type: "optimistic"; runId: string; itemIds: string[]; decision: Decision }
  /**
   * The post failed: put back only the items the guess moved. A frame may have
   * landed meanwhile, so re-seating the pre-decision run would lose its items.
   */
  | { type: "rollback"; runId: string; itemIds: string[]; decision: Decision };

export function emptyLedger<R>(): LedgerState<R> {
  return { runs: new Map() };
}

function withRun<R extends LedgerRun>(runs: Map<string, R>, run: R): Map<string, R> {
  const next = new Map(runs);
  next.set(run.id, run);
  return next;
}

function guessed(decision: Decision): LedgerItemStatus {
  return decision === "accept" ? "accepted" : "rejected";
}

function moveItems<R extends LedgerRun, I extends LedgerItem>(
  shape: RunShape<R, I>,
  state: LedgerState<R>,
  runId: string,
  itemIds: string[],
  from: (status: LedgerItemStatus) => boolean,
  to: LedgerItemStatus,
): LedgerState<R> {
  const known = state.runs.get(runId);
  if (!known) return state;
  const ids = new Set(itemIds);
  let touched = false;
  const items = shape.items(known).map((item) => {
    if (!ids.has(item.id) || !from(item.status)) return item;
    touched = true;
    return { ...item, status: to };
  });
  return touched ? { runs: withRun(state.runs, shape.withItems(known, items)) } : state;
}

export function ledgerReducer<R extends LedgerRun, I extends LedgerItem>(
  shape: RunShape<R, I>,
  state: LedgerState<R>,
  action: LedgerAction<R>,
): LedgerState<R> {
  switch (action.type) {
    case "reset":
      return state.runs.size === 0 ? state : emptyLedger();
    case "loaded":
      return { runs: new Map(action.runs.map((r) => [r.id, r])) };
    case "updated": {
      const known = state.runs.get(action.run.id);
      if (known && action.run.updated_at < known.updated_at) return state;
      return { runs: withRun(state.runs, action.run) };
    }
    case "replaced":
      return { runs: withRun(state.runs, action.run) };
    case "acked": {
      const known = state.runs.get(action.runId);
      if (!known || known.acknowledged) return state;
      return { runs: withRun(state.runs, { ...known, acknowledged: true }) };
    }
    case "optimistic":
      return moveItems(shape, state, action.runId, action.itemIds, (s) => s === "pending", guessed(action.decision));
    case "rollback":
      // A status other than our guess came from the server and outranks it.
      return moveItems(shape, state, action.runId, action.itemIds, (s) => s === guessed(action.decision), "pending");
  }
}

export function pendingItems<R extends LedgerRun, I extends LedgerItem>(shape: RunShape<R, I>, run: R): I[] {
  return shape.items(run).filter((i) => i.status === "pending");
}

/** The runs this user reviews, newest first; nothing until the alias is known. */
export function myRuns<R extends LedgerRun>(state: LedgerState<R>, alias: string | null): R[] {
  if (!alias) return [];
  return [...state.runs.values()]
    .filter((r) => r.reviewer === alias)
    .sort((a, b) => b.updated_at - a.updated_at || b.created_at - a.created_at);
}

/** Runs with something to decide now. */
export function openRunsOf<R extends LedgerRun, I extends LedgerItem>(shape: RunShape<R, I>, runs: R[]): R[] {
  return runs.filter((r) => r.status === "open" && (shape.elided(r) || pendingItems(shape, r).length > 0));
}

/** Runs that applied at once and haven't been dismissed. */
export function unseenAppliedOf<R extends LedgerRun>(runs: R[]): R[] {
  return runs.filter((r) => r.auto_applied && !r.acknowledged && r.status !== "expired");
}

/** Every open run's pending items, tagged with their run, in each run's own order. */
export function pendingItemsOf<R extends LedgerRun, I extends LedgerItem>(
  shape: RunShape<R, I>,
  runs: R[],
): { runId: string; agent: string; item: I }[] {
  return runs.flatMap((r) => pendingItems(shape, r).map((item) => ({ runId: r.id, agent: r.agent, item })));
}

/** An item id restarts at 1 in every run, so keys pair it with its run. */
export function itemKey(runId: string, itemId: string): string {
  return `${runId}:${itemId}`;
}
