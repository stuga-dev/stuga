/**
 * Floating actions above a text selection: bold, italic and link while the document
 * is editable, Comment, and Edit with AI unless the document is read-only
 * (commenting is a separate grant from editing) or the node's AI chat is off.
 */
import type { MouseEvent as ReactMouseEvent } from "react";
import type { Editor } from "@tiptap/react";
import { Button } from "@astryxdesign/core/Button";
import { ToggleButton } from "@astryxdesign/core/ToggleButton";
import { Divider } from "@astryxdesign/core/Divider";
import { Bold, Italic, Link2, MessageSquarePlus, Sparkles } from "lucide-react";
import { useComments } from "../../comments/comments-context";
import { useAiCoauthor } from "../../ai/ai-coauthor-context";
import { useAiChat } from "../../state/model-options";
import { clampCentre, useEditorAnchor } from "../use-editor-anchor";
import { t } from "../../i18n/i18n";

/** Generous half-width of the bubble. */
const HALF = 180;

export function SelectionBubble({
  editor,
  readOnly,
  onEditLink,
}: {
  editor: Editor;
  /** Passed in because `editor.isEditable` lags one render behind a lock. */
  readOnly: boolean;
  /** Opens the link editor on the selection, as the toolbar's Link does. */
  onEditLink: () => void;
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
    <div className="selection-bubble" style={{ top: rect.top, left: rect.left }} role="toolbar" aria-label={t("editor.selection.label")}>
      {!readOnly && (
        <>
          <ToggleButton label={t("editor.toolbar.bold", { shortcut: "⌘B" })} tooltip={t("editor.toolbar.bold", { shortcut: "⌘B" })} size="sm" isIconOnly icon={<Bold size={15} />} isPressed={editor.isActive("bold")} onPressedChange={() => editor.chain().focus().toggleBold().run()} onMouseDown={keep} />
          <ToggleButton label={t("editor.toolbar.italic", { shortcut: "⌘I" })} tooltip={t("editor.toolbar.italic", { shortcut: "⌘I" })} size="sm" isIconOnly icon={<Italic size={15} />} isPressed={editor.isActive("italic")} onPressedChange={() => editor.chain().focus().toggleItalic().run()} onMouseDown={keep} />
          <ToggleButton label={t("common.link")} tooltip={t("common.link")} size="sm" isIconOnly icon={<Link2 size={15} />} isPressed={editor.isActive("link")} onPressedChange={onEditLink} onMouseDown={keep} />
          <Divider orientation="vertical" />
        </>
      )}
      <Button label={t("common.comment")} variant="ghost" size="sm" icon={<MessageSquarePlus size={15} />} onMouseDown={keep} onClick={startForSelection} />
      {!readOnly && !aiOff && (
        <Button label={t("editor.selection.editWithAi")} variant="ghost" size="sm" icon={<Sparkles size={15} />} onMouseDown={keep} onClick={startSelectionEdit} />
      )}
    </div>
  );
}
