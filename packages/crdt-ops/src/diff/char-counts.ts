/** How much text one version added and removed relative to the one before it. */
export interface CharChange {
  added: number;
  removed: number;
}

/**
 * Work cap for the weighted LCS, in matrix cells (what the loop costs). Past it
 * the whole changed middle counts as removed and re-added: coarse, bounded and
 * still length-consistent. 1M cells is roughly 15ms.
 */
const CHAR_CHANGE_MAX_CELLS = 1_000_000;

/**
 * Characters gained and lost between two markdown states — the version list's
 * "+312 −45", computed from the same serializations the compare view diffs.
 *
 * Cheapest first: trim the common prefix/suffix (exact for one contiguous
 * edit); a middle empty on one side is a pure insert or delete (exact);
 * otherwise an LCS over lines weighted by length, keeping one rolling row.
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

  const midA = base.slice(pre, base.length - suf);
  const midB = next.slice(pre, next.length - suf);

  // 2. pure insert / pure delete.
  if (midA.length === 0 || midB.length === 0) return { added: midB.length, removed: midA.length };

  // 3. line-aligned middle.
  const a = midA.split("\n");
  const b = midB.split("\n");
  if (a.length * b.length > CHAR_CHANGE_MAX_CELLS) {
    return { added: midB.length, removed: midA.length };
  }

  const n = a.length;
  const m = b.length;
  // Weighted LCS: dp[j] = characters in common between a[0..i) and b[0..j).
  const prev = new Int32Array(m + 1);
  const cur = new Int32Array(m + 1);
  for (let i = 1; i <= n; i++) {
    const ai = a[i - 1]!;
    // A matched line is worth its characters plus its newline (an empty line is
    // worth 1). The last line has none, so `common` can undercount by one; the
    // clamp keeps both counts non-negative and `added - removed` exact.
    const weight = ai.length + (i < n ? 1 : 0);
    for (let j = 1; j <= m; j++) {
      cur[j] = ai === b[j - 1] ? prev[j - 1]! + weight : Math.max(prev[j]!, cur[j - 1]!);
    }
    prev.set(cur);
  }
  const common = Math.min(prev[m]!, midA.length, midB.length);
  return { added: midB.length - common, removed: midA.length - common };
}
