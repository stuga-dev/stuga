/** The collaborative editor bound to the document's Y.Doc, with its toolbar and floating overlays. */
import { useEffect, useRef, useState, useCallback } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import type { StugaProvider } from "../sync/stuga-provider";
import { useSharedEditor } from "./editor-context";
import { stugaEditorExtensions } from "./extensions";
import { FootnotePopover } from "./overlays/FootnotePopover";
import { filesFrom, useUpload } from "./use-upload";
import { useComments } from "../comments/comments-context";
import { CommentComposer } from "../comments/CommentComposer";
import { AiEditComposer } from "../ai/AiEditComposer";
import { EditorToolbar } from "./toolbar/EditorToolbar";
import { SelectionBubble } from "./overlays/SelectionBubble";
import { ImageCaptionBubble } from "./overlays/ImageCaptionBubble";
import { LinkPopover } from "./overlays/LinkPopover";
import { SlashMenu } from "./overlays/SlashMenu";
import { MentionMenu } from "./overlays/MentionMenu";
import { UploadTray } from "./overlays/UploadTray";
import { t } from "../i18n/i18n";

export function Editor({ provider, alias, label, docId, readOnly, hasSynced, autoFocus }: { provider: StugaProvider; alias: string; label: string; docId: string; readOnly: boolean; hasSynced: boolean; autoFocus: boolean }) {
  const { setEditor } = useSharedEditor();
  const { clickComment } = useComments();
  // The editor's config is captured once at construction, so its callbacks read through refs.
  const clickRef = useRef(clickComment);
  clickRef.current = clickComment;
  const uploadRef = useRef<(files: File[]) => void>(() => {});
  // Bumped by the toolbar's Link button to open LinkPopover in edit mode.
  const [linkEditTick, setLinkEditTick] = useState(0);
  const requestLinkEdit = useCallback(() => setLinkEditTick((t) => t + 1), []);

  const editor = useEditor({
    editable: !readOnly,
    // Only an intentionally created document should be ready to type immediately.
    // Opening an existing one may be a reading action, especially on a phone.
    autofocus: autoFocus && !readOnly ? "start" : false,
    extensions: stugaEditorExtensions({
      ydoc: provider.doc,
      awareness: provider.awareness,
      alias,
      label,
      onClickComment: (num) => clickRef.current?.(num),
    }),
    editorProps: {
      attributes: { class: "stuga-editor", "aria-label": t("editor.content.label") },
      handlePaste(_view, event) {
        const files = filesFrom(event.clipboardData);
        if (files.length === 0) return false;
        event.preventDefault();
        uploadRef.current(files);
        return true;
      },
      handleDrop(_view, event) {
        const files = filesFrom((event as DragEvent).dataTransfer);
        if (files.length === 0) return false;
        event.preventDefault();
        uploadRef.current(files);
        return true;
      },
    },
  });

  const uploader = useUpload(editor, docId);
  uploadRef.current = uploader.upload;

  useEffect(() => {
    if (editor && !editor.isDestroyed) editor.setEditable(!readOnly);
  }, [editor, readOnly]);

  useEffect(() => {
    setEditor(editor);
    return () => setEditor(null);
  }, [editor, setEditor]);

  if (!editor) return <div className="editor-loading">{t("editor.content.loading")}</div>;
  return (
    <>
      {/* Outside .editor-shell so it ignores the page-width preference. Removed on
          a read-only document because Tiptap commands dispatch regardless of
          `editable`, and a refused local edit would silently vanish. */}
      {!readOnly && (
        <div className="editor-toolbar-bar">
          <EditorToolbar editor={editor} onEditLink={requestLinkEdit} onPickFiles={uploader.upload} />
        </div>
      )}
      <div className="editor-shell">
        <div className="editor-page" data-empty-hint={hasSynced && !readOnly ? "true" : "false"}>
          <EditorContent editor={editor} />
        </div>
        <SelectionBubble editor={editor} readOnly={readOnly} />
        <ImageCaptionBubble editor={editor} />
        <LinkPopover editor={editor} editTick={linkEditTick} />
        <FootnotePopover editor={editor} />
        <SlashMenu editor={editor} onPickFiles={uploader.upload} />
        <MentionMenu editor={editor} />
        <CommentComposer />
        <AiEditComposer />
        <UploadTray uploader={uploader} />
      </div>
    </>
  );
}
