/**
 * Shows an image's caption, its `title` attribute, under it in the editor. A
 * widget decoration rather than a NodeView, since the resize NodeView owns the
 * image's DOM; decorations also stay out of the schema shared with the server.
 */
import { Extension } from "@tiptap/react";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";

const imageCaptionKey = new PluginKey("imageCaption");

/** The caption text of an image node, or "" when it has none. */
export function captionOf(attrs: Record<string, unknown>): string {
  return typeof attrs.title === "string" ? attrs.title.trim() : "";
}

/** Exported for tests. */
export function captionElement(caption: string): HTMLElement {
  const el = document.createElement("figcaption");
  el.className = "stuga-image-caption";
  el.textContent = caption;
  // The caret must never land in text no transaction can record.
  el.setAttribute("contenteditable", "false");
  return el;
}

/** One widget after each captioned image, including images nested in lists, quotes and tables. */
export function imageCaptionDecorations(doc: PMNode): Decoration[] {
  const decos: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== "image") return;
    const caption = captionOf(node.attrs);
    if (!caption) return;
    decos.push(
      Decoration.widget(pos + node.nodeSize, () => captionElement(caption), {
        // `key` lets ProseMirror reuse the DOM across redraws.
        side: 1,
        ignoreSelection: true,
        key: `image-caption:${caption}`,
      }),
    );
  });
  return decos;
}

export const ImageCaption = Extension.create({
  name: "imageCaption",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: imageCaptionKey,
        props: {
          decorations(state) {
            const decos = imageCaptionDecorations(state.doc);
            return decos.length ? DecorationSet.create(state.doc, decos) : DecorationSet.empty;
          },
        },
      }),
    ];
  },
});
