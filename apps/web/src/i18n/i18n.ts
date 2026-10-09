/**
 * The interface language: one per page load, chosen before the first render (see main.tsx) and
 * changed only by reloading, so nothing holds a string from the language before. `t()` therefore
 * works anywhere, module scope included, in code the app loads after the catalog.
 */
import IntlMessageFormat from "intl-messageformat";
import { isUiLanguage, matchUiLanguage, type UiLanguage } from "@stuga/protocol/domain/ui-languages";
import { EN, flatten, type MessageKey } from "./en";
import { pseudoCatalog } from "./pseudo";

export type { MessageKey } from "./en";

/** A language the app can run in: the shipped ones, plus en-XA while developing. */
export type ActiveLanguage = UiLanguage | "en-XA";

export type MessageValues = Record<string, string | number | Date | null | undefined>;

let active: ActiveLanguage = "en";
/** The active language's own catalog; a key it lacks falls back to English. */
let messages: Record<string, string> = EN;
/** Astryx's catalog for the active language, keyed the way its provider looks it up. */
let astryxCatalog: { tag: string; messages: Record<string, unknown> } | null = null;

const formatters = new Map<string, IntlMessageFormat>();

export function uiLanguage(): ActiveLanguage {
  return active;
}

/**
 * The locale numbers and dates are formatted in. The browser's own when it reads the same
 * catalog, so en-GB keeps day-first dates and pt-PT its own; the interface language otherwise.
 */
export function formatLocale(): string {
  if (active === "en-XA") return "en";
  const browser = typeof navigator === "undefined" ? undefined : navigator.language;
  return browser && matchUiLanguage(browser) === active ? browser : active;
}

function formatter(message: string): IntlMessageFormat {
  const locale = formatLocale();
  const cacheKey = `${locale}\u0000${message}`;
  let f = formatters.get(cacheKey);
  if (!f) {
    f = new IntlMessageFormat(message, locale, undefined, { ignoreTag: false });
    formatters.set(cacheKey, f);
  }
  return f;
}

function formatted(key: string, values: MessageValues | undefined): string {
  const message = messages[key] ?? EN[key];
  if (message === undefined) return key;
  try {
    return String(formatter(message).format(values));
  } catch {
    // A translation that cannot format falls back to English rather than breaking the page.
    const english = EN[key];
    if (english === undefined || english === message) return key;
    try {
      return String(formatter(english).format(values));
    } catch {
      return key;
    }
  }
}

/** The message for `key` in the interface language, with its ICU arguments filled in. */
export function t(key: MessageKey, values?: MessageValues): string {
  return formatted(key, values);
}

/** For a key assembled at run time from a known prefix; the catalog test checks each prefix's keys exist. */
export function tDynamic(key: string, values?: MessageValues): string {
  return formatted(key, values);
}

/** Whether the catalog has a message for a key assembled at run time. */
export function hasMessage(key: string): boolean {
  return key in EN;
}

/** The raw ICU parts of a message, for rich text (see rich.tsx). */
export function formatParts(key: MessageKey, values: Record<string, unknown>): unknown {
  const message = messages[key] ?? EN[key];
  if (message === undefined) return key;
  try {
    return formatter(message).format(values as never);
  } catch {
    return key;
  }
}

const APP_CATALOGS = import.meta.glob<Record<string, Record<string, string>>>("./messages/*/index.ts", { import: "default" });

/** Astryx ships a catalog per region; the app's languages read these. */
const ASTRYX_CATALOGS: Record<Exclude<ActiveLanguage, "en">, { tag: string; load: () => Promise<{ default: Record<string, unknown> }> }> = {
  "zh-Hans": { tag: "zh-CN", load: () => import("@astryxdesign/core/locales/zh-CN.generated.js") },
  "zh-Hant": { tag: "zh-TW", load: () => import("@astryxdesign/core/locales/zh-TW.generated.js") },
  ja: { tag: "ja-JP", load: () => import("@astryxdesign/core/locales/ja-JP.generated.js") },
  ko: { tag: "ko-KR", load: () => import("@astryxdesign/core/locales/ko-KR.generated.js") },
  de: { tag: "de-DE", load: () => import("@astryxdesign/core/locales/de-DE.generated.js") },
  fr: { tag: "fr-FR", load: () => import("@astryxdesign/core/locales/fr-FR.generated.js") },
  es: { tag: "es-ES", load: () => import("@astryxdesign/core/locales/es-ES.generated.js") },
  "pt-BR": { tag: "pt-BR", load: () => import("@astryxdesign/core/locales/pt-BR.generated.js") },
  "en-XA": { tag: "en-XA", load: () => import("@astryxdesign/core/locales/pseudo.generated.js") },
};

/**
 * Loads a language's catalogs and makes it the active one. A catalog that fails to load leaves
 * the page in English rather than blank; the result says which language is active.
 */
export async function loadUiLanguage(language: ActiveLanguage): Promise<ActiveLanguage> {
  if (language === "en") return activate("en", EN, null);
  try {
    const astryx = ASTRYX_CATALOGS[language];
    if (language === "en-XA") {
      const astryxMessages = await astryx.load();
      return activate(language, pseudoCatalog(EN), { tag: astryx.tag, messages: astryxMessages.default });
    }
    const load = APP_CATALOGS[`./messages/${language}/index.ts`];
    if (!load) return activate("en", EN, null);
    const [app, astryxMessages] = await Promise.all([load(), astryx.load()]);
    return activate(language, flatten(app), { tag: astryx.tag, messages: astryxMessages.default });
  } catch {
    return activate("en", EN, null);
  }
}

function activate(language: ActiveLanguage, catalog: Record<string, string>, astryx: typeof astryxCatalog): ActiveLanguage {
  active = language;
  messages = catalog;
  astryxCatalog = astryx;
  formatters.clear();
  if (typeof document !== "undefined") document.documentElement.lang = language;
  return language;
}

/** What InternationalizationProvider takes for the active language; null in English, its default. */
export function astryxMessages(): { tag: string; messages: Record<string, unknown> } | null {
  return astryxCatalog;
}

export function isActiveLanguage(value: unknown): value is ActiveLanguage {
  return isUiLanguage(value) || value === "en-XA";
}
