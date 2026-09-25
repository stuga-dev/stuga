import { useEffect } from "react";
import type * as Y from "yjs";
import { DOC_FLUSH_INTERVAL_MS } from "@stuga/protocol/domain/limits";
import { Docs, type DocSummary } from "../api";

/** Time the index job gets, after the actor's snapshot, to write the document's row, embedding included. */
export const INDEX_ALLOWANCE_MS = 10_000;

/**
 * Re-read the document once its content has been still long enough to be
 * snapshotted and indexed: indexing re-derives the title of a document nobody
 * renamed, and the server has no other way to say so.
 */
export function useRefreshAfterIndexing(docId: string, ydoc: Y.Doc | null, onDoc: (doc: DocSummary) => void): void {
  useEffect(() => {
    if (!ydoc) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active = true;
    const onUpdate = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        Docs.get(docId).then(
          (doc) => active && onDoc(doc),
          () => {},
        );
      }, DOC_FLUSH_INTERVAL_MS + INDEX_ALLOWANCE_MS);
    };
    ydoc.on("update", onUpdate);
    return () => {
      active = false;
      clearTimeout(timer);
      ydoc.off("update", onUpdate);
    };
  }, [docId, ydoc, onDoc]);
}
