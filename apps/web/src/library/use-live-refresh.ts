/**
 * Keeps a list current without a push channel: it is re-read when the tab comes
 * back into view or the window regains focus, and on an interval while the tab
 * is visible and the person has paused, so a re-read never lands mid-gesture.
 */
import { useEffect, useRef } from "react";

/** How often a visible, idle list is re-read. */
export const LIVE_REFRESH_MS = 25_000;
/** Input this recent defers an interval re-read to the next tick. */
export const LIVE_REFRESH_IDLE_MS = 4_000;
/** Focus and visibility often fire together; one re-read covers both. */
const RETURN_DEBOUNCE_MS = 1_000;

/** Calls `onRefresh` as described above while mounted; it need not be stable. */
export function useLiveRefresh(onRefresh: () => void): void {
  const latest = useRef(onRefresh);
  latest.current = onRefresh;

  useEffect(() => {
    let lastInput = 0;
    let lastReturn = 0;
    const visible = () => document.visibilityState === "visible";
    const onInput = () => {
      lastInput = Date.now();
    };
    const onReturn = () => {
      if (!visible() || Date.now() - lastReturn < RETURN_DEBOUNCE_MS) return;
      lastReturn = Date.now();
      latest.current();
    };
    const tick = setInterval(() => {
      if (!visible() || Date.now() - lastInput < LIVE_REFRESH_IDLE_MS) return;
      latest.current();
    }, LIVE_REFRESH_MS);
    const opts = { capture: true, passive: true } as const;
    window.addEventListener("pointerdown", onInput, opts);
    window.addEventListener("keydown", onInput, opts);
    // A drag sends no pointer events while it moves.
    window.addEventListener("dragover", onInput, opts);
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      clearInterval(tick);
      window.removeEventListener("pointerdown", onInput, opts);
      window.removeEventListener("keydown", onInput, opts);
      window.removeEventListener("dragover", onInput, opts);
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, []);
}
