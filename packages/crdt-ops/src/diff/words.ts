/**
 * Word-level diff for the intra-block preview (`~~brown~~ red`): an LCS over
 * whitespace-delimited tokens that keeps the spacing between them. Presentation
 * only; a coarse result never changes what is committed.
 */
export type WordOp = { type: "eq" | "del" | "ins"; text: string };

/** Per-side token cap for the O(n·m) LCS; beyond it the changed middle is one del + one ins, so the table stays ≤ ~2.25M cells. */
const WORD_DIFF_MAX_TOKENS = 1500;

/**
 * Below this share of the changed middle's words kept, the middle reads as a rewrite: one del + one
 * ins. Interleaving a few shared words ("~~Delivery~~ The ~~is~~ Supplier…") is unreadable.
 */
const REWRITE_BELOW_SHARED = 1 / 3;

/**
 * A fragmented diff (many changed runs, or one every few words) reads as a rewrite while fewer than
 * this share of the block's words stay: a translation or a rephrase keeps names and small words, and
 * striking around them leaves "~~Wednesday:~~Onsdag: Ben ~~opens,~~öppnar".
 */
const FRAGMENTED_REWRITE_BELOW_SHARED = 0.65;
const FRAGMENTED_RUNS = 3;
/** One changed run per this many words or fewer counts as fragmented. */
const FRAGMENTED_WORDS_PER_RUN = 5;

/** Split into tokens that alternate non-space / space runs, so joining round-trips. */
function tokenize(s: string): string[] {
  return s.match(/\s+|\S+/g) ?? [];
}

const isSpace = (t: string) => !/\S/.test(t);
const wordCount = (ts: readonly string[]) => ts.filter((t) => !isSpace(t)).length;

type Run = { type: "eq"; text: string } | { type: "change"; del: string; ins: string };

/**
 * Token ops grouped into equal runs and changed runs (each one deletion then one insertion). A space
 * kept between two changes joins them, so the words of one rephrased stretch are struck together and
 * the new words follow, instead of alternating word by word.
 */
function groupRuns(ops: readonly WordOp[]): Run[] {
  const runs: Run[] = [];
  const change = (): Extract<Run, { type: "change" }> => {
    const last = runs[runs.length - 1];
    if (last?.type === "change") return last;
    const fresh: Run = { type: "change", del: "", ins: "" };
    runs.push(fresh);
    return fresh;
  };
  ops.forEach((op, i) => {
    if (op.type === "del") change().del += op.text;
    else if (op.type === "ins") change().ins += op.text;
    else if (isSpace(op.text) && runs[runs.length - 1]?.type === "change" && ops[i + 1] && ops[i + 1]!.type !== "eq") {
      const c = change();
      c.del += op.text;
      c.ins += op.text;
    } else {
      const last = runs[runs.length - 1];
      if (last?.type === "eq") last.text += op.text;
      else runs.push({ type: "eq", text: op.text });
    }
  });
  return runs;
}

export function wordDiff(oldText: string, newText: string): WordOp[] {
  const a = tokenize(oldText);
  const b = tokenize(newText);

  // The LCS runs over the changed middle only.
  const ops: WordOp[] = [];
  const push = (type: WordOp["type"], text: string) => {
    if (!text) return;
    const last = ops[ops.length - 1];
    if (last && last.type === type) last.text += text;
    else ops.push({ type, text });
  };

  let lo = 0;
  const maxPre = Math.min(a.length, b.length);
  while (lo < maxPre && a[lo] === b[lo]) lo++;
  let hiA = a.length;
  let hiB = b.length;
  while (hiA > lo && hiB > lo && a[hiA - 1] === b[hiB - 1]) {
    hiA--;
    hiB--;
  }

  if (lo > 0) push("eq", a.slice(0, lo).join(""));

  const midA = a.slice(lo, hiA);
  const midB = b.slice(lo, hiB);
  const n = midA.length;
  const m = midB.length;

  if (n > WORD_DIFF_MAX_TOKENS || m > WORD_DIFF_MAX_TOKENS) {
    push("del", midA.join(""));
    push("ins", midB.join(""));
  } else {
    const middle: WordOp[] = [];
    const add = (type: WordOp["type"], text: string) => middle.push({ type, text });
    const lcs: number[][] = Array.from({ length: n + 1 }, () => Array.from({ length: m + 1 }, () => 0));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i]![j] = midA[i] === midB[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        add("eq", midA[i]!);
        i++;
        j++;
      } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
        add("del", midA[i]!);
        i++;
      } else {
        add("ins", midB[j]!);
        j++;
      }
    }
    while (i < n) add("del", midA[i++]!);
    while (j < m) add("ins", midB[j++]!);
    const shared = middle.filter((o) => o.type === "eq" && !isSpace(o.text)).length;
    const runs = groupRuns(middle);
    const changed = runs.filter((r) => r.type === "change").length;
    const blockWords = Math.max(wordCount(a), wordCount(b));
    const keptWords = shared + wordCount(a.slice(0, lo)) + wordCount(a.slice(hiA));
    const fragmented = changed >= FRAGMENTED_RUNS || changed * FRAGMENTED_WORDS_PER_RUN > blockWords;
    if (
      shared < REWRITE_BELOW_SHARED * Math.max(wordCount(midA), wordCount(midB)) ||
      (fragmented && keptWords < FRAGMENTED_REWRITE_BELOW_SHARED * blockWords)
    ) {
      push("del", midA.join(""));
      push("ins", midB.join(""));
    } else {
      for (const r of runs) {
        if (r.type === "eq") push("eq", r.text);
        else {
          push("del", r.del);
          push("ins", r.ins);
        }
      }
    }
  }

  if (hiA < a.length) push("eq", a.slice(hiA).join(""));
  return ops;
}
