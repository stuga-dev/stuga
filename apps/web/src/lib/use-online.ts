/** The browser's word on whether it has a network: a hint for wording, never proof that the node is reachable. */
import { useSyncExternalStore } from "react";

function subscribe(onChange: () => void): () => void {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

/** True only when the browser reports no network: `navigator.onLine === false` is never a false positive. */
export function isOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => !isOffline(),
    () => true,
  );
}
