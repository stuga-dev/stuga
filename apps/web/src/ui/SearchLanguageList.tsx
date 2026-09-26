/** The languages search gets a tokenizer for, as setup and Settings → This node → Search offer them. */
import { CheckboxList, CheckboxListItem } from "@astryxdesign/core/CheckboxList";
import type { SearchLanguage } from "@stuga/protocol/domain/search-languages";
import { SEARCH_LANGUAGE_LABELS } from "../lib/format";

/** What the list says under its label: the languages that need no choosing. */
export const SEARCH_LANGUAGES_NOTE = "Chinese, Japanese and English need nothing extra.";

interface Props {
  choices: readonly SearchLanguage[];
  value: SearchLanguage[];
  onChange: (languages: SearchLanguage[]) => void;
  isDisabled?: boolean;
  /** Under a heading that already says what the list is, and shows the note itself: a hidden label hides its note too. */
  isLabelHidden?: boolean;
}

export function SearchLanguageList({ choices, value, onChange, isDisabled, isLabelHidden }: Props) {
  return (
    <CheckboxList
      label="Search languages"
      isLabelHidden={isLabelHidden}
      description={isLabelHidden ? undefined : SEARCH_LANGUAGES_NOTE}
      value={value}
      // In the choices' order, which is the order the node keeps them in.
      onChange={(next) => onChange(choices.filter((l) => next.includes(l)))}
      density="compact"
      isDisabled={isDisabled}
    >
      {choices.map((l) => (
        <CheckboxListItem key={l} value={l} label={SEARCH_LANGUAGE_LABELS[l]} />
      ))}
    </CheckboxList>
  );
}
