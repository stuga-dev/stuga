import { closesFence, fenceOpener, type Fence } from "./fences.js";

/** Count the cells in a GFM table row: split on unescaped pipes, dropping the
 *  empty leading/trailing cells the outer `|` pipes produce. */
function countRowCells(row: string): number {
  let s = row.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).length;
}

// A GFM delimiter row: only pipes / dashes / colons / spaces, with ≥1 dash.
const DELIM_ROW = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
// Per-cell alignment tokens of an existing delimiter row (`:--`, `:-:`, `--:`).
const ALIGN_CELL = /^(:?)-+(:?)$/;

/** Build a delimiter row of `cols` cells, reusing per-column alignment where the
 *  original delimiter provided it (else a plain `---`). */
function buildDelimiter(cols: number, source: string): string {
  let s = source.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  const given = s.split("|").map((c) => c.trim());
  const cell = (i: number): string => {
    const m = ALIGN_CELL.exec(given[i] ?? "");
    if (!m) return "---";
    const left = m[1] === ":";
    const right = m[2] === ":";
    return left && right ? ":-:" : right ? "--:" : left ? ":--" : "---";
  };
  return "| " + Array.from({ length: cols }, (_, i) => cell(i)).join(" | ") + " |";
}

/** Indent width in columns, with tabs expanded the way markdown-it counts them. */
function indentWidth(line: string): number {
  return (/^\s*/.exec(line)?.[0] ?? "").replace(/\t/g, "    ").length;
}

/**
 * Repair GFM tables markdown-it would otherwise reject into a paragraph of
 * literal pipes: a delimiter row whose column count differs from the header's
 * is rebuilt to match, and a table indented 4+ columns past its list item's
 * continuation indent (an indented code block) is dedented to that indent.
 * Indentation is relative to the enclosing list item because the serializer
 * legitimately nests tables at 4+ absolute columns. Fenced code is never touched.
 */
export function normalizeMarkdownTables(markdown: string): string {
  if (!markdown.includes("|")) return markdown;
  const lines = markdown.split("\n");
  const out: string[] = [];
  let fence: Fence | null = null;
  // Continuation indents of the list items open around this line, outermost first.
  const listIndents: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (fence) {
      // A non-blank line left of the fence's container ends the container, and the fence with it.
      if (line.trim() === "" || indentWidth(line) >= fence.base) {
        if (closesFence(line, fence)) fence = null;
        out.push(line);
        continue;
      }
      fence = null;
    }
    if (line.trim() !== "") {
      const width = indentWidth(line);
      // A line dedented past an item's continuation column has closed it.
      while (listIndents.length > 0 && listIndents[listIndents.length - 1]! > width) listIndents.pop();
      const opened = fenceOpener(line, listIndents.at(-1) ?? 0);
      if (opened) {
        fence = opened;
        out.push(line);
        continue;
      }
      const marker = /^\s*(?:[-*+]|\d{1,9}[.)])\s+/.exec(line);
      if (marker) {
        const itemIndent = marker[0].replace(/\t/g, "    ").length;
        listIndents.push(itemIndent);
        const inItem = fenceOpener(line.slice(marker[0].length));
        if (inItem) {
          fence = { ...inItem, base: itemIndent };
          out.push(line);
          continue;
        }
      }
    }
    const base = listIndents.length > 0 ? listIndents[listIndents.length - 1]! : 0;
    const next = lines[i + 1];
    if (line.includes("|") && line.trim() !== "" && next !== undefined && DELIM_ROW.test(next) && next.includes("-")) {
      const cols = countRowCells(line);
      // Keep the table at its list item's own column; flatten only the excess.
      const raw = /^\s*/.exec(line)![0];
      const indent = indentWidth(line) - base >= 4 ? " ".repeat(base) : raw;
      out.push(indent + line.replace(/^\s+/, ""));
      out.push(indent + buildDelimiter(cols, next));
      i++;
      // Re-indent the contiguous body rows (pipe lines until a blank line / non-row).
      while (i + 1 < lines.length && lines[i + 1]!.includes("|") && lines[i + 1]!.trim() !== "") {
        out.push(indent + lines[i + 1]!.replace(/^\s+/, ""));
        i++;
      }
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}
