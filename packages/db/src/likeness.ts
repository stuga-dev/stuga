/**
 * How alike two pieces of text are, for what Save to Stuga reports beside its places: a sentence a
 * new point may make untrue. Everything here is plain computation over strings.
 *
 * - `foldText` is the normal form text is compared in: NFKC (full-width letters and digits to
 *   half-width, half-width kana to full), case folded, every dash as "-", runs of space as one.
 *   Superscript, subscript, circled and fraction digits keep their own form: "10⁶" is not "106".
 * - `hashText` is `foldText` with a hyphen between two letters dropped, so "re-printed" and
 *   "reprinted" are one text and "-5" and "5" stay two.
 * - `textLikeness` estimates the Jaccard of two texts' character shingles by MinHash: three
 *   characters, or a pair of characters in a script written without spaces, as search pairs them;
 *   each run of digits read as one placeholder, punctuation left out, and a shingle of digits and
 *   spaces alone dropped, so numbers or dates never make two texts alike. It says apart whether their
 *   numbers differ: "the budget is 300" and "the budget is 350" are the same point with a new
 *   number, never the same text twice.
 */

/** Every character a writer may use for a dash or a minus. */
const DASHES = /[-‐-―−﹘﹣－⸺⸻]/gu;

/** NFKC everywhere but on digits NFKC would turn into plain ones (⁶, ₂, ①, ½), which keep their meaning. */
function nfkc(text: string): string {
  return text.replace(/[^\p{No}]+/gu, (run) => run.normalize("NFKC"));
}

/** NFKC, case folded, dashes as "-", spaces collapsed and trimmed, no space either side of a dash. */
export function foldText(text: string): string {
  return nfkc(nfkc(text).toUpperCase().toLowerCase())
    .replace(DASHES, "-")
    .replace(/\s+/gu, " ")
    .replace(/ ?- ?/g, "-")
    .trim();
}

/** `foldText` without a hyphen between two letters. */
export function hashText(text: string): string {
  return foldText(text).replace(/(?<=\p{L})-(?=\p{L})/gu, "");
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const LETTERS = /[\p{L}\p{N}\p{M}]+/gu;
const LETTER = /\p{L}/u;

/** A text's words: runs of letters and digits, a run of CJK characters a word of its own. */
function wordsOf(text: string): Array<{ text: string; cjk: boolean }> {
  const out: Array<{ text: string; cjk: boolean }> = [];
  for (const run of foldText(text).match(LETTERS) ?? []) {
    let word = "";
    let cjk = false;
    for (const char of run) {
      const isCjk = CJK.test(char);
      if (word !== "" && isCjk !== cjk) {
        out.push({ text: word, cjk });
        word = "";
      }
      word += char;
      cjk = isCjk;
    }
    if (word !== "") out.push({ text: word, cjk });
  }
  return out;
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const x of a) if (b.has(x)) shared++;
  return shared / (a.size + b.size - shared);
}

/** The runs of digits in `text`, leading zeros dropped, in order of size: "09" and "9" are one number, "1.2" two. */
export function numbersOf(text: string): string[] {
  return (foldText(text).match(/\p{N}+/gu) ?? []).map((run) => run.replace(/^0+(?=\d)/, "")).sort();
}

/** Whether two texts name different numbers: then they are different points, however alike the words. */
export function numbersDiffer(a: string, b: string): boolean {
  const x = numbersOf(a);
  const y = numbersOf(b);
  return x.length !== y.length || x.some((n, i) => n !== y[i]);
}

// ---- MinHash ------------------------------------------------------------------------

/** Hash functions in a signature: an estimate's standard error is about sqrt(J(1-J)/256), 0.025 at 0.8. */
export const MINHASH_PERMUTATIONS = 256;
/** Characters a shingle spans. */
export const SHINGLE_CHARS = 3;

/**
 * The text's character shingles: folded as `hashText` folds it, punctuation left out, each run of
 * digits one "#". Two neighbouring characters of a script written without spaces make one, as
 * search pairs them (前台早上 → 前台, 台早, 早上); elsewhere `size` characters do. A shingle with no
 * letter in it ("# #") says nothing of what a text is about and is left out. A text shorter than a
 * shingle is its own.
 */
export function shingles(text: string, size = SHINGLE_CHARS): Set<string> {
  const plain = hashText(text)
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const chars = [...plain.replace(/\p{N}+/gu, "#")];
  const out = new Set<string>();
  const add = (gram: string) => {
    if (LETTER.test(gram)) out.add(gram);
  };
  if (chars.length <= size) {
    if (chars.length > 0) add(chars.join(""));
    return out;
  }
  for (let i = 0; i + 1 < chars.length; i++) {
    if (CJK.test(chars[i]!) && CJK.test(chars[i + 1]!)) add(chars[i]! + chars[i + 1]!);
    else if (i + size <= chars.length) add(chars.slice(i, i + size).join(""));
  }
  return out;
}

/** FNV-1a over UTF-16 code units: a fixed 32-bit hash, the same on every machine. */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A 32-bit mix (murmur3's finaliser), seeded per permutation. */
function mix(x: number, seed: number): number {
  let h = (x ^ seed) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

const SEEDS = Array.from({ length: MINHASH_PERMUTATIONS }, (_, i) => mix(i + 1, 0x9e3779b9));

/** The MinHash signature of a set of shingles: per hash function, the least value any shingle takes. */
export function minhash(set: ReadonlySet<string>): Uint32Array {
  const signature = new Uint32Array(MINHASH_PERMUTATIONS).fill(0xffffffff);
  for (const item of set) {
    const base = fnv1a(item);
    for (let i = 0; i < MINHASH_PERMUTATIONS; i++) {
      const v = mix(base, SEEDS[i]!);
      if (v < signature[i]!) signature[i] = v;
    }
  }
  return signature;
}

/** The Jaccard two signatures estimate: the share of hash functions on which they agree. */
export function estimateJaccard(a: Uint32Array, b: Uint32Array): number {
  let same = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same++;
  return same / a.length;
}

/** A text ready to compare with others: its signature, how many shingles it has, its numbers and its words. */
export interface TextSketch {
  signature: Uint32Array;
  size: number;
  numbers: string[];
  words: Set<string>;
}

/** Letters a word needs before it says what a text is about: "the", "on" and "new" say little. */
const CONTENT_WORD_CHARS = 4;

/**
 * The words that say what a text is about: those of CONTENT_WORD_CHARS letters or more, and each
 * pair of neighbouring characters in a script written without spaces. Numbers are left out: a new
 * figure is what a correction changes.
 */
export function contentWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const word of wordsOf(text)) {
    const chars = [...word.text];
    if (word.cjk) {
      if (chars.length === 1) out.add(word.text);
      for (let i = 0; i + 1 < chars.length; i++) out.add(chars[i]! + chars[i + 1]!);
    } else if (chars.length >= CONTENT_WORD_CHARS && !/^\p{N}+$/u.test(word.text)) out.add(word.text);
  }
  return out;
}

export function sketch(text: string): TextSketch {
  const set = shingles(text);
  return { signature: minhash(set), size: set.size, numbers: numbersOf(text), words: contentWords(text) };
}

export interface Likeness {
  /** The estimated Jaccard of their shingles. */
  jaccard: number;
  /**
   * The estimated share of the shorter text's shingles the longer one holds too: high when one
   * restates the other and adds to it, as a correction does ("the budget is 300" → "the budget went
   * from 300 to 350"). Taken from the Jaccard estimate and the two sizes.
   */
  overlap: number;
  /** They name different numbers: the same point with a new figure, never the same text twice. */
  numbersDiffer: boolean;
  /**
   * The share of the shorter text's content words the other holds too: what keeps two short points
   * that share only their framing ("… support … on 20 October") from reading as one. 0 when either
   * has none: numbers and short words alone never make two texts alike.
   */
  words: number;
  /** How many content words the two share. */
  sharedWords: number;
  /** How many content words the one with fewer has. */
  fewerWords: number;
}

/** Shingles the shorter text needs before its overlap counts: a title of two words is in everything. */
const OVERLAP_MIN_SHINGLES = 6;

export function textLikeness(a: TextSketch, b: TextSketch): Likeness {
  // A text of numbers and spaces alone has no shingle: it is like nothing, itself included.
  const j = a.size === 0 || b.size === 0 ? 0 : estimateJaccard(a.signature, b.signature);
  const small = Math.min(a.size, b.size);
  // |A ∩ B| = J (|A| + |B|) / (1 + J).
  const overlap = small >= OVERLAP_MIN_SHINGLES ? Math.min(1, (j * (a.size + b.size)) / (1 + j) / small) : j;
  const numbersDiffer = a.numbers.length !== b.numbers.length || a.numbers.some((n, i) => n !== b.numbers[i]);
  const fewerWords = Math.min(a.words.size, b.words.size);
  let sharedWords = 0;
  for (const w of a.words) if (b.words.has(w)) sharedWords++;
  const words = fewerWords === 0 ? 0 : sharedWords / fewerWords;
  return { jaccard: j, overlap, numbersDiffer, words, sharedWords, fewerWords };
}

/**
 * The thresholds, calibrated on the fixture in likeness.test.ts (corrections and updates of one
 * point, against other points of the same topic, in English and Chinese). Character shingles of a
 * correction score far below 0.8: on the fixture its estimated Jaccard runs 0.34–1 and an unrelated
 * point's 0–0.27, while the overlap, 0.59–1 against 0.46 at most, keeps them further apart; the
 * hint sits between the two.
 */
export const REPLACE_HINT_OVERLAP = 0.52;
/**
 * The share of content words a hint also needs. A correction shares 0.5–1 of them; two short points
 * of one meeting that share only their framing 0.4 at most, though their shingles overlap past 0.52.
 */
export const REPLACE_HINT_WORDS = 0.5;
/** Past this, with the same numbers, the two are very likely the same point written twice. */
export const LIKELY_DUPLICATE = 0.95;

/** Content words two texts must share, at least, before they are alike: one shared word is a coincidence. */
export const SHARED_WORDS_MIN = 2;

/** What a likeness says of a new point and an old sentence: null, a sentence it may replace, or very likely the same. */
export function replaceHint(l: Likeness): "possibly_replaces" | "likely_duplicate" | null {
  // Alike in their words, not in their numbers, dates or framing alone.
  if (l.sharedWords < Math.min(SHARED_WORDS_MIN, l.fewerWords) || l.fewerWords === 0) return null;
  if (!l.numbersDiffer && l.jaccard >= LIKELY_DUPLICATE) return "likely_duplicate";
  if (l.overlap >= REPLACE_HINT_OVERLAP && l.words >= REPLACE_HINT_WORDS) return "possibly_replaces";
  return null;
}
