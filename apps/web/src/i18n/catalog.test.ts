import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import IntlMessageFormat from "intl-messageformat";
import { describe, expect, it } from "vitest";
import { UI_LANGUAGES } from "@stuga/protocol/domain/ui-languages";
import { EN, EN_NAMESPACES } from "./en";
import { DYNAMIC_KEY_PREFIXES } from "./dynamic-keys";
import { pseudoMessage } from "./pseudo";

const here = fileURLToPath(new URL(".", import.meta.url));
const messagesDir = join(here, "messages");
const srcDir = join(here, "..");

function catalog(language: string): Record<string, Record<string, string>> {
  const dir = join(messagesDir, language);
  return Object.fromEntries(
    readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => [f.slice(0, -".json".length), JSON.parse(readFileSync(join(dir, f), "utf8")) as Record<string, string>]),
  );
}

type Ast = ReturnType<IntlMessageFormat["getAst"]>;

/** Argument names and their kinds (plain, number, plural, select, tag…), sorted, which a translation must keep. */
function argumentsOf(ast: Ast, out = new Set<string>()): Set<string> {
  for (const el of ast as unknown as { type: number; value?: string; options?: Record<string, { value: Ast }>; children?: Ast }[]) {
    if (el.value !== undefined && el.type !== 0 && el.type !== 7) out.add(`${el.value}:${el.type}`);
    for (const option of Object.values(el.options ?? {})) argumentsOf(option.value, out);
    if (el.children) argumentsOf(el.children, out);
  }
  return out;
}

function parse(message: string, locale: string): Ast {
  return new IntlMessageFormat(message, locale, undefined, { ignoreTag: false }).getAst();
}

/** `I18N_NAMESPACE=editor`: check one namespace, while others are mid-extraction. */
const only = process.env.I18N_NAMESPACE;
const pick = <T,>(all: Record<string, T>): Record<string, T> =>
  only ? Object.fromEntries(Object.entries(all).filter(([ns]) => ns === only)) : all;

const en = pick(catalog("en"));

it("lists every English namespace file in en.ts", () => {
  expect(Object.keys(EN_NAMESPACES).sort()).toEqual(Object.keys(catalog("en")).sort());
});

describe.each(UI_LANGUAGES.filter((l) => l !== "en"))("%s", (language) => {
  const translated = pick(catalog(language));

  it("has every namespace and every key English has, and no other", () => {
    expect(Object.keys(translated).sort()).toEqual(Object.keys(en).sort());
    const missing: string[] = [];
    const extra: string[] = [];
    for (const [ns, messages] of Object.entries(en)) {
      const other = translated[ns] ?? {};
      for (const key of Object.keys(messages)) if (!(key in other)) missing.push(`${ns}.${key}`);
      for (const key of Object.keys(other)) if (!(key in messages)) extra.push(`${ns}.${key}`);
    }
    expect({ missing, extra }).toEqual({ missing: [], extra: [] });
  });

  it("keeps each message's arguments, plurals and tags", () => {
    const mismatched: string[] = [];
    for (const [ns, messages] of Object.entries(en)) {
      for (const [key, english] of Object.entries(messages)) {
        const message = translated[ns]?.[key];
        if (message === undefined) continue;
        let ours: Set<string>;
        try {
          ours = argumentsOf(parse(message, language));
        } catch (e) {
          mismatched.push(`${ns}.${key}: ${(e as Error).message}`);
          continue;
        }
        const theirs = argumentsOf(parse(english, "en"));
        if ([...ours].sort().join() !== [...theirs].sort().join()) mismatched.push(`${ns}.${key}`);
      }
    }
    expect(mismatched).toEqual([]);
  });
});

it("parses every English message, none with a straight apostrophe, which ICU reads as a quote", () => {
  const bad: string[] = [];
  for (const [key, message] of Object.entries(EN)) {
    if (only && !key.startsWith(`${only}.`)) continue;
    if (message.includes("'")) bad.push(`${key}: has '`);
    try {
      parse(message, "en");
    } catch (e) {
      bad.push(`${key}: ${(e as Error).message}`);
    }
  }
  expect(bad).toEqual([]);
});

it("uses every English key somewhere in the app", () => {
  const sources: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "messages") walk(path);
      } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) sources.push(readFileSync(path, "utf8"));
    }
  };
  walk(srcDir);
  const all = sources.join("\n");
  const unused = Object.keys(EN).filter(
    (key) =>
      (!only || key.startsWith(`${only}.`)) && !all.includes(`"${key}"`) && !all.includes(`'${key}'`) && !DYNAMIC_KEY_PREFIXES.some((prefix) => key.startsWith(prefix)),
  );
  expect(unused).toEqual([]);
});

it("pseudo-translates text but not arguments, plural keywords or tags", () => {
  expect(pseudoMessage("Open <link>Settings</link>")).toBe("[Öþéñ <link>Šéţţîñĝš</link>~~~~]");
  const plural = pseudoMessage("{count, plural, one {# row} other {# rows}}");
  expect(plural).toContain("{count, plural, one {# ŕöŵ} other {# ŕöŵš}}");
  expect(() => parse(plural, "en")).not.toThrow();
});

it("has every language translated from the English as it reads now", () => {
  if (only) return;
  const recorded = JSON.parse(readFileSync(join(here, "source-hashes.json"), "utf8")) as Record<string, string>;
  const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 12);
  const changed = Object.keys(EN).filter((key) => recorded[key] !== hash(EN[key]!));
  const dropped = Object.keys(recorded).filter((key) => !(key in EN));
  expect(
    { changed, dropped },
    "English changed since it was translated: translate these keys again in every language, then run pnpm --filter @stuga/web i18n:check --accept",
  ).toEqual({ changed: [], dropped: [] });
});
