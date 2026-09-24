/**
 * Anchor a ProseMirror range to Yjs relative positions, which travel with the
 * content, and resolve it back to absolute positions after collaborators edit.
 *
 * Reads the binding through @tiptap/y-tiptap, the package the Collaboration
 * extension installs the y-sync plugin from: a separate y-prosemirror copy would
 * carry a different PluginKey and `getState` would return undefined.
 */
import { ySyncPluginKey, absolutePositionToRelativePosition, relativePositionToAbsolutePosition } from "@tiptap/y-tiptap";
import type { EditorState } from "@tiptap/pm/state";
import type * as Y from "yjs";

export interface RelRange {
  from: Y.RelativePosition;
  to: Y.RelativePosition;
}

interface Binding {
  type: Y.XmlFragment;
  mapping: unknown;
}

function getBinding(state: EditorState): Binding | null {
  const ps = ySyncPluginKey.getState(state) as { binding?: Binding } | undefined;
  return ps?.binding ?? null;
}

/** Null while the binding is not ready, including when a concurrent structural change makes the helpers throw. */
export function captureRelRange(state: EditorState, from: number, to: number): RelRange | null {
  const b = getBinding(state);
  if (!b) return null;
  try {
    return {
      from: absolutePositionToRelativePosition(from, b.type, b.mapping as never),
      to: absolutePositionToRelativePosition(to, b.type, b.mapping as never),
    };
  } catch {
    return null;
  }
}

/** Null when the range is gone. Never throws: it runs on every transaction for the comment highlights. */
export function resolveRelRange(ydoc: Y.Doc, state: EditorState, rel: RelRange): { from: number; to: number } | null {
  const b = getBinding(state);
  if (!b) return null;
  try {
    const from = relativePositionToAbsolutePosition(ydoc, b.type, rel.from, b.mapping as never);
    const to = relativePositionToAbsolutePosition(ydoc, b.type, rel.to, b.mapping as never);
    if (from == null || to == null) return null;
    return { from, to };
  } catch {
    return null;
  }
}
