import { describe, expect, it } from "vitest";
import { cosineDistance, quantile, strictFromTail } from "./stats.js";

describe("quantile", () => {
  it("takes the nearest rank, as embed-bench does", () => {
    const xs = Array.from({ length: 101 }, (_, i) => i / 100);
    expect(quantile(xs, 0)).toBe(0);
    expect(quantile(xs, 0.01)).toBe(0.01);
    expect(quantile(xs, 0.5)).toBe(0.5);
    expect(quantile(xs, 1)).toBe(1);
    expect(quantile([0.3, 0.4], 0.5)).toBe(0.4);
  });
});

describe("strictFromTail", () => {
  it("is exact on a tail whose quantiles are linear in log q", () => {
    // t(q) = a + b ln q: the 0.1% point follows from the 1% and 5% ones.
    const t = (q: number) => 0.5 + 0.03 * Math.log(q);
    expect(strictFromTail(t(0.01), t(0.05), 0)).toBeCloseTo(t(0.001), 12);
  });

  it("never goes below the smallest distance seen", () => {
    expect(strictFromTail(0.3, 0.6, 0.29)).toBe(0.29);
  });
});

describe("cosineDistance", () => {
  it("is 0 for one direction, 1 for orthogonal and 2 for opposite vectors", () => {
    expect(cosineDistance([1, 2], [2, 4])).toBeCloseTo(0, 12);
    expect(cosineDistance([1, 0], [0, 3])).toBeCloseTo(1, 12);
    expect(cosineDistance([1, 0], [-1, 0])).toBeCloseTo(2, 12);
  });
});
