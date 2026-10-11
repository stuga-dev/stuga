/**
 * Search snippets: raw document text with keyword hits between ⟦ and ⟧. They are
 * rendered as text and <mark> elements, never as HTML, so a document cannot inject markup.
 */
import { SNIPPET_MIN, stripMarkdown } from "../ai/citations";
import type { ReactNode } from "react";
import { t } from "../i18n/i18n";

export interface SnippetPart {
  text: string;
  hit: boolean;
}

/**
 * Splits a snippet at its ⟦ ⟧ sentinels into the text the page shows (see
 * excerptText), with runs of whitespace collapsed to one space.
 */
export function snippetParts(snippet: string): SnippetPart[] {
  const parts: SnippetPart[] = [];
  let hit = false;
  for (const piece of excerptText(snippet).split(/([\uE000\uE001])/)) {
    if (piece === OPEN) hit = true;
    else if (piece === CLOSE) hit = false;
    else if (piece) parts.push({ text: piece, hit });
  }
  return parts;
}

/**
 * Drops all but about `lead` characters before the first hit, cut at a word, so the
 * hit shows in a row clamped to a line or two. Text without a hit is left whole.
 */
export function windowParts(parts: SnippetPart[], lead: number): SnippetPart[] {
  const first = parts.findIndex((p) => p.hit);
  if (first < 0) return parts;
  const before = parts.slice(0, first).map((p) => p.text).join("");
  if (before.length <= lead) return parts;
  // A cut inside an emoji or other astral character leaves half of it, which shows as U+FFFD.
  const cut = before.slice(-lead).replace(/^[\uDC00-\uDFFF]/, "");
  const word = cut.indexOf(" ");
  const kept = word >= 0 && word < cut.length - 1 ? cut.slice(word + 1) : cut;
  return [{ text: `…${kept}`, hit: false }, ...parts.slice(first)];
}

/**
 * `parts` without the document's title at their start: a document's opening often
 * repeats it as a heading, and the result already shows the title above.
 */
export function withoutTitle(parts: SnippetPart[], title: string): SnippetPart[] {
  const name = title.replace(/\s+/g, " ").trim();
  const text = parts.map((p) => p.text).join("");
  // Compared at the title's own length: lowercasing can change a string's length ("İ").
  if (!name || text.slice(0, name.length).toLowerCase() !== name.toLowerCase()) return parts;
  const rest = text.slice(name.length);
  // Only a whole title: "Price list" does not open "Price lists are…".
  if (rest && !/^[\s:·–—-]/.test(rest)) return parts;
  let drop = name.length + (/^[\s:·–—-]+/.exec(rest)?.[0].length ?? 0);
  const kept: SnippetPart[] = [];
  for (const p of parts) {
    if (drop >= p.text.length) {
      drop -= p.text.length;
      continue;
    }
    kept.push(drop > 0 ? { ...p, text: p.text.slice(drop) } : p);
    drop = 0;
  }
  return kept;
}

/** The query's words worth marking in a title: two characters or more, or any non-ASCII character. */
export function queryTerms(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/\s+/))].filter((t) => t.length >= 2 || /[^\u0020-\u007e]/.test(t));
}

/** `s` as a pattern that matches it literally. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Marks each case-insensitive occurrence of `terms` in `text`. */
export function markTerms(text: string, terms: string[]): SnippetPart[] {
  if (terms.length === 0 || !text) return [{ text, hit: false }];
  const pattern = new RegExp(`(${terms.map(escapeRegExp).join("|")})`, "gi");
  // A capturing split alternates between the text around matches and the matches.
  return text
    .split(pattern)
    .map((s, i) => ({ text: s, hit: i % 2 === 1 }))
    .filter((p) => p.text);
}

export function Marked({ parts }: { parts: SnippetPart[] }) {
  return <>{parts.map((p, i) => (p.hit ? <mark key={i}>{p.text}</mark> : p.text))}</>;
}

/**
 * Whether a hit was found by meaning alone: near the query in meaning, with none of
 * its words highlighted in the title or the excerpt. Such a hit reads as a mistake
 * unless it says so.
 */
export function foundByMeaning(hit: { title: string; snippet: string; sem_score: number }, query: string): boolean {
  if (!(hit.sem_score > 0) || hit.snippet.includes("⟦")) return false;
  return !markTerms(hit.title, queryTerms(query)).some((p) => p.hit);
}

/**
 * A search hit's excerpt, without a repeat of `title` at its start; `lead` windows it around the
 * first hit, and `label` goes before it on its first line.
 */
export function Snippet({
  text,
  title,
  lead,
  label,
  className = "snippet",
}: {
  text: string;
  title?: string;
  lead?: number;
  label?: ReactNode;
  className?: string;
}) {
  const parts = title ? withoutTitle(snippetParts(text), title) : snippetParts(text);
  const shown = lead === undefined ? parts : windowParts(parts, lead);
  return (
    <span className={className}>
      {label}
      {label && shown.length > 0 && " · "}
      <Marked parts={shown} />
    </span>
  );
}

/** A search hit's description: its excerpt, after a label when it was found by meaning alone. */
export function HitDescription({
  hit,
  query,
  lead,
  className,
}: {
  hit: { title: string; snippet: string; sem_score: number };
  query: string;
  lead?: number;
  className?: string;
}) {
  const label = foundByMeaning(hit, query) ? <span className="hit-meaning">{t("common.foundByMeaning")}</span> : undefined;
  return <Snippet text={hit.snippet} title={hit.title} lead={lead} label={label} className={className} />;
}

/** The URL parameter that carries a search hit's passage to the opened document (see CitationJump). */
export const HIT_PARAM = "hit";

/** Characters kept on each side of the hit: a few words, or a short run of text written without spaces. */
const HINT_CONTEXT = 24;

// Private-use characters carry the hit's place through the Markdown stripping,
// and set code spans aside from it.
const OPEN = "\uE000";
const CLOSE = "\uE001";
const CODE = "\uE002";

/**
 * A link or image the snippet's first line starts inside: `label](target)`,
 * `label](targ` when the line also ends inside it, or the tail of a target. A
 * word that ends in ")" is a target's tail when it holds a "/", ":", "#", "@" or
 * "%", ends in a file extension, or is plain ASCII without the hit, like "brief.md)",
 * escapes included (a target's parentheses are escaped); otherwise it is prose, like
 * "号)", "๖)" or a hit's own word. Dropping a word of prose that closes a parenthesis
 * costs the excerpt that word; keeping a cut target shows text the page does not.
 */
const START_REMNANT =
  /^(?:\\.|[^[\]\\])*\](?:\((?:\\.|[^)\\])*(?:\)|$))?|^(?=(?:\\.|[^\s()\\])*[/:#@%]|(?:\\.|[^\s()\\])*\.[\w\uE000\uE001]+\)|(?:\\[!-~]|[!-'*-[\]-~])*\))(?:\\.|[^\s()\\])*\)/;
/** A link or image the snippet's last line ends inside: `[label`, `[label](targ`, or `](targ` after a label begun above. */
const END_REMNANT = /(?<!\\)!?\[(?:\\.|[^[\]\\])*(?:\](?:\((?:\\.|[^)\\])*)?)?$|\]\((?:\\.|[^()\\])*$/;
/**
 * A backslash escape, which never opens a code span, or a code span: a whole run
 * of backticks, its text, the same run.
 */
const CODE_SPAN = /\\[\s\S]|(?<!(?<!\\)`)(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g;
/** A fenced code block's opening or closing line, inside any quote or list item. A line of inline code is not one. */
const FENCE = /^[ \t]*(?:>[ \t]?)*[ \t]*(?:(?:[-+*]|\d+[.)])[ \t]+)?(?:`{3,}[^`]*|~{3,}.*)$/;
/** A table row: the serializer writes a pipe at each end. */
const TABLE_ROW = /^\s*\||(?<!\\)\|\s*$/;
/** A pipe between two table cells; one inside a cell is escaped. */
const CELL_BREAK = /(?<!\\)\|/;
/** A table's delimiter row, which the page does not show. */
const TABLE_RULE = /^(?=.*\|)[ \t|:-]+$/;
/** A thematic break, which the page shows as a rule. */
const THEMATIC_BREAK = /^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/;

/**
 * One line of indexed Markdown as the editor shows it: block markers, images,
 * link targets and emphasis dropped, escapes undone. A hit in a link's target
 * moves to its label, which is all the page shows of the link. Delimiters go
 * without a trace: "**May**." renders "May.", not "May .". A code span shows its
 * text as written.
 */
function pageText(line: string): string {
  const code: string[] = [];
  const shown = line
    // A task item's box goes with its list marker: the page shows a checkbox, not "[x]".
    .replace(/^[ \t]*(?:>[ \t]?)*[ \t]*(?:#{1,6}[ \t]+|(?:[-+*]|\d+[.)])[ \t]+(?:\[[ xX]\](?:[ \t]+|$))?)?/, "")
    .replace(CODE_SPAN, (m: string, ticks?: string, body = "") => {
      if (!ticks) return m;
      // The serializer pads a span that holds a backtick with a space each side, which the page does not show.
      code.push(body.includes("`") && /^ [\s\S]* $/.test(body) ? body.slice(1, -1) : body);
      return `${CODE}${code.length - 1}${CODE}`;
    })
    .replace(/!\[(?:\\.|[^\]\\])*\]\((?:\\.|[^)\\])*\)/g, " ")
    .replace(/\[((?:\\.|[^\]\\])*)\]\(((?:\\.|[^)\\])*)\)/g, (_, label: string, target: string) =>
      target.includes(OPEN) && !label.includes(OPEN) ? `${OPEN}${label}${CLOSE}` : label,
    )
    // An autolink; the serializer escapes a `<` that only looks like one, after any escaped backslashes.
    .replace(/(?<=(?:^|[^\\])(?:\\\\)*)<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*)>/g, "$1")
    // A hard break; the rest of the paragraph is on the next line.
    .replace(/(?<!\\)\\$/, "")
    // The serializer escapes a literal `*`, `~` or backtick, and leaves `_` bare only
    // inside a word, where a hit can start or end right beside it.
    .replace(/\\[\s\S]|(?<=\w[\uE000\uE001]*)(_+)(?=[\uE000\uE001]*[^\W_])|[*~`]+|_+/g, (m: string, inWord?: string) =>
      m[0] === "\\" || inWord ? m : "",
    )
    // The serializer spells edge whitespace and some edge characters as references.
    .replace(/(?<!\\)&#(?:(\d{1,7})|[xX]([0-9a-fA-F]{1,6}));/g, (ref, dec?: string, hex?: string) => {
      const cp = dec ? Number(dec) : parseInt(hex ?? "", 16);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ref;
    })
    .replace(/\\([!-/:-@[-`{-~])/g, "$1")
    .replace(/\uE002(\d+)\uE002/g, (_, i: string) => code[Number(i)] ?? "");
  return shown;
}

/** Whether the fence above `next` closes a block: the serializer follows a closing fence with a blank line and an opening one with code. */
function closesBlock(next: string | undefined): boolean {
  return next !== undefined && /^[\s>]*$/.test(next);
}

/**
 * Whether the line starting at `from` is in a fenced code block. Fences above it
 * alternate between opening and closing, but the snippet may start inside a block,
 * so its first fence may close one. Code itself may hold blank lines.
 */
function inCodeBlock(text: string, from: number): boolean {
  if (from === 0) return false;
  const above = text.slice(0, from - 1).split("\n");
  let code = false;
  let seen = false;
  for (const [i, line] of above.entries()) {
    if (!FENCE.test(line)) continue;
    code = seen ? !code : !closesBlock(above[i + 1]);
    seen = true;
  }
  return code;
}

/**
 * What the page shows of a link cut at the snippet's edge when it holds a hit:
 * the label left of it, carrying a hit from the target as a whole link's label
 * does, or the target as written when no label is left. Nothing of an image.
 */
function cutLink(cut: string): string {
  if (!cut.includes(OPEN) || cut.startsWith("![")) return "";
  const link = /^\[?((?:\\.|[^[\]\\])*)\]\(?((?:\\.|[^)\\])*)\)?$/.exec(cut) ?? /^\[((?:\\.|[^[\]\\])*)()$/.exec(cut);
  if (!link) return cut.replace(/\)$/, "");
  const [, label = "", target = ""] = link;
  if (!label.trim()) return target;
  return target.includes(OPEN) && !label.includes(OPEN) ? `${OPEN}${label}${CLOSE}` : label;
}

/** The first backtick run no code span pairs: what is left of a span the snippet's edge cut. */
function strayTicks(line: string): RegExpExecArray | null {
  // Spans and escapes blanked out, so what is left keeps its place in the line.
  return /`+/.exec(line.replace(CODE_SPAN, (m: string) => " ".repeat(m.length)));
}

/**
 * How many of a line's code spans the serializer could not have written: a sign
 * that their backticks pair the wrong way, setting the prose between two spans
 * aside as code. It delimits a span with one backtick more than the longest run
 * inside, and pads only one that holds a backtick, or text with a space at each end.
 */
function misfits(line: string): number {
  let n = 0;
  for (const [, ticks, body = ""] of line.matchAll(CODE_SPAN)) {
    if (!ticks) continue;
    const inner = Math.max(0, ...(body.match(/`+/g) ?? []).map((run) => run.length));
    const padded = /^ [\s\S]* $/.test(body) && (ticks.length > 1 || /^ {2}[\s\S]* {2}$/.test(body));
    if (inner >= ticks.length || (/^\s|\s$/.test(body) && !padded)) n++;
  }
  return n;
}

/** `line` with the code span the snippet's start cut closed by `close` opened again, so its text shows as code. */
function reopenHead(line: string, close: RegExpExecArray): string {
  const head = line.slice(0, close.index);
  if (!head.trim()) return line.slice(close.index + close[0].length);
  // A span delimited by two backticks or more is padded; the cut took the opening pad.
  return close[0] + (close[0].length > 1 && /\s$/.test(head) ? " " : "") + line;
}

/** `line` with the code span the snippet's end cut, which its first unpaired run opens, closed again. */
function closeTail(line: string): string {
  const open = strayTicks(line);
  if (!open) return line;
  const tail = line.slice(open.index + open[0].length);
  if (!tail.trim()) return line.slice(0, open.index);
  return line + (open[0].length > 1 && /^\s/.test(tail) ? " " : "") + open[0];
}

/**
 * The backticks closing a code span the snippet's first line starts inside, when
 * a run is left unpaired. They are longer than any run the span's text holds,
 * and the rest of the line pairs after them. A backslash in code is as written,
 * so it escapes nothing there. On a line that also ends the snippet, the unpaired
 * run may instead open a span the cut ended inside: the reading whose spans fit
 * better wins.
 */
function spanClose(line: string, last: boolean): RegExpExecArray | null {
  const stray = strayTicks(line);
  if (!stray) return null;
  const runs = [...line.matchAll(/`+/g)] as RegExpExecArray[];
  const longest = runs.filter((r, i) => runs.slice(0, i).every((p) => p[0].length < r[0].length));
  const run = longest.find((r) => !strayTicks(line.slice(r.index + r[0].length))) ?? runs[0];
  if (!run || !last) return run ?? null;
  const reopened = reopenHead(line, run);
  const start = misfits(closeTail(reopened));
  const end = misfits(closeTail(line));
  if (start !== end) return start < end ? run : null;
  // A tie goes to the reading that needs one cut, not two, then to the one that sets
  // less text aside as code. A run with nothing or a backslash before it reads as
  // an opening or an escaped backtick.
  if (strayTicks(reopened)) return null;
  const head = line.slice(0, run.index);
  const tail = line.slice(stray.index + stray[0].length);
  return /[^\s\\]\s*$/.test(head) && head.trim().length <= tail.trim().length ? run : null;
}

/**
 * A line the snippet's edge cut, mended to render as the page does. A link the
 * cut fell inside goes as `cut` says, or whole without `cut`, even inside code.
 * A code span it fell inside is closed again, so its text shows as written and
 * the spans after it pair as on the page.
 */
function mendCut(line: string, first: boolean, last: boolean, cut?: (remnant: string) => string): string {
  const shown = cut ?? (() => "");
  if (first) {
    let close = spanClose(line, last);
    // A link inside the code is code; one around it goes with it.
    const link = START_REMNANT.exec(line);
    if (link && (!cut || !close || link[0].length > close.index)) {
      line = line.replace(START_REMNANT, shown);
      close = spanClose(line, last);
    }
    if (close) line = reopenHead(line, close);
  }
  if (last) {
    // A character reference the cut ended inside ("do&#32").
    line = line.replace(/(?<!\\)&#(?:\d{0,7}|[xX][0-9a-fA-F]{0,6})$/, "");
    const open = strayTicks(line);
    const link = END_REMNANT.exec(line);
    if (link && (!cut || !open || link.index < open.index)) line = line.replace(END_REMNANT, shown);
    line = closeTail(line);
  }
  return line;
}

/**
 * A snippet's indexed Markdown as the page shows it, its hits between OPEN and
 * CLOSE. Each line renders as passageHint renders the hit's, without the stripping
 * that matching needs, so code keeps its `*` and `_`. A table row shows its cells
 * joined by " · "; fences, delimiter rows and rules show nothing.
 */
/** How many quotes a line is in. */
function quoteDepth(line: string): number {
  return (/^(?:[ \t]*>[ \t]?)*/.exec(line)?.[0].match(/>/g) ?? []).length;
}

function excerptText(snippet: string): string {
  const text = snippet.replace(/[\uE000-\uE002]/g, "").replace(/⟦/g, OPEN).replace(/⟧/g, CLOSE);
  const lines = text.split("\n");
  // Above its first fence, the snippet is in code when that fence closes a block.
  const first = lines.findIndex((l) => FENCE.test(l));
  const startsInCode = first > 0 && closesBlock(lines[first + 1]);
  // A block in a quote carries the quote's markers on every line, as its fences do; ">>>" in plain code stays.
  let quotes = startsInCode ? quoteDepth(lines[first] ?? "") : 0;
  let from = 0;
  const shown = lines.map((line, i) => {
    const code = (i < first && startsInCode) || inCodeBlock(text, from);
    from += line.length + 1;
    if (FENCE.test(line)) {
      quotes = quoteDepth(line);
      return "";
    }
    if (code) return quotes ? line.replace(new RegExp(`^(?:[ \\t]*>[ \\t]?){0,${quotes}}`), "") : line;
    if (TABLE_RULE.test(line) || THEMATIC_BREAK.test(line)) return "";
    const isRow = TABLE_ROW.test(line);
    // The snippet can start or end inside a code span, or a link, which goes unless it holds a hit.
    line = mendCut(line, i === 0, i === lines.length - 1, cutLink);
    if (!isRow) return pageText(line);
    return line
      .split(CELL_BREAK)
      .map((cell) => pageText(cell.replace(/\\\|/g, "|")).trim())
      .filter(Boolean)
      .join(" · ");
  });
  return shown.join("\n").replace(/\s+/g, " ").trim();
}

/** About the last `n` characters of `s`, from a word start where the text has spaces. */
function lastChars(s: string, n: number): string {
  if (s.length <= n || /\s/.test(s[s.length - n - 1] ?? "")) return s.slice(-n);
  // A cut inside an emoji or other astral character leaves half of it, which the URL turns into U+FFFD.
  const cut = s.slice(-n).replace(/^[\uDC00-\uDFFF]/, "");
  const space = cut.search(/\s/);
  return space < 0 ? cut : cut.slice(space);
}

/** About the first `n` characters of `s`, to a word end where the text has spaces. */
function firstChars(s: string, n: number): string {
  if (s.length <= n || /\s/.test(s[n] ?? "")) return s.slice(0, n);
  const cut = s.slice(0, n).replace(/[\uD800-\uDBFF]$/, "");
  const space = cut.search(/\s\S*$/);
  return space < 0 ? cut : cut.slice(0, space);
}

/**
 * Text to find a search hit's passage by in the opened document: the first hit
 * and a few words either side, as the page renders them. Null for a snippet
 * without a keyword hit (a passage close in meaning, or the opening), and for one
 * too short to tell its passage from a chance match. Never the hit word alone,
 * which would land on its first use anywhere in the document.
 */
export function passageHint(snippet: string): string | null {
  const text = snippet.replace(/[\uE000-\uE002]/g, "");
  const at = text.indexOf("⟦");
  if (at < 0) return null;
  // One line of Markdown is one block or one table row, and the hint must lie within one block to match.
  const from = text.lastIndexOf("\n", at) + 1;
  const newline = text.indexOf("\n", at);
  const to = newline < 0 ? text.length : newline;
  const shut = text.indexOf("⟧", at);
  const hitEnd = shut >= 0 && shut < to ? shut : to;
  const marked = text.slice(from, at) + OPEN + text.slice(at + 1, hitEnd) + CLOSE + text.slice(Math.min(hitEnd + 1, to), to);
  let line = marked.replace(/[⟦⟧]/g, "");

  // A code block's line shows as written.
  const code = inCodeBlock(text, from);
  if (!code) {
    const isRow = TABLE_ROW.test(line);
    // The snippet can start or end inside a link or a code span. Text cut from either end of a
    // line still matches, so a link goes whole: matching strips a link inside code too.
    line = mendCut(line, from === 0, to === text.length);
    // Each cell renders as its own block. The serializer escapes every pipe in a cell, code spans' too.
    if (isRow) line = (line.split(CELL_BREAK).find((cell) => cell.includes(OPEN)) ?? "").replace(/\\\|/g, "|");
  }

  // Stripped as citations are, to match the page's text.
  const plain = stripMarkdown(code ? line : pageText(line));
  const open = plain.indexOf(OPEN);
  const close = plain.indexOf(CLOSE, open);
  if (open < 0 || close < 0) return null;
  const before = lastChars(plain.slice(0, open), HINT_CONTEXT);
  const after = firstChars(plain.slice(close + 1), HINT_CONTEXT);
  if (!/[\p{L}\p{N}]/u.test(before + after)) return null;
  const hint = `${before}${plain.slice(open + 1, close)}${after}`.replace(/\s+/g, " ").trim();
  return hint.length >= SNIPPET_MIN ? hint : null;
}

/** Scripts written without spaces between words, where a word can start anywhere. */
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

/** A letter, mark or digit of a script written with spaces, which a word cannot start right after. */
const IN_WORD = `(?!${UNSPACED.source})[\\p{L}\\p{M}\\p{N}]`;

/**
 * Whether `title` holds one of `terms` at a word's start: "repair" is in "Repairs",
 * "to" is not in "history", "docker" is in "使用Docker部署".
 */
function titleHolds(title: string, terms: string[]): boolean {
  const lower = title.toLowerCase();
  return terms.some((t) => (UNSPACED.test(t) ? lower.includes(t) : new RegExp(`(?<!${IN_WORD})${escapeRegExp(t)}`, "u").test(lower)));
}

/**
 * A search hit's link: the document, opened at the matched passage. A title that
 * holds a query word means the person is switching documents, so it opens at the top.
 */
export function hitHref(docId: string, hit: { title: string; snippet: string }, query: string): string {
  const path = `/doc/${encodeURIComponent(docId)}`;
  if (titleHolds(hit.title, queryTerms(query))) return path;
  const hint = passageHint(hit.snippet);
  return hint ? `${path}?${new URLSearchParams({ [HIT_PARAM]: hint })}` : path;
}
