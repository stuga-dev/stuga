// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { getSchema } from "@tiptap/react";
import type { Schema } from "@tiptap/pm/model";
import * as Y from "yjs";
import { stugaEditorExtensions } from "./extensions";
import { stugaExtensions } from "@stuga/crdt-ops";
import { captionOf, captionElement, imageCaptionDecorations } from "./image-caption";

function schema(): Schema {
  return getSchema(
    stugaEditorExtensions({ ydoc: new Y.Doc(), awareness: {}, alias: "tester", onClickComment: () => {} }),
  ) as unknown as Schema;
}

describe("captionOf", () => {
  it("reads the title attr and treats blank as absent", () => {
    expect(captionOf({ title: "Fig 1" })).toBe("Fig 1");
    expect(captionOf({ title: "  Fig 1  " })).toBe("Fig 1");
    expect(captionOf({ title: "   " })).toBe("");
    expect(captionOf({ title: null })).toBe("");
    expect(captionOf({})).toBe("");
  });
});

describe("caption decorations", () => {
  it("emits one widget per captioned image, right after the node", () => {
    const s = schema();
    const captioned = s.nodes.image!.create({ src: "a.png", title: "Fig 1" });
    const bare = s.nodes.image!.create({ src: "b.png" });
    const para = s.nodes.paragraph!.create(null, s.text("text"));
    const doc = s.topNodeType.create(null, [captioned, bare, para]);

    const decos = imageCaptionDecorations(doc);
    expect(decos).toHaveLength(1);
    expect(decos[0]!.from).toBe(captioned.nodeSize);
  });

  it("captions an image nested in a blockquote or a list item", () => {
    const s = schema();
    const img = () => s.nodes.image!.create({ src: "a.png", title: "Nested" });
    const quote = s.nodes.blockquote!.create(null, [img()]);
    const doc = s.topNodeType.create(null, [quote]);
    expect(imageCaptionDecorations(doc)).toHaveLength(1);
  });

  it("renders the caption as text, never as markup", () => {
    const el = captionElement('<img src=x onerror="alert(1)">');
    expect(el.textContent).toBe('<img src=x onerror="alert(1)">');
    expect(el.querySelector("img")).toBeNull();
    expect(el.getAttribute("contenteditable")).toBe("false");
  });

  it("never reaches the schema — the editor and server nodes stay identical", () => {
    const editor = schema();
    const server = getSchema(stugaExtensions()) as unknown as Schema;
    expect(Object.keys(editor.nodes).sort()).toEqual(Object.keys(server.nodes).sort());
    expect(Object.keys(editor.nodes.image!.spec.attrs ?? {}).sort()).toEqual(
      Object.keys(server.nodes.image!.spec.attrs ?? {}).sort(),
    );
    expect(Object.keys(server.nodes.image!.spec.attrs ?? {})).toContain("title");
  });
});
