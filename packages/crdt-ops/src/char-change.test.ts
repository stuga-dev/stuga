/**
 * Character change counts for version history: a contiguous edit reports the
 * characters it touched, a same-length rewrite is not "nothing changed", moved
 * blocks are not churn, and the counts stay non-negative, bounded by each side
 * and consistent with the length delta.
 */
import { describe, expect, it } from "vitest";
import { charChangeCounts } from "./diff/char-counts.js";

describe("charChangeCounts", () => {
  it("reports nothing for identical text", () => {
    expect(charChangeCounts("# Title\n\nbody", "# Title\n\nbody")).toEqual({ added: 0, removed: 0 });
  });

  it("counts a first version as pure insertion", () => {
    expect(charChangeCounts("", "hello")).toEqual({ added: 5, removed: 0 });
  });

  it("counts a wipe as pure deletion", () => {
    expect(charChangeCounts("hello", "")).toEqual({ added: 0, removed: 5 });
  });

  it("counts only the characters a contiguous edit touched", () => {
    // One word swapped in the middle of a long line: the prefix/suffix trim
    // alone is the exact answer, so nothing else may be counted.
    const base = "The quick brown fox jumps over the lazy dog.";
    const next = "The quick red fox jumps over the lazy dog.";
    expect(charChangeCounts(base, next)).toEqual({ added: 3, removed: 5 });
  });

  it("counts an appended paragraph, not the paragraphs above it", () => {
    const base = "# Doc\n\nOne.\n\nTwo.";
    const next = "# Doc\n\nOne.\n\nTwo.\n\nThree.";
    expect(charChangeCounts(base, next)).toEqual({ added: "\n\nThree.".length, removed: 0 });
  });

  it("sees a same-length rewrite that a net length delta would miss", () => {
    const base = "alpha\n\nbravo\n\ncharlie";
    const next = "alpha\n\nDELTA\n\ncharlie";
    const { added, removed } = charChangeCounts(base, next);
    expect(added).toBe(5);
    expect(removed).toBe(5);
    // The whole point: the net delta is zero and would have read "no change".
    expect(next.length - base.length).toBe(0);
  });

  it("does not charge untouched lines when a line is deleted from the middle", () => {
    const base = "one\ntwo\nthree\nfour\nfive";
    const next = "one\ntwo\nfour\nfive";
    // "three\n" leaves; "one/two/four/five" are matched lines and stay free.
    expect(charChangeCounts(base, next)).toEqual({ added: 0, removed: 6 });
  });

  it("does not charge untouched lines when a line is inserted in the middle", () => {
    const base = "one\ntwo\nfour\nfive";
    const next = "one\ntwo\nthree\nfour\nfive";
    expect(charChangeCounts(base, next)).toEqual({ added: 6, removed: 0 });
  });

  it("charges a reordered pair once, not the whole document", () => {
    const base = "intro\n\naaa\n\nbbb\n\noutro";
    const next = "intro\n\nbbb\n\naaa\n\noutro";
    const { added, removed } = charChangeCounts(base, next);
    // One of the two moved blocks is re-matched by the line LCS, so this costs
    // one block — never the four lines a naive middle-span count would charge.
    expect(added).toBeLessThanOrEqual(5);
    expect(removed).toBeLessThanOrEqual(5);
    expect(added).toBeGreaterThan(0);
  });

  it("stays bounded (and still sane) past the work cap", () => {
    // 5000x5000 = 25M cells, past CHAR_CHANGE_MAX_CELLS — the coarse branch. It
    // must still return finite, non-negative counts within each side's length.
    const base = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
    const next = Array.from({ length: 5000 }, (_, i) => `LINE ${i}`).join("\n");
    const { added, removed } = charChangeCounts(base, next);
    expect(added).toBeGreaterThan(0);
    expect(removed).toBeGreaterThan(0);
    expect(added).toBeLessThanOrEqual(next.length);
    expect(removed).toBeLessThanOrEqual(base.length);
    expect(added - removed).toBe(next.length - base.length);
  });

  it("still measures a LOPSIDED document accurately, and quickly", () => {
    // Deleting a chunk from a long document: 6000 × 40 lines is well under the cell cap.
    const body = Array.from({ length: 6000 }, (_, i) => `paragraph ${i}`);
    const base = body.join("\n");
    const next = [...body.slice(0, 20), ...body.slice(40)].join("\n");
    const started = Date.now();
    const { added, removed } = charChangeCounts(base, next);
    expect(added).toBe(0); // nothing was written
    // Exactly the 20 removed lines and their newlines — not the whole document.
    expect(removed).toBe(base.length - next.length);
    expect(removed).toBeLessThan(base.length / 10);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("keeps the invariants on every pair it is given", () => {
    const samples: Array<[string, string]> = [
      ["", ""],
      ["a", "b"],
      ["\n\n\n", "\n\n"],
      ["# H\n\np1\n\np2\n", "# H\n\np1 edited\n\np2\n\np3\n"],
      ["| a | b |\n| - | - |\n| 1 | 2 |", "| a | b |\n| - | - |\n| 1 | 3 |\n| 4 | 5 |"],
      ["repeat\nrepeat\nrepeat", "repeat\nrepeat"],
      ["prefix middle suffix", "prefix suffix"],
    ];
    for (const [base, next] of samples) {
      const { added, removed } = charChangeCounts(base, next);
      expect(added, `added >= 0 for ${JSON.stringify([base, next])}`).toBeGreaterThanOrEqual(0);
      expect(removed, `removed >= 0 for ${JSON.stringify([base, next])}`).toBeGreaterThanOrEqual(0);
      expect(added).toBeLessThanOrEqual(next.length);
      expect(removed).toBeLessThanOrEqual(base.length);
      // A character is either kept, added, or removed — so the counts have to
      // reconcile with the plain length delta.
      expect(added - removed).toBe(next.length - base.length);
    }
  });
});
