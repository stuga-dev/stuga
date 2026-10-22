import { describe, expect, it } from "vitest";
import { SEARCH_LANGUAGES } from "@stuga/protocol/domain/search-languages";
import { SEARCH_FORMAT } from "./search-text.js";
import { SEARCH_CONFIGS, chunkText, searchConfigs, searchFormat, vectorTerms } from "./search-vectors.js";

describe("vectorTerms", () => {
  it("gives each distinct term its positions, words and CJK terms counted apart, and the text's length in terms", () => {
    expect(vectorTerms("The plan, the plans: 审批 the plan", 1)).toEqual({
      latin: { the: "1,3,5", plan: "2,6", plans: "4" },
      cjk: { 审: "1", 批: "2", 审批: "3" },
      length: 9,
    });
  });

  it("keeps a term's first 256 positions, and every word from the last position on at it", () => {
    const many = vectorTerms("tick ".repeat(300), 1);
    expect(many.latin.tick!.split(",")).toHaveLength(256);
    expect(many.length).toBe(300);
    const late = vectorTerms(`${"filler ".repeat(16_400)}late`, 1);
    expect(late.latin.late).toBe("16383");
  });

  /** The bytes Postgres takes for `terms` under `configs` configurations, at most: lexemes padded, position counts and positions. */
  const size = (terms: ReturnType<typeof vectorTerms>, configs: number) =>
    Object.entries(terms.latin).reduce((n, [w, p]) => n + configs * (w.length + 1 + 2 + 2 * p.split(",").length) + w.length + 1, 0) +
    Object.entries(terms.cjk).reduce((n, [w, p]) => n + Buffer.byteLength(w) + 1 + 2 + 2 * p.split(",").length, 0);

  it("indexes a text past what one vector holds from its start, and counts all of it", () => {
    const words = Array.from({ length: 200_000 }, (_, i) => `w${i.toString(36)}`);
    const terms = vectorTerms(words.join(" "), 3);
    const kept = Object.keys(terms.latin);
    expect(kept.length).toBeLessThan(words.length);
    expect(kept.at(-1)).toBe(words[kept.length - 1]);
    expect(size(terms, 3)).toBeLessThanOrEqual(1_000_000);
    expect(terms.length).toBe(words.length);
  });

  it("counts the positions of CJK text, whose pairs and characters repeat, against what one vector holds", () => {
    let state = 7;
    const han = () => String.fromCodePoint(0x4e00 + ((state = (Math.imul(state, 1103515245) + 12345) & 0x7fffffff) % 3000));
    const terms = vectorTerms(Array.from({ length: 300_000 }, han).join(""), 1);
    expect(size(terms, 1)).toBeLessThanOrEqual(1_000_000);
    expect(terms.length).toBe(300_000 * 2 - 1);
  });
});

describe("searchConfigs and searchFormat", () => {
  it("stems in English, then each chosen language once, in a fixed order", () => {
    expect(searchConfigs([])).toEqual(["english"]);
    expect(searchConfigs(["fr", "de", "fr"])).toEqual(["english", "german", "french"]);
  });

  it("names a configuration Postgres has for every choice", () => {
    expect(Object.keys(SEARCH_CONFIGS).sort()).toEqual([...SEARCH_LANGUAGES].sort());
  });

  it("names the text's spelling and the configurations, so another set is another format", () => {
    expect(searchFormat([])).toBe(`${SEARCH_FORMAT}/v1/english`);
    expect(searchFormat(["de", "fr"])).toBe(searchFormat(["fr", "de"]));
    expect(searchFormat(["de"])).not.toBe(searchFormat([]));
  });
});

describe("chunkText", () => {
  it("puts the title, on the opening passage only, before the heading and the passage", () => {
    expect(chunkText("Handbook", "Releases", "Tuesdays.")).toBe("Handbook Releases Tuesdays.");
    expect(chunkText(null, null, "Tuesdays.")).toBe("  Tuesdays.");
  });
});
