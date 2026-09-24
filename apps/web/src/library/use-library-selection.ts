import { useCallback, useEffect, useRef, useState } from "react";
import { Docs, type DocSummary } from "../api";
import type { LibraryRow } from "./DocTable";

/**
 * The browse view's selection. A single selected document is mirrored into the
 * URL's `?sel=` and shown in the detail rail; closing the rail deselects.
 */
export function useLibrarySelection({
  selectedDocId,
  onSelectDoc,
  rows,
  loaded,
  movedAway,
}: {
  /** The URL's `?sel=`. */
  selectedDocId: string | null;
  onSelectDoc: (docId: string | null) => void;
  rows: LibraryRow[] | null;
  /** The current listing finished loading; a refetch in flight must not prune the selection. */
  loaded: boolean;
  /** Bumped when the parent's move dialog moved items out of this listing. */
  movedAway: number;
}) {
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [previewDoc, setPreviewDoc] = useState<DocSummary | null>(null);

  /**
   * `?sel=` values written but not yet echoed back as the prop. Two quick clicks
   * put two writes in flight, and only a queue tells our own echoes, in any
   * order, from a real navigation (Back, a deep link) that must be adopted.
   */
  const pendingSelWrites = useRef<Array<string | null>>([]);
  useEffect(() => {
    const q = pendingSelWrites.current;
    const at = q.indexOf(selectedDocId);
    if (at !== -1) {
      q.splice(0, at + 1);
      return;
    }
    setSelectedIds(selectedDocId === null ? new Set() : new Set([selectedDocId]));
  }, [selectedDocId]);

  // A click seeds the preview at once; a deep link has only the id.
  useEffect(() => {
    if (!selectedDocId) {
      setPreviewDoc(null);
      return;
    }
    if (previewDoc?.doc_id === selectedDocId) return;
    let live = true;
    Docs.get(selectedDocId)
      .then((d) => live && setPreviewDoc(d))
      .catch(() => live && setPreviewDoc(null));
    return () => {
      live = false;
    };
  }, [selectedDocId, previewDoc]);

  // Ids no longer in the listing stop counting, or the selection bar counts rows it cannot act on.
  useEffect(() => {
    if (!loaded || rows === null) return;
    const present = new Set(rows.map((r) => r.id));
    setSelectedIds((cur) => {
      if (cur.size === 0) return cur;
      const kept = [...cur].filter((id) => present.has(id));
      return kept.length === cur.size ? cur : new Set(kept);
    });
  }, [rows, loaded]);

  useEffect(() => {
    if (movedAway > 0) setSelectedIds(new Set());
  }, [movedAway]);

  const writeSel = useCallback(
    (next: string | null) => {
      pendingSelWrites.current.push(next);
      onSelectDoc(next);
    },
    [onSelectDoc],
  );

  /** Adopt a selection the table resolved; only a single document goes into `?sel=`. */
  const select = useCallback(
    (ids: string[], primary: LibraryRow | null) => {
      setSelectedIds(new Set(ids));
      const single = ids.length === 1 && primary?.kind === "doc" ? primary : null;
      setPreviewDoc(single?.doc ?? null);
      const nextSel = single ? single.id : null;
      // While a write is in flight the prop is stale, so compare with the last value written.
      const q = pendingSelWrites.current;
      const lastIntended = q.length > 0 ? q[q.length - 1] : selectedDocId;
      // A write of the value the URL already holds never echoes, and would swallow a later navigation to it.
      if (nextSel !== lastIntended) writeSel(nextSel);
    },
    [selectedDocId, writeSel],
  );

  /** Drop items that left the listing, and the rail and `?sel=` with them. */
  const forget = useCallback(
    (ids: ReadonlySet<string>) => {
      setSelectedIds((cur) => {
        const next = new Set([...cur].filter((id) => !ids.has(id)));
        return next.size === cur.size ? cur : next;
      });
      setPreviewDoc((cur) => (cur && ids.has(cur.doc_id) ? null : cur));
      if (selectedDocId && ids.has(selectedDocId)) writeSel(null);
    },
    [selectedDocId, writeSel],
  );

  return {
    selectedIds,
    previewDoc,
    setPreviewDoc,
    /** The rail shows one document's details or none. */
    railVisible: previewDoc !== null && selectedIds.size <= 1,
    select,
    forget,
  };
}
