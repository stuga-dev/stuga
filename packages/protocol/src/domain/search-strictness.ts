/**
 * How far a match by meaning may sit in the search box, as a level: the node measures its embedding
 * model and puts each level at the distance below which that share of unrelated text falls.
 */
export const SEARCH_STRICTNESS_LEVELS = ["strict", "balanced", "loose", "off"] as const;
export type SearchStrictness = (typeof SEARCH_STRICTNESS_LEVELS)[number];

export const DEFAULT_SEARCH_STRICTNESS: SearchStrictness = "balanced";

export function isSearchStrictness(v: unknown): v is SearchStrictness {
  return (SEARCH_STRICTNESS_LEVELS as readonly unknown[]).includes(v);
}
