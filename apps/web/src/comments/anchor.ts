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
 * and the comment becomes "orphaned" (shown in the sidebar, no highlight).
 */
import * as Y from "yjs";
import type { Editor } from "@tiptap/react";
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
