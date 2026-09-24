// @vitest-environment jsdom
// editor.css draws "Start writing here…" on the paragraph the Placeholder extension marks.
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { Editor, type JSONContent } from "@tiptap/react";
import { stugaEditorExtensions } from "./extensions";
import { rememberUsers } from "../state/identity";

// Known in advance, so the mention chip asks the directory for nothing.
rememberUsers([{ alias: "ann", username: "ann", display_name: "Ann", email: null }]);

let editor: Editor | null = null;

function mount(content: JSONContent[] | null, editable = true): Editor {
  const element = document.createElement("div");
  document.body.appendChild(element);
  const ydoc = new Y.Doc();
  editor = new Editor({
    element,
    editable,
    extensions: stugaEditorExtensions({ ydoc, awareness: new Awareness(ydoc), alias: "tester", onClickComment: () => {} }),
  });
  if (content) editor.commands.setContent({ type: "doc", content });
  return editor;
}

const hinted = (e: Editor) => e.view.dom.querySelector("p.is-editor-empty");

afterEach(() => {
  editor?.destroy();
  editor = null;
  document.body.innerHTML = "";
});

describe("the empty-document hint", () => {
  it("marks the paragraph of an empty document with the hint text", () => {
    const e = mount(null);
    expect(hinted(e)?.getAttribute("data-placeholder")).toBe("Start writing here…");
  });

  it("leaves a paragraph that ends in a mention unmarked", () => {
    const e = mount([{ type: "paragraph", content: [{ type: "mention", attrs: { alias: "ann", label: "Ann" } }] }]);
    // ProseMirror adds the trailing break that the hint must not read as emptiness.
    expect(e.view.dom.querySelector("br.ProseMirror-trailingBreak")).not.toBeNull();
    expect(hinted(e)).toBeNull();
  });

  it("leaves a paragraph that ends in a hard break unmarked", () => {
    const e = mount([{ type: "paragraph", content: [{ type: "text", text: "Hi" }, { type: "hardBreak" }] }]);
    expect(hinted(e)).toBeNull();
  });

  it("marks nothing in a read-only editor", () => {
    const e = mount(null, false);
    expect(hinted(e)).toBeNull();
  });
});
