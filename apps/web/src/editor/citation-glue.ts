/**
 * Keeps a citation marker on the line of the word before it. A line may break after any space, so
 * the spaces right before a marker get a span that does not wrap (`.citation-glue`); word joiners
 * in editor.css glue the marker's own edges. Decorations only, never the document.
 */
import { Extension } from "@tiptap/react";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";

const citationGlueKey = new PluginKey<DecorationSet>("citationGlue"); // i18n-exempt: plugin identifier

const GLUE_CLASS = "citation-glue";

/** How many whitespace characters `text` ends with. */
function trailingSpaces(text: string): number {
  let i = text.length;
  while (i > 0 && /\s/.test(text[i - 1]!)) i--;
  return text.length - i;
}

function glueDecorations(doc: PMNode): DecorationSet {
  const decos: Decoration[] = [];
  doc.descendants((block, blockPos) => {
    if (!block.inlineContent) return true;
    let before: PMNode | null = null;
    block.forEach((child, offset) => {
      const spaces = before?.isText && child.type.name === "footnoteReference" ? trailingSpaces(before.text!) : 0;
      if (spaces) {
        const at = blockPos + 1 + offset;
        decos.push(Decoration.inline(at - spaces, at, { class: GLUE_CLASS }));
      }
      before = child;
    });
    return false;
  });
  return decos.length ? DecorationSet.create(doc, decos) : DecorationSet.empty;
}

export const CitationGlue = Extension.create({
  name: "citationGlue", // i18n-exempt: extension identifier

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: citationGlueKey,
        state: {
          init: (_, state) => glueDecorations(state.doc),
          apply: (tr, set) => (tr.docChanged ? glueDecorations(tr.doc) : set),
        },
        props: {
          decorations: (state) => citationGlueKey.getState(state),
        },
      }),
    ];
  },
});

/** The same glue for markup serialized outside the editor's view, such as a proposed change's ghost. */
export function glueCitationSpaces(root: ParentNode): void {
  for (const marker of root.querySelectorAll(".citation-ref")) {
    const before = marker.previousSibling;
    if (before?.nodeType !== Node.TEXT_NODE) continue;
    const text = before as Text;
    const spaces = trailingSpaces(text.data);
    if (!spaces) continue;
    const glue = document.createElement("span");
    glue.className = GLUE_CLASS;
    glue.appendChild(text.splitText(text.length - spaces));
    marker.before(glue);
  }
}
