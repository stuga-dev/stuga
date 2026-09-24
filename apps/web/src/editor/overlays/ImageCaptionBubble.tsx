/** Caption editor under a selected image. The caption is the image's `title` (`![alt](src "caption")`). */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { NodeSelection } from "@tiptap/pm/state";
import { captionOf } from "../image-caption";
import { useEditorAnchor } from "../use-editor-anchor";

/** Debounce for writing the caption, so typing isn't one CRDT step and undo entry per character. */
const COMMIT_DEBOUNCE_MS = 300;

interface Target {
  /** Document position of the selected image node. */
  pos: number;
  top: number;
  left: number;
}

/** The selected image node's position, or null when the selection isn't one. */
function selectedImage(editor: Editor): number | null {
  const { selection } = editor.state;
  if (!(selection instanceof NodeSelection)) return null;
  return selection.node.type.name === "image" ? selection.from : null;
}

export function ImageCaptionBubble({ editor }: { editor: Editor }) {
  const [value, setValue] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The write the debounce still owes, carrying the position it was typed at. */
  const pending = useRef<{ pos: number; text: string } | null>(null);
  /** Which image `value` was seeded from, so a reseed can't fight the typing. */
  const seededPos = useRef<number | null>(null);

  /**
   * Write at a captured position, not through updateAttributes(): by the time a
   * debounced write lands the selection or a remote edit may have moved, and the
   * node check turns a stale write into a no-op.
   */
  const commit = useCallback(
    (pos: number, text: string) => {
      if (editor.isDestroyed) return;
      editor
        .chain()
        .command(({ tr }) => {
          const node = tr.doc.nodeAt(pos);
          if (!node || node.type.name !== "image") return false;
          if (captionOf(node.attrs) === text.trim()) return false;
          // Null, not "", so the markdown goes back to a bare ![alt](src).
          tr.setNodeAttribute(pos, "title", text.trim() || null);
          return true;
        })
        .run();
    },
    [editor],
  );

  /** Run the debounced write now, if one is owed. */
  const flush = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const owed = pending.current;
    pending.current = null;
    if (owed) commit(owed.pos, owed.text);
  }, [commit]);

  const [target] = useEditorAnchor(editor, (): Target | null => {
    const pos = selectedImage(editor);
    const dom = pos === null ? null : editor.view.nodeDOM(pos);
    if (pos === null || !(dom instanceof HTMLElement) || !editor.isEditable) {
      seededPos.current = null;
      return null;
    }
    // Reseed only when the selected image changes, or every transaction would overwrite the typing.
    if (seededPos.current !== pos) {
      seededPos.current = pos;
      const node = editor.state.doc.nodeAt(pos);
      setValue(node ? captionOf(node.attrs) : "");
    }
    const box = dom.getBoundingClientRect();
    return { pos, top: box.bottom, left: box.left + box.width / 2 };
  });

  // Teardown writes what the debounce still owes rather than dropping it.
  useEffect(() => flush, [flush]);

  if (!target) return null;

  const onChange = (next: string) => {
    setValue(next);
    if (timer.current) clearTimeout(timer.current);
    pending.current = { pos: target.pos, text: next };
    timer.current = setTimeout(flush, COMMIT_DEBOUNCE_MS);
  };

  return (
    <div
      className="image-caption-popover"
      style={{ top: target.top, left: target.left }}
      role="group"
      aria-label="Image caption"
    >
      <label className="image-caption-popover__label" htmlFor="stuga-image-caption">
        Caption
      </label>
      <input
        id="stuga-image-caption"
        className="image-caption-popover__input"
        value={value}
        placeholder="Describe this image…"
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
        onBlur={flush}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === "Escape") {
            e.preventDefault();
            flush();
            editor.commands.focus();
          }
        }}
      />
    </div>
  );
}
