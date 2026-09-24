import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type Dispatch } from "react";
import { getAlias } from "../lib/http/client";
import {
  emptyLedger,
  itemKey,
  ledgerReducer,
  myRuns,
  openRunsOf,
  pendingItems,
  unseenAppliedOf,
  type Decision,
  type LedgerAction,
  type LedgerItem,
  type LedgerRun,
  type LedgerState,
  type RunShape,
} from "./run-ledger";

/** Runs the mount snapshot asks for: the bar and catch-up cards only show recent activity. */
const RUNS_SNAPSHOT_LIMIT = 20;

export interface RunNotice {
  id: number;
  /**
   * `conflict`: refused because the content moved, and gone. `blocked`: waits
   * on an earlier item of its run and is still pending. `accepted`: landed and
   * can be undone through `runId`.
   */
  kind: "conflict" | "blocked" | "error" | "accepted";
  message: string;
  runId?: string;
}

interface DecideResult<R> {
  run: R;
  applied: number;
  conflicts: number;
  blocked: number;
  deferred?: number;
}

export interface LedgerApi<R> {
  list: (limit: number) => Promise<{ runs: R[] }>;
  decide: (runId: string, decision: Decision, itemIds?: string[]) => Promise<DecideResult<R>>;
  revert: (runId: string) => Promise<{ run: R }>;
  ack: (runId: string) => Promise<unknown>;
}

function blockedMessage(n: number): string {
  return n === 1
    ? "That change builds on an earlier one in this run — accept that first (or use Accept all)."
    : `${n} of those changes build on earlier ones in this run — accept those first (or use Accept all).`;
}

function errorMessage(e: unknown, decision: Decision): string {
  const detail = e instanceof Error && e.message ? e.message : "";
  return detail ? `Couldn’t ${decision} that change: ${detail}` : `Couldn’t ${decision} that change.`;
}

function withKeys(set: ReadonlySet<string>, keys: string[], add: boolean): ReadonlySet<string> {
  const next = new Set(set);
  for (const k of keys) {
    if (add) next.add(k);
    else next.delete(k);
  }
  return next;
}

/**
 * Loads, follows and decides one item's runs. Deciding is optimistic: items
 * leave the pending set on click, their keys sit in `inFlight` meanwhile, and a
 * failure puts them back and surfaces a notice (`decide` never rejects).
 */
export function useRunLedger<R extends LedgerRun, I extends LedgerItem>({
  shape,
  itemId,
  api,
  conflictMessage,
  onDecided,
  onReverted,
}: {
  shape: RunShape<R, I>;
  /** The document or database the runs belong to; a change resets the ledger. */
  itemId: string;
  api: LedgerApi<R>;
  conflictMessage: (n: number) => string;
  onDecided?: (res: DecideResult<R>, runId: string, decision: Decision, notify: Notify) => void;
  onReverted?: () => void;
}) {
  const reducer = useCallback((s: LedgerState<R>, a: LedgerAction<R>) => ledgerReducer(shape, s, a), [shape]);
  const [state, dispatch] = useReducer(reducer, undefined, emptyLedger<R>);
  // The alias arrives with the first authed response, so it is read again after the snapshot.
  const [alias, setAlias] = useState<string | null>(() => getAlias());
  const [busy, setBusy] = useState(false);
  const [inFlight, setInFlight] = useState<ReadonlySet<string>>(() => new Set());
  const [notices, setNotices] = useState<RunNotice[]>([]);
  const noticeSeq = useRef(0);
  // Decisions run outside render and must see the current run, not a render's copy.
  const stateRef = useRef(state);
  stateRef.current = state;
  const apiRef = useRef(api);
  apiRef.current = api;
  const hooks = useRef({ conflictMessage, onDecided, onReverted });
  hooks.current = { conflictMessage, onDecided, onReverted };

  const notify = useCallback<Notify>((kind, message, runId) => {
    setNotices((prev) => [...prev, { id: ++noticeSeq.current, kind, message, runId }]);
  }, []);
  const dismissNotice = useCallback((id: number) => setNotices((prev) => prev.filter((n) => n.id !== id)), []);

  useEffect(() => {
    // Reset before the request, or a slow response leaves the previous item's runs on screen.
    dispatch({ type: "reset" });
    setInFlight(new Set());
    let cancelled = false;
    apiRef.current
      .list(RUNS_SNAPSHOT_LIMIT)
      .then((r) => {
        if (cancelled) return;
        dispatch({ type: "loaded", runs: r.runs });
        setAlias(getAlias());
      })
      .catch((e: { status?: number }) => {
        // Without access to the ledger the item itself still works, so that stays quiet.
        if (cancelled || e?.status === 403 || e?.status === 404) return;
        notify("error", "Couldn’t load agent changes for this item. Reload to try again.");
      });
    return () => {
      cancelled = true;
    };
  }, [itemId, notify]);

  const runs = useMemo(() => myRuns(state, alias), [state, alias]);
  const openRuns = useMemo(() => openRunsOf(shape, runs), [shape, runs]);
  const unseenApplied = useMemo(() => unseenAppliedOf(runs), [runs]);

  const decide = useCallback(
    async (runId: string, decision: Decision, itemIds?: string[]) => {
      const before = stateRef.current.runs.get(runId);
      const targets = itemIds ?? (before ? pendingItems(shape, before).map((i) => i.id) : []);
      const keys = targets.map((id) => itemKey(runId, id));
      setBusy(true);
      if (keys.length > 0) setInFlight((prev) => withKeys(prev, keys, true));
      if (targets.length > 0) dispatch({ type: "optimistic", runId, itemIds: targets, decision });
      try {
        const res = await apiRef.current.decide(runId, decision, itemIds);
        // The authoritative statuses; a blocked item comes back pending, undoing its guess.
        dispatch({ type: "updated", run: res.run });
        if (res.conflicts > 0) notify("conflict", hooks.current.conflictMessage(res.conflicts));
        if (res.blocked > 0) notify("blocked", blockedMessage(res.blocked));
        if (res.deferred) {
          notify("error", "Some proposals couldn’t be read just now — they stay pending; try again shortly.");
        }
        hooks.current.onDecided?.(res, runId, decision, notify);
      } catch (e) {
        if (targets.length > 0) dispatch({ type: "rollback", runId, itemIds: targets, decision });
        notify("error", errorMessage(e, decision));
      } finally {
        if (keys.length > 0) setInFlight((prev) => withKeys(prev, keys, false));
        setBusy(false);
      }
    },
    [shape, notify],
  );

  /** Undo an applied run; rejects (a 409 ApiError when the content moved on) for the caller to explain. */
  const revert = useCallback(async (runId: string) => {
    setBusy(true);
    try {
      const res = await apiRef.current.revert(runId);
      dispatch({ type: "updated", run: res.run });
      hooks.current.onReverted?.();
    } finally {
      setBusy(false);
    }
  }, []);

  /** Dismiss a catch-up card at once; if the call fails the card returns on the next load. */
  const ack = useCallback(async (runId: string) => {
    dispatch({ type: "acked", runId });
    await apiRef.current.ack(runId).catch(() => {});
  }, []);

  return {
    state,
    stateRef,
    dispatch: dispatch as Dispatch<LedgerAction<R>>,
    runs,
    openRuns,
    unseenApplied,
    busy,
    inFlight,
    notices,
    notify,
    dismissNotice,
    decide,
    revert,
    ack,
  };
}

type Notify = (kind: RunNotice["kind"], message: string, runId?: string) => void;
