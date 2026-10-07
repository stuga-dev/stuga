/**
 * How far a match by meaning may sit in the search box, as a level: the node measures its embedding
 * model and puts each level at the distance below which that share of unrelated text falls.
 * `custom` is a distance set by hand through the API.
 */
export const SEARCH_STRICTNESS_LEVELS = ["strict", "balanced", "loose", "off"] as const;
export type SearchStrictnessLevel = (typeof SEARCH_STRICTNESS_LEVELS)[number];
export type SearchStrictness = SearchStrictnessLevel | "custom";

export const DEFAULT_SEARCH_STRICTNESS: SearchStrictnessLevel = "balanced";

export function isSearchStrictness(v: unknown): v is SearchStrictness {
  return v === "custom" || (SEARCH_STRICTNESS_LEVELS as readonly unknown[]).includes(v);
}
