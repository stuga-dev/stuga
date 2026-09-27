/**
 * Languages keyword search gets a more accurate tokenizer for, beyond the
 * general one every text gets. That one segments Chinese and Japanese on its
 * own and splits other languages at spaces, keeping each word as written;
 * English it also stems. `zh` adds jieba, which keeps a compound whole beside
 * its parts (人工智能), so a whole-word match ranks first; `ja` and `ko` add a
 * Lindera dictionary, so a glued-on Korean particle (해구의) comes apart; every
 * other choice adds pg_search's stemmer for the language, so `maisons` finds
 * `maison`. Each one is a column in the search indexes, so a node carries only
 * those it chose. ISO 639-1 codes, in the order the node keeps them.
 */
export const SEARCH_LANGUAGES = [
  "ar", "cs", "da", "de", "el", "es", "fi", "fr", "hu", "it", "ja",
  "ko", "nl", "no", "pl", "pt", "ro", "ru", "sv", "ta", "tr", "zh",
] as const;

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
