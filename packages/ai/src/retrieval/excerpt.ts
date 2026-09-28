/**
 * What a judge reads of each candidate: the window of a long passage that holds the most of the
 * query's terms, so an answer past a section's opening is still seen. A term weighs less the more
 * candidates it appears in, so words every candidate shares count for little. Terms are words, and
 * character pairs in scripts written without spaces. A passage that fits is read whole; one where no
 * term matches is read from its start, and so is one whose start matches as well as any window.
 */

const WORD = /[\p{L}\p{N}\p{M}_]+/gu;
/** Scripts written without spaces between words: their terms are character pairs. */
const UNSPACED = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}\p{sc=Thai}\p{sc=Lao}\p{sc=Khmer}\p{sc=Myanmar}]/u;
/** Where a line or sentence ends, for opening a window on the next one. */
const BOUNDARIES = ["\n", ". ", "? ", "! ", "。", "？", "！"];

interface Term {
  term: string;
  /** Offset in the text, in UTF-16 code units. */
  at: number;
}

/** Lowercased words, and character pairs within runs of an unspaced script, in text order. */
export function termsOf(text: string): Term[] {
  const out: Term[] = [];
  for (const m of text.matchAll(WORD)) {
    const word = m[0];
    let run = "";
    let runAt = 0;
    let unspaced = false;
    const flush = () => {
      if (!run) return;
      if (unspaced) {
        const chars = Array.from(run);
        if (chars.length === 1) out.push({ term: run, at: runAt });
        for (let k = 0, at = runAt; k + 1 < chars.length; at += chars[k]!.length, k++) out.push({ term: chars[k]! + chars[k + 1]!, at });
      } else if (run.length > 1 || /\p{N}/u.test(run)) {
        out.push({ term: run.toLowerCase(), at: runAt });
      }
      run = "";
    };
    for (let k = 0; k < word.length; ) {
      const ch = String.fromCodePoint(word.codePointAt(k)!);
      const u = UNSPACED.test(ch);
      if (run && u !== unspaced) flush();
      if (!run) {
        runAt = m.index + k;
        unspaced = u;
      }
      run += ch;
      k += ch.length;
    }
    flush();
  }
  return out;
}

/** One excerpt of at most `chars` characters per text, in order; one that starts past its text's start opens with "…". */
export function excerpts(query: string, texts: string[], chars: number): string[] {
  const terms = texts.map(termsOf);
  const wanted = new Set(termsOf(query).map((t) => t.term));
  // Weighted by how many candidates hold the term, as BM25's IDF weighs it over a corpus.
  const weight = new Map<string, number>();
  for (const t of wanted) {
    const df = terms.filter((ts) => ts.some((x) => x.term === t)).length;
    if (df > 0) weight.set(t, Math.log(1 + (texts.length - df + 0.5) / (df + 0.5)));
  }
  return texts.map((text, i) => {
    if (text.length <= chars) return text.trim();
    const start = bestStart(text, terms[i]!.filter((t) => weight.has(t.term)), weight, chars);
    return start === 0 ? text.slice(0, chars).trim() : `… ${text.slice(start, start + chars).trim()}`;
  });
}

/** Where the best window of `chars` starts: the earliest of those holding the most weight. */
function bestStart(text: string, hits: Term[], weight: Map<string, number>, chars: number): number {
  const scoreAt = (start: number) => {
    const seen = new Set<string>();
    for (const h of hits) if (h.at >= start && h.at < start + chars) seen.add(h.term);
    return [...seen].reduce((s, t) => s + weight.get(t)!, 0);
  };
  // A best window can slide right until it starts on a term, so the text's start and each term's
  // are the only starts to try. Two pointers keep the terms inside the window as it slides.
  let best = { start: 0, score: scoreAt(0) };
  const inside = new Map<string, number>();
  let sum = 0;
  for (let a = 0, b = 0; a < hits.length; a++) {
    for (; b < hits.length && hits[b]!.at < hits[a]!.at + chars; b++) {
      const n = inside.get(hits[b]!.term) ?? 0;
      if (n === 0) sum += weight.get(hits[b]!.term)!;
      inside.set(hits[b]!.term, n + 1);
    }
    if (sum > best.score + 1e-9) best = { start: hits[a]!.at, score: sum };
    const n = inside.get(hits[a]!.term)!;
    if (n === 1) sum -= weight.get(hits[a]!.term)!;
    inside.set(hits[a]!.term, n - 1);
  }
  if (best.start === 0) return 0;
  // Open on the line or sentence the first term is in, when the window still holds every term.
  const back = Math.max(0, best.start - Math.floor(chars / 5));
  const lead = text.slice(back, best.start);
  const after = Math.max(...BOUNDARIES.map((p) => (lead.lastIndexOf(p) < 0 ? -1 : lead.lastIndexOf(p) + p.length)));
  if (after < 0 && back > 0) return best.start;
  const open = after < 0 ? 0 : back + after;
  return scoreAt(open) >= best.score - 1e-9 ? open : best.start;
}
