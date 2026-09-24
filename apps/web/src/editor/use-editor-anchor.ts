import { useEffect, useRef, useState, type DependencyList } from "react";
import type { Editor } from "@tiptap/react";

/** Clearance a floating overlay keeps from the window edges. */
const EDGE = 8;

/**
 * Re-read an overlay's position whenever the editor's selection, content or
 * focus changes, the document scrolls, or the window resizes. `read` returns
 * null to hide the overlay; `deps` re-subscribe when state `read` uses changes.
 * The returned `hide` clears the anchor until the next change.
 */
export function useEditorAnchor<T>(
  editor: Editor,
  read: () => T | null,
  deps: DependencyList = [],
): [anchor: T | null, hide: () => void] {
  const [anchor, setAnchor] = useState<T | null>(null);
  const readRef = useRef(read);
  readRef.current = read;

  useEffect(() => {
    if (editor.isDestroyed) return;
    const update = () => setAnchor(readRef.current());
    update();
    const events = ["selectionUpdate", "transaction", "blur", "focus"] as const;
    for (const ev of events) editor.on(ev, update);
    const scroller = editor.view.dom.closest(".doc-main");
    scroller?.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      for (const ev of events) editor.off(ev, update);
      scroller?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, ...deps]);

  return [anchor, () => setAnchor(null)];
}

/** Keep a horizontally centred overlay of the given half-width inside the window. */
export function clampCentre(left: number, halfWidth: number): number {
  return Math.min(Math.max(left, halfWidth + EDGE), window.innerWidth - halfWidth - EDGE);
}
