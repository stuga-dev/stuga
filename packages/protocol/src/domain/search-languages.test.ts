import { describe, expect, it } from "vitest";
import { parseSearchLanguages } from "./search-languages";

describe("parseSearchLanguages", () => {
  it("keeps the known languages, once each, in the choices' order", () => {
    expect(parseSearchLanguages([])).toEqual([]);
    expect(parseSearchLanguages(["ar"])).toEqual(["ar"]);
    expect(parseSearchLanguages(["ar", "ko", "ar"])).toEqual(["ko", "ar"]);
  });

  it("refuses anything but a list of choices", () => {
    for (const raw of [undefined, null, "ko", "ko,ar", { ko: true }, ["ko", "fr"], ["KO"], [" ko"], [1]]) {
      expect(parseSearchLanguages(raw), JSON.stringify(raw)).toBeNull();
    }
  });
});
