import { useEffect } from "react";
import type * as Y from "yjs";
import { DOC_FLUSH_INTERVAL_MS } from "@stuga/protocol/domain/limits";
import { Docs, type DocSummary } from "../api";

/** Time the index job gets, after the actor's snapshot, to write the document's row, embedding included. */
export const INDEX_ALLOWANCE_MS = 10_000;

/**
 * Re-read the document once its content has been still long enough to be
 * snapshotted and indexed: indexing re-derives the title of a document nobody
 * renamed, and the server has no other way to say so. Also when the page comes
 * back into view, which may have missed a rename. `onDoc` gets the row and when
 * it was asked for, so an answer older than what the page knows can be told apart.
 */
export function useRefreshAfterIndexing(
  docId: string,
  ydoc: Y.Doc | null,
  onDoc: (doc: DocSummary, requestedAt: number) => void,
): void {
  useEffect(() => {
    if (!ydoc) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active = true;
    const read = () => {
      const requestedAt = Date.now();
      Docs.get(docId).then(
        (doc) => active && onDoc(doc, requestedAt),
        () => {},
      );
    };
    const onUpdate = () => {
      clearTimeout(timer);
      timer = setTimeout(read, DOC_FLUSH_INTERVAL_MS + INDEX_ALLOWANCE_MS);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") read();
    };
    ydoc.on("update", onUpdate);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      active = false;
      clearTimeout(timer);
      ydoc.off("update", onUpdate);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [docId, ydoc, onDoc]);
}
