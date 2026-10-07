/**
 * The probe's own rules: every language has every topic in grid order, passages fit their length
 * tier, queries are typed or asked as their style says, and a query shares no content word with a
 * passage it is paired with as unrelated. PROBE_LANG=ko checks one language while it is written.
 */
import { describe, expect, it } from "vitest";
import { chunkEmbedInput } from "../../chunk.js";
import { queryStyle } from "../../cutoff.js";
import { PROBE, PROBE_LANGUAGES, PROBE_TOPIC_IDS, domainOf, lengthBounds, type ProbeLanguage } from "./index.js";

const only = process.env.PROBE_LANG;
const languages = PROBE.filter((l) => !only || l.lang === only);

/** A passage as the node embeds it. */
const embedded = (p: ProbeLanguage["topics"][number]["passages"][number], first: boolean) => chunkEmbedInput(p.title, p.headingPath, p.body, first);

const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]+/gu;
const HANGUL_RUN = /\p{Script=Hangul}+/gu;
const WORD = /[\p{L}\p{N}]+/gu;
const ARABIC_ARTICLE = /^(وال|بال|فال|كال|لل|ال)/;

/**
 * Content tokens: character bigrams where words run together (Chinese, Japanese) or carry
 * particles (Korean), else words of three letters or more, cut to six characters so inflected forms
 * of one word meet. Digits alone are not content.
 */
function tokens(text: string): Set<string> {
  const s = text.normalize("NFKC").toLowerCase();
  const out = new Set<string>();
  const bigrams = (run: string) => {
    const cs = [...run];
    for (let i = 0; i + 1 < cs.length; i++) out.add(cs[i]! + cs[i + 1]!);
  };
  for (const m of s.matchAll(CJK_RUN)) bigrams(m[0]);
  for (const m of s.matchAll(HANGUL_RUN)) bigrams(m[0]);
  for (const m of s.replace(CJK_RUN, " ").replace(HANGUL_RUN, " ").matchAll(WORD)) {
    const w = m[0].replace(ARABIC_ARTICLE, "");
    if ([...w].length < 3 || /^\p{N}+$/u.test(w)) continue;
    out.add([...w].length >= 7 ? [...w].slice(0, 6).join("") : w);
  }
  return out;
}

describe.each(languages)("probe $lang", (L) => {
  it("is one of the probe's languages and has every topic in grid order", () => {
    expect(PROBE_LANGUAGES).toContain(L.lang);
    expect(L.topics.map((t) => t.id)).toEqual(PROBE_TOPIC_IDS);
  });

  it("gives each passage a title, a later chunk a heading path, and fits each body to its tier", () => {
    const off: string[] = [];
    L.topics.forEach((t, ti) => {
      t.passages.forEach((p, pi) => {
        if (!p.title.trim()) off.push(`${t.id}[${pi}]: no title`);
        if ((pi === 0) !== (p.headingPath === null)) off.push(`${t.id}[${pi}]: ${pi === 0 ? "first chunk has a heading path" : "later chunk needs a heading path"}`);
        const [lo, hi] = lengthBounds(L.lang, ti, pi);
        const n = [...p.body].length;
        if (n < lo || n > hi) off.push(`${t.id}[${pi}]: body ${n} characters, wants ${lo}-${hi}`);
      });
    });
    expect(off).toEqual([]);
  });

  it("types short queries as a search box gets them and asks questions as Ask does", () => {
    const off = L.topics.flatMap((t) => [
      ...t.short.filter((q) => queryStyle(q) !== "short").map((q) => `${t.id} short: ${q}`),
      ...(queryStyle(t.question) === "question" ? [] : [`${t.id} question: ${t.question}`]),
    ]);
    expect(off).toEqual([]);
  });

  it("repeats no text", () => {
    const all = L.topics.flatMap((t) => [...t.short, t.question, ...t.passages.map((p) => p.body)]);
    expect(new Set(all).size).toBe(all.length);
  });

  it("pairs no query with a passage of another domain that shares a content word", () => {
    const passages = L.topics.flatMap((t) => t.passages.map((p, pi) => ({ topic: t.id, pi, tokens: tokens(embedded(p, pi === 0)) })));
    // A token in more than a quarter of the passages is a function word of the language, not content.
    const df = new Map<string, number>();
    for (const p of passages) for (const tok of p.tokens) df.set(tok, (df.get(tok) ?? 0) + 1);
    const common = new Set([...df].filter(([, n]) => n > passages.length / 4).map(([tok]) => tok));
    const clashes: string[] = [];
    for (const t of L.topics) {
      for (const q of [...t.short, t.question]) {
        const qt = [...tokens(q)].filter((tok) => !common.has(tok));
        for (const p of passages) {
          if (domainOf(p.topic) === domainOf(t.id)) continue;
          const shared = qt.filter((tok) => p.tokens.has(tok));
          if (shared.length) clashes.push(`"${q}" (${t.id}) ~ ${p.topic}[${p.pi}]: ${shared.join(", ")}`);
        }
      }
    }
    expect(clashes).toEqual([]);
  });
});
