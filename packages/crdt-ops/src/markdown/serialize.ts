/**
 * ProseMirror → Markdown for the Stuga schema; the inverse half of parse.ts's
 * round-trip contract. It escapes more than markdown strictly needs, alternates
 * adjacent list markers and re-serializes table cells with their marks because
 * each of those would otherwise change the document on re-parse.
 *
 * Shapes GFM cannot express, accepted as bounded losses: underline (no syntax);
 * whitespace between two fusing emphasis runs; a hard break in a table cell or
 * heading (both one line); a mark around a block image; the paragraph break in a
 * multi-paragraph footnote; per-cell alignments that disagree within a column.
 */
import { mentionHref } from "@stuga/protocol/domain/mentions";
import { MarkdownSerializer, defaultMarkdownSerializer } from "prosemirror-markdown";
import { Fragment } from "prosemirror-model";
import type { Node as PMNode, Schema } from "prosemirror-model";
import {
  expelMarkEdgeWhitespace,
  holdsLeadingEdge,
  holdsTrailingEdge,
  keptMarkEdges,
  refFirstChar,
  refLastChar,
  wsEntities,
} from "./flanking.js";

/**
 * Attrs the editor owns that markdown cannot express (a resized cell's
 * `colwidth`, an image's pixel box). Consumers comparing live vs re-parsed
 * documents must ignore them; a new schema attr without a markdown spelling
 * belongs here.
 */
export const EDITOR_ONLY_ATTRS: ReadonlySet<string> = new Set(["colwidth", "width", "height"]);

/** A link/image destination; one containing whitespace or `<>` needs CommonMark's `<…>` form. */
function mdUrl(url: string): string {
  return /[\s<>]/.test(url) ? `<${url.replace(/[<>\\]/g, "\\$&")}>` : url.replace(/[()]/g, "\\$&");
}

/** `![alt](src "title")`, shared by the block image and table-cell serializers. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function imageMarkdown(node: any, esc: (s: string) => string = (s) => s): string {
  const title = node.attrs.title ? ` ${JSON.stringify(node.attrs.title)}` : "";
  return `![${esc(node.attrs.alt || "")}](${mdUrl(node.attrs.src || "")}${title})`;
}

/** The extra space a code span needs on each side to survive CommonMark stripping
 *  one leading and one trailing space from `` ` x ` ``. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function codeSpanPad(node: any): string {
  const text: string = node?.isText ? (node.text ?? "") : "";
  return text.startsWith(" ") && text.endsWith(" ") && /\S/.test(text) ? " " : "";
}

/**
 * Characters inert in a text node but active in markdown that prosemirror-markdown's
 * `esc` leaves alone: `&` opening a character reference and `<` opening an
 * autolink. Lookaheads keep ordinary prose (`AT&T`, `a < b`) unescaped.
 */
const ESCAPE_EXTRA = /&(?=#\d+;|#[xX][0-9a-fA-F]+;|[a-zA-Z][a-zA-Z0-9]{1,31};)|<(?=[a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*>|[^\s<>@]+@[^\s<>]+>)/g;

/**
 * Serialize a text node so re-parsing yields the same text node. Line-start
 * escapes apply to every output line, including after a hard break (the stock
 * handler only escapes at block start), plus hazards `esc` misses: `1)` list
 * markers (we emit `)` ourselves), a bare `1.`, `===` after a hard break (setext
 * underline), a trailing `#` run in a heading, and whitespace markdown would eat.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function serializeText(state: any, node: any, parent: any, index: number): void {
  // Inside `<autolink>` the text is the URL.
  if (state.inAutolink) {
    state.text(node.text, false);
    return;
  }
  const headingTail = parent?.type.name === "heading" && index === parent.childCount - 1;
  // Line edges are judged on the document, not on `state.out`, which already
  // holds an opening mark's delimiter.
  const prev = parent && index > 0 ? parent.child(index - 1) : null;
  const next = parent && index + 1 < parent.childCount ? parent.child(index + 1) : null;
  const startsLine = !prev || prev.type.name === "hardBreak";
  const endsLine = !next || next.type.name === "hardBreak";
  const held = keptMarkEdges(node, prev, next);
  const prev2 = parent && index > 1 ? parent.child(index - 2) : null;
  const next2 = parent && index + 2 < parent.childCount ? parent.child(index + 2) : null;
  const guardStart = holdsTrailingEdge(prev, prev2, node);
  const guardEnd = holdsLeadingEdge(next, node, next2);
  const lines = String(node.text).split("\n");
  for (let i = 0; i < lines.length; i++) {
    // Measured before `write()`, which appends the enclosing block's prefix.
    const atBlockStart: boolean = state.atBlockStart;
    const sol = atBlockStart || /(^|\n)$/.test(state.out) || i > 0;
    state.write();
    let s: string = state.esc(lines[i], sol);
    if (sol) {
      s = s.replace(/^(\s*\d+)\)(\s|$)/, "$1\\)$2").replace(/^(\s*\d+)\.$/, "$1\\.");
      // Only after a hard break; the trailing whitespace is captured, not consumed.
      if (!atBlockStart) s = s.replace(/^(\s*)(=+)([^\S\n]*)$/, "$1\\$2$3");
    }
    if (headingTail && i === lines.length - 1) s = s.replace(/(\s)(#+)([ \t]*)$/, "$1\\$2$3");
    if (i > 0 || startsLine || (i === 0 && held.lead)) s = s.replace(/^[^\S\n]+/, wsEntities);
    if (i === lines.length - 1 && (endsLine || held.trail)) s = s.replace(/[^\S\n]+$/, wsEntities);
    // After the whitespace rules: an edge already encoded or escaped is punctuation.
    if (i === 0 && guardStart) s = refFirstChar(s);
    if (i === lines.length - 1 && guardEnd) s = refLastChar(s);
    state.out += s;
    if (i !== lines.length - 1) state.out += "\n";
  }
}

/**
 * One textblock's inline content as a single markdown line, marks and escapes
 * included, by serializing it as a lone paragraph. A hard break becomes a space.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function inlineBlockToMarkdown(block: any): string {
  const schema: Schema = block.type.schema;
  const paragraph = schema.nodes.paragraph;
  if (!paragraph) return block.textContent;
  const kids: PMNode[] = [];
  block.content.forEach((child: PMNode) => {
    kids.push(child.type.name === "hardBreak" ? schema.text(" ") : child);
  });
  if (kids.length === 0) return "";
  const doc = schema.topNodeType.create(null, Fragment.from(paragraph.create(null, Fragment.fromArray(kids))));
  return docToMarkdown(doc).replace(/\n+/g, " ").trim();
}

/**
 * A table cell as one GFM line: its blocks joined by spaces, pipes escaped.
 * Marks, footnote references and hoisted block images are part of the cell; a
 * plain-text projection would make every mark-bearing table disagree with its
 * live document.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function cellToInline(cell: any): string {
  const parts: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const emit = (block: any): void => {
    if (block.type.name === "image") {
      parts.push(imageMarkdown(block));
      return;
    }
    if (block.isTextblock) {
      const s = inlineBlockToMarkdown(block);
      if (s) parts.push(s);
      return;
    }
    block.forEach(emit); // a list/blockquote nested in the cell
  };
  cell.forEach(emit);
  return parts.join(" ").replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();
}

let serializerCache: MarkdownSerializer | null = null;

/** How many immediately preceding siblings share this node's type. Adjacent
 *  same-type lists fuse on re-parse unless their marker or delimiter alternates. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function siblingListRun(parent: any, index: number, type: unknown): number {
  let run = 0;
  for (let i = index - 1; i >= 0 && parent.child(i).type === type; i--) run++;
  return run;
}

export function docToMarkdown(doc: PMNode): string {
  if (!serializerCache) {
    const D = defaultMarkdownSerializer;
    serializerCache = new MarkdownSerializer(
      {
        paragraph: D.nodes.paragraph!,
        blockquote: D.nodes.blockquote!,
        heading: D.nodes.heading!,
        horizontalRule: D.nodes.horizontal_rule!,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        bulletList(state: any, node: any, parent: any, index: number) {
          const marker = siblingListRun(parent, index, node.type) % 2 === 0 ? "*" : "-";
          state.renderList(node, "  ", () => `${marker} `);
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        orderedList(state: any, node: any, parent: any, index: number) {
          const start = node.attrs.start ?? 1;
          const maxW = String(start + node.childCount - 1).length;
          const space = state.repeat(" ", maxW + 2);
          const delim = siblingListRun(parent, index, node.type) % 2 === 0 ? "." : ")";
          state.renderList(node, space, (i: number) => {
            const nStr = String(start + i);
            return state.repeat(" ", maxW - nStr.length) + nStr + delim + " ";
          });
        },
        /**
         * An item's empty lead paragraph is skipped when the item has more content
         * (the image hoist leaves that shape). Written out it becomes `* ` plus a
         * blank line, which ends the item on re-parse; the parser re-creates the
         * paragraph the content spec requires.
         */
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        listItem(state: any, node: any) {
          const first = node.firstChild;
          if (node.childCount > 1 && first?.type.name === "paragraph" && first.childCount === 0) {
            for (let i = 1; i < node.childCount; i++) state.render(node.child(i), node, i);
            return;
          }
          state.renderContent(node);
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        codeBlock(state: any, node: any) {
          const backticks: string[] | null = node.textContent.match(/`{3,}/gm);
          const fence = backticks ? backticks.sort().slice(-1)[0] + "`" : "```";
          state.write(fence + (node.attrs.language || "") + "\n");
          state.text(node.textContent, false);
          state.write("\n");
          state.write(fence);
          state.closeBlock(node);
        },
        /**
         * A hard break inside a heading becomes a space: an ATX heading ends at
         * the newline, so the stock `\` + newline would split it into two blocks.
         * A footnote definition keeps the stock rendering; its continuation lines
         * belong to it.
         */
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        hardBreak(state: any, node: any, parent: any, index: number) {
          if (parent.type.name !== "heading") {
            D.nodes.hard_break!(state, node, parent, index);
            return;
          }
          // Trailing breaks emit nothing, as the stock serializer does.
          for (let i = index + 1; i < parent.childCount; i++) {
            if (parent.child(i).type !== node.type) {
              state.text(" ", false);
              return;
            }
          }
        },
        text: serializeText,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        image(state: any, node: any) {
          state.write(imageMarkdown(node, (s: string) => state.esc(s)));
          state.closeBlock(node);
        },
        // GFM pipe table: row 0 is the header. Alignment is per column in GFM and
        // per cell in Tiptap, so each column takes the first cell that has one.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        table(state: any, node: any) {
          const rows: string[][] = [];
          const aligns: (string | null)[] = [];
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          node.forEach((row: any) => {
            const cells: string[] = [];
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            row.forEach((cell: any) => {
              if (!aligns[cells.length]) aligns[cells.length] = cell.attrs.align ?? null;
              cells.push(cellToInline(cell));
            });
            rows.push(cells);
          });
          if (rows.length === 0) {
            state.closeBlock(node);
            return;
          }
          const cols = Math.max(...rows.map((r) => r.length));
          const pad = (r: string[]) => Array.from({ length: cols }, (_, i) => r[i] ?? "");
          const line = (r: string[]) => `| ${pad(r).join(" | ")} |`;
          const delim = (i: number): string =>
            aligns[i] === "left" ? ":--" : aligns[i] === "center" ? ":-:" : aligns[i] === "right" ? "--:" : "---";
          state.write(line(rows[0]!) + "\n");
          state.write(`| ${Array.from({ length: cols }, (_, i) => delim(i)).join(" | ")} |\n`);
          for (let i = 1; i < rows.length; i++) state.write(line(rows[i]!) + "\n");
          state.closeBlock(node);
        },
        // Rows and cells are written by table(); these keep a direct visit from throwing.
        tableRow() {},
        tableCell() {},
        tableHeader() {},
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mention(state: any, node: any) {
          state.write(`[@${state.esc(String(node.attrs.label))}](${mdUrl(mentionHref(String(node.attrs.alias)))})`);
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        footnoteReference(state: any, node: any) {
          state.write(`[^${node.attrs.n}]`);
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        footnoteDefinition(state: any, node: any) {
          state.write(`[^${node.attrs.n}]: `);
          state.renderInline(node);
          state.closeBlock(node);
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      {
        // expelEnclosingWhitespace stays off: it moves edge spaces out of the mark
        // and so rewrites the document. serializeText encodes them instead.
        italic: { ...D.marks.em!, expelEnclosingWhitespace: false },
        bold: { ...D.marks.strong!, expelEnclosingWhitespace: false },
        code: {
          ...D.marks.code!,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          open(state: any, mark: any, parent: any, index: number) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return (D.marks.code!.open as any)(state, mark, parent, index) + codeSpanPad(parent.child(index));
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          close(state: any, mark: any, parent: any, index: number) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return codeSpanPad(parent.child(index - 1)) + (D.marks.code!.close as any)(state, mark, parent, index);
          },
        },
        strike: { open: "~~", close: "~~", mixable: true, expelEnclosingWhitespace: false },
        link: {
          ...D.marks.link!,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          close(state: any, mark: any, _parent: any, _index: number) {
            const { inAutolink } = state;
            state.inAutolink = undefined;
            if (inAutolink) return ">";
            const title = mark.attrs.title ? ` "${String(mark.attrs.title).replace(/"/g, '\\"')}"` : "";
            return `](${mdUrl(mark.attrs.href ?? "")}${title})`;
          },
        },
        // No markdown syntax: the text survives, the mark is dropped at this boundary.
        underline: { open: "", close: "", mixable: true },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      { escapeExtraCharacters: ESCAPE_EXTRA },
    );
  }
  return serializerCache.serialize(expelMarkEdgeWhitespace(doc));
}
