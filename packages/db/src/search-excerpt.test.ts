import { describe, expect, it } from "vitest";
import { EXCERPT_CHARS, completionAt, keywordExcerpt } from "./search-excerpt.js";

/** The positions of `words` (as written, case aside) among the text's words. */
function at(text: string, ...words: string[]): Set<number> {
  const all = text.match(/[\p{L}\p{N}\p{M}]+/gu) ?? [];
  return new Set(all.flatMap((w, i) => (words.includes(w.toLowerCase()) ? [i + 1] : [])));
}

const excerpt = (text: string, words: string[], cjk: string[] = []) =>
  keywordExcerpt(text, { words: at(text, ...words), cjk: new Set(cjk) })?.text ?? null;

const apart = "Calm air over the bay. ".repeat(12);

describe("keywordExcerpt", () => {
  it("is the whole text when it fits, its matches marked", () => {
    expect(excerpt("The tapir sleeps.", ["tapir"])).toBe("The ⟦tapir⟧ sleeps.");
  });

  it("is nothing for a text holding no match", () => {
    expect(excerpt("The tapir sleeps.", [])).toBeNull();
    expect(excerpt("The tapir sleeps.", ["heron"])).toBeNull();
  });

  it("shows the window with the most different matches, then the most matches, then the first", () => {
    const text = `The tapir sleeps. The tapir eats. The tapir swims. ${apart}By the river a tapir, a heron and a lemur. ${apart}A heron and a heron.`;
    expect(excerpt(text, ["tapir", "heron", "lemur"])).toContain("a ⟦tapir⟧, a ⟦heron⟧ and a ⟦lemur⟧");
    const tie = `Early on, a tapir met a heron. ${apart}Later, a tapir met a lemur.`;
    expect(excerpt(tie, ["tapir", "heron", "lemur"])).toContain("a ⟦tapir⟧ met a ⟦heron⟧");
  });

  it("opens on the sentence or line of the window's first match when it is near, cut at whole words", () => {
    const text = `${apart}Then, by the river, a tapir met a heron at dawn and they walked on together for a while. ${apart}`;
    const shown = excerpt(text, ["tapir", "heron"])!;
    expect(shown.startsWith("Then, by the river, a ⟦tapir⟧ met a ⟦heron⟧")).toBe(true);
    expect(shown.length).toBeLessThanOrEqual(EXCERPT_CHARS + 4);
    expect(text).toContain(shown.replace(/[⟦⟧]/g, ""));
    // Ends on a whole word.
    expect(text).toMatch(new RegExp(`${shown.replace(/[⟦⟧]/g, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`));
  });

  it("chooses among the first 64 windows holding a match", () => {
    const naps = (n: number) => `A tapir naps. ${apart}`.repeat(n);
    expect(excerpt(`${naps(63)}A tapir met a heron.`, ["tapir", "heron"])).toContain("A ⟦tapir⟧ met a ⟦heron⟧");
    expect(excerpt(`${naps(64)}A tapir met a heron.`, ["tapir", "heron"])).toMatch(/^A ⟦tapir⟧ naps\./);
  });

  it("marks only the matches, whatever brackets the text holds", () => {
    const text = "A tapir saw ⟦gecko⟦ and <b>gecko</b>.";
    expect(excerpt(text, ["gecko"])).toBe("A tapir saw ⟦⟦gecko⟧⟦ and <b>⟦gecko⟧</b>.");
  });

  it("marks neighbouring CJK pairs as one run, and characters searched alone", () => {
    expect(excerpt("涉及马里亚纳海沟的生物", [], ["马里", "里亚", "亚纳", "纳海", "海沟"])).toBe("涉及⟦马里亚纳海沟⟧的生物");
    expect(excerpt("國家圖書館週末開放", [], ["图书", "书馆"])).toBe("國家⟦圖書館⟧週末開放");
    expect(excerpt("我们开会了", [], ["会"])).toBe("我们开⟦会⟧了");
  });

  it("marks a run of matching pairs longer than an excerpt in pieces it can show", () => {
    const shown = excerpt(`开始${"哈".repeat(300)}`, [], ["哈哈"])!;
    expect(shown).toMatch(/^⟦哈{200}⟧/);
    expect(shown.length).toBeLessThanOrEqual(EXCERPT_CHARS + 4);
  });

  it("marks a word written with accents or in full width where the index found it", () => {
    expect(excerpt("The ＣＡＦＥ and the café", ["ｃａｆｅ", "café"])).toBe("The ⟦ＣＡＦＥ⟧ and the ⟦café⟧");
  });

  it("leaves a word past the last position the index keeps unmarked, as it cannot be told apart", () => {
    const text = `${"filler ".repeat(16_400)}tapir`;
    expect(keywordExcerpt(text, { words: new Set([16383, 16401]), cjk: new Set() })).toBeNull();
  });
});

describe("completionAt", () => {
  it("finds the first word the unfinished last word begins, as the index spells both", () => {
    const text = "If you are not sure where a Café is.";
    expect(text.slice(completionAt(text, "whe"))).toBe("where a Café is.");
    expect(text.slice(completionAt(text, "caf"))).toBe("Café is.");
    expect(completionAt(text, "xyz")).toBe(-1);
  });
});
