import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type Dispatch } from "react";
import { getAlias } from "../lib/http/client";
import { t } from "../i18n/i18n";
import { runAgentLabel } from "../state/identity";
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
   * can be reverted through `runId`. `decided`: `itemIds` of `runId` were just
   * decided, and the decision can be undone. `undone`: that decision was undone. `noted`: a
   * rejection with a note, which goes to the agent at once and so has no Undo.
   */
  kind: "conflict" | "blocked" | "error" | "accepted" | "decided" | "undone" | "noted";
  message: string;
  runId?: string;
  itemIds?: string[];
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
  decide: (runId: string, decision: Decision, itemIds?: string[], note?: string) => Promise<DecideResult<R>>;
  revert: (runId: string) => Promise<{ run: R }>;
  /** Put decided items back up for review; a ledger without it offers no Undo after a decision. */
  undo?: (runId: string, itemIds: string[]) => Promise<{ run: R }>;
  ack: (runId: string) => Promise<unknown>;
}

function blockedMessage(n: number): string {
  return t("review.notice.blocked", { count: n });
}

function decidedMessage(decision: Decision, n: number, agent: string): string {
  return decision === "accept"
    ? t("review.notice.accepted", { count: n, agent })
    : t("review.notice.rejected", { count: n, agent });
}

function errorMessage(e: unknown, decision: Decision): string {
  const detail = e instanceof Error && e.message ? e.message : "";
  if (decision === "accept") {
    return detail ? t("review.notice.acceptFailedDetail", { detail }) : t("review.notice.acceptFailed");
  }
  return detail ? t("review.notice.rejectFailedDetail", { detail }) : t("review.notice.rejectFailed");
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
 * failure puts them back and surfaces a notice (`decide` never rejects; it
 * resolves to the run as the server now has it, or null when the decision failed).
 */
export function useRunLedger<R extends LedgerRun, I extends LedgerItem>({
  shape,
  itemId,
  api,
  conflictMessage,
  onDecided,
  onReverted,
  onUndoable,
}: {
  shape: RunShape<R, I>;
  /** The document or database the runs belong to; a change resets the ledger. */
  itemId: string;
  api: LedgerApi<R>;
  conflictMessage: (n: number) => string;
  onDecided?: (res: DecideResult<R>, runId: string, decision: Decision, notify: Notify) => void;
  onReverted?: () => void;
  /** A decision that Undo can take back was just made. */
  onUndoable?: (runId: string, itemIds: string[], decision: Decision) => void;
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
  const hooks = useRef({ conflictMessage, onDecided, onReverted, onUndoable });
  hooks.current = { conflictMessage, onDecided, onReverted, onUndoable };

  const notify = useCallback<Notify>((kind, message, runId, itemIds) => {
    setNotices((prev) => [...prev, { id: ++noticeSeq.current, kind, message, runId, ...(itemIds ? { itemIds } : {}) }]);
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
        notify("error", t("review.notice.ledgerFailed"));
      });
    return () => {
      cancelled = true;
    };
  }, [itemId, notify]);

  const runs = useMemo(() => myRuns(state, alias), [state, alias]);
  const openRuns = useMemo(() => openRunsOf(shape, runs), [shape, runs]);
  const unseenApplied = useMemo(() => unseenAppliedOf(runs), [runs]);

  const decide = useCallback(
    async (runId: string, decision: Decision, itemIds?: string[], note?: string) => {
      const before = stateRef.current.runs.get(runId);
      const targets = itemIds ?? (before ? pendingItems(shape, before).map((i) => i.id) : []);
      const keys = targets.map((id) => itemKey(runId, id));
      setBusy(true);
      if (keys.length > 0) setInFlight((prev) => withKeys(prev, keys, true));
      if (targets.length > 0) dispatch({ type: "optimistic", runId, itemIds: targets, decision });
      try {
        const res = await apiRef.current.decide(runId, decision, itemIds, note);
        // The authoritative statuses; a blocked item comes back pending, undoing its guess.
        dispatch({ type: "updated", run: res.run });
        if (res.conflicts > 0) notify("conflict", hooks.current.conflictMessage(res.conflicts));
        if (res.blocked > 0) notify("blocked", blockedMessage(res.blocked));
        if (res.deferred) {
          notify("error", t("review.notice.deferred"));
        }
        hooks.current.onDecided?.(res, runId, decision, notify);
        // A rejection with a note goes to the agent at once, so only a plain decision offers Undo.
        if (note) {
          const n = shape.items(res.run).filter((i) => targets.includes(i.id) && i.status === "rejected").length;
          if (n > 0) notify("noted", t("review.notice.rejectedWithNote", { count: n, agent: runAgentLabel(res.run) }), runId);
        } else if (apiRef.current.undo) {
          const landed = new Set(targets);
          const done = shape.items(res.run).filter((i) => landed.has(i.id) && i.status === (decision === "accept" ? "accepted" : "rejected"));
          if (done.length > 0) {
            const ids = done.map((i) => i.id);
            hooks.current.onUndoable?.(runId, ids, decision);
            notify("decided", decidedMessage(decision, done.length, runAgentLabel(res.run)), runId, ids);
          }
        }
        return res.run;
      } catch (e) {
        if (targets.length > 0) dispatch({ type: "rollback", runId, itemIds: targets, decision });
        notify("error", errorMessage(e, decision));
        return null;
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

  /** Put a decision's items back up for review; rejects (a 409 ApiError when it no longer can) for the caller to explain. */
  const undo = useCallback(async (runId: string, itemIds: string[]) => {
    const call = apiRef.current.undo;
    if (!call) return;
    setBusy(true);
    try {
      const res = await call(runId, itemIds);
      dispatch({ type: "updated", run: res.run });
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
    undo,
    ack,
  };
}

type Notify = (kind: RunNotice["kind"], message: string, runId?: string, itemIds?: string[]) => void;
