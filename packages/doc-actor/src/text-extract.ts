/**
 * Plain text from the Y.Doc, for the derived title, the version text hash and
 * search. Not a faithful serializer; the Markdown projection is crdt-ops'.
 */
import * as Y from "yjs";
import { getStugaSchema } from "@stuga/crdt-ops";

export function extractText(doc: Y.Doc): string {
  const parts: string[] = [];
  walk(doc.getXmlFragment("default"), parts);
  // Pieces are concatenated, not newline-joined: formatting runs within a line
  // are separate pieces. Lines come from the block and hard-break newlines.
  return parts.join("").replace(/\n{3,}/g, "\n\n").trim();
}

function walk(node: Y.XmlFragment | Y.XmlElement | Y.XmlText, out: string[]): void {
  if (node instanceof Y.XmlText) {
    // The delta, not toString(), which renders marks as HTML-like tags.
    for (const op of node.toDelta() as Array<{ insert?: unknown }>) {
      if (typeof op.insert === "string") out.push(op.insert);
    }
    return;
  }
  const len = node.length;
  for (let i = 0; i < len; i++) {
    const child = node.get(i);
    if (child instanceof Y.XmlText || child instanceof Y.XmlElement) walk(child, out);
  }
  // Every block separates its text from the next (table cells and footnote
  // definitions included); a hard break is an in-block line break.
  if (node instanceof Y.XmlElement && (isBlock(node.nodeName) || node.nodeName === "hardBreak")) out.push("\n");
}

function isBlock(nodeName: string): boolean {
  return getStugaSchema().nodes[nodeName]?.isBlock === true;
}

/** First non-empty line, used to derive the doc title on flush. */
export function deriveTitle(text: string): string {
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t) return t.slice(0, 200);
  }
  return "";
}
