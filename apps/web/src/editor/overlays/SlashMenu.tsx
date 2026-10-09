/**
 * Block insert menu, opened by typing `/` at the start of a block. It deletes
 * the typed `/query` and runs the same editor command the toolbar would.
 */
import { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { useEditorAnchor } from "../use-editor-anchor";
import { isComposingKey } from "../../lib/ime";
import { t, type MessageKey } from "../../i18n/i18n";
import { EN } from "../../i18n/en";

interface SlashItem {
  id: string;
  labelKey: MessageKey;
  hint: string;
  /** Match terms for filtering (besides the label, translated and English). */
  terms: string[];
  run: (e: Editor) => void;
}

const ITEMS: SlashItem[] = [
  { id: "h1", labelKey: "editor.blocks.heading1", hint: "H1", terms: ["title", "h1"], run: (e) => e.chain().focus().toggleHeading({ level: 1 }).run() }, // i18n-exempt: H1–H3 are heading-level glyphs
  { id: "h2", labelKey: "editor.blocks.heading2", hint: "H2", terms: ["h2"], run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run() }, // i18n-exempt: H1–H3 are heading-level glyphs
  { id: "h3", labelKey: "editor.blocks.heading3", hint: "H3", terms: ["h3"], run: (e) => e.chain().focus().toggleHeading({ level: 3 }).run() }, // i18n-exempt: H1–H3 are heading-level glyphs
  { id: "bullet", labelKey: "editor.blocks.bulletList", hint: "•", terms: ["ul", "unordered", "list"], run: (e) => e.chain().focus().toggleBulletList().run() },
  { id: "ordered", labelKey: "editor.blocks.numberedList", hint: "1.", terms: ["ol", "ordered", "number", "list"], run: (e) => e.chain().focus().toggleOrderedList().run() },
  { id: "quote", labelKey: "editor.blocks.quote", hint: "❝", terms: ["blockquote", "citation"], run: (e) => e.chain().focus().toggleBlockquote().run() },
  { id: "code", labelKey: "editor.blocks.codeBlock", hint: "{ }", terms: ["pre", "snippet", "fence"], run: (e) => e.chain().focus().toggleCodeBlock().run() },
  // setCodeBlock, not toggle, so it also works from an empty block.
  { id: "mermaid", labelKey: "editor.blocks.mermaid", hint: "◇", terms: ["diagram", "flowchart", "graph", "chart", "sequence"], run: (e) => e.chain().focus().setCodeBlock({ language: "mermaid" }).run() },
  { id: "divider", labelKey: "editor.blocks.divider", hint: "―", terms: ["hr", "horizontal", "rule", "separator"], run: (e) => e.chain().focus().setHorizontalRule().run() },
  { id: "table", labelKey: "editor.blocks.table", hint: "⊞", terms: ["grid", "rows", "columns"], run: (e) => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
];

/**
 * The query after a `/` at the very start of a block: letters, marks and digits of any script, so
 * `/标题` filters as `/heading` does. A `/` mid-sentence never opens the menu.
 */
const SLASH_QUERY = /^\/([\p{L}\p{M}\p{N}_-]*)$/u;

/** Whether an item answers a query, by its label in the interface language, its English label, or its terms. */
function slashItemMatches(item: Pick<SlashItem, "labelKey" | "terms">, query: string): boolean {
  const q = query.toLowerCase();
  if (!q) return true;
  return (
    t(item.labelKey).toLowerCase().includes(q) ||
    (EN[item.labelKey] ?? "").toLowerCase().includes(q) ||
    item.terms.some((term) => term.includes(q))
  );
}

interface SlashState {
  /** Doc position of the block start, where the `/` is. */
  from: number;
  /** Doc position of the caret (end of the query). */
  to: number;
  query: string;
  rect: { top: number; left: number };
}

export function SlashMenu({
  editor,
  onPickFiles,
}: {
  editor: Editor;
  /** Upload and insert files through the shared progress-tracked uploader: images as images, anything else as links. */
  onPickFiles: (files: File[]) => void;
}) {
  const [active, setActive] = useState(0);
  const imageRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // The capture-phase key handler is bound once, so it reads the latest values through refs.
  const stateRef = useRef<SlashState | null>(null);
  const activeRef = useRef(0);
  const filteredRef = useRef<SlashItem[]>([]);

  const allItems: SlashItem[] = [
    ...ITEMS,
    { id: "image", labelKey: "editor.blocks.image", hint: "▣", terms: ["img", "photo", "picture", "upload"], run: () => imageRef.current?.click() },
    { id: "file", labelKey: "editor.blocks.file", hint: "⎘", terms: ["attachment", "attach", "pdf", "document", "upload"], run: () => fileRef.current?.click() },
  ];

  const [state, hide] = useEditorAnchor(editor, (): SlashState | null => {
    const { state: s, view } = editor;
    const sel = s.selection;
    if (!sel.empty || !view.hasFocus() || !editor.isEditable) return null;
    const $from = sel.$from;
    if (!$from.parent.isTextblock || $from.parent.type.name === "codeBlock") return null;
    const blockStart = $from.start();
    const m = SLASH_QUERY.exec(s.doc.textBetween(blockStart, sel.from, "\n", "\n"));
    if (!m) return null;
    const coords = view.coordsAtPos(sel.from);
    if (stateRef.current?.from !== blockStart || stateRef.current.query !== (m[1] ?? "")) setActive(0);
    return { from: blockStart, to: sel.from, query: m[1] ?? "", rect: { top: coords.bottom, left: coords.left } };
  });

  const filtered = state
    ? allItems.filter((it) => slashItemMatches(it, state.query))
    : [];
  filteredRef.current = filtered;
  stateRef.current = state;
  activeRef.current = active;

  // Capture phase, so menu keys never reach ProseMirror as caret moves or newlines.
  useEffect(() => {
    if (editor.isDestroyed) return;
    const dom = editor.view.dom;
    const onKey = (e: KeyboardEvent) => {
      const st = stateRef.current;
      const items = filteredRef.current;
      // An input method's keys pick its own candidates, not a block.
      if (!st || isComposingKey(e)) return;
      if (e.key === "Escape") {
        e.preventDefault();
        hide();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((a) => (items.length ? (a + 1) % items.length : 0));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => (items.length ? (a - 1 + items.length) % items.length : 0));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        if (!items.length) return;
        e.preventDefault();
        choose(items[activeRef.current] ?? items[0]!);
      }
    };
    dom.addEventListener("keydown", onKey, true);
    return () => dom.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  function choose(item: SlashItem) {
    const st = stateRef.current;
    if (!st) return;
    editor.chain().focus().deleteRange({ from: st.from, to: st.to }).run();
    item.run(editor);
    hide();
  }

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length) onPickFiles(files);
  }

  // The menu is about 240px wide and up to 320px tall.
  const left = state ? Math.min(state.rect.left, window.innerWidth - 250) : 0;
  const top = state ? Math.min(state.rect.top + 4, window.innerHeight - 320) : 0;

  // The input stays mounted outside the menu: the menu closes in the same tick
  // that `choose` clicks it, and a remounted input never delivers its file.
  return (
    <>
      <input ref={imageRef} type="file" accept="image/*" multiple hidden onChange={onPick} />
      <input ref={fileRef} type="file" multiple hidden onChange={onPick} />
      {state && (
        <div className="slash-menu" style={{ top, left }} role="listbox" aria-label={t("editor.slash.label")}>
          {filtered.length === 0 && (
            <div className="slash-item slash-item--empty" role="presentation">
              <span className="slash-item__label">
                {state.query ? t("editor.slash.noMatch", { query: state.query }) : t("editor.slash.empty")}
              </span>
            </div>
          )}
          {filtered.map((it, i) => (
            <button
              key={it.id}
              type="button"
              role="option"
              aria-selected={i === active}
              className={`slash-item${i === active ? " active" : ""}`}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(it)}
            >
              <span className="slash-item__hint" aria-hidden="true">{it.hint}</span>
              <span className="slash-item__label">{t(it.labelKey)}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}
