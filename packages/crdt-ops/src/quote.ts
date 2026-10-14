/**
 * Where a quoted passage sits in a document, and the Yjs relative positions that
 * pin a comment to it. Shared by the browser, which anchors a person's comment,
 * and the document actor, which anchors the co-author's, so both read the text
 * and store the anchor the same way.
 */
import * as Y from "yjs";
import type { Node as PMNode } from "prosemirror-model";
import { absolutePositionToRelativePosition, initProseMirrorDoc } from "@tiptap/y-tiptap";
import { findFuzzyMatch } from "@stuga/protocol/text/fuzzy-match";
import { markdownToDoc } from "./markdown/parse.js";
import { getStugaSchema } from "./schema.js";

/**
 * A stretch of the document's text. A text node's characters each sit at their
 * own position; a leaf's text and a block separator start at `from` and end at
 * `to` as one, since a range cannot begin or end inside them.
 */
export interface TextRun {
  /** Where the run begins in the document's text. */
  offset: number;
  from: number;
  to: number;
  text: boolean;
}

export interface DocText {
  text: string;
  /** In `offset` order. */
  runs: TextRun[];
}

/** A document is immutable, so its text is read once however many comments are placed on it. */
const docTexts = new WeakMap<PMNode, DocText>();

/**
 * The whole document read the way a comment's quote is read,
 * `textBetween(from, to, " ")`: a space between text blocks, and a leaf only its
 * `leafText`, which a mention does not have.
 */
export function docText(doc: PMNode): DocText {
  const cached = docTexts.get(doc);
  if (cached) return cached;
  let text = "";
  const runs: TextRun[] = [];
  let first = true;
  // Where the text read so far ends: a separator's range end.
  let end = 0;
  doc.descendants((node, pos) => {
    const leaf = node.isLeaf && !node.isText ? (node.type.spec.leafText?.(node) ?? "") : "";
    if (node.isBlock && (node.isTextblock || leaf)) {
      const start = node.isTextblock ? pos + 1 : pos;
      if (first) first = false;
      else {
        runs.push({ offset: text.length, from: start, to: end, text: false });
        text += " ";
      }
      end = start;
    }
    if (node.isText) {
      runs.push({ offset: text.length, from: pos, to: pos + node.nodeSize, text: true });
      text += node.text;
      end = pos + node.nodeSize;
    } else if (leaf) {
      runs.push({ offset: text.length, from: pos, to: pos + node.nodeSize, text: false });
      text += leaf;
      end = pos + node.nodeSize;
    }
  });
  const read = { text, runs };
  docTexts.set(doc, read);
  return read;
}

/** Markdown read as `docText` reads the document it makes: no formatting marks, a space between blocks. */
export function markdownPlainText(md: string): string {
  return docText(markdownToDoc(md, getStugaSchema())).text;
}

/** The run holding the character at `offset`. */
function runAt(runs: TextRun[], offset: number): TextRun {
  let lo = 0;
  let hi = runs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (runs[mid]!.offset <= offset) lo = mid;
    else hi = mid - 1;
  }
  return runs[lo]!;
}

/**
 * The document range holding `length` characters of `docText(doc)` from `at`,
 * or null when they hold no position, as a lone block separator does.
 */
export function textRange(doc: PMNode, at: number, length: number): { from: number; to: number } | null {
  const { text, runs } = docText(doc);
  if (length <= 0 || at < 0 || at + length > text.length) return null;
  const last = at + length - 1;
  const head = runAt(runs, at);
  const tail = runAt(runs, last);
  const from = head.text ? head.from + (at - head.offset) : head.from;
  const to = tail.text ? tail.from + (last - tail.offset) + 1 : tail.to;
  return from < to ? { from, to } : null;
}

function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
}

/** A relative position as a comment stores it. */
export function encodeRelPos(pos: Y.RelativePosition): string {
  return bytesToB64(Y.encodeRelativePosition(pos));
}

/** Null for a stored anchor that is not a relative position. */
export function decodeRelPos(b64: string): Y.RelativePosition | null {
  try {
    return Y.decodeRelativePosition(b64ToBytes(b64));
  } catch {
    return null;
  }
}

/** Where a quote sits in a live document, as a comment stores it. */
export interface QuoteAnchor {
  /** Base64 Yjs RelativePositions; both null when the quote was found but could not be pinned (stored quote-only). */
  start: string | null;
  end: string | null;
  /** The document's own text at that place (what `anchor_quote` stores). */
  quote: string;
}

/**
 * Where `quote` occurs in the document, found exactly first and then with
 * typography folded. Null when it is not there exactly once. Never changes `ydoc`.
 *
 * The returned quote is the document's own text, so `quoteRange` places a
 * quote-only anchor on the same words.
 */
export function quoteAnchor(ydoc: Y.Doc, quote: string): QuoteAnchor | null {
  if (!quote) return null;
  // y-tiptap's converter deletes or merges Yjs items it cannot represent in the
  // document it reads, so it reads a copy. The copy holds the same item IDs, so
  // positions made on it resolve on every client.
  const copy = new Y.Doc();
  try {
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(ydoc));
    const frag = copy.getXmlFragment("default");
    // Any transaction on the copy means the converter changed it: positions in a
    // changed copy may name items the live document still shows otherwise.
    const watch = { changed: false };
    copy.on("afterTransaction", () => {
      watch.changed = true;
    });
    let read: ReturnType<typeof initProseMirrorDoc>;
    try {
      read = initProseMirrorDoc(frag, getStugaSchema());
    } catch {
      return null; // a fragment the editor cannot read either
    }
    const match = findFuzzyMatch(docText(read.doc).text, quote, { wantUnique: true });
    if (!match) return null;
    const range = textRange(read.doc, match.index, match.matched.length);
    if (!range) return null;
    const quoteOnly: QuoteAnchor = { start: null, end: null, quote: match.matched };
    if (watch.changed) return quoteOnly;
    try {
      const start = absolutePositionToRelativePosition(range.from, frag, read.mapping) as Y.RelativePosition;
      const end = absolutePositionToRelativePosition(range.to, frag, read.mapping) as Y.RelativePosition;
      return { start: encodeRelPos(start), end: encodeRelPos(end), quote: match.matched };
    } catch {
      return quoteOnly;
    }
  } finally {
    copy.destroy();
  }
}
