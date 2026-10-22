/**
 * Languages keyword search stems words in, beside English, which it always
 * does: with French chosen, `maisons` finds `maison`. Each is one of Postgres's
 * built-in stemmers. Chinese, Japanese, Korean and Thai are found in any
 * text, by their characters and words, and are not a choice. A word in any
 * other language matches as written. ISO 639-1 codes, in the order the node
 * keeps them.
 */
export const SEARCH_LANGUAGES = [
  "ar", "da", "de", "el", "es", "fi", "fr", "hu", "it",
  "nl", "no", "pt", "ro", "ru", "sv", "ta", "tr",
] as const;

export type SearchLanguage = (typeof SEARCH_LANGUAGES)[number];

/** Languages search reads in every text, whatever is chosen. */
export const ALWAYS_SEARCHED_LANGUAGES = ["en", "ja", "ko", "th", "zh"] as const;

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
