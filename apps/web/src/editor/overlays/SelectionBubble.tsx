/**
 * Floating actions above a text selection: Comment, and Edit with AI unless the
 * document is read-only (commenting is a separate grant from editing) or the
 * node's AI chat is off.
 */
import type { MouseEvent as ReactMouseEvent } from "react";
import type { Editor } from "@tiptap/react";
import { Button } from "@astryxdesign/core/Button";
import { MessageSquarePlus, Sparkles } from "lucide-react";
import { useComments } from "../../comments/comments-context";
import { useAiCoauthor } from "../../ai/ai-coauthor-context";
import { useAiChat } from "../../state/model-options";
import { clampCentre, useEditorAnchor } from "../use-editor-anchor";

/** Generous half-width of the bubble. */
const HALF = 110;

export function SelectionBubble({
  editor,
  readOnly,
}: {
  editor: Editor;
  /** Passed in because `editor.isEditable` lags one render behind a lock. */
  readOnly: boolean;
}) {
  const { startForSelection, pending } = useComments();
  const { startSelectionEdit, selectionEdit } = useAiCoauthor();
  // The dock's AI tab says how to turn AI on; an action that can only fail has no place here.
  const aiOff = useAiChat() === "off";
  const [rect] = useEditorAnchor(editor, () => {
    const { state, view } = editor;
    const { from, to, empty } = state.selection;
    if (empty || !view.hasFocus() || state.doc.textBetween(from, to, " ").trim() === "") return null;
    const start = view.coordsAtPos(from);
    const end = view.coordsAtPos(to);
    // A wrapped selection's endpoints sit on different lines, so centre only a single-line one.
    const sameLine = Math.abs(start.top - end.top) < 4;
    return {
      top: Math.min(start.top, end.top),
      left: clampCentre(sameLine ? (start.left + end.left) / 2 : start.left, HALF),
    };
  });

  // Hidden while a comment or AI-edit composer is open.
  if (!rect || pending || selectionEdit) return null;

  const keep = (e: ReactMouseEvent) => e.preventDefault();

  return (
    <div className="selection-bubble" style={{ top: rect.top, left: rect.left }} role="toolbar" aria-label="Selection actions">
      <Button label="Comment" variant="ghost" size="sm" icon={<MessageSquarePlus size={15} />} onMouseDown={keep} onClick={startForSelection} />
      {!readOnly && !aiOff && (
        <Button label="Edit with AI" variant="ghost" size="sm" icon={<Sparkles size={15} />} onMouseDown={keep} onClick={startSelectionEdit} />
      )}
    </div>
  );
}
