/**
 * What waits for this person in "Review AI edits", for the library: the count beside the sidebar item
 * and which items carry AI edits waiting for them. Read from the inbox's `attention` view, which holds
 * only the runs this person can decide, on mount, when the tab comes back, and every minute meanwhile.
 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { INBOX_PAGE_LIMIT, Inbox, type InboxRun } from "../api";

const POLL_MS = 60_000;

interface ReviewQueue {
  /** Runs needing a decision or a look; a floor when `capped`. */
  count: number;
  capped: boolean;
  /** Documents and databases with AI edits waiting for this person's decision. */
  waiting: ReadonlySet<string>;
}

const Ctx = createContext<ReviewQueue | null>(null);

export function ReviewQueueProvider({ children }: { children: ReactNode }) {
  const [runs, setRuns] = useState<InboxRun[] | null>(null);

  useEffect(() => {
    let live = true;
    const load = () => {
      if (document.visibilityState !== "visible") return;
      // A failed read keeps what is shown; the queue is a hint, never a gate.
      Inbox.list("attention").then(
        (r) => live && setRuns(r.runs),
        () => {},
      );
    };
    load();
    const poll = setInterval(load, POLL_MS);
    document.addEventListener("visibilitychange", load);
    return () => {
      live = false;
      clearInterval(poll);
      document.removeEventListener("visibilitychange", load);
    };
  }, []);

  const value = useMemo<ReviewQueue | null>(
    () =>
      runs && {
        count: runs.length,
        capped: runs.length >= INBOX_PAGE_LIMIT,
        waiting: new Set(runs.filter((r) => r.pending > 0).map((r) => r.doc_id)),
      },
    [runs],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Null outside the library, or before the first read. */
export function useReviewQueue(): ReviewQueue | null {
  return useContext(Ctx);
}
