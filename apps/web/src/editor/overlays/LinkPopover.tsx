/**
 * Floating link editor. With the caret inside a link it shows the URL with
 * Open / Edit / Remove; after the toolbar's Link button (which bumps
 * `editTick`) it shows a URL input that sets or, when emptied, removes the link.
 */
import { useEffect, useRef, useState } from "react";
import { getMarkRange, type Editor } from "@tiptap/react";
import { clampCentre, useEditorAnchor } from "../use-editor-anchor";
import { isComposingKey } from "../../lib/ime";
import { t } from "../../i18n/i18n";

const HALF = 150;

/** Add https:// when a typed URL has no scheme. */
function normalizeUrl(raw: string): string {
  const url = raw.trim();
  if (!url) return "";
  return /^[a-z][\w+.-]*:/i.test(url) || url.startsWith("//") ? url : `https://${url}`;
}

export function LinkPopover({ editor, editTick }: { editor: Editor; editTick: number }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [href, setHref] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const [anchor, hide] = useEditorAnchor(
    editor,
    () => {
      const { state, view } = editor;
      const linkType = state.schema.marks.link;
      if (!linkType) return null;
      const range = getMarkRange(state.selection.$from, linkType);
      if (!editing && (!editor.isActive("link") || !range || !view.hasFocus())) return null;
      const coords = view.coordsAtPos(range && !editing ? range.to : state.selection.to);
      if (!editing) setHref((editor.getAttributes("link").href as string) ?? "");
      return { top: coords.bottom, left: clampCentre(coords.left, HALF) };
    },
    [editing],
  );

  // Selecting the whole link first makes Apply rewrite all of it, not just the caret point.
  useEffect(() => {
    if (editTick === 0) return;
    const { state } = editor;
    const linkType = state.schema.marks.link;
    const range = linkType ? getMarkRange(state.selection.$from, linkType) : null;
    if (range) editor.chain().focus().setTextSelection(range).run();
    setDraft((editor.getAttributes("link").href as string) ?? "");
    setEditing(true);
    requestAnimationFrame(() => inputRef.current?.select());
  }, [editTick, editor]);

  function apply() {
    const url = normalizeUrl(draft);
    if (!url) {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
    } else {
      editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
    }
    setEditing(false);
  }

  function remove() {
    editor.chain().focus().extendMarkRange("link").unsetLink().run();
    setEditing(false);
    hide();
  }

  if (!anchor) return null;
  const keep = (e: React.MouseEvent) => e.preventDefault();

  return (
    <div
      className="link-popover"
      style={{ top: anchor.top, left: anchor.left }}
      role="dialog"
      aria-label={editing ? t("editor.link.editLabel") : t("common.link")}
      onMouseDown={keep}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          setEditing(false);
          hide();
        }
      }}
    >
      {editing ? (
        <>
          <input
            ref={inputRef}
            className="link-popover__input"
            type="text"
            autoFocus
            value={draft}
            placeholder={t("editor.link.placeholder")}
            aria-label={t("editor.link.url")}
            onMouseDown={(e) => e.stopPropagation()}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !isComposingKey(e)) {
                e.preventDefault();
                apply();
              }
            }}
          />
          <button className="link-popover__btn" title={t("editor.link.apply")} onClick={apply}>{t("editor.link.apply")}</button>
          {href && (
            <button className="link-popover__btn link-popover__btn--danger" title={t("editor.link.remove")} onClick={remove}>✕</button>
          )}
        </>
      ) : (
        <>
          <a className="link-popover__url" href={href} target="_blank" rel="noopener noreferrer" title={href}>
            {href}
          </a>
          <button
            className="link-popover__btn"
            title={t("editor.link.editLabel")}
            onClick={() => {
              setDraft(href);
              setEditing(true);
              requestAnimationFrame(() => inputRef.current?.select());
            }}
          >
            {t("editor.link.edit")}
          </button>
          <button className="link-popover__btn link-popover__btn--danger" title={t("editor.link.remove")} onClick={remove}>✕</button>
        </>
      )}
    </div>
  );
}
