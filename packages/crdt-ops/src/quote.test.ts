/**
 * `quoteAnchor` pins a comment the co-author posts to a quoted passage, the way
 * a person's comment is pinned to a selection. The positions it makes on a copy
 * of the document must resolve on any client to the words the quote names, keep
 * to them through edits, and be gone with them; the live document must never
 * change.
 */
import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import type { Node as PMNode } from "prosemirror-model";
import { initProseMirrorDoc, relativePositionToAbsolutePosition, absolutePositionToRelativePosition } from "@tiptap/y-tiptap";
import {
  applyMarkdownToYXmlFragment,
  decodeRelPos,
  docText,
  encodeRelPos,
  getStugaSchema,
  markdownPlainText,
  quoteAnchor,
  textRange,
  type QuoteAnchor,
} from "./index.js";

function docOf(markdown: string): Y.Doc {
  const ydoc = new Y.Doc();
  applyMarkdownToYXmlFragment(ydoc.getXmlFragment("default"), markdown);
  return ydoc;
}

function read(ydoc: Y.Doc) {
  return initProseMirrorDoc(ydoc.getXmlFragment("default"), getStugaSchema());
}

/** Where the web's `quoteRange` places a quote: an exact, unique match in `docText`. */
function exactRange(doc: PMNode, quote: string): { from: number; to: number } | null {
  const { text } = docText(doc);
  const at = text.indexOf(quote);
  if (at < 0 || text.indexOf(quote, at + 1) >= 0) return null;
  return textRange(doc, at, quote.length);
}

/** An anchor's range on `ydoc` as a client's binding reads it. */
function resolve(ydoc: Y.Doc, anchor: QuoteAnchor): { from: number; to: number } | null {
  const frag = ydoc.getXmlFragment("default");
  const { mapping } = read(ydoc);
  const start = decodeRelPos(anchor.start!);
  const end = decodeRelPos(anchor.end!);
  if (!start || !end) return null;
  const from = relativePositionToAbsolutePosition(ydoc, frag, start, mapping);
  const to = relativePositionToAbsolutePosition(ydoc, frag, end, mapping);
  return from == null || to == null ? null : { from, to };
}

function sync(from: Y.Doc, to: Y.Doc): void {
  Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)));
}

/** The text of the `i`th top-level block, which y-tiptap keeps as one Y.XmlText however it is marked. */
function blockText(ydoc: Y.Doc, i: number): Y.XmlText {
  return (ydoc.getXmlFragment("default").get(i) as Y.XmlElement).get(0) as Y.XmlText;
}

function quoted(ydoc: Y.Doc, anchor: QuoteAnchor): string {
  const range = resolve(ydoc, anchor);
  expect(range).not.toBeNull();
  return read(ydoc).doc.textBetween(range!.from, range!.to, " ");
}

describe("quoteAnchor", () => {
  it("pins unique text that runs across marks", () => {
    const ydoc = docOf("The **quick brown** fox jumps over the lazy dog.");
    const anchor = quoteAnchor(ydoc, "quick brown fox");
    expect(anchor).not.toBeNull();
    expect(anchor!.quote).toBe("quick brown fox");
    expect(anchor!.start).toEqual(expect.any(String));
    expect(anchor!.end).toEqual(expect.any(String));
    expect(resolve(ydoc, anchor!)).toEqual(exactRange(read(ydoc).doc, "quick brown fox"));
    expect(quoted(ydoc, anchor!)).toBe("quick brown fox");
  });

  it("pins unique text that runs across blocks, read with a space between them", () => {
    const ydoc = docOf("# Bathroom\n\nThe tub stays where it is.\n\n- Retile the floor\n- Replace the tub");
    const anchor = quoteAnchor(ydoc, "where it is. Retile");
    expect(anchor).not.toBeNull();
    expect(resolve(ydoc, anchor!)).toEqual(exactRange(read(ydoc).doc, "where it is. Retile"));
    expect(quoted(ydoc, anchor!)).toBe("where it is. Retile");
  });

  it("forgives typography and keeps the document's own text as the quote", () => {
    const ydoc = docOf("She said “it’s built in” — then left.");
    const anchor = quoteAnchor(ydoc, `said "it's built in" - then`);
    expect(anchor).not.toBeNull();
    expect(anchor!.quote).toBe("said “it’s built in” — then");
    // So a quote-only anchor lands on the same words.
    expect(resolve(ydoc, anchor!)).toEqual(exactRange(read(ydoc).doc, anchor!.quote));
  });

  it("refuses a quote that is missing, empty, or there more than once", () => {
    const ydoc = docOf("Paint the hall. Paint the stairs.\n\nit's late; it’s dark.");
    expect(quoteAnchor(ydoc, "Paint the kitchen")).toBeNull();
    expect(quoteAnchor(ydoc, "")).toBeNull();
    expect(quoteAnchor(ydoc, "Paint the")).toBeNull();
    // Unique exactly nowhere, and twice once typography is folded.
    expect(quoteAnchor(ydoc, "it‘s")).toBeNull();
  });

  it("refuses everything in an empty document", () => {
    expect(quoteAnchor(new Y.Doc(), "anything")).toBeNull();
  });

  it("never changes the live document", () => {
    const withBlock = docOf("# Plan\n\nThe **tub** is freestanding.\n\n- one\n- two");
    // Something the schema cannot hold: the editor leaves it in place and cannot open the document.
    withBlock.getXmlFragment("default").insert(1, [new Y.XmlElement("unknownBlock")]);
    const withMark = docOf("The tub is freestanding.\n\nThe sink stays.");
    blockText(withMark, 0).format(4, 3, { unknownMark: {} });
    for (const [ydoc, quote, found] of [
      [docOf("# Plan\n\nThe **tub** is freestanding."), "tub is freestanding", true],
      [withBlock, "tub is freestanding", false],
      [withMark, "sink stays", false],
    ] as const) {
      const vector = Y.encodeStateVector(ydoc);
      const state = Y.encodeStateAsUpdate(ydoc);
      let updates = 0;
      ydoc.on("update", () => updates++);

      expect(quoteAnchor(ydoc, quote) !== null).toBe(found);
      expect(quoteAnchor(ydoc, "not there")).toBeNull();

      expect(updates).toBe(0);
      expect(Y.encodeStateVector(ydoc)).toEqual(vector);
      expect(Y.encodeStateAsUpdate(ydoc)).toEqual(state);
    }
    expect(withBlock.getXmlFragment("default").length).toBe(4);
  });

  it("makes the positions a binding on the live document makes", () => {
    const ydoc = docOf("Intro.\n\nThe tub is **freestanding** for now.");
    const anchor = quoteAnchor(ydoc, "is freestanding")!;
    const { doc, mapping } = read(ydoc);
    const range = exactRange(doc, "is freestanding")!;
    const frag = ydoc.getXmlFragment("default");
    expect(anchor.start).toBe(encodeRelPos(absolutePositionToRelativePosition(range.from, frag, mapping)));
    expect(anchor.end).toBe(encodeRelPos(absolutePositionToRelativePosition(range.to, frag, mapping)));
  });

  describe("on a second client", () => {
    const QUOTE = "built-in or freestanding";
    function clients() {
      const first = docOf("# Bathroom\n\nIntro line.\n\nIs the tub built-in or freestanding? Decide soon.");
      const anchor = quoteAnchor(first, QUOTE)!;
      expect(anchor.start).not.toBeNull();
      const second = new Y.Doc();
      sync(first, second);
      expect(second.clientID).not.toBe(first.clientID);
      return { first, second, anchor };
    }

    it("resolves to the range the quote names", () => {
      const { second, anchor } = clients();
      const range = resolve(second, anchor);
      expect(range).toEqual(exactRange(read(second).doc, QUOTE));
      expect(quoted(second, anchor)).toBe(QUOTE);
    });

    it("keeps to the words after insertions before them, in earlier blocks and in their own", () => {
      const { first, second, anchor } = clients();
      blockText(second, 1).insert(0, "A new opening. ");
      blockText(second, 2).insert(0, "So: ");
      // The first client's edit arrives too.
      blockText(first, 0).insert(0, "Main ");
      sync(first, second);
      expect(resolve(second, anchor)).toEqual(exactRange(read(second).doc, QUOTE));
      expect(quoted(second, anchor)).toBe(QUOTE);
    });

    it("keeps text typed at either edge with the text before it, as a selection's anchor does", () => {
      const { second, anchor } = clients();
      const text = blockText(second, 2);
      const at = text.toString().indexOf(QUOTE);
      text.insert(at + QUOTE.length, " (ask)");
      expect(quoted(second, anchor)).toBe(QUOTE);
      text.insert(at, "really ");
      expect(quoted(second, anchor)).toBe(`really ${QUOTE}`);
    });

    it("is gone once the quoted words are deleted", () => {
      const { second, anchor } = clients();
      const text = blockText(second, 2);
      text.delete(text.toString().indexOf(QUOTE), QUOTE.length);
      // Collapsed where the words were: the highlight treats an empty range as orphaned.
      const range = resolve(second, anchor);
      expect(range).not.toBeNull();
      expect(range!.to).toBe(range!.from);
    });

    it("is gone once the quoted words' block is deleted", () => {
      const { second, anchor } = clients();
      second.getXmlFragment("default").delete(2, 1);
      expect(resolve(second, anchor)).toBeNull();
    });
  });
});

describe("markdownPlainText", () => {
  it("reads Markdown as the document it makes reads, so a quote matches it", () => {
    const md = "# Bathroom\n\nThe **bathtub** is [built-in](https://e.test) \\*for now\\*.\n\n- Retile the floor\n- Keep `grout`";
    const text = markdownPlainText(md);
    expect(text).toBe("Bathroom The bathtub is built-in *for now*. Retile the floor Keep grout");
    expect(text).toBe(docText(read(docOf(md)).doc).text);
  });
});
