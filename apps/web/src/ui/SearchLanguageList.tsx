/** The languages search gets a tokenizer for, as setup and Settings → This node → Search offer them. */
import { MultiSelector } from "@astryxdesign/core/MultiSelector";
import type { SearchLanguage } from "@stuga/protocol/domain/search-languages";
import { formatLocale, t } from "../i18n/i18n";
import { searchLanguageLabel } from "../lib/format";

/** The field's label, which Settings also heads its section with. */
export const SEARCH_LANGUAGES_LABEL = t("ui.searchLanguages.label");

/** English is stemmed in every index, so shown chosen and fixed; never sent, since it is not a choice. */
const ALWAYS_ON_VALUE = "en";

interface Props {
  choices: readonly SearchLanguage[];
  value: SearchLanguage[];
  onChange: (languages: SearchLanguage[]) => void;
  isDisabled?: boolean;
  /** Under a heading that already says what the field is. */
  isLabelHidden?: boolean;
  /** As the fields beside it. */
  size?: "md" | "lg";
}

/** A language's English name, so a search in English finds it in any interface language. */
function englishName(language: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(language) ?? language;
  } catch {
    return language;
  }
}

/** The languages by name, searchable, with English always on and the chosen ones named in the field. */
export function SearchLanguageList({ choices, value, onChange, isDisabled, isLabelHidden, size }: Props) {
  const locale = formatLocale();
  const list = new Intl.ListFormat(locale, { style: "short", type: "unit" });
  // Not a choice, so not a SearchLanguage, but named the same way.
  const names = new Map<string, string>(
    [ALWAYS_ON_VALUE as SearchLanguage, ...choices].map((l) => [l, searchLanguageLabel(l)]),
  );
  const name = (language: string) => names.get(language) ?? language;
  // The selector searches labels alone, so a label carries both names; the rows and the field show one.
  const searchable = (language: string) => {
    const english = englishName(language);
    return english === name(language) ? english : `${name(language)} ${english}`;
  };
  const alwaysOn = { value: ALWAYS_ON_VALUE, label: searchable(ALWAYS_ON_VALUE), disabled: true };
  const options = choices
    .map((l) => ({ value: l, label: searchable(l) }))
    .sort((a, b) => name(a.value).localeCompare(name(b.value), locale));
  return (
    <MultiSelector
      label={SEARCH_LANGUAGES_LABEL}
      isLabelHidden={isLabelHidden}
      isOptional
      options={[
        { type: "section", title: t("ui.searchLanguages.alwaysOn"), options: [alwaysOn] },
        { type: "divider" },
        { type: "section", options },
      ]}
      value={[ALWAYS_ON_VALUE, ...value]}
      // In the choices' order, which is the order the node keeps them in.
      onChange={(next) => onChange(choices.filter((l) => next.includes(l)))}
      triggerDisplay="labels"
      formatValue={(items) => list.format(items.map((i) => name(i.value)).sort((a, b) => a.localeCompare(b, locale)))}
      renderOption={(option) => name(option.value)}
      hasSearch
      searchPlaceholder={t("ui.searchLanguages.find")}
      presentation="adaptive"
      size={size}
      width="100%"
      isDisabled={isDisabled}
    />
  );
}
