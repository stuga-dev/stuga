/** The dock's Sources panel: the document's footnote definitions, which the body hides, each linked to its marker. */
import { useEffect, useState } from "react";
import { useSharedEditor } from "../editor/editor-context";
import { collectFootnoteDefinitions, findReferencePos, type FootnoteEntry } from "../editor/footnote-detail";

/** Live count of footnote definitions, for the dock tab's badge. */
export function useSourceCount(): number {
  const { editor } = useSharedEditor();
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!editor) return;
    const recompute = () => setCount(collectFootnoteDefinitions(editor.state.doc).length);
    recompute();
    editor.on("transaction", recompute);
    return () => void editor.off("transaction", recompute);
  }, [editor]);
  return count;
}

export function SourcesPanel() {
  const { editor } = useSharedEditor();
  const [sources, setSources] = useState<FootnoteEntry[]>([]);

  useEffect(() => {
    if (!editor) return;
    const recompute = () => setSources(collectFootnoteDefinitions(editor.state.doc));
    recompute();
    editor.on("transaction", recompute);
    return () => void editor.off("transaction", recompute);
  }, [editor]);

  function jumpToMarker(n: number) {
    if (!editor) return;
    const pos = findReferencePos(editor.state.doc, n);
    if (pos === null) return;
    editor.chain().focus().setTextSelection(pos + 1).run();
    requestAnimationFrame(() => {
      const dom = editor.view.domAtPos(pos);
      const el = dom.node instanceof HTMLElement ? dom.node : dom.node.parentElement;
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }

  return (
    <div className="side-body">
      <ul className="sources-list">
        {sources.map((s) => (
          <li key={s.n} className="sources-item">
            <div className="sources-row">
              <button className="sources-num" title="Jump to citation in the document" onClick={() => jumpToMarker(s.n)}>
                [{s.n}]
              </button>
              {s.detail.doc_id ? (
                <a className="sources-title" href={`/doc/${s.detail.doc_id}`} target="_blank" rel="noopener noreferrer" title="Open source document in a new tab">
                  {s.detail.title}
                  {s.detail.heading_path ? ` — ${s.detail.heading_path}` : ""} ↗
                </a>
              ) : (
                <span className="sources-title">
                  {s.detail.title}
                  {s.detail.heading_path ? ` — ${s.detail.heading_path}` : ""}
                </span>
              )}
            </div>
            {s.detail.content && <blockquote className="sources-excerpt">{s.detail.content}</blockquote>}
          </li>
        ))}
        {sources.length === 0 && <li className="empty">No citations yet. Ask the AI co-author a grounded question.</li>}
      </ul>
    </div>
  );
}
