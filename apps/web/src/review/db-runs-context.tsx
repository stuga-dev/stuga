/**
 * A database's agent runs as the reviewer sees them: pending ops paint as ghost
 * rows and tinted cells and are decided here, and runs that applied at once
 * become catch-up cards.
 */
import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import { DatabaseRuns } from "../api";
import type { DatabaseRunOp, DatabaseRunSummary } from "@stuga/protocol/databases/types";
import type { DatabaseSocket } from "../sync/database-socket";
import { pendingItems, pendingItemsOf, type Decision, type RunShape } from "./run-ledger";
import { useRunLedger, type LedgerApi, type RunNotice } from "./use-run-ledger";

/** Rows fetched per pending insert for the grid's ghost preview. */
const RUN_SAMPLE_ROWS = 50;

const DB_RUN: RunShape<DatabaseRunSummary, DatabaseRunOp> = {
  items: (run) => run.ops,
  withItems: (run, ops) => ({ ...run, ops }),
  // `ops_truncated` elides payloads, never the ops themselves.
  elided: () => false,
};

export function pendingOps(run: DatabaseRunSummary): DatabaseRunOp[] {
  return pendingItems(DB_RUN, run);
}

/** One pending op, tagged with its run and agent. */
export interface PendingOp {
  runId: string;
  agent: string;
  op: DatabaseRunOp;
}

interface DbRunsCtx {
  runs: DatabaseRunSummary[];
  openRuns: DatabaseRunSummary[];
  unseenApplied: DatabaseRunSummary[];
  /** Pending ops across open runs: the banner and the grid overlay. */
  pending: PendingOp[];
  busy: boolean;
  /** Op keys with a decision in flight. */
  inFlight: ReadonlySet<string>;
  decide: (runId: string, decision: Decision, opIds?: string[]) => Promise<void>;
  revert: (runId: string) => Promise<void>;
  ack: (runId: string) => Promise<void>;
  notices: RunNotice[];
  dismissNotice: (id: number) => void;
}

const Ctx = createContext<DbRunsCtx | null>(null);

function conflictMessage(n: number): string {
  return n === 1
    ? "That change no longer applies — the table moved on since it was proposed."
    : `${n} of those changes no longer apply — the table moved on since they were proposed.`;
}

export function DbRunsProvider({
  socket,
  docId,
  onApplied,
  children,
}: {
  socket: DatabaseSocket | null;
  docId: string;
  /** Rows changed through a decision or revert; the page refetches. */
  onApplied: () => void;
  children: ReactNode;
}) {
  const api = useMemo<LedgerApi<DatabaseRunSummary>>(
    () => ({
      list: (limit) => DatabaseRuns.list(docId, limit),
      decide: (runId, decision, ids) => DatabaseRuns.decide(docId, runId, decision, ids),
      revert: (runId) => DatabaseRuns.revert(docId, runId),
      ack: (runId) => DatabaseRuns.ack(docId, runId),
    }),
    [docId],
  );
  const ledger = useRunLedger({
    shape: DB_RUN,
    itemId: docId,
    api,
    conflictMessage,
    // The socket's DB_CHANGED also triggers a refetch, but the decision may have raced a reconnect.
    onDecided: (res, _runId, decision) => {
      if (decision === "accept" && res.applied > 0) onApplied();
    },
    onReverted: onApplied,
  });
  const { state, dispatch, openRuns } = ledger;

  useEffect(() => {
    if (!socket) return;
    socket.runListener = (evt) => {
      if (evt.type !== "changed") dispatch({ type: "updated", run: evt.payload.run });
    };
    return () => {
      socket.runListener = null;
    };
  }, [socket, dispatch]);

  // A run past the wire budget arrives with op payloads elided, which the grid can't
  // paint. Fetch a sampled detail once per run version (an extended run is elided again).
  const hydratedAt = useRef(new Map<string, number>());
  useEffect(() => {
    for (const run of state.runs.values()) {
      if (run.ops_truncated !== true || run.status !== "open") continue;
      if (hydratedAt.current.get(run.id) === run.updated_at) continue;
      hydratedAt.current.set(run.id, run.updated_at);
      DatabaseRuns.detail(docId, run.id, { sample: RUN_SAMPLE_ROWS })
        .then((d) => dispatch({ type: "updated", run: { ...d.run, ops_truncated: undefined } }))
        .catch(() => {
          // A network failure, not an answer: a later frame retries.
          hydratedAt.current.delete(run.id);
        });
    }
  }, [state, docId, dispatch]);

  const pending = useMemo(
    () => pendingItemsOf(DB_RUN, openRuns).map(({ runId, agent, item }) => ({ runId, agent, op: item })),
    [openRuns],
  );

  const value: DbRunsCtx = {
    runs: ledger.runs,
    openRuns,
    unseenApplied: ledger.unseenApplied,
    pending,
    busy: ledger.busy,
    inFlight: ledger.inFlight,
    decide: ledger.decide,
    revert: ledger.revert,
    ack: ledger.ack,
    notices: ledger.notices,
    dismissNotice: ledger.dismissNotice,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useDbRuns(): DbRunsCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useDbRuns must be used within a DbRunsProvider");
  return ctx;
}
