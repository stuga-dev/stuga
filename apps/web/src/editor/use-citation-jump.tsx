/**
 * Lands a document opened from a citation on the cited passage, from the link's
 * `q` (an excerpt slice) and `sec` (the heading path). The body arrives over the
 * socket in several frames, so it retries until a match or the deadline, then
 * says the passage was not found. The params stay in the URL.
 */
import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { useToast } from "@astryxdesign/core/Toast";
import { useSharedEditor } from "./editor-context";
import { headingSegments, stripMarkdown } from "../ai/citations";

/** A document not rendered by now is not going to match. */
const DEADLINE_MS = 8_000;
const RETRY_MS = 150;
/** How long the landed-on block stays highlighted. */
const FLASH_MS = 1_600;
/** The document's scroll container. */
const SCROLLER = ".doc-main";
/** Breathing room between the sticky toolbar and the passage. */
const GAP_PX = 12;

const BLOCKS = "p, li, blockquote, td, th, pre, h1, h2, h3, h4, h5, h6";
const HEADINGS = "h1, h2, h3, h4, h5, h6";

/** Applied to both the excerpt and the DOM text. */
function norm(s: string): string {
  return stripMarkdown(s).toLowerCase();
}

/**
 * The section heading, which a chunk starts at, wins over the passage so the
 * reader sees which section they are in. The excerpt picks the section when the
 * heading path is missing or does not match.
 */
export function findTarget(root: HTMLElement, q: string, sec: string): HTMLElement | null {
  const heading = findHeading(root, sec);
  if (heading) return heading;

  if (q) {
    const needle = norm(q);
    if (needle) {
      for (const el of Array.from(root.querySelectorAll<HTMLElement>(BLOCKS))) {
        if (norm(el.textContent ?? "").includes(needle)) return sectionHeadingOf(root, el) ?? el;
      }
    }
  }
  return null;
}

/** The nearest heading above `el` in document order, if any. */
function sectionHeadingOf(root: HTMLElement, el: HTMLElement): HTMLElement | null {
  if (/^H[1-6]$/.test(el.tagName)) return el;
  const headings = Array.from(root.querySelectorAll<HTMLElement>(HEADINGS));
  let found: HTMLElement | null = null;
  for (const h of headings) {
    if (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) found = h;
    else break;
  }
  return found;
}

/**
 * Exact on the deepest segment, so "Overview" never matches "Overview of
 * billing". Among headings with that name, the longest matching ancestor chain wins.
 */
function findHeading(root: HTMLElement, sec: string): HTMLElement | null {
  const segs = headingSegments(sec).map(norm).filter(Boolean);
  if (segs.length === 0) return null;
  const target = segs[segs.length - 1]!;
  const wantedAncestors = segs.slice(0, -1);

  const headings = Array.from(root.querySelectorAll<HTMLElement>(HEADINGS));
  const level = (el: HTMLElement) => Number(el.tagName[1]) || 6;
  const candidates = headings.filter((el) => norm(el.textContent ?? "") === target);
  if (candidates.length === 0) return null;
  if (candidates.length === 1 || wantedAncestors.length === 0) return candidates[0]!;

  let best = candidates[0]!;
  let bestScore = -1;
  for (const cand of candidates) {
    const chain: string[] = [];
    let lvl = level(cand);
    for (let i = headings.indexOf(cand) - 1; i >= 0; i--) {
      const h = headings[i]!;
      if (level(h) < lvl) {
        chain.unshift(norm(h.textContent ?? ""));
        lvl = level(h);
      }
    }
    let score = 0;
    while (
      score < chain.length &&
      score < wantedAncestors.length &&
      chain[chain.length - 1 - score] === wantedAncestors[wantedAncestors.length - 1 - score]
    ) {
      score++;
    }
    if (score > bestScore) {
      bestScore = score;
      best = cand;
    }
  }
  return best;
}

/** Instantly, and below the sticky toolbar, which `scrollIntoView` would leave covering the passage. */
export function jumpTo(target: HTMLElement): void {
  const scroller = target.closest<HTMLElement>(SCROLLER) ?? document.querySelector<HTMLElement>(SCROLLER);
  if (!scroller) {
    target.scrollIntoView({ behavior: "auto", block: "start" });
    return;
  }
  const sticky = scroller.querySelector<HTMLElement>(".editor-toolbar-bar");
  const offset = sticky ? sticky.getBoundingClientRect().height : 0;
  const delta = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - offset - GAP_PX;
  scroller.scrollTop += delta;
}

function useCitationJump(): void {
  const [params] = useSearchParams();
  const toast = useToast();
  const { editor } = useSharedEditor();
  const q = params.get("q") ?? "";
  const sec = params.get("sec") ?? "";
  // Once per set of hints, or every render would fight the reader's own scrolling.
  const done = useRef("");

  useEffect(() => {
    if (!q && !sec) return;
    // Escaped: a literal NUL makes tools treat the file as binary.
    const key = `${q}\u0000${sec}`;
    if (done.current === key) return;
    if (!editor) return;

    let timer: number | undefined;
    let cancelled = false;
    const giveUpAt = Date.now() + DEADLINE_MS;

    const attempt = () => {
      if (cancelled) return;
      const root = editor.view?.dom as HTMLElement | undefined;
      const target = root ? findTarget(root, q, sec) : null;
      if (!target) {
        if (Date.now() < giveUpAt) {
          timer = window.setTimeout(attempt, RETRY_MS);
          return;
        }
        // Spent, so a later render does not toast again.
        done.current = key;
        toast({
          body: q
            ? `Couldn't find “${q}” in this document. It may have changed since that answer was written.`
            : "Couldn't find the cited passage in this document. It may have changed since that answer was written.",
          type: "error",
        });
        return;
      }
      done.current = key;
      jumpTo(target);
      target.classList.add("citation-target--flash");
      window.setTimeout(() => target.classList.remove("citation-target--flash"), FLASH_MS);
    };

    attempt();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [editor, q, sec, toast]);
}

/** The hook as a component, to sit inside <EditorProvider>. */
export function CitationJump(): null {
  useCitationJump();
  return null;
}
