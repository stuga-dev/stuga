/**
 * Which language a page load runs in. The account's choice lives on the node (one home); this
 * browser keeps a copy so the first paint is already in it, and drops the copy at sign-out. With
 * no choice, the browser's languages decide.
 */
import { negotiateUiLanguage, type UiLanguage } from "@stuga/protocol/domain/ui-languages";
import { api } from "../lib/http/client";
import { readStored, removeStored, writeStored } from "../lib/storage";
import { cacheLanguageChoice, cachedLanguageChoice } from "./choice-cache";
import { isActiveLanguage, uiLanguage, type ActiveLanguage } from "./i18n";

/** Set for the one reload that brings a page into the account's language, so a failing copy cannot loop. */
const RELOADED = "stuga_ui_language_reloaded";
/** en-XA, while developing: `?lang=en-XA`, kept for the tab. */
const DEV_KEY = "stuga_dev_language";

function browserLanguages(): readonly string[] {
  if (typeof navigator === "undefined") return [];
  return navigator.languages?.length ? navigator.languages : [navigator.language];
}

/** The language this browser reads when the account has no choice. */
export function browserUiLanguage(): UiLanguage {
  return negotiateUiLanguage(browserLanguages());
}

function resolve(choice: UiLanguage | null): UiLanguage {
  return choice ?? browserUiLanguage();
}

/** The language to load before the first render. */
export function bootUiLanguage(): ActiveLanguage {
  if (import.meta.env.DEV) {
    const asked = new URLSearchParams(location.search).get("lang");
    if (asked !== null) {
      if (isActiveLanguage(asked)) writeStored("session", DEV_KEY, asked);
      else removeStored("session", DEV_KEY);
    }
    const dev = readStored("session", DEV_KEY);
    if (isActiveLanguage(dev)) return dev;
  }
  return resolve(cachedLanguageChoice());
}

interface LanguageAnswer {
  ui_language: UiLanguage | null;
}

/** The account's choice, from the node. */
export function fetchLanguageChoice(): Promise<UiLanguage | null> {
  return api<LanguageAnswer>("/api/me/language").then((r) => r.ui_language);
}

/** Saves the account's choice and reloads into it. Null follows the browser. */
export async function chooseLanguage(choice: UiLanguage | null): Promise<void> {
  await api<LanguageAnswer>("/api/me/language", { method: "PUT", body: JSON.stringify({ ui_language: choice }) });
  cacheLanguageChoice(choice);
  location.reload();
}

let synced = false;

/**
 * Once a page load, after sign-in: take the account's choice into this browser. A page that
 * started in another language reloads into it at once, while nothing is open to lose.
 */
export async function syncAccountLanguage(): Promise<void> {
  if (synced) return;
  synced = true;
  let choice: UiLanguage | null;
  try {
    choice = await fetchLanguageChoice();
  } catch {
    return;
  }
  const persisted = cacheLanguageChoice(choice);
  if (uiLanguage() === "en-XA" || resolve(choice) === uiLanguage()) {
    removeStored("session", RELOADED);
    return;
  }
  if (!persisted || readStored("session", RELOADED)) return;
  writeStored("session", RELOADED, "1");
  location.reload();
}
