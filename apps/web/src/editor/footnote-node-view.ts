/**
 * The footnote reference as a clickable `[n]` chip. Only a NodeView is added;
 * the node spec is the server's, so the schemas stay identical.
 */
import type { NodeViewRendererProps } from "@tiptap/react";
import { FootnoteReference } from "@stuga/crdt-ops";
import { anchorBelow, type CitationAnchor } from "../ai/CitationPopover";

/** Fired by a reference chip; FootnotePopover opens the citation on it. */
export const FOOTNOTE_CLICK_EVENT = "stuga:footnote-click";

export interface FootnoteClickDetail {
  n: number;
  anchor: CitationAnchor;
}

export const FootnoteReferenceView = FootnoteReference.extend({
  addNodeView() {
    return (props: NodeViewRendererProps) => {
      const n = Number(props.node.attrs.n) || 1;
      const dom = document.createElement("sup");
      dom.className = "citation-ref";
      dom.setAttribute("data-footnote-ref", "");
      dom.setAttribute("data-n", String(n));
      dom.setAttribute("contenteditable", "false");
      dom.textContent = `[${n}]`;
      dom.title = `Citation ${n}`;
      dom.addEventListener("mousedown", (e) => {
        // Keep ProseMirror from moving the selection into the atom.
        e.preventDefault();
        const detail: FootnoteClickDetail = { n, anchor: anchorBelow(dom) };
        dom.dispatchEvent(new CustomEvent(FOOTNOTE_CLICK_EVENT, { detail, bubbles: true }));
      });
      return {
        dom,
        ignoreMutation: () => true,
        update: (updated) => updated.type.name === props.node.type.name,
      };
    };
  },
});

