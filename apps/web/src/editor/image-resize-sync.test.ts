// @vitest-environment jsdom
// Asserts on the rendered <img>, not the document, which always reverted correctly.
import { describe, expect, it, beforeEach } from "vitest";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { Editor } from "@tiptap/react";
import { yUndoPluginKey } from "@tiptap/y-tiptap";
import { stugaEditorExtensions } from "./extensions";
import { applyImageSize, withImageSizeSync } from "./image-resize-sync";

/** jsdom has no layout, so offset sizes are 0. */
function makeEditor(ydoc: Y.Doc) {
  const element = document.createElement("div");
  document.body.appendChild(element);
  return new Editor({
    element,
    extensions: stugaEditorExtensions({
      ydoc,
      awareness: new Awareness(ydoc),
      alias: "tester",
      onClickComment: () => {},
    }),
  });
}

describe("resizing an image in a live editor", () => {
  let ydoc: Y.Doc;
  let editor: Editor;

  beforeEach(() => {
    ydoc = new Y.Doc();
    editor = makeEditor(ydoc);
    editor.commands.setContent({
      type: "doc",
      content: [
        { type: "image", attrs: { src: "media/diagram.png", alt: "d" } },
        { type: "paragraph", content: [{ type: "text", text: "after" }] },
      ],
    });
  });

  /** The rendered image's inline size. */
  const painted = () => {
    const img = editor.view.dom.querySelector("img");
    return { width: img?.style.width ?? "", height: img?.style.height ?? "" };
  };
  /** The image's size in the document. */
  const stored = () => {
    let attrs: Record<string, unknown> = {};
    editor.state.doc.descendants((n) => {
      if (n.type.name === "image") attrs = n.attrs;
    });
    return attrs;
  };
  /** What the resize NodeView commits when a drag ends. */
  const dragTo = (width: number, height: number) =>
    editor.chain().setNodeSelection(0).updateAttributes("image", { width, height }).run();
  /** End the undo capture window, as a pause between drags does. */
  const separateActions = () => yUndoPluginKey.getState(editor.state)!.undoManager.stopCapturing();

  it("paints a size committed to the document", () => {
    dragTo(320, 200);
    expect(stored()).toMatchObject({ width: 320, height: 200 });
    expect(painted()).toEqual({ width: "320px", height: "200px" });
  });

  it("puts the image back to its natural size when the resize is undone", () => {
    dragTo(320, 200);
    expect(painted().width).toBe("320px");

    editor.commands.undo();

    expect(stored().width).toBeFalsy();
    expect(painted()).toEqual({ width: "", height: "" });
  });

  it("restores the previous size when a second resize is undone", () => {
    dragTo(320, 200);
    separateActions();
    dragTo(640, 400);
    expect(painted().width).toBe("640px");

    editor.commands.undo();

    expect(stored()).toMatchObject({ width: 320, height: 200 });
    expect(painted()).toEqual({ width: "320px", height: "200px" });
  });

  it("follows a collaborator's resize arriving over the CRDT", async () => {
    dragTo(320, 200);

    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(ydoc));
    const img = peer.getXmlFragment("default").get(0) as Y.XmlElement;
    peer.transact(() => {
      img.setAttribute("width", 500 as never);
      img.setAttribute("height", 312 as never);
    });
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(peer, Y.encodeStateVector(ydoc)));
    await new Promise((r) => setTimeout(r, 0));

    expect(stored()).toMatchObject({ width: 500, height: 312 });
    expect(painted()).toEqual({ width: "500px", height: "312px" });
  });
});

describe("withImageSizeSync", () => {
  /** A container wrapping an <img>, like the real node view. */
  function fakeView(update?: (n: unknown) => boolean) {
    const dom = document.createElement("div");
    dom.appendChild(document.createElement("img"));
    return { dom, update, destroy() {} };
  }
  const node = (attrs: Record<string, unknown>) => ({ attrs }) as never;
  const img = (v: { dom: HTMLElement }) => v.dom.querySelector("img")!;

  it("returns null for an extension with no node view of its own", () => {
    expect(withImageSizeSync(null)).toBeNull();
    expect(withImageSizeSync(undefined)).toBeNull();
  });

  it("repaints on update and keeps the wrapped view's answer", () => {
    const inner = fakeView(() => true);
    const view = withImageSizeSync(() => inner as never)!({} as never);
    expect(view.update!(node({ width: 240, height: 120 }), [], null as never)).toBe(true);
    expect(img(inner).style.width).toBe("240px");
    expect(img(inner).style.height).toBe("120px");
  });

  it("does not repaint a view that asked to be rebuilt", () => {
    const inner = fakeView(() => false);
    img(inner).style.width = "100px";
    const view = withImageSizeSync(() => inner as never)!({} as never);
    expect(view.update!(node({ width: 240 }), [], null as never)).toBe(false);
    expect(img(inner).style.width).toBe("100px");
  });

  it("leaves a drag in progress alone", () => {
    const inner = fakeView(() => true);
    inner.dom.dataset.resizeState = "true";
    img(inner).style.width = "410px";
    const view = withImageSizeSync(() => inner as never)!({} as never);
    view.update!(node({ width: 240 }), [], null as never);
    expect(img(inner).style.width).toBe("410px");
  });

  it("works for a view whose dom is the image", () => {
    const dom = document.createElement("img");
    const view = withImageSizeSync(() => ({ dom, update: () => true }) as never)!({} as never);
    view.update!(node({ width: 64, height: 64 }), [], null as never);
    expect(dom.style.width).toBe("64px");
  });
});

describe("applyImageSize", () => {
  function target() {
    const dom = document.createElement("div");
    dom.appendChild(document.createElement("img"));
    return dom;
  }

  it("ignores sizes that are not usable pixel counts", () => {
    const dom = target();
    for (const bad of [null, undefined, 0, -20, Number.NaN, "320", "320px"]) {
      applyImageSize(dom, { width: bad });
      expect(dom.querySelector("img")!.style.width, `for ${String(bad)}`).toBe("");
    }
  });

  it("is a no-op when there is no image to paint", () => {
    expect(() => applyImageSize(document.createElement("div"), { width: 10 })).not.toThrow();
  });
});
