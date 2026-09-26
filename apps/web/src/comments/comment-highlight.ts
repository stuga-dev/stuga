/**
 * CommentHighlight — a Tiptap extension that paints a highlight under every
 * placed comment (see `commentRange`) and reports clicks on those highlights.
 *
 * The comments themselves live in React state; this extension only reads them
 * out of its own `storage` (kept in sync by the comments context) and turns
 * each one into a ProseMirror inline Decoration. Decorations are view-only — no
 * marks are written to the document — so the markdown serializer and the CRDT
 * never see them, and concurrent collaborators don't fight over comment ranges.
 */
import { Extension } from "@tiptap/react"; // re-exports @tiptap/core (not a direct dep)
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import type * as Y from "yjs";
import type { Comment } from "../api";
import { captureRelRange, resolveRelRange, type RelRange } from "../editor/rel-range";
import { docHasText, quoteRange, resolveAnchorRange } from "./anchor";

export interface CommentHighlightOptions {
  /** The shared Y.Doc, needed to resolve a comment's relative-position anchor. */
  ydoc: Y.Doc | null;
  /** Called with the comment number when a highlight is clicked. */
  onClickComment?: (num: number) => void;
}

export interface CommentHighlightStorage {
  comments: Comment[];
  activeNum: number | null;
  /**
   * A RESOLVED comment whose anchor should be painted anyway, briefly.
   *
   * A resolved thread keeps its anchor but loses its highlight — that is the
   * point of resolving. Clicking it in the sidebar still scrolls the editor to
   * the anchored words, and without a highlight the user lands somewhere in the
   * middle of a paragraph with nothing to tell them which words the thread was
   * about. So the click paints the range for a moment and the context clears it
   * (see comments-context), rather than resurrecting the permanent decoration.
   */
  flashNum: number | null;
}

/** At most this many threads in a document are placed by their quote; the rest are listed, not painted. */
export const QUOTE_PLACEMENT_MAX = 200;

/** Where a thread's first comment without an anchor was placed by its quote, or null for nowhere. */
interface QuotePlacement {
  quote: string;
  at: RelRange | null;
}

interface Placements {
  /** The comment list the placements were worked out for. */
  comments: Comment[] | null;
  byNum: ReadonlyMap<number, QuotePlacement>;
}

const commentHighlightKey = new PluginKey<Placements>("commentHighlight");

const NONE: Placements = { comments: null, byNum: new Map() };

/**
 * Places each thread that has no anchor, as an imported one has none, by
 * searching the text for its quote once: when the comment list changes, or when
 * the text first arrives. The place found is kept as Yjs relative positions, so
 * from then on it travels with its words the way an anchor does, and no
 * keystroke or peer update searches the text again.
 */
function placeByQuote(tr: Transaction, prev: Placements, comments: Comment[], state: EditorState): Placements {
  if (comments === prev.comments) return prev;
  const threads = comments.filter(byQuote).slice(0, QUOTE_PLACEMENT_MAX);
  const byNum = new Map<number, QuotePlacement>();
  for (const c of threads) {
    const kept = prev.byNum.get(c.num);
    if (kept?.quote === c.anchor_quote) byNum.set(c.num, kept);
  }
  if (byNum.size === threads.length) return { comments, byNum };
  // Positions are read through the y-sync binding, which catches up with a local
  // edit only after the edit is applied; y-sync's own changes arrive current.
  const ySync = tr.getMeta(ySyncPluginKey) as { isChangeOrigin?: unknown } | undefined;
  if (tr.docChanged && ySync?.isChangeOrigin !== true) return prev;
  if (!ySyncPluginKey.getState(state)?.binding || !docHasText(state.doc)) return prev;
  for (const c of threads) {
    if (byNum.has(c.num)) continue;
    const range = quoteRange(state.doc, c.anchor_quote!);
    byNum.set(c.num, { quote: c.anchor_quote!, at: range && captureRelRange(state, range.from, range.to) });
  }
  return { comments, byNum };
}

/** A thread's first comment that has no anchor, only a quote. */
function byQuote(c: Comment): boolean {
  return c.parent_num === null && !(c.anchor_start && c.anchor_end) && !!c.anchor_quote;
}

/**
 * Where a comment sits now: its anchor, empty or null once the anchored text is
 * gone, or for a thread's first comment that has none, where its quote occurred
 * exactly once when it was placed (see `placeByQuote`). An anchored comment is
 * never moved to its quote elsewhere, which may be other words. Null leaves it
 * unplaced: listed, not painted.
 */
export function commentRange(ydoc: Y.Doc, state: EditorState, c: Comment): { from: number; to: number } | null {
  if (c.anchor_start && c.anchor_end) return resolveAnchorRange(ydoc, state, c.anchor_start, c.anchor_end);
  const placed = commentHighlightKey.getState(state)?.byNum.get(c.num);
  return placed?.at && placed.quote === c.anchor_quote ? resolveRelRange(ydoc, state, placed.at) : null;
}

/**
 * Every highlight this document should be painting right now.
 *
 * Split out of the plugin (and exported) because it is the whole behaviour: what
 * gets a highlight, which one is emphasised, and — the part that is easy to
 * regress — that a RESOLVED thread is silent unless it is the one being flashed.
 * A plugin's `decorations` prop can only be exercised through a live EditorView;
 * this can be called directly with a state and a storage snapshot.
 */
export function commentDecorations(
  ydoc: Y.Doc | null,
  state: EditorState,
  storage: CommentHighlightStorage,
): Decoration[] {
  if (!ydoc) return [];
  const decos: Decoration[] = [];
  for (const c of storage.comments) {
    const flashing = c.num === storage.flashNum;
    if (c.resolved && !flashing) continue;
    const range = commentRange(ydoc, state, c);
    if (!range || range.from >= range.to) continue; // document-level, or orphaned
    const active = c.num === storage.activeNum;
    decos.push(
      Decoration.inline(range.from, range.to, {
        class: flashing
          ? "comment-highlight comment-highlight--flash"
          : active
            ? "comment-highlight comment-highlight--active"
            : "comment-highlight",
        "data-comment-num": String(c.num),
      }),
    );
  }
  return decos;
}

/** The extension's plugin, over the storage the comments context writes to. */
export function commentHighlightPlugin(options: CommentHighlightOptions, storage: CommentHighlightStorage): Plugin<Placements> {
  return new Plugin<Placements>({
    key: commentHighlightKey,
    state: {
      init: () => NONE,
      apply: (tr, prev, _old, state) => placeByQuote(tr, prev, storage.comments, state),
    },
    props: {
      handleClick(_view, _pos, event) {
        const el = (event.target as HTMLElement)?.closest?.(".comment-highlight");
        if (!el || !options.onClickComment) return false;
        const num = el.getAttribute("data-comment-num");
        if (num) options.onClickComment(Number(num));
        return false; // don't swallow the click; let the caret move too
      },
      decorations(state) {
        return DecorationSet.create(state.doc, commentDecorations(options.ydoc, state, storage));
      },
    },
  });
}

export const CommentHighlight = Extension.create<CommentHighlightOptions, CommentHighlightStorage>({
  name: "commentHighlight",

  addOptions() {
    return { ydoc: null, onClickComment: undefined };
  },

  addStorage() {
    return { comments: [], activeNum: null, flashNum: null };
  },

  addProseMirrorPlugins() {
    return [commentHighlightPlugin(this.options, this.storage)];
  },
});
