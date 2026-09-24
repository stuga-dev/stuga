import { describe, it, expect } from "vitest";
import { findFuzzyMatch, normalizeTypography } from "./fuzzy-match.js";

describe("normalizeTypography", () => {
  it("folds smart quotes, dashes, and odd spaces to ASCII (length-preserving)", () => {
    const s = "“x” ‘y’ a—b a–b a b"; // “x” ‘y’ a—b a–b a<nbsp>b
    const out = normalizeTypography(s);
    expect(out).toBe('"x" \'y\' a-b a-b a b');
    // The dash/quote/space folds are all 1:1, so length is unchanged.
    expect(out.length).toBe(s.length);
  });

  it("leaves already-ASCII text untouched", () => {
    const s = 'plain "text" with - dashes';
    expect(normalizeTypography(s)).toBe(s);
  });
});

describe("findFuzzyMatch", () => {
  it("exact match returns fuzzy=false and the needle itself", () => {
    const m = findFuzzyMatch("## Notes\nbody", "## Notes");
    expect(m).toEqual({ index: 0, matched: "## Notes", fuzzy: false });
  });

  it("matches across smart quotes / em-dash, returning the ORIGINAL doc bytes", () => {
    const doc = "The team’s “north star” goal — ship — is set."; // ’ “ ” — —
    const needle = 'The team\'s "north star" goal - ship - is set.'; // ASCII equivalents
    const m = findFuzzyMatch(doc, needle);
    expect(m).not.toBeNull();
    expect(m!.fuzzy).toBe(true);
    // matched is the real doc span (with smart chars), so a splice replaces real bytes.
    expect(m!.matched).toBe(doc.slice(m!.index, m!.index + m!.matched.length));
    expect(/[“”—’]/.test(m!.matched)).toBe(true);
  });

  it("matches across a non-breaking space", () => {
    const doc = "price: $10 total"; // NBSP after colon
    const m = findFuzzyMatch(doc, "price: $10 total"); // regular space
    expect(m?.fuzzy).toBe(true);
    expect(m!.matched).toContain(" ");
  });

  it("returns null when the text genuinely isn't present", () => {
    expect(findFuzzyMatch("hello world", "goodbye")).toBeNull();
  });

  it("wantUnique returns null on a second (exact) occurrence", () => {
    const doc = "a b c\n---\na b c";
    expect(findFuzzyMatch(doc, "a b c", { wantUnique: true })).toBeNull();
    expect(findFuzzyMatch(doc, "a b c")!.index).toBe(0); // without wantUnique, first match
  });

  it("wantUnique returns null on a second FUZZY occurrence too", () => {
    const doc = "say “hi” then say “hi” again"; // two smart-quoted 'hi's
    expect(findFuzzyMatch(doc, 'say "hi"', { wantUnique: true })).toBeNull();
  });

  it("does NOT misalign when an ellipsis char is present (length-changing fold)", () => {
    // needle uses '...' where doc uses '…' — the ellipsis fold changes length, so
    // the normalized pass is skipped rather than producing a misaligned splice.
    expect(findFuzzyMatch("wait… done", "wait... done")).toBeNull();
    // But an exact ellipsis match still works via pass 1.
    expect(findFuzzyMatch("wait… done", "wait… done")?.fuzzy).toBe(false);
  });

  it("respects the from offset", () => {
    const doc = "xx target yy target zz";
    const first = findFuzzyMatch(doc, "target")!;
    const second = findFuzzyMatch(doc, "target", { from: first.index + 1 })!;
    expect(second.index).toBeGreaterThan(first.index);
  });
});
