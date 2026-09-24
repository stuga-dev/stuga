/**
 * Hides footnote definitions from the editor body with node decorations; they
 * stay in the document and show in the Sources panel. Decorations never touch
 * the document, and `contenteditable=false` keeps the caret out.
 */
import { Extension } from "@tiptap/react";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

const footnoteHideKey = new PluginKey("footnoteHide");

const HIDE_ATTRS = { class: "footnote-hidden", contenteditable: "false" };

export const FootnoteHide = Extension.create({
  name: "footnoteHide",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: footnoteHideKey,
        props: {
          decorations(state) {
            const decos: Decoration[] = [];
            const doc = state.doc;
            // Definitions are always top-level blocks.
            doc.forEach((node, offset) => {
              if (node.type.name === "footnoteDefinition") {
                decos.push(Decoration.node(offset, offset + node.nodeSize, HIDE_ATTRS));
              }
            });
            return decos.length ? DecorationSet.create(doc, decos) : DecorationSet.empty;
          },
        },
      }),
    ];
  },
});
