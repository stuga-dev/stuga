// @vitest-environment jsdom
/**
 * A citation marker stays on the line of the word before it, with the punctuation after it, in the
 * editor and in the read-only views. jsdom has no line layout, so these check what decides a break:
 * the spaces and characters around a marker sit in a box that does not wrap.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { Editor } from "@tiptap/react";
import { stugaEditorExtensions } from "./extensions";
import { glueCitationSpaces } from "./citation-glue";
import { glueCitations } from "./citation-glue-markdown";
import { renderCardMarkdown } from "../review/card-markdown";
import { renderAssistantHtml } from "../ai/render-markdown";
import type { AiCitation } from "@stuga/protocol/wire/doc-socket";

// vitest stubs CSS imports, and cwd is the package root.
beforeAll(() => {
  for (const sheet of ["editor.css", "ask.css", "review.css"]) {
    const style = document.createElement("style");
    style.textContent = readFileSync(resolve(process.cwd(), "src/styles", sheet), "utf8");
    document.head.appendChild(style);
  }
});

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
  document.body.innerHTML = "";
});

const ref = (n: number) => ({ type: "footnoteReference", attrs: { n } });
const text = (t: string) => ({ type: "text", text: t });

function mount(...paragraphs: object[][]): HTMLElement {
  const element = document.body.appendChild(document.createElement("div"));
  const ydoc = new Y.Doc();
  editor = new Editor({
    element,
    extensions: stugaEditorExtensions({ ydoc, awareness: new Awareness(ydoc), alias: "tester", onClickComment: () => {} }),
    // As Editor.tsx sets it; editor.css scopes the editor's rules to it.
    editorProps: { attributes: { class: "stuga-editor" } },
  });
  editor.commands.setContent({ type: "doc", content: paragraphs.map((content) => ({ type: "paragraph", content })) });
  return editor.view.dom;
}

/** The text of each non-wrapping span in `root`, as written. */
function glued(root: ParentNode): string[] {
  return [...root.querySelectorAll<HTMLElement>(".citation-glue")].map((el) => el.textContent ?? "");
}

describe("a citation marker in the editor", () => {
  it("keeps the space before it from wrapping, at its full width", () => {
    const dom = mount([text("Refunds are paid within 14 days of a request "), ref(1), text(".")]);

    const glue = dom.querySelector<HTMLElement>(".citation-glue")!;
    expect(glue.textContent).toBe(" ");
    expect(glue.nextElementSibling?.matches("sup.citation-ref")).toBe(true);
    expect(getComputedStyle(glue).whiteSpace).toBe("pre");
    // The document is untouched: the space is still text in the paragraph.
    expect(editor!.state.doc.textContent).toBe("Refunds are paid within 14 days of a request .");
  });

  it("follows edits to the spaces before it", () => {
    const dom = mount([text("Paid within 14 days "), ref(1), text(".")]);
    const at = "Paid within 14 days".length + 1;

    editor!.commands.deleteRange({ from: at, to: at + 1 });
    expect(glued(dom)).toEqual([]);
    editor!.view.dispatch(editor!.state.tr.insertText("  ", at));
    expect(glued(dom)).toEqual(["  "]);
  });

  it("takes the separator ProseMirror puts between two markers out of the line", () => {
    const dom = mount([text("Two sources at once"), ref(1), ref(2), text(".")]);

    const separator = dom.querySelector("sup.citation-ref + img.ProseMirror-separator")!;
    expect(separator.nextElementSibling?.matches("sup.citation-ref")).toBe(true);
    expect(getComputedStyle(separator).position).toBe("absolute");
  });

  it("glues the spaces before it in a proposed change's ghost too", () => {
    const ghost = document.createElement("p");
    ghost.innerHTML = 'Paid within 14 days <sup class="citation-ref">[1]</sup>. Then <sup class="citation-ref">[2]</sup>';
    glueCitationSpaces(ghost);

    expect(ghost.innerHTML).toBe(
      'Paid within 14 days<span class="citation-glue"> </span><sup class="citation-ref">[1]</sup>. Then<span class="citation-glue"> </span><sup class="citation-ref">[2]</sup>',
    );
  });
});

describe("a citation marker in a read-only view", () => {
  it("shares a span that does not wrap with the last letter, the space and the stop on the review card", () => {
    document.body.innerHTML = renderCardMarkdown("Refunds are paid within 14 days of a request [^1].");

    expect(document.body.innerHTML).toContain('reques<span class="citation-glue">t <sup class="review-card-cite">1</sup>.</span>');
    expect(getComputedStyle(document.querySelector(".citation-glue")!).whiteSpace).toBe("nowrap");
  });

  it("holds an answer's chip, an atomic button, to the characters on both sides", () => {
    const cites: AiCitation[] = [1, 2].map((n) => ({ n, doc_id: "d1", title: "Refund policy", content: "Paid within 14 days." }));
    document.body.innerHTML = renderAssistantHtml("Paid within 14 days [^1]. Cards too[^2][^1], as agreed. 十四天内支付[^2]。", cites);

    expect(glued(document.body)).toEqual(["s [1].", "o[2][1],", "付[2]。"]);
    expect(getComputedStyle(document.querySelector(".citation-glue")!).whiteSpace).toBe("nowrap");
  });

  it("keeps a run without markers as escaped text", () => {
    expect(glueCitations(["a < b"], (s) => s.replace("<", "&lt;"))).toBe("a &lt; b");
  });

  it("keeps markers one span apart only where the text between them could break", () => {
    const esc = (s: string) => s;
    expect(glueCitations(["see", { marker: "<b>1</b>" }, " ", { marker: "<b>2</b>" }, " and"], esc)).toBe(
      'se<span class="citation-glue">e<b>1</b> <b>2</b></span> and',
    );
    expect(glueCitations(["one", { marker: "<b>1</b>" }, ", then two", { marker: "<b>2</b>" }], esc)).toBe(
      'on<span class="citation-glue">e<b>1</b>,</span> then tw<span class="citation-glue">o<b>2</b></span>',
    );
  });

  it("never splits a character that is more than one code point", () => {
    // A family emoji is one character made of several, joined by zero-width joiners.
    expect(glueCitations(["by 👨‍👩‍👧", { marker: "<b>1</b>" }], (s) => s)).toBe('by <span class="citation-glue">👨‍👩‍👧<b>1</b></span>');
  });
});
