/**
 * What Save to Stuga and Ask Stuga read in a table's rows: whether a point names a row, by the value its
 * title cell holds ("Initech"), or a column, by its name ("refund window") or a choice it offers ("Pro");
 * whether it says what a cell holds already; and which words of a question a row's cells hold. Plain
 * computation over text as search normalises it (NFKC, traditional Chinese as simplified, lower case), so
 * "INITECH", "Ｉｎｉｔｅｃｈ" and "initech" are one name, and 環球 is 环球.
 */
import { comparableText, holdsComparable, namesTitle, properNouns, sameStem } from "./remember-text.js";
import { normalizeText } from "./search-text.js";

const LETTER = /\p{L}/u;
const WORD = /[\p{L}\p{N}\p{M}]+/gu;
/** Scripts written without spaces: a word of them is read as its pairs of characters, as search reads it. */
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
/** Characters a name needs before a point names it: one letter ("A") is in every sentence. */
const NAME_MIN_CHARS = 2;
/** Letters two words share before one counts as the other with another ending, as sharedWords counts them. */
const STEM_MIN_CHARS = 4;
/** Digits a number needs before a question's word it is: "2" or "30" says little, "00777" names an order. */
const NUMBER_MIN_DIGITS = 3;

/**
 * Whether `text` holds `value` as written: its words, in order, standing as words (anywhere in a script
 * without spaces). A value with no letter (a number, a date) is held only when `numbers` says so.
 */
export function holdsValue(text: string, value: string, opts: { numbers?: boolean } = {}): boolean {
  const wanted = comparableText(value);
  if (wanted === "" || (!opts.numbers && !LETTER.test(wanted))) return false;
  return holdsComparable(comparableText(text), wanted);
}

/** Whether a point names the row a title cell holds: its value, as written, of two characters or more and a letter. */
export function namesRow(text: string, title: string): boolean {
  return [...comparableText(title)].length >= NAME_MIN_CHARS && holdsValue(text, title);
}

/**
 * Words that, just before a value, say it is not what holds now: "not Pro", "no longer Bo Chen",
 * "from Pro to Team", "instead of Pro"; and in a script without spaces, 不, 没 or 非 among the three
 * characters before it.
 */
const DENIES = new Set(
  (
    "not no never longer instead rather formerly previously former from replaces replaced replacing " +
    "nicht kein keine keinen nie statt anstatt früher vorher bisher pas jamais ancien ancienne " +
    "nunca antes anterior não nem antigo antiga"
  ).split(" "),
);
/** A denial within the three characters before it: 不是, 并非, 没有, 不再是. */
/** Words that may stand between a denial and what it denies: "instead of the", "no longer". */
const BETWEEN = new Set("the a an of than be is was being been der die das den dem des le la les el los las o os um uma un une ein eine einen".split(" "));
const DENIES_UNSPACED = /(?:[不没沒非无無]\p{Script=Han}{0,2}|以前)$/u;

/** Whether what stands at `at` of a comparable text is denied by the words just before it. */
function deniedAt(comparable: string, at: number): boolean {
  const before = comparable.slice(0, at);
  if (DENIES_UNSPACED.test(before.trimEnd())) return true;
  // Back from it, over the words that may stand between, to a denial or any other word.
  for (const w of before.trim().split(" ").reverse().slice(0, 3)) {
    if (DENIES.has(w)) return true;
    if (!BETWEEN.has(w)) return false;
  }
  return false;
}

/** Whether `comparable` holds `wanted` as words somewhere no word just before it denies it. */
function holdsUndenied(comparable: string, wanted: string): boolean {
  for (let at = comparable.indexOf(wanted); at !== -1; at = comparable.indexOf(wanted, at + 1)) {
    const end = at + wanted.length;
    const startsWord = at === 0 || comparable[at - 1] === " " || UNSPACED.test(wanted[0]!);
    const endsWord = end === comparable.length || comparable[end] === " " || UNSPACED.test(wanted[wanted.length - 1]!);
    if (startsWord && endsWord && !deniedAt(comparable, at)) return true;
  }
  return false;
}

/** A comparable value with numbers in it as a pattern any number fills: "14 days" finds "30 days". */
function numberShape(comparable: string): RegExp | null {
  if (!/\p{N}/u.test(comparable)) return null;
  const source = comparable
    .split(/(\p{N}+)/u)
    .map((part, i) => (i % 2 === 1 ? "\\p{N}+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`(?<![\\p{N}\\p{Script=Latin}])${source}(?![\\p{N}\\p{Script=Latin}])`, "gu");
}

/**
 * Whether a point says what a cell holds: its value as written, a number or a date too ("30" in "30 days"),
 * and not as what no longer holds ("not Bo Chen", "from 14 days to 30 days" says 30 days, not 14).
 */
export function saysCell(text: string, cell: string): boolean {
  const wanted = comparableText(cell);
  if (wanted === "") return false;
  return holdsUndenied(comparableText(text), wanted);
}

/**
 * Whether a point says that a cell holds what it holds now: it says the value (saysCell), and nothing in it
 * says another for the same cell. A value with a number is said when the first value of its shape the point
 * holds undenied is it ("30 days. It was 14 days before" says 30 days, not 14); any other, when the point names
 * nobody but the value and its row, its column or its table ("Ana Ruiz is Initech's contact; Bo Chen left"
 * says nothing for sure of Bo Chen). In doubt, a cell is not said: the caller compares it, which a cell said
 * wrongly would skip.
 */
export function cellSaid(text: string, cell: string, context: readonly string[] = []): boolean {
  const said = comparableText(text);
  const wanted = comparableText(cell);
  if (wanted === "" || !holdsUndenied(said, wanted)) return false;
  const shape = numberShape(wanted);
  if (shape) {
    for (const m of said.matchAll(shape)) if (!deniedAt(said, m.index)) return m[0] === wanted;
    return false;
  }
  const own = new Set([cell, ...context].flatMap((t) => questionWords(t)));
  return [...properNouns(text)].every((w) => questionWords(w).every((x) => own.has(x)));
}

/** Whether a point names a column: every word of its name, the same or with another ending ("Refund windows", "plans"). */
export function namesColumn(text: string, display: string): boolean {
  return namesTitle(text, display);
}

/**
 * The choices of a single-select column a point names as written ("the Pro plan"), a choice another named one
 * holds left out ("Pro" in "Pro Plus").
 */
export function namedChoices(text: string, choices: readonly string[]): string[] {
  return longestNames(choices.filter((c) => [...comparableText(c)].length >= NAME_MIN_CHARS && holdsValue(text, c)));
}

/** The one choice a point says a single-select column holds: named, and not denied ("Team, not Pro"); null for none or several. */
export function namedChoice(text: string, choices: readonly string[]): string | null {
  const said = namedChoices(text, choices).filter((c) => saysCell(text, c));
  return said.length === 1 ? said[0]! : null;
}

/**
 * Of the titles a point names, those no longer one holds: "Initech Labs" names "Initech" too, and the point
 * is about the one it names whole.
 */
export function longestNames(titles: readonly string[]): string[] {
  const keyed = titles.map((t) => ({ t, c: comparableText(t) }));
  return keyed.filter((a) => !keyed.some((b) => b.c !== a.c && b.c.length > a.c.length && holdsComparable(b.c, a.c))).map((a) => a.t);
}

/**
 * A question's words as rows are matched by, as search normalises them, each once: words of two letters or
 * more, numbers of three digits or more, and in a script without spaces each pair of neighbouring
 * characters (a lone one standing alone). Stopwords are the caller's to leave out: search names them.
 */
export function questionWords(text: string): string[] {
  const out = new Set<string>();
  for (const run of normalizeText(text).match(WORD) ?? []) {
    let word = "";
    let unspaced = false;
    const flush = () => {
      const chars = [...word];
      if (unspaced) {
        if (chars.length === 1) out.add(word);
        for (let i = 0; i + 1 < chars.length; i++) out.add(chars[i]! + chars[i + 1]!);
      } else if (/^\p{N}+$/u.test(word) ? chars.length >= NUMBER_MIN_DIGITS : chars.length >= NAME_MIN_CHARS) {
        out.add(word);
      }
      word = "";
    };
    for (const char of run) {
      const isUnspaced = UNSPACED.test(char);
      if (word !== "" && isUnspaced !== unspaced) flush();
      word += char;
      unspaced = isUnspaced;
    }
    if (word !== "") flush();
  }
  return [...out];
}

/** Of `words` (questionWords), those a cell holds: the same word, or with another ending when both have STEM_MIN_CHARS letters. */
export function wordsInCell(words: readonly string[], cell: string): string[] {
  const theirs = new Set(questionWords(cell));
  return words.filter(
    (w) =>
      theirs.has(w) ||
      (!UNSPACED.test(w) && w.length >= STEM_MIN_CHARS && [...theirs].some((x) => !UNSPACED.test(x) && x.length >= STEM_MIN_CHARS && sameStem(w, x))),
  );
}
