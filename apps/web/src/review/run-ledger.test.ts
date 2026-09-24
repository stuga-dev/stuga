import { describe, it, expect } from "vitest";
import {
  emptyLedger,
  itemKey,
  ledgerReducer,
  myRuns,
  openRunsOf,
  pendingItems,
  pendingItemsOf,
  unseenAppliedOf,
  type LedgerAction,
  type LedgerItem,
  type LedgerRun,
  type LedgerState,
  type RunShape,
} from "./run-ledger";

interface TestRun extends LedgerRun {
  items: LedgerItem[];
  truncated?: boolean;
}

const SHAPE: RunShape<TestRun, LedgerItem> = {
  items: (run) => run.items,
  withItems: (run, items) => ({ ...run, items }),
  elided: (run) => run.truncated === true,
};

const ME = "me-sub";
const T0 = 1_700_000_000_000;

function item(id: string, status: LedgerItem["status"] = "pending"): LedgerItem {
  return { id, status };
}

function run(over: Partial<TestRun> = {}): TestRun {
  return {
    id: "run_a",
    agent: "Claude",
    reviewer: ME,
    status: "open",
    items: [item("h1"), item("h2")],
    acknowledged: false,
    auto_applied: false,
    created_at: T0,
    updated_at: T0,
    ...over,
  };
}

function reduce(state: LedgerState<TestRun>, action: LedgerAction<TestRun>): LedgerState<TestRun> {
  return ledgerReducer(SHAPE, state, action);
}

function stateOf(...runs: TestRun[]): LedgerState<TestRun> {
  return reduce(emptyLedger(), { type: "loaded", runs });
}

const statuses = (s: LedgerState<TestRun>) => s.runs.get("run_a")!.items.map((i) => i.status);

describe("ledgerReducer", () => {
  it("loads a snapshot, keyed by run id", () => {
    expect([...stateOf(run(), run({ id: "run_b" })).runs.keys()]).toEqual(["run_a", "run_b"]);
  });

  it("adds a frame for a run it has never seen", () => {
    expect(reduce(emptyLedger(), { type: "updated", run: run() }).runs.get("run_a")?.items).toHaveLength(2);
  });

  it("takes a newer frame over the snapshot", () => {
    const s = reduce(stateOf(run()), {
      type: "updated",
      run: run({ updated_at: T0 + 1_000, items: [item("h1"), item("h2"), item("h3")] }),
    });
    expect(s.runs.get("run_a")?.items).toHaveLength(3);
  });

  it("drops a frame older than the run it holds, so decided items stay decided", () => {
    const decided = run({ updated_at: T0 + 5_000, items: [item("h1", "accepted")], status: "applied" });
    const s = reduce(stateOf(decided), { type: "updated", run: run({ updated_at: T0 }) });
    expect(s.runs.get("run_a")?.status).toBe("applied");
    expect(pendingItems(SHAPE, s.runs.get("run_a")!)).toHaveLength(0);
  });

  it("replaces a run regardless of its timestamp", () => {
    const s = reduce(stateOf(run({ updated_at: T0 + 5 })), { type: "replaced", run: run({ items: [item("h9")] }) });
    expect(s.runs.get("run_a")!.items.map((i) => i.id)).toEqual(["h9"]);
  });

  it("acks a run, and is a no-op on an unknown or already acked one", () => {
    const s = reduce(stateOf(run({ auto_applied: true })), { type: "acked", runId: "run_a" });
    expect(s.runs.get("run_a")?.acknowledged).toBe(true);
    expect(reduce(s, { type: "acked", runId: "run_a" })).toBe(s);
    expect(reduce(s, { type: "acked", runId: "nope" })).toBe(s);
  });

  it("resets to empty", () => {
    expect(reduce(stateOf(run()), { type: "reset" }).runs.size).toBe(0);
  });

  it("rolls a failed decision back to pending without touching anything else", () => {
    const optimistic = reduce(stateOf(run()), { type: "optimistic", runId: "run_a", itemIds: ["h1"], decision: "accept" });
    expect(statuses(optimistic)).toEqual(["accepted", "pending"]);
    const rolled = reduce(optimistic, { type: "rollback", runId: "run_a", itemIds: ["h1"], decision: "accept" });
    expect(statuses(rolled)).toEqual(["pending", "pending"]);
  });

  it("keeps items a frame delivered while the decision was in flight when rolling back", () => {
    const optimistic = reduce(stateOf(run()), { type: "optimistic", runId: "run_a", itemIds: ["h1"], decision: "accept" });
    const withFrame = reduce(optimistic, {
      type: "updated",
      run: run({ updated_at: T0 + 1_000, items: [item("h1", "accepted"), item("h2"), item("h3")] }),
    });
    const rolled = reduce(withFrame, { type: "rollback", runId: "run_a", itemIds: ["h1"], decision: "accept" });
    const after = rolled.runs.get("run_a")!;
    expect(pendingItems(SHAPE, after).map((i) => i.id)).toEqual(["h1", "h2", "h3"]);
    // A regressed `updated_at` would make the next frame look stale.
    expect(after.updated_at).toBe(T0 + 1_000);
    const next = reduce(rolled, {
      type: "updated",
      run: run({ updated_at: T0 + 2_000, items: [item("h1"), item("h2"), item("h3"), item("h4")] }),
    });
    expect(next.runs.get("run_a")!.items).toHaveLength(4);
  });

  it("leaves a status the server moved on alone when rolling back", () => {
    const state = stateOf(run({ items: [item("h1", "conflict"), item("h2")] }));
    const rolled = reduce(state, { type: "rollback", runId: "run_a", itemIds: ["h1"], decision: "accept" });
    expect(rolled).toBe(state);
  });
});

describe("myRuns", () => {
  it("keeps only the runs this user reviews", () => {
    const s = stateOf(run(), run({ id: "run_b", reviewer: "someone-else" }));
    expect(myRuns(s, ME).map((r) => r.id)).toEqual(["run_a"]);
  });

  it("shows nothing until the alias is known", () => {
    expect(myRuns(stateOf(run()), null)).toEqual([]);
  });

  it("orders newest first", () => {
    const s = stateOf(run({ id: "old", updated_at: T0 }), run({ id: "new", updated_at: T0 + 9_000 }));
    expect(myRuns(s, ME).map((r) => r.id)).toEqual(["new", "old"]);
  });
});

describe("openRunsOf", () => {
  it("keeps open runs that still have pending items", () => {
    expect(openRunsOf(SHAPE, [run()]).map((r) => r.id)).toEqual(["run_a"]);
  });

  it("drops an open run whose items were all decided", () => {
    expect(openRunsOf(SHAPE, [run({ items: [item("h1", "accepted"), item("h2", "rejected")] })])).toEqual([]);
  });

  it("drops runs that are no longer open", () => {
    expect(openRunsOf(SHAPE, [run({ status: "applied" }), run({ id: "b", status: "rejected" })])).toEqual([]);
  });

  it("keeps a run whose items the server elided", () => {
    expect(openRunsOf(SHAPE, [run({ items: [], truncated: true })]).map((r) => r.id)).toEqual(["run_a"]);
  });
});

describe("unseenAppliedOf", () => {
  const applied = { auto_applied: true, status: "applied" as const, items: [item("h1", "auto_applied")] };

  it("keeps auto-applied runs the reviewer hasn't dismissed", () => {
    expect(unseenAppliedOf([run(applied)]).map((r) => r.id)).toEqual(["run_a"]);
  });

  it("drops dismissed runs", () => {
    expect(unseenAppliedOf([run({ ...applied, acknowledged: true })])).toEqual([]);
  });

  it("drops reverted runs", () => {
    expect(unseenAppliedOf([run({ ...applied, status: "expired", reverted: true })])).toEqual([]);
  });

  it("drops runs that were reviewed live", () => {
    expect(unseenAppliedOf([run({ status: "applied", items: [item("h1", "accepted")] })])).toEqual([]);
  });
});

describe("itemKey", () => {
  it("pairs the item with its run, since item ids restart in every run", () => {
    expect(itemKey("run_a", "h1")).toBe("run_a:h1");
    expect(itemKey("run_a", "h1")).not.toBe(itemKey("run_b", "h1"));
  });
});

describe("pendingItemsOf", () => {
  it("flattens across runs, tagging each item with its run", () => {
    const flat = pendingItemsOf(SHAPE, [
      run({ items: [item("h1"), item("h2", "accepted")] }),
      run({ id: "run_b", items: [item("h3")] }),
    ]);
    expect(flat.map((p) => itemKey(p.runId, p.item.id))).toEqual(["run_a:h1", "run_b:h3"]);
  });
});
