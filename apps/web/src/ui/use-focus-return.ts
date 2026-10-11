import { useEffect, useState } from "react";

/**
 * For a dialog mounted only while it is open: when it goes, focus goes back to
 * what had it as the dialog came, as Dialog does for one that closes in place.
 * Read while first rendering, before anything inside takes focus; given back
 * only when focus went with the dialog, so a rerun of effects that leaves the
 * dialog in place (React's StrictMode) does not pull focus out of it.
 */
export function useFocusReturn(): void {
  const [trigger] = useState(() => document.activeElement);
  useEffect(
    () => () => {
      const lost = !document.activeElement || document.activeElement === document.body;
      if (lost && trigger instanceof HTMLElement && trigger !== document.body && trigger.isConnected) trigger.focus();
    },
    [trigger],
  );
}
