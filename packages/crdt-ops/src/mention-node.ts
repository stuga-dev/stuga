/**
 * An @mention of a person in a document: an inline atom carrying the person's
 * alias and the label it was inserted with (their username, or a name when
 * they have none). Markdown spells it `[@label](mention:<alias>)`. A pure data
 * spec; the editor adds only behaviour, so both schemas stay identical.
 */
import { Node, mergeAttributes } from "@tiptap/core";

export const Mention = Node.create({
  name: "mention",
  inline: true,
  group: "inline",
  atom: true,
  selectable: false,
  // A mention is its own link, and a code span is verbatim: neither mark may hold one.
  marks: "bold italic strike underline",
  addAttributes() {
    return {
      alias: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-alias") ?? "",
        renderHTML: (attrs) => ({ "data-alias": String(attrs.alias) }),
      },
      label: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-label") ?? "",
        renderHTML: (attrs) => ({ "data-label": String(attrs.label) }),
      },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-mention]" }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { "data-mention": "", class: "mention" }), `@${node.attrs.label}`];
  },
});
