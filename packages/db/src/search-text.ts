/**
 * The text the keyword index holds, and the terms a query searches it by. Postgres's text search
 * parser splits on spaces and punctuation, which is right for English or Arabic but leaves a run of
 * Chinese, Japanese, Korean or Thai as one long token that no query word equals. So before it is
 * indexed, text is normalised (full-width to half-width, traditional Chinese to simplified, lower
 * case) and cut in two:
 *
 * - `latin`: the words of every script written with spaces, accents dropped, for the stemming
 *   configurations (`to_tsvector('english', …)` and the node's other search languages).
 * - `cjk`: Han, kana and Hangul as every character and every pair of neighbours ("审批人" → 审 批 人
 *   审批 批人), so a word of one or two characters is found wherever it stands; Thai (and Lao, Khmer,
 *   Myanmar) as the words `Intl.Segmenter` finds. Indexed as written.
 *
 * Which treatment each script gets was measured on MIRACL: pairs beat dictionary words for Chinese
 * and Japanese and the words as written for Korean, and dictionary words beat pairs for Thai. Against
 * the jieba, Lindera and ICU tokenizers search used before, this spelling, ranked by BM25, scored
 * higher on Chinese, Korean and Thai and the same on English.
 *
 * Text is normalised a run of letters at a time, so every term knows where in the text it stands. A
 * query is cut and spelled out the same way, at whatever is not a letter and where a script changes,
 * so the index and the query always agree.
 */
import * as OpenCC from "opencc-js/t2cn";

/**
 * Names the text `searchParts` makes. A row indexed under another name is indexed again at boot: the
 * version moves when this module changes what it writes, and ICU's version is in it because the Thai
 * word breaks come from ICU's dictionaries, which a newer Node may draw differently.
 */
export const SEARCH_FORMAT = `2/icu-${process.versions.icu ?? "none"}`;

/** Terms one query searches by at most: a pasted paragraph searches by its start. */
export const MAX_QUERY_TERMS = 64;

/** Characters a word may have and be a term: a longer one is a key or an encoded blob, which nobody types. */
export const MAX_TERM_CHARS = 100;

// ---- Normalising --------------------------------------------------------------------

let toSimplified: ((text: string) => string) | null = null;

/** Thai and Lao sara am as NFKC splits them, into nikhahit and sara aa, which ICU's dictionaries do not read as one word. */
const SPLIT_AM = /\u0E4D\u0E32|\u0ECD\u0EB2/g;

/**
 * NFKC (full-width letters, digits and punctuation to half-width; half-width kana to full), with Thai
 * and Lao sara am kept whole, then simplified Chinese, then lower case.
 */
export function normalizeText(text: string): string {
  toSimplified ??= OpenCC.Converter({ from: "t", to: "cn" });
  const nfkc = text.normalize("NFKC").replace(SPLIT_AM, (am) => (am === "\u0E4D\u0E32" ? "\u0E33" : "\u0EB3"));
  return toSimplified(nfkc).toLowerCase();
}

// ---- Runs ---------------------------------------------------------------------------

type Mode = "pairs" | "words" | null;

const HAN = /[\p{Script=Han}々-〇]/u;
/** Kana, the long-vowel mark, and the half-width voicing marks, which normalising joins to the kana before them. */
const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}ー\uFF9E\uFF9F]/u;
const HANGUL = /\p{Script=Hangul}/u;
const THAI = /[\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
/** A word of a spaced script: letters, digits and marks; everything else separates. */
const WORD = /[\p{L}\p{N}\p{M}]+/gu;
const COMBINING_ACCENT = /[̀-ͯ]/g;

function modeOf(char: string): Mode {
  if (HAN.test(char) || KANA.test(char) || HANGUL.test(char)) return "pairs";
  if (THAI.test(char)) return "words";
  return null;
}

let segmenter: Intl.Segmenter | null = null;

function wordsOf(run: string): string[] {
  segmenter ??= new Intl.Segmenter(undefined, { granularity: "word" });
  const out: string[] = [];
  for (const s of segmenter.segment(run)) if (s.isWordLike) out.push(s.segment);
  return out;
}

function pairsOf(chars: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i]! + chars[i + 1]!);
  return out;
}

/**
 * The words of a spaced run, accents dropped. Cut here rather than by Postgres's parser, so the index
 * and the query are cut the same way and `node.js` or `expand-contract` are never read as a host or a
 * hyphenated compound on one side only.
 */
function latinWords(text: string): string[] {
  return text.normalize("NFD").replace(COMBINING_ACCENT, "").normalize("NFC").match(WORD) ?? [];
}

// ---- Indexed text -------------------------------------------------------------------

export interface SearchParts {
  /** Space-separated words, for the stemming configurations. */
  latin: string;
  /** Space-separated characters, pairs and Thai words, for the `simple` configuration. */
  cjk: string;
}

/** One term of the indexed text and where it was read. */
export interface SearchToken {
  part: keyof SearchParts;
  term: string;
  /**
   * Where in the text the term was read, in UTF-16 units. A run that normalising made longer or
   * shorter (a ligature, kana composed with its voicing mark) gives each of its terms the whole run.
   */
  start: number;
  end: number;
}

/** A run of letters, digits and marks as the text has it. */
const LETTERS = /[\p{L}\p{N}\p{M}]+/gu;
const MARK = /\p{M}/u;

/** A run of letters cut where its treatment changes, a mark going with the letter before it. */
function scriptRuns(text: string, at: number): { text: string; mode: Mode; start: number; end: number }[] {
  const runs: { text: string; mode: Mode; start: number; end: number }[] = [];
  let start = 0;
  let mode: Mode = null;
  let i = 0;
  for (const char of text) {
    const m: Mode = i > 0 && MARK.test(char) ? mode : modeOf(char);
    if (i > start && m !== mode) {
      runs.push({ text: text.slice(start, i), mode, start: at + start, end: at + i });
      start = i;
    }
    mode = m;
    i += char.length;
  }
  if (i > start) runs.push({ text: text.slice(start), mode, start: at + start, end: at + i });
  return runs;
}

/** The terms of one run of letters, in `searchParts`' order. */
function runTokens(letters: string, at: number): SearchToken[] {
  const tokens: SearchToken[] = [];
  for (const run of scriptRuns(letters, at)) {
    const normal = normalizeText(run.text);
    if (run.mode === null) {
      for (const term of latinWords(normal)) {
        if (term.length <= MAX_TERM_CHARS) tokens.push({ part: "latin", term, start: run.start, end: run.end });
      }
    } else if (run.mode === "words") {
      const same = normal.length === run.text.length;
      segmenter ??= new Intl.Segmenter(undefined, { granularity: "word" });
      for (const s of segmenter.segment(normal)) {
        if (!s.isWordLike || s.segment.length > MAX_TERM_CHARS) continue;
        const start = same ? run.start + s.index : run.start;
        tokens.push({ part: "cjk", term: s.segment, start, end: same ? start + s.segment.length : run.end });
      }
    } else {
      const chars = [...normal];
      const written = [...run.text];
      const starts: number[] = [];
      for (let k = 0, i = run.start; k < written.length; i += written[k]!.length, k++) starts.push(i);
      const same = chars.length === written.length;
      const startOf = (k: number) => (same ? starts[k]! : run.start);
      const endOf = (k: number) => (same ? starts[k]! + written[k]!.length : run.end);
      for (let k = 0; k < chars.length; k++) tokens.push({ part: "cjk", term: chars[k]!, start: startOf(k), end: endOf(k) });
      for (let k = 0; k + 1 < chars.length; k++) tokens.push({ part: "cjk", term: chars[k]! + chars[k + 1]!, start: startOf(k), end: endOf(k + 1) });
    }
  }
  return tokens;
}

/**
 * The terms of `text`, a run of letters at a time, in the order `searchParts` writes each part's,
 * with where each was read: the index's n-th word is the n-th latin token, so a position the index
 * holds leads back to the text. Every term of a run lies before the next run's.
 */
export function* searchRuns(text: string): Generator<SearchToken[]> {
  for (const letters of text.matchAll(LETTERS)) yield runTokens(letters[0], letters.index);
}

/** `searchRuns`, a term at a time. */
export function* searchTokens(text: string): Generator<SearchToken> {
  for (const run of searchRuns(text)) yield* run;
}

/** What the keyword index holds for `text`. */
export function searchParts(text: string): SearchParts {
  const parts: Record<keyof SearchParts, string[]> = { latin: [], cjk: [] };
  for (const token of searchTokens(text)) parts[token.part].push(token.term);
  return { latin: parts.latin.join(" "), cjk: parts.cjk.join(" ") };
}

// ---- Queries ------------------------------------------------------------------------

export interface QueryTerms {
  latin: string[];
  cjk: string[];
}

export interface QueryShape extends QueryTerms {
  /**
   * What a document must hold of the CJK terms: one of each group, as indexes into `cjk`. A piece of
   * one or two characters is its term; in a longer piece, every character must stand in a pair the
   * document holds, so 人工智能 finds 人工审核的智能 while 马里亚纳海沟 does not find 马匹, 里程,
   * 亚洲 and 海关 apart. A Thai word is its own group.
   */
  cjkGroups: number[][];
}

/**
 * The terms a query searches by, spelled as `searchParts` spells the indexed text, and the groups a
 * match must hold. A Chinese, Japanese or Korean piece of two characters is its pair alone, since its
 * characters would find every text holding either one; a longer piece also searches by character.
 * At most MAX_QUERY_TERMS terms; a group whose terms are past them is left out.
 */
export function queryShape(query: string): QueryShape {
  const latin = new Set<string>();
  const cjk = new Map<string, number>();
  const groups = new Map<string, number[]>();
  const full = () => latin.size + cjk.size >= MAX_QUERY_TERMS;
  const add = (term: string): number | undefined => {
    if (!cjk.has(term) && !full()) cjk.set(term, cjk.size);
    return cjk.get(term);
  };
  const need = (...terms: (number | undefined)[]) => {
    const group = [...new Set(terms.filter((t) => t !== undefined))].sort((a, b) => a - b);
    if (group.length) groups.set(group.join(","), group);
  };
  // Cut and normalised as searchTokens cuts and normalises the text, a run of letters at a time.
  for (const letters of query.matchAll(LETTERS)) {
    for (const run of scriptRuns(letters[0], 0)) {
      const text = normalizeText(run.text);
      if (run.mode === null) {
        for (const word of latinWords(text)) if (word.length <= MAX_TERM_CHARS && !full()) latin.add(word);
      } else if (run.mode === "words") {
        for (const word of wordsOf(text)) if (word.length <= MAX_TERM_CHARS) need(add(word));
      } else {
        const chars = [...text];
        if (chars.length === 1) need(add(chars[0]!));
        else {
          const pairs = pairsOf(chars).map(add);
          if (chars.length > 2) chars.forEach(add);
          for (let k = 0; k < chars.length; k++) need(pairs[k - 1], pairs[k]);
        }
      }
    }
  }
  return { latin: [...latin], cjk: [...cjk.keys()], cjkGroups: [...groups.values()] };
}

/** The terms a query searches by: `queryShape` without its groups. */
export function queryTerms(query: string): QueryTerms {
  const { latin, cjk } = queryShape(query);
  return { latin, cjk };
}
