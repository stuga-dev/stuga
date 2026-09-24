// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { EditorState } from "@tiptap/pm/state";
import { EditorView } from "@tiptap/pm/view";
import { ySyncPlugin } from "@tiptap/y-tiptap";
import { applyMarkdownToYXmlFragment, getStugaSchema } from "@stuga/crdt-ops";
import { captureRelRange, resolveRelRange } from "./rel-range";

describe("selection anchoring (relative positions)", () => {
  it("remaps an AI selection across a concurrent insertion before it", async () => {
    const schema = getStugaSchema();
    const ydoc = new Y.Doc();
    const frag = ydoc.getXmlFragment("default");
    applyMarkdownToYXmlFragment(frag, "AAAAA hello world BBBBB");

    const place = document.createElement("div");
    const view = new EditorView(place, {
      state: EditorState.create({ schema, plugins: [ySyncPlugin(frag)] }),
    });
    const full = view.state.doc.textContent;
    const from = 1 + full.indexOf("hello");
    const to = from + "hello world".length;
    expect(view.state.doc.textBetween(from, to)).toBe("hello world");

    const rel = captureRelRange(view.state, from, to);
    expect(rel).not.toBeNull();

    const textNode = (frag.get(0) as Y.XmlElement).get(0) as Y.XmlText;
    ydoc.transact(() => textNode.insert(0, "XX "));
    await new Promise((r) => setTimeout(r, 0));

    const live = resolveRelRange(ydoc, view.state, rel!);
    expect(live).not.toBeNull();
    expect(live!.from).toBe(from + 3);
    expect(view.state.doc.textBetween(live!.from, live!.to)).toBe("hello world");

    view.destroy();
  });
});
