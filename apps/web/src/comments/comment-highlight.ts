/**
 * CommentHighlight — a Tiptap extension that paints a highlight under every
 * anchored comment and reports clicks on those highlights.
 *
 * The comments themselves live in React state; this extension only reads them
 * out of its own `storage` (kept in sync by the comments context) and turns
 * each one into a ProseMirror inline Decoration. Decorations are view-only — no
 * marks are written to the document — so the markdown serializer and the CRDT
 * never see them, and concurrent collaborators don't fight over comment ranges.
 */
import { Extension } from "@tiptap/react"; // re-exports @tiptap/core (not a direct dep)
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type * as Y from "yjs";
import type { Comment } from "../api";
import { resolveAnchorRange } from "./anchor";

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

const commentHighlightKey = new PluginKey("commentHighlight");

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
    if ((c.resolved && !flashing) || !c.anchor_start || !c.anchor_end) continue;
    const range = resolveAnchorRange(ydoc, state, c.anchor_start, c.anchor_end);
    if (!range || range.from >= range.to) continue; // orphaned
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

export const CommentHighlight = Extension.create<CommentHighlightOptions, CommentHighlightStorage>({
  name: "commentHighlight",

  addOptions() {
    return { ydoc: null, onClickComment: undefined };
  },

  addStorage() {
    return { comments: [], activeNum: null, flashNum: null };
  },

  addProseMirrorPlugins() {
    const options = this.options;
    const storage = this.storage;
    return [
      new Plugin({
        key: commentHighlightKey,
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
      }),
    ];
  },
});
