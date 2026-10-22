import { describe, expect, it } from "vitest";
import { ALWAYS_SEARCHED_LANGUAGES, SEARCH_LANGUAGES, parseSearchLanguages } from "./search-languages";

describe("parseSearchLanguages", () => {
  it("keeps the known languages, once each, in the choices' order", () => {
    expect(parseSearchLanguages([])).toEqual([]);
    expect(parseSearchLanguages(["ar"])).toEqual(["ar"]);
    expect(parseSearchLanguages(["tr", "de", "fr", "ar", "de"])).toEqual(["ar", "de", "fr", "tr"]);
  });

  it("refuses anything but a list of choices", () => {
    for (const raw of [undefined, null, "de", "de,ar", { de: true }, ["de", "en"], ["de", "th"], ["DE"], [" de"], [1]]) {
      expect(parseSearchLanguages(raw), JSON.stringify(raw)).toBeNull();
    }
  });

  it("refuses a language search always reads, or one it has no stemmer for", () => {
    for (const language of [...ALWAYS_SEARCHED_LANGUAGES, "cs", "pl"]) {
      expect(parseSearchLanguages([language]), language).toBeNull();
    }
    expect(SEARCH_LANGUAGES.some((l) => (ALWAYS_SEARCHED_LANGUAGES as readonly string[]).includes(l))).toBe(false);
  });
});
