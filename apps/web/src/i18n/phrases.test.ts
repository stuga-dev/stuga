/** The phrases a person says to their AI, and the title of their own notes, as the glossary gives them. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ASK_STUGA, MY_NOTES, SAVE_TO_STUGA, UI_LANGUAGES, type UiLanguage } from "@stuga/protocol/domain/ui-languages";

const glossary = readFileSync(new URL("./glossary.md", import.meta.url), "utf8");

/** A Terms row's cells, by its English, in the order of the table's language columns. */
function termRow(english: string): Record<UiLanguage, string | undefined> {
  const line = glossary.split("\n").find((l) => l.startsWith(`| ${english} |`));
  const cells = line?.split("|").slice(2).map((c) => c.trim()) ?? [];
  const header = glossary.split("\n").find((l) => l.startsWith("| English |"))!.split("|").slice(2).map((c) => c.trim());
  return Object.fromEntries(UI_LANGUAGES.map((language) => [language, language === "en" ? english : cells[header.indexOf(language)]])) as Record<UiLanguage, string | undefined>;
}

describe("the glossary's Terms", () => {
  it.each([
    ["Save to Stuga", SAVE_TO_STUGA],
    ["Ask Stuga", ASK_STUGA],
    ["My notes", MY_NOTES],
  ] as const)("gives “%s” as the model is taught it", (english, phrases) => {
    expect(termRow(english)).toEqual(phrases);
  });
});
