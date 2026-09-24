/**
 * Reads AI-citation footnotes out of the document, where each definition is a
 * `/doc/<id>` link labelled "Title — Section" followed by a quoted excerpt.
 */
import type { Node as PMNode } from "@tiptap/pm/model";
import type { CitationDetail } from "../ai/citations";

export function readDefinition(def: PMNode, n: number): CitationDetail {
  let docId = "";
  let label = "";
  let excerpt = "";
  def.descendants((child) => {
    if (child.isText) {
      const link = child.marks.find((m) => m.type.name === "link");
      if (link) {
        label += child.text ?? "";
        const href = String(link.attrs.href ?? "");
        const m = /\/doc\/([^/\s)]+)/.exec(href);
        if (m) docId = m[1]!;
      } else {
        excerpt += child.text ?? "";
      }
    }
  });
  excerpt = excerpt.trim().replace(/^"|"$/g, "").trim();
  const [title, ...rest] = label.split(" — ");
  return {
    n,
    doc_id: docId,
    title: (title ?? "").trim() || "Untitled",
    heading_path: rest.length ? rest.join(" — ").trim() : null,
    content: excerpt || null,
  };
}

/** A footnote definition located in the doc, with its parsed detail. */
export interface FootnoteEntry {
  n: number;
  detail: CitationDetail;
}

/** Every footnote definition, by number. */
export function collectFootnoteDefinitions(doc: PMNode): FootnoteEntry[] {
  const out: FootnoteEntry[] = [];
  doc.descendants((node) => {
    if (node.type.name === "footnoteDefinition") {
      const n = Number(node.attrs.n) || 0;
      out.push({ n, detail: readDefinition(node, n) });
      return false;
    }
    return true;
  });
  return out.sort((a, b) => a.n - b.n);
}

/** The position of the first `[^n]` marker. */
export function findReferencePos(doc: PMNode, n: number): number | null {
  let found: number | null = null;
  doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.type.name === "footnoteReference" && Number(node.attrs.n) === n) {
      found = pos;
      return false;
    }
    return true;
  });
  return found;
}
