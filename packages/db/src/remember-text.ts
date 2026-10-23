/**
 * What Save to Stuga reads in a passage beside where a point could go: whether the point is written
 * there already, and which sentences there the point may make untrue. Plain computation over the
 * Markdown search found, so nothing here reaches past what the caller could search.
 *
 * "Already there" is decided sentence by sentence: a sentence holds the point's words in their
 * order, normalised as search normalises text (NFKC, traditional Chinese as simplified, lower case),
 * with every mark of punctuation or Markdown left out and a link read as its text; and it states
 * them: it asks no question, and denies nothing the point does not ("no longer", "nicht", "不").
 * Struck-through text (~~…~~, <del>, <s>) is read as gone. A sentence a point may replace is one
 * `textLikeness` finds alike (likeness.ts): the same point with a new figure, or a rule restated with
 * a change; one that says what the point says, in other words or as part of it, is a likely duplicate.
 */
import { REPLACE_HINT_OVERLAP, contentWords, numbersOf, replaceHint, sketch, textLikeness, type TextSketch } from "./likeness.js";
import { normalizeText } from "./search-text.js";

const WORD = /[\p{L}\p{N}\p{M}]+/gu;
/** Scripts written without spaces between words: a match inside a run of them needs no word boundary. */
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
/** A Markdown link's or image's target, which a reader never sees. */
const LINK_TARGET = /\]\([^)\n]*\)/g;
/** A space beside a character of an unspaced script, which writers put in or leave out ("每人 300 元", "每人300元"). */
const SPACE_BY_UNSPACED =
  /(?<=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]) | (?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}])/gu;

/** A text as "already there" compares it: its words in order, one space apart, none beside an unspaced script. */
export function comparableText(text: string): string {
  return (normalizeText(text.replace(LINK_TARGET, "]")).match(WORD) ?? []).join(" ").replace(SPACE_BY_UNSPACED, "");
}

/**
 * The sentences of `text` that say the point: for each sentence of the point, one that holds its
 * words in their order and states them (see above). Null when a sentence of the point has none, or
 * the point has no words: numbers and dates alone say nothing.
 */
export function savedSentences(text: string, point: string): string[] | null {
  const wanted = claimsOf(point)
    .map((c) => ({ said: c.said, comparable: comparableText(c.said) }))
    .filter((w) => LETTER.test(w.comparable));
  if (wanted.length === 0) return null;
  const claims = claimsOf(text).map((c) => ({ ...c, comparable: comparableText(c.said) }));
  const found: string[] = [];
  for (const w of wanted) {
    const hit = claims.find((c) => holdsComparable(c.comparable, w.comparable) && states(c.said, w.said));
    if (!hit) return null;
    if (!found.includes(hit.sentence)) found.push(hit.sentence);
  }
  return found;
}

/** Whether `text` says the point already: see savedSentences. */
export function holdsPoint(text: string, point: string): boolean {
  return savedSentences(text, point) !== null;
}

/** Whether a comparable text holds another, standing as words: at a space, or anywhere in a script without spaces. */
export function holdsComparable(haystack: string, wanted: string): boolean {
  const first = wanted[0]!;
  const last = wanted[wanted.length - 1]!;
  for (let at = haystack.indexOf(wanted); at !== -1; at = haystack.indexOf(wanted, at + 1)) {
    const end = at + wanted.length;
    const starts = at === 0 || haystack[at - 1] === " " || UNSPACED.test(first);
    const ends = end === haystack.length || haystack[end] === " " || UNSPACED.test(last);
    if (starts && ends) return true;
  }
  return false;
}

const HEADING = /^\s{0,3}#{1,6}\s/;
const FENCE = /^\s*(?:`{3,}|~{3,})/;
/** A list item's, a quote's or a task's marker, which is not part of the sentence. */
const LINE_MARKER = /^\s*(?:>\s?)*(?:(?:[-+*]|\d+[.)])\s+)?(?:\[[ xX]\]\s+)?/;
/** Where one sentence ends and the next begins: after . ! ? and a space, or after a CJK full stop. */
const SENTENCE_END = /(?<=[.!?])\s+(?=\S)|(?<=[。！？])/gu;
/** Struck-through text, which a reader takes as no longer true. */
const STRUCK = /~~(?=\S)[^~\n]*?~~|<(del|s|strike)\b[^>]*>[^\n]*?<\/\1\s*>/giu;
const LETTER = /\p{L}/u;
/** What struck-through text is blanked with: a private-use character no text holds, one UTF-16 unit. */
const STRUCK_MARK = "\uE000";
/** A word or mark that denies: a sentence with more of them than the point says the opposite. */
const NEGATION =
  /(?<![\p{L}\p{N}])(?:not|no|never|cannot|none|nobody|nothing|nicht|kein\p{L}*|nie|niemals|pas|jamais|nunca|jamás|ningun\p{L}*|não|nenhum\p{L}*)(?![\p{L}\p{N}])|n['’]t(?!\p{L})|不|没|沒|ません|않|없|못/giu;
const QUESTION = /[?？]/u;

/** Characters a sentence needs before it is compared: shorter is a label, not a claim. */
const SENTENCE_MIN_CHARS = 8;
/** Characters a sentence may have and still be handed back to quote: longer is a paragraph with no stops. */
const SENTENCE_MAX_CHARS = 600;

/** A sentence as written, to quote in an edit, and what it says with struck-through text left out. */
interface Claim {
  sentence: string;
  said: string;
}

/** Every sentence of a Markdown text, as written and as said: no heading, code or list marker among them. */
function claimsOf(markdown: string): Claim[] {
  const out: Claim[] = [];
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || HEADING.test(line)) continue;
    const body = line.replace(LINE_MARKER, "").trim();
    // Struck-through text blanked in a copy of the same length, so a sentence's place holds in both.
    const blank = body.replace(STRUCK, (m) => STRUCK_MARK.repeat(m.length));
    let start = 0;
    const push = (end: number) => {
      const sentence = body.slice(start, end).trim();
      const said = blank.slice(start, end).replaceAll(STRUCK_MARK, " ").replace(/\s+/g, " ").trim();
      if (sentence !== "" && said !== "") out.push({ sentence, said });
    };
    for (const m of body.matchAll(SENTENCE_END)) {
      push(m.index);
      start = m.index + m[0].length;
    }
    push(body.length);
  }
  return out;
}

/** The claims compared with a point: long enough to be one, short enough to quote. */
function comparedClaims(markdown: string): Claim[] {
  return claimsOf(markdown).filter((c) => c.said.length >= SENTENCE_MIN_CHARS && c.sentence.length <= SENTENCE_MAX_CHARS);
}

/** The sentences of a passage's Markdown, as written: no heading, code or list marker among them, nor one wholly struck through. */
export function sentencesOf(markdown: string): string[] {
  return comparedClaims(markdown).map((c) => c.sentence);
}

function negations(text: string): number {
  return text.match(NEGATION)?.length ?? 0;
}

/** Whether a sentence states what `point` states: no question, and no denial the point does not make. */
function states(said: string, point: string): boolean {
  return !QUESTION.test(said) && negations(said) <= negations(point);
}

/** A date, which says when rather than how much: a reworded duplicate is told by its other figures. */
const DATE =
  /\d{4}\s*[-/.年]\s*\d{1,2}(?:\s*[-/.月]\s*\d{1,2}\s*日?)?|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}|\d{1,2}\s*月\s*\d{1,2}\s*日?|\d{1,2}\s*日|(?<!\d)(?:19|20)\d{2}(?!\d)/gu;

/** The figures of a text other than its dates, each once. */
function figuresOf(text: string): string[] {
  return [...new Set(numbersOf(text.normalize("NFKC").replace(DATE, " ")))];
}

function sameFigures(a: string[], b: string[]): boolean {
  return a.length > 0 && a.length === b.length && a.every((n, i) => n === b[i]);
}

export interface AlikeSentence {
  /** The sentence as the passage has it, to quote in an edit. */
  sentence: string;
  /** `likely_duplicate`: it says what the point says; `possibly_replaces`: the point may make it untrue. */
  hint: "possibly_replaces" | "likely_duplicate";
  /** How much of the shorter of the two the other holds, 0 to 1: the order hints are listed in. */
  overlap: number;
}

/** Sketches kept for one call, so a passage several points find is read once. */
export type SketchCache = Map<string, TextSketch>;

function sketchOf(text: string, cache?: SketchCache): TextSketch {
  const kept = cache?.get(text);
  if (kept) return kept;
  const made = sketch(text);
  cache?.set(text, made);
  return made;
}

/**
 * The sentences of `markdown` alike enough to the point to name, most alike first. A sentence the
 * point holds word for word, or one with the same figures in other words, is a likely duplicate when
 * it states what the point states; a question or a denial is one the point may make untrue.
 */
export function alikeSentences(point: string, markdown: string, cache?: SketchCache): AlikeSentence[] {
  const mine = sketchOf(point, cache);
  const wanted = comparableText(point);
  const figures = figuresOf(point);
  const out: AlikeSentence[] = [];
  for (const { sentence, said } of comparedClaims(markdown)) {
    const likeness = textLikeness(mine, sketchOf(said, cache));
    const says = states(said, point);
    const comparable = comparableText(said);
    // A sentence the point repeats word for word says what the point says, whatever else the point adds.
    const repeated = says && LETTER.test(comparable) && holdsComparable(wanted, comparable);
    let hint = repeated ? "likely_duplicate" : replaceHint(likeness);
    if (hint === "likely_duplicate" && !says) hint = "possibly_replaces";
    // The same figures, a word of the point and most of its letters: very likely the point in other words.
    const reworded =
      says && likeness.sharedWords >= 1 && likeness.overlap >= REPLACE_HINT_OVERLAP && sameFigures(figures, figuresOf(said));
    if (hint !== "likely_duplicate" && reworded) hint = "likely_duplicate";
    if (hint) out.push({ sentence, hint, overlap: likeness.overlap });
  }
  return out.sort((a, b) => b.overlap - a.overlap);
}

/** Letters two words share at the start, at least, before one counts as the other with another ending. */
const SHARED_STEM_CHARS = 4;

/** Letters two words have in common at the start. */
function commonStart(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/**
 * Whether two words are one with another ending: the shorter is the start of the other ("refund",
 * "refunds"), or they part only at the shorter's last letter ("policy", "policies"), with at least
 * SHARED_STEM_CHARS in common.
 */
export function sameStem(a: string, b: string): boolean {
  const shorter = Math.min(a.length, b.length);
  const common = commonStart(a, b);
  return common >= SHARED_STEM_CHARS && common >= shorter - 1;
}

/**
 * The point's words the passage holds too, to say why it fits: the same word, or, unless `exact`, the
 * same with another ending (sameStem); a pair of characters in a script without spaces. At most `max`,
 * in the point's order, as search normalises them.
 */
export function sharedWords(point: string, passage: string, max = 6, exact = false): string[] {
  const theirs = [...contentWords(normalizeText(passage))];
  const held = new Set(theirs);
  const out: string[] = [];
  for (const word of contentWords(normalizeText(point))) {
    if (out.length >= max) break;
    if (held.has(word) || (!exact && theirs.some((other) => sameStem(word, other)))) out.push(word);
  }
  return out;
}

/** `words` with each one sharing a stem with an earlier one left out: "accounts" and "account" are one word. */
export function distinctWords(words: Iterable<string>): string[] {
  const out: string[] = [];
  for (const word of words) if (!out.some((w) => w === word || sameStem(w, word))) out.push(word);
  return out;
}

/** The content words of a text as `sharedWords` compares them: what a stopword check is asked about. */
export function wordsOfPoint(text: string): string[] {
  return [...contentWords(normalizeText(text))];
}

/** An email or web address: where to send something, which says nothing of what a point is about. */
const ADDRESS = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+|\b(?:https?:\/\/|www\.)[^\s)>\]]*[^\s)>\].,;:!?'"]/gu;

/** `text` without its email and web addresses: "ap@globex.example" is no reason to name the page holding "example". */
export function withoutAddresses(text: string): string {
  return text.replace(ADDRESS, " ");
}

/** Whether a passage is headings alone, with no text of its own to cite or to fit a point. */
export function headingsOnly(markdown: string): boolean {
  return markdown.split("\n").every((line) => line.trim() === "" || HEADING.test(line));
}

/** The level of a passage's opening heading line, or null when it opens with text. */
export function openingHeadingLevel(markdown: string): number | null {
  const first = markdown.split("\n").find((line) => line.trim() !== "");
  const m = first === undefined ? null : /^\s{0,3}(#{1,6})\s/.exec(first);
  return m ? m[1]!.length : null;
}

/** Names of months and days, which English writes capitalised though they name no one. */
const CALENDAR = new Set(
  (
    "january february march april may june july august september october november december " +
    "jan feb mar apr jun jul aug sep sept oct nov dec " +
    "monday tuesday wednesday thursday friday saturday sunday mon tue tues wed thu thur thurs fri sat sun"
  ).split(" "),
);

const NAME_WORD = /[\p{L}\p{M}][\p{L}\p{M}\p{N}]*(?:['’]s\b)?/gu;

/**
 * The proper nouns of a text, lower-cased: a capitalised word that does not open its sentence, and
 * one with a possessive ("Acme's") anywhere. Months and days are left out, and so is a word written
 * in capitals alone when it opens a sentence. Scripts without capitals have none.
 */
export function properNouns(text: string): Set<string> {
  const out = new Set<string>();
  for (const { said } of claimsOf(text)) {
    let first = true;
    for (const m of said.matchAll(NAME_WORD)) {
      const possessive = /['’]s$/u.test(m[0]);
      const word = possessive ? m[0].slice(0, -2) : m[0];
      const opens = first;
      first = false;
      if ([...word].length < 2 || !/^\p{Lu}/u.test(word)) continue;
      if (opens && !possessive) continue;
      const folded = word.normalize("NFKC").toLowerCase();
      if (!CALENDAR.has(folded)) out.add(folded);
    }
  }
  return out;
}

/** The possessive proper nouns of a text alone ("Acme's", "Globex’s"), lower-cased: whose a sentence is. */
export function possessiveNames(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(NAME_WORD)) {
    if (!/['’]s$/u.test(m[0])) continue;
    const word = m[0].slice(0, -2);
    if ([...word].length >= 2 && /^\p{Lu}/u.test(word)) out.add(word.normalize("NFKC").toLowerCase());
  }
  return out;
}

/** A title's words: its runs of letters, each of two characters or more, as search normalises them. */
function titleWords(title: string): string[] {
  return (normalizeText(title).match(WORD) ?? []).filter((w) => [...w].length >= 2 || UNSPACED.test(w));
}

/**
 * Whether `text` names a page titled `title`: it holds every word of the title, the same or with
 * another ending, or, in a script without spaces, the title's text itself. A title of no words is
 * named by nothing.
 */
export function namesTitle(text: string, title: string): boolean {
  const wanted = titleWords(title);
  if (wanted.length === 0) return false;
  const plain = normalizeText(text);
  const words = plain.match(WORD) ?? [];
  const compact = comparableText(text);
  return wanted.every((w) =>
    UNSPACED.test(w) ? compact.includes(comparableText(w)) : words.some((x) => x === w || (w.length >= SHARED_STEM_CHARS && sameStem(w, x))),
  );
}

/**
 * Whether a page's title reads as a name in these texts ("Initech", "Acme"), not as a word ("Refunds",
 * "Travel"): its first word is written with its capital wherever it appears in them, in any form
 * (itself, or with another ending), and appears at least once; never in lower case. A title in a
 * script without capitals never does.
 */
export function readsAsName(title: string, texts: readonly string[]): boolean {
  const first = title.normalize("NFKC").match(/[\p{L}\p{M}]+/u)?.[0];
  if (!first || !/^\p{Lu}/u.test(first)) return false;
  const wanted = first.toLowerCase();
  let seen = false;
  for (const text of texts) {
    for (const m of text.normalize("NFKC").matchAll(/[\p{L}\p{M}]+/gu)) {
      const word = m[0];
      const folded = word.toLowerCase();
      if (folded !== wanted && !(Math.min(folded.length, wanted.length) >= SHARED_STEM_CHARS && sameStem(folded, wanted))) continue;
      if (!/^\p{Lu}/u.test(word)) return false;
      seen = true;
    }
  }
  return seen;
}
