/**
 * Markdown → ProseMirror for the Stuga schema (CommonMark + strikethrough + GFM
 * tables + footnotes, no raw HTML).
 *
 * Contract with serialize.ts, for every document reachable in the product:
 *
 *     markdownToDoc(docToMarkdown(doc))  ==  doc      (structurally)
 *     docToMarkdown(markdownToDoc(md))   ==  md       (fixed point)
 *
 * The review overlay and the 3-way merge compare the live document against its
 * re-parsed markdown, so any divergence reads as a concurrent human edit. Each
 * token rule below names the divergence it closes.
 */
import MarkdownIt, { type MarkdownIt as MarkdownItInstance } from "markdown-it";
import { MarkdownParser } from "prosemirror-markdown";
import type { Node as PMNode, Schema } from "prosemirror-model";
import { aliasFromMentionHref } from "@stuga/protocol/domain/mentions";
import { footnotePlugin } from "../markdown-it-footnote.js";
import { CODE_EXCLUDES } from "../schema.js";
import { normalizeMarkdownTables } from "./tables.js";

function tokenizer(): MarkdownItInstance {
  const md = MarkdownIt({ html: false }); // tables enabled by default
  // Destinations stay verbatim: the default normalizeLink percent-encodes, so
  // `report draft.png` would never equal its own projection. validateLink still
  // refuses javascript:/data:.
  md.normalizeLink = (url: string) => url;
  md.use(footnotePlugin);
  // `^[inline note]` has no node here and would be silently dropped; left as
  // literal text (the serializer escapes its `[`) it round-trips.
  md.inline.ruler.disable("footnote_inline");
  // Match a numeric `[^n]` even with no definition, so a bare marker parses to the
  // same footnoteReference the live document holds. Non-numeric labels fall
  // through to the stock rule; our own output escapes `[`, so it never lands here.
  md.inline.ruler.before("footnote_ref", "stuga_footnote_ref", (state, silent) => {
    const max = state.posMax;
    const start = state.pos;
    if (start + 3 > max) return false;
    if (state.src.charCodeAt(start) !== 0x5b /* [ */) return false;
    if (state.src.charCodeAt(start + 1) !== 0x5e /* ^ */) return false;
    let pos = start + 2;
    for (; pos < max; pos++) {
      const ch = state.src.charCodeAt(pos);
      if (ch === 0x5d /* ] */) break;
      if (ch < 0x30 || ch > 0x39) return false; // digits only
    }
    if (pos === start + 2 || pos >= max) return false;
    if (!silent) {
      const tok = state.push("footnote_ref", "", 0);
      tok.meta = { label: state.src.slice(start + 2, pos) };
    }
    state.pos = pos + 1;
    return true;
  });
  // Keep each `[^n]: …` definition where it was written. The stock footnote_tail
  // moves referenced definitions to the end and drops unreferenced ones, which
  // changes block count and order.
  md.core.ruler.at("footnote_tail", (state) => {
    for (const tok of state.tokens) {
      if (tok.type === "footnote_reference_open") tok.type = "footnote_open";
      else if (tok.type === "footnote_reference_close") tok.type = "footnote_close";
    }
    return true;
  });
  // Reshape definitions into top-level `inline*` blocks: drop the section wrapper
  // and backrefs and unwrap the paragraph. A multi-paragraph definition has
  // nowhere to keep its break, so its paragraphs join with a space rather than
  // fusing the words across it.
  md.core.ruler.push("stuga_footnote_flatten", (state) => {
    const out: (typeof state.tokens)[number][] = [];
    let inDef = false;
    let sawInline = false;
    for (const tok of state.tokens) {
      if (tok.type === "footnote_block_open" || tok.type === "footnote_block_close") continue;
      if (tok.type === "footnote_open") {
        inDef = true;
        sawInline = false;
        out.push(tok);
        continue;
      }
      if (tok.type === "footnote_close") {
        inDef = false;
        out.push(tok);
        continue;
      }
      if (inDef && (tok.type === "paragraph_open" || tok.type === "paragraph_close" || tok.type === "footnote_anchor")) {
        continue;
      }
      if (inDef && tok.type === "inline") {
        if (sawInline) {
          const gap = new state.Token("text", "", 0);
          gap.content = " ";
          tok.children = [gap, ...(tok.children ?? [])];
          tok.content = " " + tok.content;
        }
        sawInline = true;
      }
      out.push(tok);
    }
    state.tokens = out;
    return true;
  });
  // `[@label](mention:<alias>)` is a mention node, not a link. Only the exact
  // shape the serializer writes qualifies: plain `@…` text and nothing else
  // inside, so a link someone formatted stays a link.
  md.core.ruler.push("stuga_mentions", (state) => {
    for (const tok of state.tokens) {
      if (tok.type !== "inline" || !tok.children) continue;
      const kids = tok.children;
      const out: typeof kids = [];
      for (let i = 0; i < kids.length; i++) {
        const open = kids[i]!;
        const text = kids[i + 1];
        const close = kids[i + 2];
        const alias = open.type === "link_open" ? aliasFromMentionHref(String(open.attrGet("href") ?? "")) : null;
        if (alias && text?.type === "text" && text.content.startsWith("@") && close?.type === "link_close") {
          const mention = new state.Token("mention", "", 0);
          mention.meta = { alias, label: text.content.slice(1) };
          out.push(mention);
          i += 2;
          continue;
        }
        out.push(open);
      }
      tok.children = out;
    }
    return true;
  });
  // Table cells require a block child; markdown-it emits a bare `inline` inside th/td.
  md.core.ruler.push("stuga_table_cell_paragraphs", (state) => {
    const out: (typeof state.tokens)[number][] = [];
    let inCell = false;
    for (const tok of state.tokens) {
      if (tok.type === "th_open" || tok.type === "td_open") inCell = true;
      if (tok.type === "th_close" || tok.type === "td_close") inCell = false;
      if (inCell && tok.type === "inline") {
        const open = new state.Token("paragraph_open", "p", 1);
        const close = new state.Token("paragraph_close", "p", -1);
        out.push(open, tok, close);
      } else {
        out.push(tok);
      }
    }
    state.tokens = out;
    return true;
  });
  // Hoist images out of inline content. `image` is a block node in this schema
  // (it must match the editor's), and prosemirror-markdown drops a whole
  // paragraph whose inline content contains one. So split the paragraph around
  // each image. An item whose text starts with an image keeps the empty lead
  // paragraph `listItem` requires.
  md.core.ruler.push("stuga_hoist_block_images", (state) => {
    type Tok = (typeof state.tokens)[number];
    const isBreak = (t: Tok): boolean => t.type === "softbreak" || t.type === "hardbreak";
    // A run earns a paragraph only if it carries real text or an inline atom.
    const hasContent = (t: Tok): boolean =>
      t.nesting === 0 && (t.type === "text" ? t.content.trim() !== "" : !isBreak(t));
    // Trim only the whitespace/breaks that hugged the image; the block boundary
    // replaces them. Edges are measured over content tokens, since reopened marks
    // can sit outside the content.
    const trimEdges = (run: Tok[]): Tok[] => {
      const body = run.filter((t) => t.nesting === 0);
      const edge = new Set<Tok>();
      for (let i = 0; i < body.length && isBreak(body[i]!); i++) edge.add(body[i]!);
      for (let i = body.length - 1; i >= 0 && isBreak(body[i]!); i--) edge.add(body[i]!);
      const kept = run.filter((t) => !edge.has(t));
      const text = kept.filter((t) => t.nesting === 0);
      const first = text[0];
      const last = text[text.length - 1];
      if (first?.type === "text") first.content = first.content.replace(/^\s+/, "");
      if (last?.type === "text") last.content = last.content.trimEnd(); // linear; /\s+$/ backtracks quadratically
      return kept;
    };
    const out: Tok[] = [];
    // Enclosing block types, innermost last.
    const parents: string[] = [];
    let splitParagraph = false;
    for (const tok of state.tokens) {
      if (tok.nesting === 1) parents.push(tok.type.replace(/_open$/, ""));
      else if (tok.nesting === -1) parents.pop();
      // A split already closed every run it produced.
      if (splitParagraph && tok.type === "paragraph_close") {
        splitParagraph = false;
        continue;
      }
      const images = tok.type === "inline" && tok.children ? tok.children.some((c) => c.type === "image") : false;
      if (!images) {
        out.push(tok);
        continue;
      }
      // Only a paragraph can be split; a heading or footnote definition is
      // `inline*` itself, so it keeps its text and loses the image.
      const open = parents[parents.length - 1] === "paragraph" ? out[out.length - 1] : undefined;
      if (!open || open.type !== "paragraph_open") {
        tok.children = trimEdges(tok.children!.filter((c) => c.type !== "image"));
        // Close the double space the removed image left between two text tokens.
        for (let i = 1; i < tok.children.length; i++) {
          const prev = tok.children[i - 1]!;
          const cur = tok.children[i]!;
          if (prev.type === "text" && cur.type === "text" && /\s$/.test(prev.content)) {
            cur.content = cur.content.replace(/^\s+/, "");
          }
        }
        out.push(tok);
        continue;
      }
      out.pop();
      const close = new state.Token("paragraph_close", open.tag, -1);
      const emit = (run: Tok[]): void => {
        const kept = trimEdges(run);
        if (!kept.some(hasContent)) return;
        const inline = new state.Token("inline", "", 0);
        inline.children = kept;
        inline.content = kept.map((t) => t.content).join("");
        out.push(open, inline, close);
      };
      let run: Tok[] = [];
      const openMarks: Tok[] = [];
      for (const child of tok.children!) {
        if (child.type === "image") {
          // Each run must be balanced: close the marks the image sat inside and
          // reopen them after it. The mark around the image itself is lost.
          for (let i = openMarks.length - 1; i >= 0; i--) {
            run.push(new state.Token(openMarks[i]!.type.replace(/_open$/, "_close"), openMarks[i]!.tag, -1));
          }
          emit(run);
          out.push(child);
          run = [...openMarks];
          continue;
        }
        if (child.nesting === 1) openMarks.push(child);
        else if (child.nesting === -1) openMarks.pop();
        run.push(child);
      }
      emit(run);
      splitParagraph = true;
    }
    state.tokens = out;
    return true;
  });
  // Restore the marks a code span evicts. prosemirror-markdown keeps one flat mark
  // set, so opening `code` inside `**…**` removes bold for the rest of the inline
  // run. Close the evicted marks before each code span and reopen the same tokens
  // after it — the shape the editor produces. Marks code does not exclude (link)
  // stay open across the span, which is how `[`x`](url)` keeps its href.
  md.core.ruler.push("stuga_reopen_marks_around_code", (state) => {
    type Tok = (typeof state.tokens)[number];
    for (const tok of state.tokens) {
      if (tok.type !== "inline" || !tok.children) continue;
      if (!tok.children.some((c) => c.type === "code_inline")) continue;
      const out: Tok[] = [];
      const open: Tok[] = [];
      for (const child of tok.children) {
        if (child.type === "code_inline") {
          const evicted = open.filter((t) => codeEvictsToken(t.type));
          if (evicted.length > 0) {
            for (let i = evicted.length - 1; i >= 0; i--) {
              out.push(new state.Token(evicted[i]!.type.replace(/_open$/, "_close"), evicted[i]!.tag, -1));
            }
            out.push(child);
            // The same token objects: the parser reads attrs off them and the
            // original closers still balance them.
            out.push(...evicted);
            continue;
          }
        }
        if (child.nesting === 1) open.push(child);
        else if (child.nesting === -1) open.pop();
        out.push(child);
      }
      tok.children = out;
    }
    return true;
  });
  return md;
}

interface TokenAttrs {
  attrGet(n: string): string | null;
}

const CODE_EVICTED_MARKS = new Set(CODE_EXCLUDES.split(" "));

/** Every markdown-it inline token that opens a mark, and that mark. */
const MARK_OPEN_TOKENS: Record<string, string> = {
  strong_open: "bold",
  em_open: "italic",
  s_open: "strike",
  link_open: "link",
};

/** Whether a code span inside `type`'s mark evicts it. An unknown opener counts
 *  as evicted, the side that recreates the mark after the span. */
function codeEvictsToken(type: string): boolean {
  const mark = MARK_OPEN_TOKENS[type];
  return mark === undefined || CODE_EVICTED_MARKS.has(mark);
}

/** Tiptap's per-cell `align`, read off the `style` markdown-it writes for a delimiter row's colons. */
function cellAlign(tok: TokenAttrs): "left" | "center" | "right" | null {
  const m = /text-align\s*:\s*(left|center|right)/i.exec(tok.attrGet("style") ?? "");
  return m ? (m[1]!.toLowerCase() as "left" | "center" | "right") : null;
}

// markdown-it token type -> ProseMirror node/mark spec. softbreak is added
// automatically by MarkdownParser (becomes a space).
const TOKENS = {
  blockquote: { block: "blockquote" },
  paragraph: { block: "paragraph" },
  list_item: { block: "listItem" },
  bullet_list: { block: "bulletList" },
  ordered_list: {
    block: "orderedList",
    // A start of 0 is legal and must not become 1.
    getAttrs: (tok: { attrGet(n: string): string | null }) => ({
      start: tok.attrGet("start") != null ? Number(tok.attrGet("start")) : 1,
    }),
  },
  heading: { block: "heading", getAttrs: (tok: { tag: string }) => ({ level: Number(tok.tag.slice(1)) }) },
  code_block: { block: "codeBlock", noCloseToken: true },
  fence: {
    block: "codeBlock",
    getAttrs: (tok: { info: string }) => ({ language: tok.info || null }),
    noCloseToken: true,
  },
  hr: { node: "horizontalRule" },
  hardbreak: { node: "hardBreak" },
  em: { mark: "italic" },
  strong: { mark: "bold" },
  s: { mark: "strike" },
  code_inline: { mark: "code", noCloseToken: true },
  link: {
    mark: "link",
    getAttrs: (tok: { attrGet(n: string): string | null }) => ({
      href: tok.attrGet("href"),
      title: tok.attrGet("title") || null,
    }),
  },
  // The alt comes from the parsed children: `tok.content` is the raw source with
  // its backslash escapes, which would grow on every round trip.
  image: {
    node: "image",
    getAttrs: (tok: { attrGet(n: string): string | null; content: string; children?: { content: string }[] }) => ({
      src: tok.attrGet("src"),
      alt: (tok.children ? tok.children.map((c) => c.content).join("") : tok.content) || tok.attrGet("alt") || null,
      title: tok.attrGet("title") || null,
    }),
  },
  table: { block: "table" },
  tr: { block: "tableRow" },
  th: { block: "tableHeader", getAttrs: (tok: TokenAttrs) => ({ align: cellAlign(tok) }) },
  td: { block: "tableCell", getAttrs: (tok: TokenAttrs) => ({ align: cellAlign(tok) }) },
  // thead/tbody have no node — skip them but recurse.
  thead: { ignore: true },
  tbody: { ignore: true },
  mention: {
    node: "mention",
    getAttrs: (tok: { meta?: { alias?: string; label?: string } }) => ({
      alias: tok.meta?.alias ?? "",
      label: tok.meta?.label ?? "",
    }),
  },
  footnote_ref: {
    node: "footnoteReference",
    getAttrs: (tok: { meta?: { label?: string } }) => ({ n: Number(tok.meta?.label) || 1 }),
  },
  footnote: {
    block: "footnoteDefinition",
    getAttrs: (tok: { meta?: { label?: string } }) => ({ n: Number(tok.meta?.label) || 1 }),
  },
} as const;

let parserCache: { schema: Schema; parser: MarkdownParser } | null = null;

export function markdownToDoc(markdown: string, schema: Schema): PMNode {
  if (!parserCache || parserCache.schema !== schema) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    parserCache = { schema, parser: new MarkdownParser(schema as any, tokenizer() as any, TOKENS as any) };
  }
  return parserCache.parser.parse(normalizeMarkdownTables(markdown ?? ""));
}
