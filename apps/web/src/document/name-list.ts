import { formatLocale } from "../i18n/i18n";

/** Names as a short list in the reader's locale: "Ada, Grace" in English. */
export function nameList(names: readonly string[]): string {
  return new Intl.ListFormat(formatLocale(), { type: "unit", style: "short" }).format(names);
}
