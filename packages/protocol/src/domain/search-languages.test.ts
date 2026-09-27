import { describe, expect, it } from "vitest";
import { parseSearchLanguages } from "./search-languages";

describe("parseSearchLanguages", () => {
  it("keeps the known languages, once each, in the choices' order", () => {
    expect(parseSearchLanguages([])).toEqual([]);
    expect(parseSearchLanguages(["ar"])).toEqual(["ar"]);
    expect(parseSearchLanguages(["zh", "ko", "fr", "ar", "ko"])).toEqual(["ar", "fr", "ko", "zh"]);
  });

  it("refuses anything but a list of choices", () => {
    for (const raw of [undefined, null, "ko", "ko,ar", { ko: true }, ["ko", "en"], ["ko", "th"], ["KO"], [" ko"], [1]]) {
      expect(parseSearchLanguages(raw), JSON.stringify(raw)).toBeNull();
    }
  });
});
