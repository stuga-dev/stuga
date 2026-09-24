/**
 * Word-level diff for the intra-block preview (`~~brown~~ red`): an LCS over
 * whitespace-delimited tokens that keeps the spacing between them. Presentation
 * only; a coarse result never changes what is committed.
 */
export type WordOp = { type: "eq" | "del" | "ins"; text: string };

/** Per-side token cap for the O(n·m) LCS; beyond it the changed middle is one del + one ins, so the table stays ≤ ~2.25M cells. */
const WORD_DIFF_MAX_TOKENS = 1500;

/** Split into tokens that alternate non-space / space runs, so joining round-trips. */
function tokenize(s: string): string[] {
  return s.match(/\s+|\S+/g) ?? [];
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
        push("eq", midA[i]!);
        i++;
        j++;
      } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
        push("del", midA[i]!);
        i++;
      } else {
        push("ins", midB[j]!);
        j++;
      }
    }
    while (i < n) push("del", midA[i++]!);
    while (j < m) push("ins", midB[j++]!);
  }

  if (hiA < a.length) push("eq", a.slice(hiA).join(""));
  return ops;
}
