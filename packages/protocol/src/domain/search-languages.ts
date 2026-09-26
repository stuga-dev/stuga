/**
 * Languages keyword search gets a more accurate tokenizer for, beyond the
 * general one every text gets. That one segments Chinese and Japanese on its
 * own but treats Korean and Arabic as already spaced, so a glued-on particle
 * (Korean 의, Arabic ل) stays attached. `ko` adds a Korean dictionary
 * segmenter; `ar` adds Arabic stemming, which strips ال but not a bare ل. Each
 * one is a column in the search indexes, so a node carries only those it chose.
 */
export const SEARCH_LANGUAGES = ["ko", "ar"] as const;

export type SearchLanguage = (typeof SEARCH_LANGUAGES)[number];

/**
 * A list of languages as the node stores it: known ones only, each once, in
 * SEARCH_LANGUAGES order. Null for anything else: not an array, or an entry
 * that is not a choice.
 */
export function parseSearchLanguages(raw: unknown): SearchLanguage[] | null {
  if (!Array.isArray(raw)) return null;
  if (!raw.every((l) => (SEARCH_LANGUAGES as readonly unknown[]).includes(l))) return null;
  return SEARCH_LANGUAGES.filter((l) => raw.includes(l));
}
