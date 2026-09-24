/**
 * Back from another site can show this page from the browser's back-forward
 * cache: its state is exactly as it was left, and no effect runs again. A page
 * that left mid-step (a spinner, a busy button) uses this to put itself right.
 */
import { useEffect } from "react";

/** Run `onRestored` whenever the page is shown again from the back-forward cache. Pass a stable function. */
export function usePageRestored(onRestored: () => void): void {
  useEffect(() => {
    const onShow = (event: PageTransitionEvent) => {
      if (event.persisted) onRestored();
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, [onRestored]);
}
