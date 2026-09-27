/** The languages search gets a tokenizer for, as setup and Settings → This node → Search offer them. */
import { MultiSelector } from "@astryxdesign/core/MultiSelector";
import type { SearchLanguage } from "@stuga/protocol/domain/search-languages";
import { SEARCH_LANGUAGE_LABELS } from "../lib/format";

/** The field's label, which Settings also heads its section with. */
export const SEARCH_LANGUAGES_LABEL = "Languages in your documents";

/** Stemmed in every index, so shown chosen and fixed; never sent, since it is not a choice. */
const ALWAYS_ON = { value: "en", label: "English", disabled: true };

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

/** The languages by name, searchable, with English always on and the chosen ones named in the field. */
export function SearchLanguageList({ choices, value, onChange, isDisabled, isLabelHidden, size }: Props) {
  const options = choices
    .map((l) => ({ value: l, label: SEARCH_LANGUAGE_LABELS[l] }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return (
    <MultiSelector
      label={SEARCH_LANGUAGES_LABEL}
      isLabelHidden={isLabelHidden}
      isOptional
      options={[
        { type: "section", title: "Always on", options: [ALWAYS_ON] },
        { type: "divider" },
        { type: "section", options },
      ]}
      value={[ALWAYS_ON.value, ...value]}
      // In the choices' order, which is the order the node keeps them in.
      onChange={(next) => onChange(choices.filter((l) => next.includes(l)))}
      triggerDisplay="labels"
      formatValue={(items) => items.map((i) => i.label).sort((a, b) => a.localeCompare(b)).join(", ")}
      hasSearch
      searchPlaceholder="Find a language"
      presentation="adaptive"
      size={size}
      width="100%"
      isDisabled={isDisabled}
    />
  );
}
