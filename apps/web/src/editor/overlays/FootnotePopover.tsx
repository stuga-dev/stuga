/**
 * Opens the citation popover for a clicked footnote reference, reading its
 * source and excerpt from the matching definition in the document itself.
 */
import { useCallback, useEffect, useState } from "react";
import type { Editor } from "@tiptap/react";
import type { Node as PMNode } from "@tiptap/pm/model";
import { CitationPopover, type CitationAnchor } from "../../ai/CitationPopover";
import type { CitationDetail } from "../../ai/citations";
import { FOOTNOTE_CLICK_EVENT, type FootnoteClickDetail } from "../footnote-node-view";
import { readDefinition } from "../footnote-detail";

export function FootnotePopover({ editor }: { editor: Editor }) {
  const [popover, setPopover] = useState<{ citation: CitationDetail; anchor: CitationAnchor } | null>(null);
  const close = useCallback(() => setPopover(null), []);

  useEffect(() => {
    const dom = editor.view.dom;
    const onClick = (e: Event) => {
      const { n, anchor } = (e as CustomEvent<FootnoteClickDetail>).detail;
      let found: PMNode | null = null;
      editor.state.doc.descendants((node) => {
        if (found) return false;
        if (node.type.name === "footnoteDefinition" && Number(node.attrs.n) === n) {
          found = node;
          return false;
        }
        return true;
      });
      const citation: CitationDetail = found ? readDefinition(found, n) : { n, doc_id: "", title: "Untitled" };
      setPopover({ citation, anchor });
    };
    dom.addEventListener(FOOTNOTE_CLICK_EVENT, onClick);
    return () => dom.removeEventListener(FOOTNOTE_CLICK_EVENT, onClick);
  }, [editor]);

  if (!popover) return null;
  return <CitationPopover citation={popover.citation} anchor={popover.anchor} onClose={close} />;
}
