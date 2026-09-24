/**
 * Controller for the Ask page: the thread list, the open thread's turns and the
 * turn streaming in. The server owns the transcript, so no history is sent with
 * a question and the local turns are only optimistic.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Ask, AskThreads, type AskThreadSummary, type AskTurn } from "../api";
import type { AiCitation } from "@stuga/protocol/wire/doc-socket";
import type { AskStep } from "@stuga/protocol/api/ask";

/** How long to keep looking for the turn the server persists after a Stop. */
const STOP_SYNC_TRIES = 5;
const STOP_SYNC_DELAY_MS = 700;

/** A turn as the page renders it: a stored one, or the one being streamed. */
export interface AskUiTurn {
  question: string;
  answer: string;
  citations: AiCitation[];
  steps: AskStep[];
  /** The live activity label while streaming. */
  status?: string;
  /** The turn ended early or retrieval degraded; the answer still stands. */
  notice?: string | null;
  error?: string | null;
  streaming?: boolean;
}

interface AskContextValue {
  threads: AskThreadSummary[];
  threadId: string | null;
  turns: AskUiTurn[];
  streaming: boolean;
  loading: boolean;
  /** The open thread's transcript failed to load (not the same as an empty thread). */
  loadError: string | null;
  /** Re-run the load the error above came from. */
  retryLoad: () => void;
  scope: string;
  setScope: (v: string) => void;
  /** Ask a question in the open thread, creating one if there isn't one yet. */
  send: (question: string) => Promise<void>;
  /** Re-send the last turn's question after it failed, replacing the failure. */
  retryLast: () => Promise<void>;
  stop: () => void;
  openThread: (id: string | null) => void;
  renameThread: (id: string, title: string) => Promise<void>;
  deleteThread: (id: string) => Promise<void>;
}

const Ctx = createContext<AskContextValue | null>(null);

export function useAsk(): AskContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAsk must be used inside <AskProvider>");
  return v;
}

export function AskProvider({
  threadId,
  onNavigate,
  children,
}: {
  threadId: string | null;
  onNavigate: (id: string | null) => void;
  children: React.ReactNode;
}) {
  const [threads, setThreads] = useState<AskThreadSummary[]>([]);
  const [turns, setTurns] = useState<AskUiTurn[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Bumped by retryLoad to re-run the load effect for the same thread id. */
  const [reloadNonce, setReloadNonce] = useState(0);
  const [scope, setScope] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  /**
   * A thread this tab created mid-question. Its turn is persisted only when the
   * stream finishes, so loading it now would replace the streaming answer with
   * the server's empty list.
   */
  const selfCreatedRef = useRef<string | null>(null);
  /** Bumped whenever what is on screen changes, so a late post-Stop reconcile can tell it is stale. */
  const generationRef = useRef(0);

  const refreshThreads = useCallback(async () => {
    await AskThreads.list()
      .then((r) => setThreads(r.threads))
      .catch(() => {});
  }, []);

  useEffect(() => {
    void refreshThreads();
  }, [refreshThreads]);

  // Aborting on unmount stops the server's loop instead of letting it spend unwatched.
  useEffect(
    () => () => {
      generationRef.current++;
      abortRef.current?.abort();
    },
    [],
  );

  const retryLoad = useCallback(() => setReloadNonce((n) => n + 1), []);

  /** Load the open thread's stored transcript. */
  useEffect(() => {
    if (!threadId) {
      setTurns([]);
      setLoadError(null);
      // The scope belongs to the conversation just closed, not to the next one.
      setScope("");
      return;
    }
    if (selfCreatedRef.current === threadId) return;
    let live = true;
    setLoading(true);
    setLoadError(null);
    // Clear first, so the previous thread's transcript never shows under this title.
    setTurns([]);
    AskThreads.get(threadId)
      .then((r) => {
        if (!live) return;
        setTurns(
          r.turns.map((t: AskTurn) => ({
            question: t.question,
            answer: t.answer,
            citations: t.citations ?? [],
            steps: t.steps ?? [],
          })),
        );
        setScope(r.thread.collection_id ?? "");
      })
      .catch(() => live && setLoadError("Couldn’t load this conversation."))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [threadId, reloadNonce]);

  /** Patch the turn currently streaming (always the last one). */
  const patchLast = useCallback((fn: (t: AskUiTurn) => AskUiTurn) => {
    setTurns((all) => (all.length === 0 ? all : [...all.slice(0, -1), fn(all[all.length - 1]!)]));
  }, []);

  const send = useCallback(
    async (question: string) => {
      const q = question.trim();
      if (!q || streaming) return;
      generationRef.current++;

      // Created on the first question, so opening the page leaves no empty threads behind.
      let id = threadId;
      if (!id) {
        try {
          const created = await AskThreads.create({ collectionId: scope || null });
          id = created.thread_id;
          selfCreatedRef.current = id;
          onNavigate(id);
        } catch {
          setTurns((all) => [
            ...all,
            { question: q, answer: "", citations: [], steps: [], error: "Couldn't start a conversation." },
          ]);
          return;
        }
      }

      setTurns((all) => [...all, { question: q, answer: "", citations: [], steps: [], streaming: true, status: "Thinking…" }]);
      setStreaming(true);

      abortRef.current = Ask.stream(
        q,
        { collectionId: scope || null, threadId: id },
        {
          onToken: (t) => patchLast((x) => ({ ...x, answer: x.answer + t })),
          onStatus: (label) => patchLast((x) => ({ ...x, status: label })),
          onStep: (s) => patchLast((x) => ({ ...x, steps: [...x.steps, s] })),
          // The agent answered from memory and was sent back to search; drop the uncited draft.
          onReset: () => patchLast((x) => ({ ...x, answer: "" })),
          onDone: (r) => {
            patchLast((x) => ({
              ...x,
              citations: r.citations as AiCitation[],
              notice: r.notice,
              status: undefined,
              streaming: false,
            }));
            setStreaming(false);
            void refreshThreads();
          },
          onError: (message) => {
            patchLast((x) => ({ ...x, error: message, status: undefined, streaming: false }));
            setStreaming(false);
          },
        },
      );
    },
    [threadId, scope, streaming, onNavigate, patchLast, refreshThreads],
  );

  /** Re-ask the last question after it failed, replacing the failed turn. */
  const retryLast = useCallback(async () => {
    const last = turns[turns.length - 1];
    if (!last?.error || streaming) return;
    setTurns((all) => all.slice(0, -1));
    await send(last.question);
  }, [turns, streaming, send]);

  /**
   * Merge in the partial turn the server stores for a stopped answer. It is
   * written a beat after the abort lands, so this polls briefly; without it the
   * stopped answer never gets its citations.
   */
  const reconcileStopped = useCallback(
    async (id: string, seq: number, question: string) => {
      for (let i = 0; i < STOP_SYNC_TRIES; i++) {
        await new Promise((r) => setTimeout(r, STOP_SYNC_DELAY_MS));
        if (generationRef.current !== seq) return;
        const r = await AskThreads.get(id).catch(() => null);
        if (!r || generationRef.current !== seq) return;
        const stored = r.turns[r.turns.length - 1];
        if (!stored || stored.question !== question) continue;
        if ((stored.citations ?? []).length === 0 && (stored.steps ?? []).length === 0) continue;
        patchLast((x) =>
          x.question === question
            ? {
                ...x,
                answer: stored.answer || x.answer,
                citations: stored.citations ?? x.citations,
                steps: (stored.steps ?? []).length ? stored.steps : x.steps,
              }
            : x,
        );
        return;
      }
    },
    [patchLast],
  );

  /** Stop the turn. The agent loop notices the aborted stream between rounds and stores the partial turn. */
  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    const question = turns[turns.length - 1]?.question;
    patchLast((x) => ({ ...x, status: undefined, streaming: false, notice: x.notice ?? "Stopped." }));
    setStreaming(false);
    void refreshThreads();
    const seq = ++generationRef.current;
    if (threadId && question) void reconcileStopped(threadId, seq, question);
  }, [patchLast, refreshThreads, reconcileStopped, threadId, turns]);

  const openThread = useCallback(
    (id: string | null) => {
      abortRef.current?.abort();
      abortRef.current = null;
      generationRef.current++;
      setStreaming(false);
      selfCreatedRef.current = null;
      onNavigate(id);
    },
    [onNavigate],
  );

  const renameThread = useCallback(
    async (id: string, title: string) => {
      await AskThreads.rename(id, title).catch(() => {});
      await refreshThreads();
    },
    [refreshThreads],
  );

  const deleteThread = useCallback(
    async (id: string) => {
      await AskThreads.remove(id).catch(() => {});
      if (id === threadId) openThread(null);
      await refreshThreads();
    },
    [threadId, openThread, refreshThreads],
  );

  const value = useMemo(
    () => ({
      threads,
      threadId,
      turns,
      streaming,
      loading,
      loadError,
      retryLoad,
      scope,
      setScope,
      send,
      retryLast,
      stop,
      openThread,
      renameThread,
      deleteThread,
    }),
    [
      threads,
      threadId,
      turns,
      streaming,
      loading,
      loadError,
      retryLoad,
      scope,
      send,
      retryLast,
      stop,
      openThread,
      renameThread,
      deleteThread,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
