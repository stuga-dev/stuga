// @vitest-environment jsdom
/**
 * What the editor paints for a comment, over a REAL Yjs-bound editor state.
 *
 * The anchors here are genuine relative positions captured from a live binding
 * (`anchorFromSelection`, the same call the selection composer makes), not
 * hand-written offsets — so a comment in these tests is anchored exactly the way
 * a comment in the app is, and the orphaning case below is a real orphaning.
 *
 * The load-bearing pair is the resolved one. Resolving a thread must take its
 * highlight away — that is what resolving is FOR — and clicking that thread in
 * the sidebar must bring the highlight back temporarily, or the jump lands the
 * reader mid-paragraph with nothing marking the words it was about. Both halves
 * are asserted, because a regression that simply highlighted resolved threads
 * again would satisfy the second on its own.
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { EditorView } from "@tiptap/pm/view";
import { ySyncPlugin } from "@tiptap/y-tiptap";
import { getStugaSchema, applyMarkdownToYXmlFragment } from "@stuga/crdt-ops";
import type { Comment } from "../api";
import { commentDecorations, type CommentHighlightStorage } from "./comment-highlight";
import { anchorFromSelection } from "./anchor";

const PROSE = "The quick brown fox jumps over the lazy dog.";
const PHRASE = "brown fox";

/** The storage shape the extension reads, with everything off by default. */
function storage(over: Partial<CommentHighlightStorage>): CommentHighlightStorage {
  return { comments: [], activeNum: null, flashNum: null, ...over };
}

/** A live Y-bound view over PROSE, with one comment genuinely anchored to PHRASE. */
function fixture(over: Partial<Comment> = {}) {
  const ydoc = new Y.Doc();
  const frag = ydoc.getXmlFragment("default");
  applyMarkdownToYXmlFragment(frag, PROSE);
  const view = new EditorView(document.createElement("div"), {
    state: EditorState.create({ schema: getStugaSchema(), plugins: [ySyncPlugin(frag)] }),
  });

  const from = 1 + view.state.doc.textContent.indexOf(PHRASE);
  const to = from + PHRASE.length;
  expect(view.state.doc.textBetween(from, to)).toBe(PHRASE);
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));

  // anchorFromSelection only reads `editor.state`; give it exactly that.
  const anchor = anchorFromSelection({ state: view.state } as never);
  expect(anchor, "the y-binding must be ready or the anchor is not a real one").not.toBeNull();

  const comment: Comment = {
    num: 7,
    doc_id: "d1",
    parent_num: null,
    author: "alice",
    body: "why this word?",
    anchor_start: anchor!.start,
    anchor_end: anchor!.end,
    anchor_quote: anchor!.quote,
    resolved: false,
    mentions: [],
    created_at: new Date().toISOString(),
    ...over,
  };
  return { ydoc, view, comment, from, to };
}

function attrs(d: unknown): Record<string, string> {
  return ((d as { type?: { attrs?: Record<string, string> } })?.type?.attrs ?? {}) as Record<string, string>;
}
function className(d: unknown): string {
  return attrs(d).class ?? "";
}

describe("commentDecorations", () => {
  it("paints an open comment over exactly the text it was anchored to", () => {
    const { ydoc, view, comment, from, to } = fixture();
    const decos = commentDecorations(ydoc, view.state, storage({ comments: [comment] }));
    expect(decos).toHaveLength(1);
    expect(decos[0]!.from).toBe(from);
    expect(decos[0]!.to).toBe(to);
    expect(comment.anchor_quote).toBe(PHRASE);
    view.destroy();
  });

  it("marks the active comment so it reads stronger than its neighbours", () => {
    const { ydoc, view, comment } = fixture();
    const plain = commentDecorations(ydoc, view.state, storage({ comments: [comment] }));
    const active = commentDecorations(ydoc, view.state, storage({ comments: [comment], activeNum: 7 }));
    expect(className(plain[0])).toBe("comment-highlight");
    expect(className(active[0])).toContain("comment-highlight--active");
    view.destroy();
  });

  it("paints nothing for a resolved comment", () => {
    const { ydoc, view, comment } = fixture({ resolved: true });
    expect(commentDecorations(ydoc, view.state, storage({ comments: [comment] }))).toEqual([]);
    // Not even when it is the selected row in the sidebar: being active must not
    // resurrect a resolved thread's highlight.
    expect(commentDecorations(ydoc, view.state, storage({ comments: [comment], activeNum: 7 }))).toEqual([]);
    view.destroy();
  });

  it("flashes a resolved comment's anchor while it is the flashed one", () => {
    const { ydoc, view, comment, from, to } = fixture({ resolved: true });
    const lit = commentDecorations(ydoc, view.state, storage({ comments: [comment], activeNum: 7, flashNum: 7 }));
    expect(lit).toHaveLength(1);
    expect(lit[0]!.from).toBe(from);
    expect(lit[0]!.to).toBe(to);
    expect(className(lit[0])).toContain("comment-highlight--flash");
    // …and goes quiet again once the flash times out.
    expect(commentDecorations(ydoc, view.state, storage({ comments: [comment], activeNum: 7, flashNum: null }))).toEqual([]);
    view.destroy();
  });

  it("flashes only the clicked thread, leaving other resolved ones dark", () => {
    const { ydoc, view, comment } = fixture({ resolved: true });
    const other: Comment = { ...comment, num: 8 };
    const decos = commentDecorations(ydoc, view.state, storage({ comments: [comment, other], flashNum: 8 }));
    expect(decos).toHaveLength(1);
    expect(attrs(decos[0])["data-comment-num"]).toBe("8");
    view.destroy();
  });

  it("paints nothing for a doc-level comment", () => {
    const { ydoc, view, comment } = fixture();
    const docLevel: Comment = { ...comment, anchor_start: null, anchor_end: null };
    expect(commentDecorations(ydoc, view.state, storage({ comments: [docLevel] }))).toEqual([]);
    view.destroy();
  });

  it("drops the highlight when the anchored text is deleted, rather than sliding it", () => {
    const { ydoc, view, comment } = fixture();
    const para = ydoc.getXmlFragment("default").get(0) as Y.XmlElement;
    const text = para.get(0) as Y.XmlText;
    ydoc.transact(() => text.delete(text.toString().indexOf(PHRASE), PHRASE.length));
    const decos = commentDecorations(ydoc, view.state, storage({ comments: [comment] }));
    // Either orphaned outright (no decoration) or collapsed to nothing — never a
    // non-empty range over the words that moved into those positions.
    for (const d of decos) expect(d.to - d.from).toBe(0);
    view.destroy();
  });
});
