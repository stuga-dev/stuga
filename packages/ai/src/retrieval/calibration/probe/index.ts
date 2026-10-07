/**
 * The texts a node embeds to measure its model: in each of eight languages, the same 32 topics in 8
 * domains, each with two queries typed as in a search box, one question, and two passages written
 * like workspace content. A query and a passage from different domains are unrelated by
 * construction (probe.test.ts checks they share no content words); a query and its own topic's
 * passages are related. Every text is written for Stuga, natively in each language.
 */
import { ar } from "./ar.js";
import { de } from "./de.js";
import { en } from "./en.js";
import { es } from "./es.js";
import { ja } from "./ja.js";
import { ko } from "./ko.js";
import { ru } from "./ru.js";
import { zh } from "./zh.js";

export const PROBE_LANGUAGES = ["en", "es", "de", "ru", "ar", "zh", "ja", "ko"] as const;
export type ProbeLanguageCode = (typeof PROBE_LANGUAGES)[number];

/** Eight domains of four topics, the same ids in every language. */
export const PROBE_TOPICS = {
  food: ["sourdough-starter", "pickling", "coffee-brewing", "cast-iron-care"],
  sport: ["offside-rule", "chess-openings", "marathon-training", "tennis-serve"],
  "money-law-work": ["tenancy-deposit", "income-tax-filing", "parental-leave", "invoice-dispute"],
  health: ["kidney-stones", "sprained-ankle", "hay-fever", "tooth-filling"],
  "nature-space": ["volcanoes", "bird-migration", "satellite-orbits", "ocean-tides"],
  "machines-software": ["database-indexes", "bicycle-gears", "password-managers", "printer-jams"],
  "arts-history-language": ["jazz-voicings", "camera-exposure", "roman-roads", "verb-conjugation"],
  "home-garden-craft": ["leaking-tap", "beekeeping", "knitting", "composting"],
} as const;

export type ProbeDomain = keyof typeof PROBE_TOPICS;

/** Topic ids in grid order: "food.sourdough-starter", … */
export const PROBE_TOPIC_IDS: readonly string[] = Object.entries(PROBE_TOPICS).flatMap(([d, ts]) => ts.map((t) => `${d}.${t}`));

export interface ProbePassage {
  title: string;
  /** Null for a document's first chunk; a heading path ("Section > Subsection") for a later one. */
  headingPath: string | null;
  body: string;
}

export interface ProbeTopic {
  /** "food.sourdough-starter": the same in every language. */
  id: string;
  /** Typed as in a search box: `queryStyle` calls each "short". */
  short: [string, string];
  /** Asked as in Ask or by an agent: `queryStyle` calls it a "question". */
  question: string;
  /** A first chunk (headingPath null) and a later chunk. */
  passages: [ProbePassage, ProbePassage];
}

export interface ProbeLanguage {
  lang: ProbeLanguageCode;
  /** In PROBE_TOPIC_IDS order. */
  topics: ProbeTopic[];
}

export const PROBE: readonly ProbeLanguage[] = [en, es, de, ru, ar, zh, ja, ko];

/** A topic's domain, from its id. */
export function domainOf(topicId: string): ProbeDomain {
  return topicId.slice(0, topicId.indexOf(".")) as ProbeDomain;
}

/**
 * The body length a passage should have: tier (topic index + passage index) mod 3, so every tier
 * holds first and later chunks. Bounds are for alphabetic scripts; Korean is half, and Chinese and
 * Japanese about a third, so their token counts stay comparable.
 */
export function lengthBounds(lang: ProbeLanguageCode, topicIndex: number, passageIndex: number): [number, number] {
  const tier = ([[200, 400], [900, 1500], [3000, 4000]] as const)[(topicIndex + passageIndex) % 3]!;
  const scale = lang === "ko" ? 0.5 : lang === "zh" || lang === "ja" ? 0.35 : 1;
  return [Math.round(tier[0] * scale), Math.round(tier[1] * scale)];
}
