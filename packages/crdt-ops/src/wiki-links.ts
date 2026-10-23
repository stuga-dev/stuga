/**
 * What the wiki reads of a page's approved text: the Stuga pages it links to and cites, each with the
 * passages that hold it, and its opening paragraph as a one-line summary. Read through the parser the
 * page's own text goes through, so a link in code is no link and a footnote is a citation.
 */
import type { Node as PMNode } from "prosemirror-model";
import { markdownToDoc } from "./markdown/parse.js";
import { getStugaSchema } from "./schema.js";

export type WikiLinkKind = "link" | "citation";

export interface WikiLink {
  /** The doc_id it names. */
  target: string;
  /** `citation` when a footnote names it, `link` for a link in the text. */
  kind: WikiLinkKind;
  /** The passages holding it, as plain text in document order: for a citation, its footnote too. */
  passages: string[];
  /** The rows of a database it names, `<table_id>.<row_id>`, in order: a link to a row opens it in its table. */
  rows: string[];
}

export interface WikiText {
  links: WikiLink[];
  /** The opening paragraph, plain and cut at WIKI_SUMMARY_MAX characters; "" when there is none. */
  summary: string;
}

/** The longest summary; a longer opening paragraph is cut at a word and ends with "…". */
export const WIKI_SUMMARY_MAX = 160;

/**
 * The page a link opens: an in-app link (`/doc/<id>`, perhaps with a query), or the same at one of
 * `origins`, the addresses the node is reached at, as a page's address copied from the browser is.
 * Null for any other link.
 */
export function wikiLinkTarget(href: string, origins: readonly string[] = []): string | null {
  let path = href.trim();
  for (const origin of origins) {
    const base = origin.replace(/\/+$/, "");
    if (base && path.toLowerCase().startsWith(`${base.toLowerCase()}/doc/`)) {
      path = path.slice(base.length);
      break;
    }
  }
  const id = /^\/doc\/([^/?#\s]{1,200})(?:[?#].*)?$/.exec(path)?.[1];
  if (!id) return null;
  try {
    return decodeURIComponent(id);
  } catch {
    return null;
  }
}

/** An id as an address carries it: no dot, no slash, no space, as the node's ids are. */
const ROW_PART = /^[A-Za-z0-9_-]{1,100}$/;

/**
 * The page a link opens, and the row of a database it opens there: `/doc/<database>?table=<t>&row=<r>`, as a
 * row is linked from its table (or the same at one of `origins`). Null for a link that opens no page.
 */
export function wikiLinkRef(href: string, origins: readonly string[] = []): { target: string; row: string | null } | null {
  const target = wikiLinkTarget(href, origins);
  if (!target) return null;
  const query = /\?([^#]*)/.exec(href)?.[1] ?? "";
  let row: string | null = null;
  try {
    const params = new URLSearchParams(query);
    const table = params.get("table");
    const rowId = params.get("row");
    if (table && rowId && ROW_PART.test(table) && ROW_PART.test(rowId)) row = `${table}.${rowId}`;
  } catch {
    row = null;
  }
  return { target, row };
}

/** A node's text as a reader reads it: a mention by its label, a line break as a space, no footnote markers. */
function plainText(node: PMNode): string {
  let out = "";
  node.descendants((child) => {
    if (child.isText) out += child.text ?? "";
    else if (child.type.name === "mention") out += `@${String(child.attrs.label ?? "")}`;
    else if (child.type.name === "hardBreak" || child.isBlock) out += " ";
    return true;
  });
  // A footnote marker leaves its space behind before the punctuation it stood at.
  return out.replace(/\s+/g, " ").replace(/ ([.,;:!?)])/g, "$1").trim();
}

/** A page a node's links name, and the rows of it they open. */
interface Named {
  target: string;
  rows: string[];
}

/** Each page a node's links name, once, in order, with the rows of it they open. */
function linkTargets(node: PMNode, origins: readonly string[]): Named[] {
  const out: Named[] = [];
  node.descendants((child) => {
    if (!child.isText) return true;
    for (const mark of child.marks) {
      if (mark.type.name !== "link") continue;
      const ref = wikiLinkRef(String(mark.attrs.href ?? ""), origins);
      if (!ref) continue;
      let named = out.find((n) => n.target === ref.target);
      if (!named) {
        named = { target: ref.target, rows: [] };
        out.push(named);
      }
      if (ref.row && !named.rows.includes(ref.row)) named.rows.push(ref.row);
    }
    return true;
  });
  return out;
}

/** The footnote numbers a node's markers name. */
function footnoteRefs(node: PMNode): number[] {
  const out: number[] = [];
  node.descendants((child) => {
    if (child.type.name === "footnoteReference") out.push(Number(child.attrs.n) || 0);
    return true;
  });
  return out;
}

/** Cut at a word where there is one in the second half, else at a character. */
function cutSummary(text: string): string {
  const chars = [...text];
  if (chars.length <= WIKI_SUMMARY_MAX) return text;
  const head = chars.slice(0, WIKI_SUMMARY_MAX - 1).join("");
  const space = head.lastIndexOf(" ");
  return `${(space >= head.length / 2 ? head.slice(0, space) : head).trimEnd()}…`;
}

interface Passage {
  text: string;
  links: Named[];
  refs: number[];
}

export function wikiText(markdown: string, opts: { origins?: readonly string[] } = {}): WikiText {
  const origins = opts.origins ?? [];
  const doc = markdownToDoc(markdown, getStugaSchema());
  const passages: Passage[] = [];
  const footnotes = new Map<number, { targets: Named[]; text: string }>();
  let opening = "";
  let fallback = "";
  doc.descendants((node, _pos, parent) => {
    if (node.type.name === "footnoteDefinition") {
      footnotes.set(Number(node.attrs.n) || 0, { targets: linkTargets(node, origins), text: plainText(node) });
      return false;
    }
    // Code is verbatim: a link written in it opens nothing.
    if (node.type.name === "codeBlock") return false;
    if (!node.isTextblock) return true;
    const text = plainText(node);
    const links = linkTargets(node, origins);
    const refs = footnoteRefs(node);
    if (links.length > 0 || refs.length > 0) passages.push({ text, links, refs });
    if (node.type.name === "paragraph" && text) {
      // A paragraph at the page's top level opens it; one in a list or a quote, only when none does.
      if (!opening && parent === doc) opening = text;
      if (!fallback && parent?.type.name !== "tableCell" && parent?.type.name !== "tableHeader") fallback = text;
    }
    return false;
  });

  const byKey = new Map<string, WikiLink>();
  const add = ({ target, rows }: Named, kind: WikiLinkKind, text: string) => {
    const key = `${kind}\u0000${target}`;
    const link = byKey.get(key) ?? { target, kind, passages: [], rows: [] };
    if (text && !link.passages.includes(text)) link.passages.push(text);
    for (const row of rows) if (!link.rows.includes(row)) link.rows.push(row);
    byKey.set(key, link);
  };
  for (const p of passages) for (const named of p.links) add(named, "link", p.text);
  for (const [n, footnote] of footnotes) {
    for (const named of footnote.targets) {
      add(named, "citation", footnote.text);
      for (const p of passages) if (p.refs.includes(n)) add(named, "citation", p.text);
    }
  }
  const summary = opening || fallback;
  return { links: [...byKey.values()], summary: summary ? cutSummary(summary) : "" };
}
