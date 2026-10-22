import { describe, expect, it } from "vitest";
import {
  ASK_STUGA,
  askStugaElsewhere,
  isUiLanguage,
  matchUiLanguage,
  MY_NOTES,
  negotiateUiLanguage,
  parseAcceptLanguage,
  SAVE_TO_STUGA,
  saveToStugaElsewhere,
  UI_LANGUAGE_NAMES,
  UI_LANGUAGES,
} from "./ui-languages";

describe("matchUiLanguage", () => {
  it("reads Chinese by script", () => {
    expect(matchUiLanguage("zh")).toBe("zh-Hans");
    expect(matchUiLanguage("zh-CN")).toBe("zh-Hans");
    expect(matchUiLanguage("zh-SG")).toBe("zh-Hans");
    expect(matchUiLanguage("zh-TW")).toBe("zh-Hant");
    expect(matchUiLanguage("zh-HK")).toBe("zh-Hant");
    expect(matchUiLanguage("zh-MO")).toBe("zh-Hant");
    expect(matchUiLanguage("zh-Hant-CN")).toBe("zh-Hant");
  });

  it("gives every Portuguese the Brazilian catalog", () => {
    expect(matchUiLanguage("pt")).toBe("pt-BR");
    expect(matchUiLanguage("pt-PT")).toBe("pt-BR");
  });

  it("matches a regional tag to its language", () => {
    expect(matchUiLanguage("en-GB")).toBe("en");
    expect(matchUiLanguage("de-CH")).toBe("de");
    expect(matchUiLanguage("es-419")).toBe("es");
    expect(matchUiLanguage("ja-JP")).toBe("ja");
  });

  it("finds nothing for a language without a catalog or a malformed tag", () => {
    expect(matchUiLanguage("sv")).toBeNull();
    expect(matchUiLanguage("not a tag!")).toBeNull();
    expect(matchUiLanguage("")).toBeNull();
  });
});

describe("negotiateUiLanguage", () => {
  it("takes the first preference with a catalog", () => {
    expect(negotiateUiLanguage(["sv-SE", "de-DE", "en"])).toBe("de");
  });

  it("falls back to English", () => {
    expect(negotiateUiLanguage(["sv", "fi"])).toBe("en");
    expect(negotiateUiLanguage([])).toBe("en");
  });
});

describe("parseAcceptLanguage", () => {
  it("orders by weight, keeping the header's order on ties", () => {
    expect(parseAcceptLanguage("fr;q=0.5, ja, de;q=0.9, ko")).toEqual(["ja", "ko", "de", "fr"]);
  });

  it("drops the wildcard, q=0 and malformed entries", () => {
    expect(parseAcceptLanguage("*, en;q=0, zh-TW;q=0.8, ??, de;q=abc")).toEqual(["zh-TW"]);
  });

  it("reads nothing from an absent header", () => {
    expect(parseAcceptLanguage(null)).toEqual([]);
    expect(parseAcceptLanguage("")).toEqual([]);
  });
});

it("names every language", () => {
  for (const tag of UI_LANGUAGES) expect(UI_LANGUAGE_NAMES[tag]).toBeTruthy();
  expect(isUiLanguage("zh-Hans")).toBe(true);
  expect(isUiLanguage("zh")).toBe(false);
});

describe("the phrases a person says to their AI", () => {
  it("has each in every language, naming Stuga", () => {
    for (const tag of UI_LANGUAGES) {
      expect(SAVE_TO_STUGA[tag]).toContain("Stuga");
      expect(ASK_STUGA[tag]).toContain("Stuga");
      expect(MY_NOTES[tag]).toBeTruthy();
    }
  });

  it("lists every other language's once, quoted, without the English", () => {
    expect(saveToStugaElsewhere()).toBe(
      '"存到 Stuga", "Stugaに保存", "Stuga에 저장", "In Stuga speichern", "Enregistrer dans Stuga", "Guardar en Stuga", "Salvar no Stuga"',
    );
    expect(askStugaElsewhere()).not.toContain('"Ask Stuga"');
    expect(askStugaElsewhere()).toContain('"問問 Stuga"');
  });
});
