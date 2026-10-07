/** The statistics of a calibration, shared number for number with experiments/embed-bench. */

/** Nearest rank, as embed-bench's cutoffs.ts takes it: `sorted` ascending, q in [0, 1]. */
export function quantile(sorted: readonly number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))]!;
}

/**
 * The 0.1% point from the 1% and 5% points, extended log-linearly down the tail: the empirical 0.1%
 * rests on a handful of pairs. Never below the smallest distance seen.
 */
export function strictFromTail(t1: number, t5: number, min: number): number {
  return Math.max(min, t1 - ((t5 - t1) * Math.log(10)) / Math.log(5));
}

/** Cosine distance, as pgvector's `<=>` computes it. */
export function cosineDistance(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return 1 - dot / Math.sqrt(na * nb);
}
