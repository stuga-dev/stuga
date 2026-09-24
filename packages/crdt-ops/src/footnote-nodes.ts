/**
 * Footnote nodes for AI citations: an inline `footnoteReference` atom (`[^n]`)
 * and a block `footnoteDefinition` holding the source link and excerpt as inline
 * content. Pure data specs; the editor's NodeView extends the reference without
 * changing its spec, so both schemas stay identical.
 */
import { Node, mergeAttributes } from "@tiptap/core";

/** Inline `[^n]` citation marker. Atom: no editable content, just the number. */
export const FootnoteReference = Node.create({
  name: "footnoteReference",
  inline: true,
  group: "inline",
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      n: {
        default: 1,
        parseHTML: (el) => Number(el.getAttribute("data-n")) || 1,
        renderHTML: (attrs) => ({ "data-n": String(attrs.n) }),
      },
    };
  },
  parseHTML() {
    return [{ tag: "sup[data-footnote-ref]" }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      "sup",
      mergeAttributes(HTMLAttributes, { "data-footnote-ref": "", class: "citation-ref" }),
      `[${node.attrs.n}]`,
    ];
  },
});

/** Block footnote definition: `[^n]: <inline content>` (link + excerpt text). */
export const FootnoteDefinition = Node.create({
  name: "footnoteDefinition",
  group: "block",
  content: "inline*",
  defining: true,
  addAttributes() {
    return {
      n: {
        default: 1,
        parseHTML: (el) => Number(el.getAttribute("data-n")) || 1,
        renderHTML: (attrs) => ({ "data-n": String(attrs.n) }),
      },
    };
  },
  parseHTML() {
    return [{ tag: "div[data-footnote-def]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-footnote-def": "" }), 0];
  },
});
