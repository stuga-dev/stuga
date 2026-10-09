/**
 * The languages Stuga's interface is written in, as BCP 47 tags. English is the source every
 * other catalog is translated from. Interface language only: what keyword search understands
 * is SEARCH_LANGUAGES, a separate node setting.
 */
export const UI_LANGUAGES = ["en", "zh-Hans", "zh-Hant", "ja", "ko", "de", "fr", "es", "pt-BR"] as const;

export type UiLanguage = (typeof UI_LANGUAGES)[number];

/** Each language as its own speakers write it, which is how a picker lists it in every language. */
export const UI_LANGUAGE_NAMES: Record<UiLanguage, string> = {
  en: "English",
  "zh-Hans": "简体中文",
  "zh-Hant": "繁體中文",
  ja: "日本語",
  ko: "한국어",
  de: "Deutsch",
  fr: "Français",
  es: "Español",
  "pt-BR": "Português (Brasil)",
};

export function isUiLanguage(value: unknown): value is UiLanguage {
  return typeof value === "string" && (UI_LANGUAGES as readonly string[]).includes(value);
}

/**
 * The interface language for one requested tag, or null when none fits. Chinese goes by script,
 * so zh-TW, zh-HK and zh-MO read Traditional and zh, zh-CN and zh-SG Simplified; every
 * Portuguese gets the Brazilian catalog, the only one there is.
 */
export function matchUiLanguage(tag: string): UiLanguage | null {
  let locale: Intl.Locale;
  try {
    locale = new Intl.Locale(tag.trim());
  } catch {
    return null;
  }
  const { language } = locale;
  if (language === "zh") {
    let script: string | undefined;
    try {
      script = locale.maximize().script;
    } catch {
      script = undefined;
    }
    return script === "Hant" ? "zh-Hant" : "zh-Hans";
  }
  if (language === "pt") return "pt-BR";
  return isUiLanguage(language) ? language : null;
}

/** The first of a reader's languages, in their order of preference, that the interface is written in; English when none is. */
export function negotiateUiLanguage(preferred: readonly string[]): UiLanguage {
  for (const tag of preferred) {
    const match = matchUiLanguage(tag);
    if (match) return match;
  }
  return "en";
}

/**
 * An Accept-Language header's tags, most wanted first: weights are honoured, `q=0` and `*` are
 * dropped, and a malformed entry is skipped rather than failing the rest.
 */
export function parseAcceptLanguage(header: string | null | undefined): string[] {
  if (!header) return [];
  const entries: { tag: string; q: number; at: number }[] = [];
  header.split(",").forEach((part, at) => {
    const [rawTag = "", ...params] = part.trim().split(";");
    const tag = rawTag.trim();
    if (!tag || tag === "*" || !/^[A-Za-z]{1,8}(-[A-Za-z0-9]{1,8})*$/.test(tag)) return;
    let q = 1;
    for (const param of params) {
      const [name = "", value = ""] = param.split("=").map((s) => s.trim());
      if (name === "q") q = /^[0-9.]+$/.test(value) ? Number(value) : Number.NaN;
    }
    if (!Number.isFinite(q) || q <= 0 || q > 1) return;
    entries.push({ tag, q, at });
  });
  return entries.sort((a, b) => b.q - a.q || a.at - b.at).map((e) => e.tag);
}
