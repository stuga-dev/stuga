/**
 * The keyword excerpt of a search hit: the window of its text showing the most of the query's words.
 * Matches are found as the index found them. A word matched where the index holds one of the query's
 * stems, at the positions Postgres returns for the hit, so "plans" marks "planning"; a CJK or Thai term
 * where the text, spelled as search-text.ts spells it, holds it, neighbouring pairs marked as one run.
 * The text's own brackets and tags are never read as marks.
 */
import { normalizeText, searchRuns } from "./search-text.js";
import { MAX_POSITION } from "./search-vectors.js";

/** The excerpt is the best of the first this many windows of the text that hold a match. */
export const EXCERPT_WINDOWS = 64;
export const EXCERPT_CHARS = 200;
/** Characters an excerpt may open before its first match, to start on that match's line or sentence. */
const LEAD = 40;
/** Where a line or sentence ends, for opening an excerpt on the next one. */
const BOUNDARIES = ["\n", ". ", "? ", "! ", "。", "？", "！"];
/** Characters a cut may move to end on a word; text written without spaces has none that near, and is kept as cut. */
const WORD_CUT_MAX = 24;
const WORD_CHAR = /[\p{L}\p{N}\p{M}_]/u;

/** What a hit's text is matched against. */
export interface ExcerptMarks {
  /** Positions of the text's words (from 1) that hold one of the query's stems. */
  words: ReadonlySet<number>;
  /** CJK and Thai terms to mark. */
  cjk: ReadonlySet<string>;
}

interface Span {
  start: number;
  end: number;
}

interface Window extends Span {
  matches: Span[];
}

/** The matches in `text`, in order, until they open more than EXCERPT_WINDOWS windows. */
function windowsOf(text: string, marks: ExcerptMarks): Window[] {
  const windows: Window[] = [];
  let word = 0;
  for (const run of searchRuns(text)) {
    const found: Span[] = [];
    for (const token of run) {
      if (token.part === "latin") {
        word++;
        // Every word from the last position on is held there, so none of them can be told apart.
        if (word < MAX_POSITION && marks.words.has(word)) found.push({ start: token.start, end: token.end });
      } else if (marks.cjk.has(token.term)) {
        found.push({ start: token.start, end: token.end });
      }
    }
    found.sort((a, b) => a.start - b.start || a.end - b.end);
    for (const match of found) {
      const window = windows[windows.length - 1];
      const last = window?.matches[window.matches.length - 1];
      if (window && last && match.start < last.end && match.end - last.start <= EXCERPT_CHARS) {
        // Overlapping pairs of one run of characters are one match, as long as an excerpt can show it.
        last.end = Math.max(last.end, match.end);
        window.end = Math.max(window.end, last.end);
      } else if (window && match.end - window.start <= EXCERPT_CHARS) {
        window.matches.push({ ...match });
        window.end = match.end;
      } else {
        if (windows.length === EXCERPT_WINDOWS) return windows;
        windows.push({ start: match.start, end: match.end, matches: [{ ...match }] });
      }
    }
  }
  return windows;
}

/** The window showing the most different matches (as the index spells them), then the most matches, then the first. */
function bestWindow(text: string, windows: Window[]): Window | null {
  let best: { window: Window; distinct: number } | null = null;
  for (const window of windows) {
    const distinct = new Set(window.matches.map((m) => normalizeText(text.slice(m.start, m.end)))).size;
    if (!best || distinct > best.distinct || (distinct === best.distinct && window.matches.length > best.window.matches.length)) {
      best = { window, distinct };
    }
  }
  return best?.window ?? null;
}

/** `at`, or the next code point's start when `at` falls inside a surrogate pair. */
function onCodePoint(text: string, at: number): number {
  const code = text.charCodeAt(at);
  return at > 0 && code >= 0xdc00 && code <= 0xdfff ? at + 1 : at;
}

/** `at` moved past the word it falls inside, and the spaces after, never beyond `limit`. */
function wordStart(text: string, at: number, limit: number): number {
  let i = at;
  if (i > 0 && WORD_CHAR.test(text[i - 1]!)) {
    while (i < limit && i - at < WORD_CUT_MAX && WORD_CHAR.test(text[i]!)) i++;
    if (i >= limit || WORD_CHAR.test(text[i]!)) return at;
  }
  while (i < limit && (text[i] === " " || text[i] === "\t")) i++;
  return i;
}

/** `at` moved back before the word it falls inside, and the spaces before, never before `limit`. */
function wordEnd(text: string, at: number, limit: number): number {
  let i = at;
  if (i < text.length && WORD_CHAR.test(text[i]!)) {
    while (i > limit && at - i < WORD_CUT_MAX && WORD_CHAR.test(text[i - 1]!)) i--;
    if (i <= limit || WORD_CHAR.test(text[i - 1]!)) return at;
  }
  while (i > limit && (text[i - 1] === " " || text[i - 1] === "\t")) i--;
  return i;
}

/**
 * Where the excerpt of `window` begins and ends: EXCERPT_CHARS at most, opening on the line or
 * sentence of its first match when that is near, using the whole length when the text ends sooner,
 * and cut at whole words.
 */
function excerptRange(text: string, window: Window): Span {
  if (text.length <= EXCERPT_CHARS) return { start: 0, end: text.length };
  const back = Math.max(0, window.start - LEAD);
  const lead = text.slice(back, window.start);
  const after = Math.max(...BOUNDARIES.map((b) => (lead.lastIndexOf(b) < 0 ? -1 : lead.lastIndexOf(b) + b.length)));
  let start = after < 0 ? back : back + after;
  start = Math.max(start, window.end - EXCERPT_CHARS);
  start = Math.max(0, Math.min(start, text.length - EXCERPT_CHARS));
  start = wordStart(text, onCodePoint(text, start), window.start);
  const end = wordEnd(text, onCodePoint(text, Math.min(text.length, start + EXCERPT_CHARS)), window.end);
  return { start, end };
}

/**
 * The keyword excerpt of `text`, its matches between ⟦ and ⟧, and where in the text it begins
 * (UTF-16 units); null when the text holds no match.
 */
export function keywordExcerpt(text: string, marks: ExcerptMarks): { text: string; start: number } | null {
  if (marks.words.size === 0 && marks.cjk.size === 0) return null;
  const windows = windowsOf(text, marks);
  const best = bestWindow(text, windows);
  if (!best) return null;
  const range = excerptRange(text, best);
  let out = "";
  let at = range.start;
  for (const window of windows) {
    for (const match of window.matches) {
      if (match.start < at || match.end > range.end) continue;
      out += `${text.slice(at, match.start)}⟦${text.slice(match.start, match.end)}⟧`;
      at = match.end;
    }
  }
  return { text: out + text.slice(at, range.end), start: range.start };
}

/** Where the first word the unfinished last word (as the index spells it) begins stands in `text`, in UTF-16 units; -1 for none. */
export function completionAt(text: string, prefix: string): number {
  for (const run of searchRuns(text)) {
    for (const token of run) if (token.part === "latin" && token.term.startsWith(prefix)) return token.start;
  }
  return -1;
}
