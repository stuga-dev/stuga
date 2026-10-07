/**
 * Lands a document opened from a citation on the cited passage, from the link's
 * `q` (an excerpt slice) and `sec` (the heading path), and one opened from a
 * search hit on the matched block, from `hit` (see passageHint). The body arrives
 * over the socket in several frames, so it retries until a match or the deadline.
 * A citation then says the passage was not found; a search hit leaves the
 * document at the top, as a plain link would. The params stay in the URL.
 */
import { useEffect, useRef } from "react";
import { useLocation, useSearchParams } from "react-router-dom";
import { useToast } from "@astryxdesign/core/Toast";
import type { Editor } from "@tiptap/react";
import { Selection } from "@tiptap/pm/state";
import { useSharedEditor } from "./editor-context";
import { flashBlock } from "./passage-flash";
import { SNIPPET_MIN, headingSegments, stripMarkdown } from "../ai/citations";
import { HIT_PARAM } from "../lib/snippet";

/** A document not rendered by now is not going to match. */
const DEADLINE_MS = 8_000;
const RETRY_MS = 150;
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
    const el = needle ? firstBlock(root, needle) : null;
    if (el) return sectionHeadingOf(root, el) ?? el;
  }
  return null;
}

/**
 * A search hit lands on the block that holds the hit, innermost first, so a
 * paragraph in a list item or a quote flashes alone. Its section heading would
 * leave the reader looking for the words again.
 */
export function findPassage(root: HTMLElement, hit: string): HTMLElement | null {
  const needle = norm(hit);
  // A hand-made link is held to the length a generated one meets.
  if (needle.length < SNIPPET_MIN) return null;
  let block = firstBlock(root, needle);
  let inner = block && firstBlock(block, needle);
  while (inner) {
    block = inner;
    inner = firstBlock(inner, needle);
  }
  return block;
}

/** The first block under `scope`, in document order, whose text holds `needle` (already normalized). */
function firstBlock(scope: HTMLElement, needle: string): HTMLElement | null {
  for (const el of Array.from(scope.querySelectorAll<HTMLElement>(BLOCKS))) {
    if (norm(el.textContent ?? "").includes(needle)) return el;
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

/**
 * Puts the reader at the landed block, not just the viewport, so a Tab into the
 * editor or a screen reader starts at the passage instead of the top. An editable
 * editor gets its caret there without focus: opening a document is reading, and a
 * phone would raise its keyboard. ProseMirror holds the caret until the editor is
 * focused, and puts it back when a Tab in resets it to the top. A read-only
 * editor has no caret, so the block takes focus, as PresenceStack does.
 */
function placeReader(editor: Editor, block: HTMLElement): void {
  if (!editor.isEditable) {
    block.tabIndex = -1;
    // jumpTo placed it below the sticky toolbar; focus's own scroll could tuck it back under.
    block.focus({ preventScroll: true });
    return;
  }
  const { view } = editor;
  try {
    const $pos = view.state.doc.resolve(view.posAtDOM(block, 0));
    // No scrollIntoView, since jumpTo placed it; a selection alone never enters undo history.
    view.dispatch(view.state.tr.setSelection(Selection.near($pos)));
  } catch {
    // A block ProseMirror cannot map leaves the caret where it was; the jump still happened.
  }
}

function useCitationJump(): void {
  const [params] = useSearchParams();
  const toast = useToast();
  const { editor } = useSharedEditor();
  const q = params.get("q") ?? "";
  const sec = params.get("sec") ?? "";
  // A citation's hints win over a search hit's; no link carries both.
  const hit = q || sec ? "" : (params.get(HIT_PARAM) ?? "");
  // The palette's pick of the passage already open repeats the URL, so it carries a fresh nonce to land again.
  const jump = (useLocation().state as { jump?: number } | null)?.jump ?? 0;
  // Once per set of hints and pick, or every render would fight the reader's own scrolling.
  const done = useRef({ key: "", jump: 0 });

  useEffect(() => {
    if (!q && !sec && !hit) return;
    // Escaped: a literal NUL makes tools treat the file as binary.
    const key = `${q}\u0000${sec}\u0000${hit}`;
    // A later navigation that drops the nonce is no new pick.
    if (done.current.key === key && (!jump || done.current.jump === jump)) return;
    if (!editor) return;

    let timer: number | undefined;
    let cancelled = false;
    const giveUpAt = Date.now() + DEADLINE_MS;

    const attempt = () => {
      if (cancelled) return;
      const root = editor.view?.dom as HTMLElement | undefined;
      const target = root ? (hit ? findPassage(root, hit) : findTarget(root, q, sec)) : null;
      if (!target) {
        if (Date.now() < giveUpAt) {
          timer = window.setTimeout(attempt, RETRY_MS);
          return;
        }
        // Spent, so a later render does not toast again.
        done.current = { key, jump };
        if (hit) return;
        toast({
          body: q
            ? `Couldn't find “${q}” in this document. It may have changed since that answer was written.`
            : "Couldn't find the cited passage in this document. It may have changed since that answer was written.",
          type: "error",
        });
        return;
      }
      done.current = { key, jump };
      jumpTo(target);
      placeReader(editor, target);
      flashBlock(editor.view, target);
    };

    attempt();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [editor, q, sec, hit, jump, toast]);
}

/** The hook as a component, to sit inside <EditorProvider>. */
export function CitationJump(): null {
  useCitationJump();
  return null;
}
