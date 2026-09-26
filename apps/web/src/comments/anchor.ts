/**
 * Collaboration-safe text anchors for comments.
 *
 * A comment is pinned to a *range of text*, not to an absolute position: if a
 * collaborator inserts or deletes text earlier in the document, the comment's
 * highlight must travel with its words. We do that with Yjs RelativePositions
 * (the same mechanism y-prosemirror uses for remote cursors, and that Stuga
 * already uses to anchor AI selection edits — see @stuga/crdt-ops).
 *
 * On disk a comment stores two base64 RelativePositions (start/end) plus the
 * quoted text. At render time we decode them and resolve back to live absolute
 * ProseMirror positions; if the anchored text is gone the resolve returns null
 * and the comment becomes "orphaned" (shown in the sidebar, no highlight). A
 * thread's first comment without an anchor, as one imported from an archive
 * is, is placed where its quote occurs if it occurs exactly once (see
 * `quoteRange` and the CommentHighlight plugin), and is orphaned otherwise.
 */
import * as Y from "yjs";
import type { Editor } from "@tiptap/react";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { EditorState } from "@tiptap/pm/state";
import { captureRelRange, resolveRelRange } from "../editor/rel-range";
import type { CommentAnchor } from "../api";

function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
}

function encodeRelPos(pos: Y.RelativePosition): string {
  return bytesToB64(Y.encodeRelativePosition(pos));
}

function decodeRelPos(b64: string): Y.RelativePosition | null {
  try {
    return Y.decodeRelativePosition(b64ToBytes(b64));
  } catch {
    return null;
  }
}

/**
 * Build a comment anchor from the editor's current selection. Returns null for
 * an empty selection or when the editor's Yjs binding isn't ready yet.
 */
export function anchorFromSelection(editor: Editor): CommentAnchor | null {
  const { from, to } = editor.state.selection;
  if (from === to) return null;
  const rel = captureRelRange(editor.state, from, to);
  if (!rel) return null;
  // Decoration-based comments never inject syntax into the doc, so the quote is
  // the clean text between the two positions.
  const quote = editor.state.doc.textBetween(from, to, " ");
  return { start: encodeRelPos(rel.from), end: encodeRelPos(rel.to), quote };
}

/**
 * Resolve a stored anchor's base64 RelativePositions back to live absolute
 * ProseMirror positions, or null if either endpoint can't be resolved (the
 * anchored text was deleted, or the binding isn't ready).
 */
export function resolveAnchorRange(
  ydoc: Y.Doc,
  state: EditorState,
  start: string,
  end: string,
): { from: number; to: number } | null {
  const from = decodeRelPos(start);
  const to = decodeRelPos(end);
  if (!from || !to) return null;
  return resolveRelRange(ydoc, state, { from, to });
}

/**
 * A stretch of the document's text. A text node's characters each sit at their
 * own position; a leaf's text and a block separator start at `from` and end at
 * `to` as one, since a range cannot begin or end inside them.
 */
interface TextRun {
  /** Where the run begins in the document's text. */
  offset: number;
  from: number;
  to: number;
  text: boolean;
}

interface DocText {
  text: string;
  /** In `offset` order. */
  runs: TextRun[];
}

/** A document is immutable, so its text is read once however many comments are placed on it. */
const docTexts = new WeakMap<PMNode, DocText>();

/**
 * The whole document read the way `anchorFromSelection` reads a quote,
 * `textBetween(from, to, " ")`: a space between text blocks, and a leaf only its
 * `leafText`, which a mention does not have.
 */
function docText(doc: PMNode): DocText {
  const cached = docTexts.get(doc);
  if (cached) return cached;
  let text = "";
  const runs: TextRun[] = [];
  let first = true;
  // Where the text read so far ends: a separator's range end.
  let end = 0;
  doc.descendants((node, pos) => {
    const leaf = node.isLeaf && !node.isText ? (node.type.spec.leafText?.(node) ?? "") : "";
    if (node.isBlock && (node.isTextblock || leaf)) {
      const start = node.isTextblock ? pos + 1 : pos;
      if (first) first = false;
      else {
        runs.push({ offset: text.length, from: start, to: end, text: false });
        text += " ";
      }
      end = start;
    }
    if (node.isText) {
      runs.push({ offset: text.length, from: pos, to: pos + node.nodeSize, text: true });
      text += node.text;
      end = pos + node.nodeSize;
    } else if (leaf) {
      runs.push({ offset: text.length, from: pos, to: pos + node.nodeSize, text: false });
      text += leaf;
      end = pos + node.nodeSize;
    }
  });
  const read = { text, runs };
  docTexts.set(doc, read);
  return read;
}

/** The run holding the character at `offset`. */
function runAt(runs: TextRun[], offset: number): TextRun {
  let lo = 0;
  let hi = runs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (runs[mid]!.offset <= offset) lo = mid;
    else hi = mid - 1;
  }
  return runs[lo]!;
}

/** Whether the document holds any text a quote could be found in: none until its content arrives. */
export function docHasText(doc: PMNode): boolean {
  return /\S/.test(docText(doc).text);
}

/** Where a quote sits in the document, when it occurs there exactly once. */
export function quoteRange(doc: PMNode, quote: string): { from: number; to: number } | null {
  if (!quote) return null;
  const { text, runs } = docText(doc);
  const at = text.indexOf(quote);
  if (at < 0 || text.indexOf(quote, at + 1) >= 0) return null;
  const last = at + quote.length - 1;
  const head = runAt(runs, at);
  const tail = runAt(runs, last);
  const from = head.text ? head.from + (at - head.offset) : head.from;
  const to = tail.text ? tail.from + (last - tail.offset) + 1 : tail.to;
  return from < to ? { from, to } : null;
}
