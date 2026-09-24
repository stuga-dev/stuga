/**
 * Keeps the reader's place across a page width or zoom change, which reflows
 * the document. The anchor is the top block on screen and the fraction of it
 * scrolled past, not a pixel offset.
 */
import { useCallback, useRef } from "react";

/** The scroll container for the document sheet. */
const SCROLLER = ".doc-main";

interface Anchor {
  el: HTMLElement;
  /** Fraction of the anchor's own height that was above the viewport top. */
  into: number;
}

function findAnchor(scroller: HTMLElement): Anchor | null {
  const editor = scroller.querySelector(".stuga-editor");
  if (!editor) return null;
  const top = scroller.getBoundingClientRect().top;
  for (const child of Array.from(editor.children)) {
    if (!(child instanceof HTMLElement)) continue;
    const r = child.getBoundingClientRect();
    if (r.bottom <= top) continue;
    const into = r.height > 0 ? Math.min(Math.max((top - r.top) / r.height, 0), 1) : 0;
    return { el: child, into };
  }
  return null;
}

function restoreAnchor(scroller: HTMLElement, a: Anchor): void {
  const top = scroller.getBoundingClientRect().top;
  const r = a.el.getBoundingClientRect();
  const targetWithinAnchor = a.into * r.height;
  // A delta, so the scroller's padding and borders do not matter.
  scroller.scrollTop += r.top + targetWithinAnchor - top;
}

/**
 * Runs a layout-changing update while holding the reading position. The restore
 * waits two frames for the committed layout, with smooth scrolling forced off.
 */
export function useKeepReadingPosition(): (apply: () => void) => void {
  const busy = useRef(false);

  return useCallback((apply: () => void) => {
    const scroller = document.querySelector(SCROLLER);
    if (!(scroller instanceof HTMLElement)) {
      apply();
      return;
    }
    const anchor = findAnchor(scroller);
    const prevBehavior = scroller.style.scrollBehavior;
    scroller.style.scrollBehavior = "auto";
    scroller.classList.add("doc-main--reflowing");

    apply();

    if (!anchor || busy.current) {
      scroller.style.scrollBehavior = prevBehavior;
      scroller.classList.remove("doc-main--reflowing");
      return;
    }
    busy.current = true;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        // A collaborator's edit may have removed it.
        if (anchor.el.isConnected) restoreAnchor(scroller, anchor);
        scroller.style.scrollBehavior = prevBehavior;
        scroller.classList.remove("doc-main--reflowing");
        busy.current = false;
      });
    });
  }, []);
}
