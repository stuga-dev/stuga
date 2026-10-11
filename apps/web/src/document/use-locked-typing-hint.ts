/**
 * Typing into a locked document says why nothing happens: a read-only editor
 * takes no keys, so without this a keystroke simply vanishes. At most once per
 * HINT_EVERY_MS, and only for keys aimed at the page's text.
 */
import { useEffect, useRef, type RefObject } from "react";
import { useToast } from "../ui/use-toast";
import { t } from "../i18n/i18n";

export const HINT_EVERY_MS = 10_000;

const EDITING_KEYS = new Set(["Enter", "Backspace", "Delete"]);

export function useLockedTypingHint(locked: boolean, page: RefObject<HTMLElement | null>): void {
  const toast = useToast();
  const last = useRef(0);
  useEffect(() => {
    if (!locked) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key.length !== 1 && !EDITING_KEYS.has(e.key)) return;
      // A field elsewhere (the title, a side panel) takes its own typing.
      if ((e.target as Element | null)?.closest?.("input, textarea, [contenteditable='true']")) return;
      const anchor = document.getSelection()?.anchorNode ?? null;
      if (!anchor || !page.current?.contains(anchor)) return;
      const now = Date.now();
      if (now - last.current < HINT_EVERY_MS) return;
      last.current = now;
      toast({ body: t("document.lockedHint"), type: "info" });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [locked, page, toast]);
}
