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
 *
 * A comment imported from an archive has no anchor, only its quote, and is
 * placed where the quote occurs if it occurs exactly once. The text is searched
 * once, not on every transaction; from then on the place travels with its words.
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { EditorView } from "@tiptap/pm/view";
import { ySyncPlugin } from "@tiptap/y-tiptap";
import { getStugaSchema, applyMarkdownToYXmlFragment } from "@stuga/crdt-ops";
import type { Comment } from "../api";
import {
  commentDecorations,
  commentHighlightPlugin,
  commentRange,
  QUOTE_PLACEMENT_MAX,
  type CommentHighlightStorage,
} from "./comment-highlight";
import { anchorFromSelection } from "./anchor";

const PROSE = "The quick brown fox jumps over the lazy dog.";
const PHRASE = "brown fox";

/**
 * A live Y-bound view over a markdown body with the highlight plugin installed,
 * and `paint`, which hands the plugin a storage snapshot (everything off by
 * default) the way the comments context does and returns what it paints.
 */
function body(markdown: string) {
  const ydoc = new Y.Doc();
  const frag = ydoc.getXmlFragment("default");
  applyMarkdownToYXmlFragment(frag, markdown);
  const storage: CommentHighlightStorage = { comments: [], activeNum: null, flashNum: null };
  const view = new EditorView(document.createElement("div"), {
    state: EditorState.create({
      schema: getStugaSchema(),
      plugins: [ySyncPlugin(frag), commentHighlightPlugin({ ydoc }, storage)],
    }),
  });
  const paint = (over: Partial<CommentHighlightStorage>) => {
    Object.assign(storage, { comments: [], activeNum: null, flashNum: null, ...over });
    view.dispatch(view.state.tr.setMeta("commentHighlight", true));
    return commentDecorations(ydoc, view.state, storage);
  };
  return { ydoc, view, paint };
}

/** A live Y-bound view over PROSE, with one comment genuinely anchored to PHRASE. */
function fixture(over: Partial<Comment> = {}) {
  const { ydoc, view, paint } = body(PROSE);

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
  return { ydoc, view, paint, comment, from, to };
}

function attrs(d: unknown): Record<string, string> {
  return ((d as { type?: { attrs?: Record<string, string> } })?.type?.attrs ?? {}) as Record<string, string>;
}
function className(d: unknown): string {
  return attrs(d).class ?? "";
}

describe("commentDecorations", () => {
  it("paints an open comment over exactly the text it was anchored to", () => {
    const { view, paint, comment, from, to } = fixture();
    const decos = paint({ comments: [comment] });
    expect(decos).toHaveLength(1);
    expect(decos[0]!.from).toBe(from);
    expect(decos[0]!.to).toBe(to);
    expect(comment.anchor_quote).toBe(PHRASE);
    view.destroy();
  });

  it("marks the active comment so it reads stronger than its neighbours", () => {
    const { view, paint, comment } = fixture();
    const plain = paint({ comments: [comment] });
    const active = paint({ comments: [comment], activeNum: 7 });
    expect(className(plain[0])).toBe("comment-highlight");
    expect(className(active[0])).toContain("comment-highlight--active");
    view.destroy();
  });

  it("paints nothing for a resolved comment", () => {
    const { view, paint, comment } = fixture({ resolved: true });
    expect(paint({ comments: [comment] })).toEqual([]);
    // Not even when it is the selected row in the sidebar: being active must not
    // resurrect a resolved thread's highlight.
    expect(paint({ comments: [comment], activeNum: 7 })).toEqual([]);
    view.destroy();
  });

  it("flashes a resolved comment's anchor while it is the flashed one", () => {
    const { view, paint, comment, from, to } = fixture({ resolved: true });
    const lit = paint({ comments: [comment], activeNum: 7, flashNum: 7 });
    expect(lit).toHaveLength(1);
    expect(lit[0]!.from).toBe(from);
    expect(lit[0]!.to).toBe(to);
    expect(className(lit[0])).toContain("comment-highlight--flash");
    // …and goes quiet again once the flash times out.
    expect(paint({ comments: [comment], activeNum: 7, flashNum: null })).toEqual([]);
    view.destroy();
  });

  it("flashes only the clicked thread, leaving other resolved ones dark", () => {
    const { view, paint, comment } = fixture({ resolved: true });
    const other: Comment = { ...comment, num: 8 };
    const decos = paint({ comments: [comment, other], flashNum: 8 });
    expect(decos).toHaveLength(1);
    expect(attrs(decos[0])["data-comment-num"]).toBe("8");
    view.destroy();
  });

  it("paints nothing for a doc-level comment", () => {
    const { view, paint, comment } = fixture();
    const docLevel: Comment = { ...comment, anchor_start: null, anchor_end: null, anchor_quote: null };
    expect(paint({ comments: [docLevel] })).toEqual([]);
    view.destroy();
  });

  it("drops the highlight when the anchored text is deleted, rather than sliding it", () => {
    const { ydoc, view, paint, comment } = fixture();
    const para = ydoc.getXmlFragment("default").get(0) as Y.XmlElement;
    const text = para.get(0) as Y.XmlText;
    ydoc.transact(() => text.delete(text.toString().indexOf(PHRASE), PHRASE.length));
    const decos = paint({ comments: [comment] });
    // Either orphaned outright (no decoration) or collapsed to nothing — never a
    // non-empty range over the words that moved into those positions.
    for (const d of decos) expect(d.to - d.from).toBe(0);
    view.destroy();
  });
});

/** A thread's first comment as an archive import stores it: an author that is no account, and only a quote. */
function importedComment(quote: string | null, over: Partial<Comment> = {}): Comment {
  return {
    num: 3,
    doc_id: "d1",
    parent_num: null,
    author: "imported:Liv",
    body: "is this still true?",
    anchor_start: null,
    anchor_end: null,
    anchor_quote: quote,
    resolved: false,
    mentions: [],
    created_at: "2025-03-01T09:00:00Z",
    ...over,
  };
}

/** The text each decoration covers, read by the rule a quote is captured by. */
function painted(view: EditorView, decos: { from: number; to: number }[]): string[] {
  return decos.map((d) => view.state.doc.textBetween(d.from, d.to, " "));
}

describe("commentDecorations: a comment without an anchor", () => {
  it("is painted over its quote when the quote occurs once", () => {
    const { view, paint } = body(PROSE);
    const decos = paint({ comments: [importedComment(PHRASE)] });
    expect(decos).toHaveLength(1);
    expect(decos[0]!.from).toBe(1 + PROSE.indexOf(PHRASE));
    expect(painted(view, decos)).toEqual([PHRASE]);
    expect(attrs(decos[0])["data-comment-num"]).toBe("3");
    view.destroy();
  });

  it("stays unplaced when the quote occurs more than once, or not at all", () => {
    const { view, paint } = body("A fox here.\n\nA fox there.");
    for (const quote of ["A fox", "fox", "e", "no such words", "", null]) {
      expect(paint({ comments: [importedComment(quote)] }), String(quote)).toEqual([]);
    }
    // Overlapping occurrences count too.
    const { view: view2, paint: paint2 } = body("aaa");
    expect(paint2({ comments: [importedComment("aa")] })).toEqual([]);
    view.destroy();
    view2.destroy();
  });

  it("matches a quote across blocks, which reads them joined by a space", () => {
    const { view, paint } = body("# Scope\n\nThe rules apply to everyone.\n\n- first item\n- second item");
    const comments = [importedComment("Scope The rules"), importedComment("everyone. first", { num: 4 })];
    const decos = paint({ comments });
    expect(painted(view, decos)).toEqual(["Scope The rules", "everyone. first"]);
    view.destroy();
  });

  it("paints only the words of a quote that begins or ends at a block break", () => {
    const { view, paint } = body("First part\n\nSecond part");
    const comments = [importedComment("part Second"), importedComment(" Second", { num: 4 }), importedComment("First part ", { num: 5 })];
    const decos = paint({ comments });
    expect(painted(view, decos)).toEqual(["part Second", "Second", "First part"]);
    view.destroy();
  });

  it("reads a mention as no text, as the quote did", () => {
    const { view, paint } = body("Ask [@Liv](mention:u_liv) about the budget.");
    expect(view.state.doc.textContent).toBe("Ask  about the budget.");
    const decos = paint({ comments: [importedComment("Ask  about")] });
    expect(decos).toHaveLength(1);
    expect(painted(view, decos)).toEqual(["Ask  about"]);
    // The mention sits inside the range.
    let mentions = 0;
    view.state.doc.nodesBetween(decos[0]!.from, decos[0]!.to, (n) => {
      if (n.type.name === "mention") mentions++;
    });
    expect(mentions).toBe(1);
    view.destroy();
  });

  it("keeps a resolved one dark unless it is flashed", () => {
    const { view, paint } = body(PROSE);
    const c = importedComment(PHRASE, { resolved: true });
    expect(paint({ comments: [c] })).toEqual([]);
    const lit = paint({ comments: [c], flashNum: 3 });
    expect(painted(view, lit)).toEqual([PHRASE]);
    expect(className(lit[0])).toContain("comment-highlight--flash");
    view.destroy();
  });

  it("never places a reply by a quote", () => {
    const { view, paint } = body(PROSE);
    const reply = importedComment(PHRASE, { num: 4, parent_num: 3 });
    expect(paint({ comments: [reply] })).toEqual([]);
    view.destroy();
  });

  it("follows its words as the text around it is edited", () => {
    const { ydoc, view, paint } = body(PROSE);
    const comments = [importedComment(PHRASE)];
    expect(painted(view, paint({ comments }))).toEqual([PHRASE]);
    const para = ydoc.getXmlFragment("default").get(0) as Y.XmlElement;
    ydoc.transact(() => (para.get(0) as Y.XmlText).insert(0, "Look: "));
    const decos = paint({ comments });
    expect(painted(view, decos)).toEqual([PHRASE]);
    expect(decos[0]!.from).toBe(1 + "Look: ".length + PROSE.indexOf(PHRASE));
    view.destroy();
  });

  it("keeps the place it was given once the quote occurs again, as an anchor would", () => {
    const { ydoc, view, paint } = body(PROSE);
    const comments = [importedComment(PHRASE)];
    paint({ comments });
    const para = ydoc.getXmlFragment("default").get(0) as Y.XmlElement;
    // The text is not searched again, so the second copy does not unplace it.
    ydoc.transact(() => (para.get(0) as Y.XmlText).insert(0, `${PHRASE} `));
    const decos = paint({ comments: [...comments] });
    expect(decos).toHaveLength(1);
    expect(decos[0]!.from).toBe(1 + PHRASE.length + 1 + PROSE.indexOf(PHRASE));
    // A thread it has not placed yet is placed against the text as it is now.
    expect(paint({ comments: [importedComment(PHRASE, { num: 4 })] })).toEqual([]);
    view.destroy();
  });

  it("is placed once the text arrives", () => {
    const { ydoc, view, paint } = body("");
    const comments = [importedComment(PHRASE)];
    expect(paint({ comments })).toEqual([]);
    applyMarkdownToYXmlFragment(ydoc.getXmlFragment("default"), PROSE);
    expect(painted(view, paint({ comments }))).toEqual([PHRASE]);
    view.destroy();
  });

  it(`places at most ${QUOTE_PLACEMENT_MAX} threads by their quote`, () => {
    const words = Array.from({ length: QUOTE_PLACEMENT_MAX + 5 }, (_, i) => `x${i}y`);
    const { view, paint } = body(words.join(" "));
    const decos = paint({ comments: words.map((w, i) => importedComment(w, { num: i + 1 })) });
    expect(decos.map((d) => attrs(d)["data-comment-num"])).toEqual(words.slice(0, QUOTE_PLACEMENT_MAX).map((_, i) => String(i + 1)));
    view.destroy();
  });
});

describe("commentRange", () => {
  it("prefers a live anchor to the quote, even where the quote is ambiguous", () => {
    const { ydoc, view, comment, from, to } = fixture();
    const para = ydoc.getXmlFragment("default").get(0) as Y.XmlElement;
    // A second "brown fox" before the anchored one: the quote no longer says which.
    ydoc.transact(() => (para.get(0) as Y.XmlText).insert(0, `${PHRASE} `));
    const shift = PHRASE.length + 1;
    expect(commentRange(ydoc, view.state, comment)).toEqual({ from: from + shift, to: to + shift });
    view.destroy();
  });

  it("leaves a comment unplaced when its anchored words are gone, though they occur once elsewhere", () => {
    const { ydoc, view, paint, comment } = fixture();
    const text = (ydoc.getXmlFragment("default").get(0) as Y.XmlElement).get(0) as Y.XmlText;
    ydoc.transact(() => {
      text.delete(text.toString().indexOf(PHRASE), PHRASE.length);
      text.insert(text.length, ` A ${PHRASE}.`);
    });
    expect(view.state.doc.textContent.split(PHRASE)).toHaveLength(2);
    const range = commentRange(ydoc, view.state, comment);
    if (range) expect(range.to - range.from).toBe(0);
    expect(paint({ comments: [comment] })).toEqual([]);
    view.destroy();
  });
});
