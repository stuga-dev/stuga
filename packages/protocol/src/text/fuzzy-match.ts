/**
 * Typography-tolerant substring matching for str_replace edits: models write
 * ASCII quotes, dashes and spaces where documents hold typographic ones. The
 * agent that stages an edit and the path that applies it must use this same
 * matcher, or an edit could stage and then fail to apply.
 */

/**
 * Fold smart quotes, dashes and odd spaces to ASCII. Every fold except the
 * ellipsis is 1:1, so indices map back to the original string.
 */
export function normalizeTypography(s: string): string {
  return s
    .replace(/[‘’‚‛′‵]/g, "'") // ' ' ‚ ‛ ′ ‵ → '
    .replace(/[“”„‟″‶]/g, '"') // " " „ ‟ ″ ‶ → "
    .replace(/[‐‑‒–—―−]/g, "-") // ‐ ‑ ‒ – — ― − → -
    .replace(/[       ]/g, " ") // NBSP + fig/narrow/thin/hair/en/em spaces → space
    .replace(/…/g, "...");
}

/** A match span in the original haystack. */
export interface FuzzyMatch {
  index: number;
  /** The haystack's own text at the span, which may differ typographically from the needle. */
  matched: string;
  /** The match needed typographic folding. */
  fuzzy: boolean;
}

/**
 * Find `needle` exactly, then with typographic folding (skipped when either side
 * has an ellipsis, whose fold changes length). `wantUnique` returns null when a
 * second match exists.
 */
export function findFuzzyMatch(
  haystack: string,
  needle: string,
  opts?: { from?: number; wantUnique?: boolean },
): FuzzyMatch | null {
  const from = opts?.from ?? 0;
  const exact = haystack.indexOf(needle, from);
  if (exact >= 0) {
    if (opts?.wantUnique && haystack.indexOf(needle, exact + 1) >= 0) return null;
    return { index: exact, matched: needle, fuzzy: false };
  }
  if (needle.indexOf("…") >= 0 || haystack.indexOf("…") >= 0) return null;
  const nH = normalizeTypography(haystack);
  const nN = normalizeTypography(needle);
  if (nH.length !== haystack.length || nN.length !== needle.length) return null;
  const at = nH.indexOf(nN, from);
  if (at < 0) return null;
  if (opts?.wantUnique && nH.indexOf(nN, at + 1) >= 0) return null;
  return { index: at, matched: haystack.slice(at, at + needle.length), fuzzy: true };
}
