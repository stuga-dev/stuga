/**
 * Floating link editor. With the caret inside a link it names where the link goes (a web
 * address, an attached file's name, or the title of a page in Stuga) with Open or Download,
 * Edit and Remove; after the toolbar's Link button (which bumps `editTick`) it shows a URL
 * input that sets or, when emptied, removes the link.
 */
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { getMarkRange, type Editor } from "@tiptap/react";
import { Docs } from "../../api";
import { attachedFileName, linkedDocId } from "../file-links";
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

/** A page link's title, once fetched; the address until then or when it cannot be read. */
function useLinkedTitle(docId: string | null): string | null {
  const [title, setTitle] = useState<{ id: string; title: string } | null>(null);
  useEffect(() => {
    if (!docId) return;
    let alive = true;
    Docs.get(docId)
      .then((d) => alive && setTitle({ id: docId, title: d.title || t("common.untitled") }))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [docId]);
  return title && title.id === docId ? title.title : null;
}

export function LinkPopover({ editor, editTick }: { editor: Editor; editTick: number }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [href, setHref] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const nav = useNavigate();
  const fileName = attachedFileName(href);
  const docId = linkedDocId(href);
  const docTitle = useLinkedTitle(docId);

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
          {docId ? (
            <a
              className="link-popover__url"
              href={href}
              title={docTitle ?? href}
              onClick={(e) => {
                e.preventDefault();
                nav(href);
              }}
            >
              {docTitle ?? href}
            </a>
          ) : (
            <a className="link-popover__url" href={href} target="_blank" rel="noopener noreferrer" title={fileName ?? href}>
              {fileName ?? href}
            </a>
          )}
          {docId ? (
            <button className="link-popover__btn" onClick={() => nav(href)}>{t("common.open")}</button>
          ) : (
            <a className="link-popover__btn" href={href} target="_blank" rel="noopener noreferrer">
              {fileName ? t("editor.link.download") : t("common.open")}
            </a>
          )}
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
