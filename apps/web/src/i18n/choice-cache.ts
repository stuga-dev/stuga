/** This browser's copy of the account's language choice, kept so the first paint is already in it. */
import { isUiLanguage, type UiLanguage } from "@stuga/protocol/domain/ui-languages";
import { readStored, removeStored, writeStored } from "../lib/storage";

const KEY = "stuga_ui_language";

/** Null follows the browser. */
export function cachedLanguageChoice(): UiLanguage | null {
  const saved = readStored("local", KEY);
  return isUiLanguage(saved) ? saved : null;
}

/** Whether the copy persisted. */
export function cacheLanguageChoice(choice: UiLanguage | null): boolean {
  if (choice) return writeStored("local", KEY, choice);
  removeStored("local", KEY);
  return true;
}

/** At sign-out: the next person on this browser starts from its own languages. */
export function forgetLanguageChoice(): void {
  removeStored("local", KEY);
}
