/**
 * A document's agent runs as the reviewer sees them: pending hunks paint as a
 * ghost diff and are decided here, and runs that applied at once become
 * catch-up cards.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AgentRunHunk, AgentRunSummary } from "@stuga/protocol/wire/doc-socket";
import type { StugaProvider } from "../sync/stuga-provider";
import { useSharedEditor } from "../editor/editor-context";
import { useRunPreview, type RunPreviewApi } from "../editor/run-preview/use-run-preview";
import { RUN_HUNK_EVENT, type HunkKey, type RunHunkDecisionDetail, type RunPreviewHunk } from "../editor/run-preview/plan";
import { hash32 } from "../lib/hash";
import { Runs } from "../api";
import { itemKey, pendingItems, pendingItemsOf, type Decision, type RunShape } from "./run-ledger";
import { useRunLedger, type LedgerApi, type RunNotice } from "./use-run-ledger";

const DOC_RUN: RunShape<AgentRunSummary, AgentRunHunk> = {
  items: (run) => run.hunks,
  withItems: (run, hunks) => ({ ...run, hunks }),
  // A truncated run arrives without hunks, but Accept all / Reject all need none.
  elided: (run) => run.hunks_truncated === true,
};

/** Hunks still awaiting a decision, in the order the agent wrote them. */
export function pendingHunks(run: AgentRunSummary): AgentRunHunk[] {
  return pendingItems(DOC_RUN, run);
}

interface PendingHunk {
  runId: string;
  /** Labels the ghost when two runs are open. */
  agent: string;
  hunk: AgentRunHunk;
}

function pendingHunksOf(runs: AgentRunSummary[]): PendingHunk[] {
  return pendingItemsOf(DOC_RUN, runs).map(({ runId, agent, item }) => ({ runId, agent, hunk: item }));
}

/** Identity of the whole pending set, text included, which keys the repaint. */
export function previewKeyOf(pending: PendingHunk[]): string {
  return pending
    .map((p) => `${p.runId}:${p.hunk.id}:${hash32(p.hunk.old_string)}:${hash32(p.hunk.new_string)}:${hash32(p.agent)}`)
    .join("|");
}

export interface AgentRunsCtx {
  /** Runs this user reviews, newest first. */
  runs: AgentRunSummary[];
  /** Runs with something to decide: the run bar and the ghost overlay. */
  openRuns: AgentRunSummary[];
  /** Applied at once and not dismissed: the catch-up cards. */
  unseenApplied: AgentRunSummary[];
  pending: PendingHunk[];
  /** A decision or revert is in flight. */
  busy: boolean;
  /** What the overlay painted, in document order, and what it couldn't. */
  preview: RunPreviewApi;
  /** Hunk keys with a decision in flight. */
  inFlight: ReadonlySet<HunkKey>;
  /** Runs whose full hunk list is being fetched. */
  loadingHunks: ReadonlySet<string>;
  decide: (runId: string, decision: Decision, hunkIds?: string[]) => Promise<void>;
  /** Fetch a truncated run's hunks so it can be reviewed hunk by hunk; once per run version. */
  loadFullHunks: (runId: string) => Promise<void>;
  /** Undo an applied run. Rejects with a 409 ApiError when the document moved on. */
  revert: (runId: string) => Promise<void>;
  ack: (runId: string) => Promise<void>;
  /** Drained into toasts by the run bar. */
  notices: RunNotice[];
  dismissNotice: (id: number) => void;
}

const Ctx = createContext<AgentRunsCtx | null>(null);

function conflictMessage(n: number): string {
  return n === 1
    ? "That change no longer matches the document — it wasn’t applied."
    : `${n} of those changes no longer match the document — they weren’t applied.`;
}

export function AgentRunsProvider({
  provider,
  docId,
  children,
}: {
  provider: StugaProvider | null;
  docId: string;
  children: ReactNode;
}) {
  const { editor } = useSharedEditor();
  const api = useMemo<LedgerApi<AgentRunSummary>>(
    () => ({
      list: (limit) => Runs.list(docId, limit),
      decide: (runId, decision, ids) => Runs.decide(docId, runId, decision, ids),
      revert: (runId) => Runs.revert(docId, runId),
      ack: (runId) => Runs.ack(docId, runId),
    }),
    [docId],
  );
  const ledger = useRunLedger({
    shape: DOC_RUN,
    itemId: docId,
    api,
    conflictMessage,
    onDecided: (res, runId, decision, notify) => {
      // An accepted change arrives as a remote update, out of Ctrl+Z's reach, so the
      // toast offers the ledger's Revert; only once nothing is left pending, since
      // Revert takes back the whole run.
      if (decision === "accept" && res.applied > 0 && pendingHunks(res.run).length === 0) {
        notify("accepted", `Accepted ${res.applied} change${res.applied === 1 ? "" : "s"} from ${res.run.agent}.`, runId);
      }
    },
  });
  const { stateRef, dispatch, openRuns, inFlight, decide, notify } = ledger;
  const [loadingHunks, setLoadingHunks] = useState<ReadonlySet<string>>(() => new Set());
  /** runId → the `updated_at` whose full hunks were last fetched. */
  const fetchedAt = useRef(new Map<string, number>());

  useEffect(() => {
    fetchedAt.current.clear();
  }, [docId]);

  // The provider is created after this mounts, so frames arrive through its mutable listener slot.
  useEffect(() => {
    if (!provider) return;
    provider.runListener = (evt) => dispatch({ type: "updated", run: evt.payload.run });
    return () => {
      provider.runListener = null;
    };
  }, [provider, dispatch]);

  const pending = useMemo(() => pendingHunksOf(openRuns), [openRuns]);
  // Keyed on the hunk text, so the costly block diff reruns only when the pending set really changes.
  const previewKey = useMemo(() => previewKeyOf(pending), [pending]);
  const previewHunks = useMemo<RunPreviewHunk[]>(
    () =>
      pending.map((p) => ({
        runId: p.runId,
        id: p.hunk.id,
        old_string: p.hunk.old_string,
        new_string: p.hunk.new_string,
        agent: p.agent,
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [previewKey],
  );
  const preview = useRunPreview(editor, provider?.doc ?? null, previewHunks, inFlight);

  const loadFullHunks = useCallback(
    async (runId: string) => {
      const known = stateRef.current.runs.get(runId);
      if (!known?.hunks_truncated || fetchedAt.current.get(runId) === known.updated_at) return;
      fetchedAt.current.set(runId, known.updated_at);
      setLoadingHunks((prev) => new Set(prev).add(runId));
      try {
        const detail = await Runs.detail(docId, runId, { full: true });
        const hunks = detail.hunks ?? [];
        if (hunks.length === 0) {
          notify("error", "Couldn’t load the individual changes for this run — you can still decide it as a whole.");
          return;
        }
        const { hunks_truncated: _elided, ...rest } = stateRef.current.runs.get(runId) ?? known;
        dispatch({ type: "replaced", run: { ...rest, hunks } });
      } catch (e) {
        fetchedAt.current.delete(runId);
        notify("error", e instanceof Error && e.message ? `Couldn’t load these changes: ${e.message}` : "Couldn’t load these changes.");
      } finally {
        setLoadingHunks((prev) => {
          const next = new Set(prev);
          next.delete(runId);
          return next;
        });
      }
    },
    [docId, notify, stateRef, dispatch],
  );

  // Inline Accept/Reject clicks arrive as a document event carrying the (run, hunk) pair.
  // Only pairs on screen and not already in flight are posted.
  const shown = useMemo(() => new Set(pending.map((p) => itemKey(p.runId, p.hunk.id))), [pending]);
  const live = useRef({ shown, inFlight, decide });
  live.current = { shown, inFlight, decide };
  useEffect(() => {
    const onHunk = (e: Event) => {
      const detail = (e as CustomEvent<RunHunkDecisionDetail>).detail;
      if (!detail?.runId || !detail.hunkId) return;
      const key = itemKey(detail.runId, detail.hunkId);
      if (!live.current.shown.has(key) || live.current.inFlight.has(key)) return;
      void live.current.decide(detail.runId, detail.decision, [detail.hunkId]);
    };
    document.addEventListener(RUN_HUNK_EVENT, onHunk);
    return () => document.removeEventListener(RUN_HUNK_EVENT, onHunk);
  }, []);

  const value: AgentRunsCtx = {
    runs: ledger.runs,
    openRuns,
    unseenApplied: ledger.unseenApplied,
    pending,
    busy: ledger.busy,
    preview,
    inFlight,
    loadingHunks,
    decide,
    loadFullHunks,
    revert: ledger.revert,
    ack: ledger.ack,
    notices: ledger.notices,
    dismissNotice: ledger.dismissNotice,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAgentRuns(): AgentRunsCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAgentRuns must be used within an AgentRunsProvider");
  return ctx;
}
