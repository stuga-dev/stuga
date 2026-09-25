/** How much text one version added and removed relative to the one before it. */
export interface CharChange {
  added: number;
  removed: number;
}

/**
 * Work cap for the LCS tables together, over lines and over the words inside
 * changed lines, in matrix cells (what the loops cost, plus one byte each for
 * the walk back). Past it a changed stretch counts as removed and re-added:
 * coarse, bounded and still length-consistent. 1M cells is roughly 15ms.
 */
const CHAR_CHANGE_MAX_CELLS = 1_000_000;

const MATCH = 0;
const SKIP_A = 1;
const SKIP_B = 2;
/** Skipping either token scores the same; each walk back takes its own side. */
const EITHER = 3;

/**
 * Word tokens: a run of letters, marks and digits, each CJK character on its
 * own, and every other character on its own, so a formatting mark or a space
 * matches alone and the tokens tile the text.
 */
const WORD =
  /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}]|(?:(?![\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}])[\p{L}\p{M}\p{N}])+|[\s\S]/gu;

/**
 * Characters gained and lost between two markdown states — the version list's
 * "+312 −45", computed from the same serializations the compare view diffs.
 *
 * Cheapest first: trim the common prefix/suffix (exact for one contiguous
 * edit); a middle empty on one side is a pure insert or delete (exact);
 * otherwise match the middle's unchanged lines with an LCS weighted by length,
 * then the unchanged words inside each run of unmatched lines the same way,
 * trimming what stays unmatched against its counterpart. That runs once on
 * the middle widened to whole lines and once on it as trimmed. The better
 * count wins, never more than the plain trim, and swapping the texts swaps
 * the counts. Lines end at "\n" only; a "\r" is text.
 */
export function charChangeCounts(base: string, next: string): CharChange {
  if (base === next) return { added: 0, removed: 0 };
  if (base === "") return { added: next.length, removed: 0 };
  if (next === "") return { added: 0, removed: base.length };

  // 1. common prefix / suffix, clamped so the two never overlap.
  const max = Math.min(base.length, next.length);
  let pre = 0;
  while (pre < max && base.charCodeAt(pre) === next.charCodeAt(pre)) pre++;
  let suf = 0;
  while (suf < max - pre && base.charCodeAt(base.length - 1 - suf) === next.charCodeAt(next.length - 1 - suf)) suf++;
  const trimmed = { added: next.length - pre - suf, removed: base.length - pre - suf };

  // 2. pure insert / pure delete.
  if (trimmed.added === 0 || trimmed.removed === 0) return trimmed;

  // 3. line-aligned middle, twice: widened to whole lines, since a trim that
  // cuts into a line leaves it unequal to its untouched twin, and as trimmed,
  // where a line a join glued to its neighbour can match whole. Each middle
  // ends in "\n", appended to both sides where the text has none.
  const widePre = pre > 0 ? base.lastIndexOf("\n", pre - 1) + 1 : 0;
  let wideSuf = 0;
  if (suf > 0) {
    const nl = base.indexOf("\n", base.length - suf);
    wideSuf = nl === -1 ? 0 : base.length - 1 - nl;
  }
  const end = wideSuf === 0 ? "\n" : "";
  const wideA = base.slice(widePre, base.length - wideSuf) + end;
  const wideB = next.slice(widePre, next.length - wideSuf) + end;
  const budget = { cells: CHAR_CHANGE_MAX_CELLS };
  let removed = Math.min(trimmed.removed, wideA.length - lineCommon(wideA, wideB, budget));
  const midA = base.slice(pre, base.length - suf) + "\n";
  if (midA !== wideA) {
    const midB = next.slice(pre, next.length - suf) + "\n";
    removed = Math.min(removed, midA.length - lineCommon(midA, midB, budget));
  }
  return { added: removed + next.length - base.length, removed };
}

/** Tokens that tile a stretch of text: each one's content, start and end. */
interface Tokens {
  keys: string[];
  start: ArrayLike<number>;
  end: ArrayLike<number>;
}

/**
 * Characters two texts ending in "\n" share: unchanged lines match whole, and
 * each run of unmatched lines keeps its common start and end with its
 * counterpart plus the words the two share between those.
 */
function lineCommon(midA: string, midB: string, budget: { cells: number }): number {
  const a = midA.split("\n");
  const b = midB.split("\n");
  a.pop();
  b.pop();
  const offA = lineStarts(a);
  const offB = lineStarts(b);
  return tokenCommon(
    { keys: a, start: offA, end: offA.subarray(1) },
    0,
    midA.length,
    { keys: b, start: offB, end: offB.subarray(1) },
    0,
    midB.length,
    budget,
    (aLo, aHi, bLo, bHi, own) =>
      runCommon(midA, aLo, aHi, midB, bLo, bHi, (x0, x1, y0, y1) => wordCommon(midA, x0, x1, midB, y0, y1, own)),
  );
}

/**
 * Characters a[aLo..aHi) and b[bLo..bHi) share by words, each run of unmatched
 * words trimmed against its counterpart. A side whose words all appear in
 * order in the other's is kept whole without a table: formatting added or
 * removed, words inserted. Otherwise 0 when the table does not fit what
 * `budget` has left.
 */
function wordCommon(
  a: string,
  aLo: number,
  aHi: number,
  b: string,
  bLo: number,
  bHi: number,
  budget: { cells: number },
): number {
  const wa = words(a, aLo, aHi);
  const wb = words(b, bLo, bHi);
  if (within(wa.keys, wb.keys)) return aHi - aLo;
  if (within(wb.keys, wa.keys)) return bHi - bLo;
  return tokenCommon(wa, aLo, aHi, wb, bLo, bHi, budget, (x0, x1, y0, y1) => runCommon(a, x0, x1, b, y0, y1));
}

/** The word tokens of text[lo..hi). */
function words(text: string, lo: number, hi: number): Tokens {
  const keys: string[] = [];
  const start: number[] = [];
  const end: number[] = [];
  const part = text.slice(lo, hi);
  WORD.lastIndex = 0;
  for (let w = WORD.exec(part); w !== null; w = WORD.exec(part)) {
    keys.push(w[0]);
    start.push(lo + w.index);
    end.push(lo + w.index + w[0].length);
  }
  return { keys, start, end };
}

/** Whether `inner` is a subsequence of `outer`. */
function within(inner: string[], outer: string[]): boolean {
  if (inner.length > outer.length) return false;
  let i = 0;
  for (let j = 0; j < outer.length && i < inner.length; j++) if (inner[i] === outer[j]) i++;
  return i === inner.length;
}

/**
 * Characters two tiled stretches share: an LCS weighted by length matches
 * unchanged tokens whole, and `gap` scores each stretch of unmatched tokens
 * between two matches. LCS ties are walked back both ways and the better
 * kept; each walk gets half of what `budget` has left for its gaps, or all of
 * it when both walks find the same gaps, so the texts' order never changes
 * what fits. 0 when the table does not fit.
 */
function tokenCommon(
  ta: Tokens,
  aLo: number,
  aHi: number,
  tb: Tokens,
  bLo: number,
  bHi: number,
  budget: { cells: number },
  gap: (aLo: number, aHi: number, bLo: number, bHi: number, own: { cells: number }) => number,
): number {
  const n = ta.keys.length;
  const m = tb.keys.length;
  if (n * m > budget.cells) return 0;
  budget.cells -= n * m;

  // dp[j] = characters in matched tokens between ta[0..i) and tb[0..j), a
  // token worth the text it spans (a line's newline included).
  const prev = new Int32Array(m + 1);
  const cur = new Int32Array(m + 1);
  const step = new Uint8Array(n * m);
  for (let i = 1; i <= n; i++) {
    const key = ta.keys[i - 1]!;
    const weight = ta.end[i - 1]! - ta.start[i - 1]!;
    const row = (i - 1) * m - 1;
    for (let j = 1; j <= m; j++) {
      if (key === tb.keys[j - 1]) {
        cur[j] = prev[j - 1]! + weight;
        step[row + j] = MATCH;
      } else if (prev[j]! > cur[j - 1]!) {
        cur[j] = prev[j]!;
        step[row + j] = SKIP_A;
      } else if (prev[j]! < cur[j - 1]!) {
        cur[j] = cur[j - 1]!;
        step[row + j] = SKIP_B;
      } else {
        cur[j] = prev[j]!;
        step[row + j] = EITHER;
      }
    }
    prev.set(cur);
  }
  const matched = prev[m]!;

  // Walk back: the stretches between matches, as [aLo, aHi, bLo, bHi] runs.
  const walk = (tie: number): number[] => {
    const gaps: number[] = [];
    let i = n;
    let j = m;
    let hiA = aHi;
    let hiB = bHi;
    while (i > 0 && j > 0) {
      let s = step[(i - 1) * m + j - 1];
      if (s === EITHER) s = tie;
      if (s === MATCH) {
        i--;
        j--;
        gaps.push(ta.end[i]!, hiA, tb.end[j]!, hiB);
        hiA = ta.start[i]!;
        hiB = tb.start[j]!;
      } else if (s === SKIP_A) {
        i--;
      } else {
        j--;
      }
    }
    gaps.push(aLo, hiA, bLo, hiB);
    return gaps;
  };
  const one = walk(SKIP_A);
  const two = walk(SKIP_B);
  const same = one.length === two.length && one.every((v, k) => v === two[k]);
  const share = same ? budget.cells : Math.floor(budget.cells / 2);
  let used = 0;
  const score = (gaps: number[]): number => {
    const own = { cells: share };
    let common = matched;
    for (let k = 0; k < gaps.length; k += 4) common += gap(gaps[k]!, gaps[k + 1]!, gaps[k + 2]!, gaps[k + 3]!, own);
    used += share - own.cells;
    return common;
  };
  const best = same ? score(one) : Math.max(score(one), score(two));
  budget.cells -= used;
  return best;
}

/** Offset of each line in the text they were split from, plus the end. */
function lineStarts(lines: string[]): Int32Array {
  const starts = new Int32Array(lines.length + 1);
  for (let k = 0; k < lines.length; k++) starts[k + 1] = starts[k]! + lines[k]!.length + 1;
  return starts;
}

/**
 * Common prefix plus common suffix of a[aLo..aHi) and b[bLo..bHi), never
 * overlapping, plus what `inner` finds in what is left between them.
 */
function runCommon(
  a: string,
  aLo: number,
  aHi: number,
  b: string,
  bLo: number,
  bHi: number,
  inner?: (aLo: number, aHi: number, bLo: number, bHi: number) => number,
): number {
  const len = Math.min(aHi - aLo, bHi - bLo);
  let p = 0;
  while (p < len && a.charCodeAt(aLo + p) === b.charCodeAt(bLo + p)) p++;
  let s = 0;
  while (s < len - p && a.charCodeAt(aHi - 1 - s) === b.charCodeAt(bHi - 1 - s)) s++;
  if (inner === undefined || p + s === len) return p + s;
  return p + s + inner(aLo + p, aHi - s, bLo + p, bHi - s);
}
