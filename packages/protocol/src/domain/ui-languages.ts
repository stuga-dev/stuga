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

/**
 * “Save to Stuga” as a person says it to their AI, in each interface language. The model is taught
 * every one, so whichever a person says saves; the glossary's Terms row holds the same.
 */
export const SAVE_TO_STUGA: Record<UiLanguage, string> = {
  en: "Save to Stuga",
  "zh-Hans": "存到 Stuga",
  "zh-Hant": "存到 Stuga",
  ja: "Stugaに保存",
  ko: "Stuga에 저장",
  de: "In Stuga speichern",
  fr: "Enregistrer dans Stuga",
  es: "Guardar en Stuga",
  "pt-BR": "Salvar no Stuga",
};

/** “Ask Stuga”, the same way: what a person says to have their AI look in Stuga first. */
export const ASK_STUGA: Record<UiLanguage, string> = {
  en: "Ask Stuga",
  "zh-Hans": "问问 Stuga",
  "zh-Hant": "問問 Stuga",
  ja: "Stugaに聞く",
  ko: "Stuga에 물어보기",
  de: "Stuga fragen",
  fr: "Demander à Stuga",
  es: "Preguntar a Stuga",
  "pt-BR": "Perguntar ao Stuga",
};

/** “Check Stuga”, the same way: what a person says to have their AI look over the wiki for pages to fix. */
export const CHECK_STUGA: Record<UiLanguage, string> = {
  en: "Check Stuga",
  "zh-Hans": "检查 Stuga",
  "zh-Hant": "檢查 Stuga",
  ja: "Stugaをチェック",
  ko: "Stuga 점검",
  de: "Stuga prüfen",
  fr: "Vérifier Stuga",
  es: "Revisar Stuga",
  "pt-BR": "Verificar o Stuga",
};

/** The title of a person's own folder for what their AI saves, in the language they read Stuga in when it is made. */
export const MY_NOTES: Record<UiLanguage, string> = {
  en: "My notes",
  "zh-Hans": "我的笔记",
  "zh-Hant": "我的筆記",
  ja: "マイノート",
  ko: "내 노트",
  de: "Meine Notizen",
  fr: "Mes notes",
  es: "Mis notas",
  "pt-BR": "Minhas notas",
};

/** A phrase in every language but English, each once and quoted: `"存到 Stuga", "Stugaに保存", …`. */
export function phraseElsewhere(phrases: Record<UiLanguage, string>): string {
  return [...new Set(Object.values(phrases))]
    .filter((phrase) => phrase !== phrases.en)
    .map((phrase) => `"${phrase}"`)
    .join(", ");
}

/** “Save to Stuga” in every language but English. */
export function saveToStugaElsewhere(): string {
  return phraseElsewhere(SAVE_TO_STUGA);
}

/** “Ask Stuga” in every language but English. */
export function askStugaElsewhere(): string {
  return phraseElsewhere(ASK_STUGA);
}

/** “Check Stuga” in every language but English. */
export function checkStugaElsewhere(): string {
  return phraseElsewhere(CHECK_STUGA);
}

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
