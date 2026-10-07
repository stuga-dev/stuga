/**
 * The search box's cutoff by meaning. A node measures its embedding model (calibration/) and keeps
 * one distance for typed searches and one for questions, since a short query and a long one sit at
 * different distances from unrelated text.
 */

/** The cosine distance a semantic match must stay under, for each style of query. */
export interface SearchCutoff {
  short: number;
  question: number;
}

export type QueryStyle = keyof SearchCutoff;

/** Scripts written without spaces between words, where a query is counted in characters. */
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;

/**
 * "short" for what people type in a search box: no question mark, at most four words, and, in
 * Chinese, Japanese or Thai, at most eight characters. Anything longer is a "question".
 */
export function queryStyle(q: string): QueryStyle {
  const text = q.trim();
  if (/[?？]/.test(text)) return "question";
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length > 4) return "question";
  if (UNSPACED.test(text) && [...text.replace(/\s+/g, "")].length > 8) return "question";
  return "short";
}

/** The distance in force for this query, or null when nothing is dropped by distance. */
export function cutoffFor(q: string, cutoff: SearchCutoff | null): number | null {
  return cutoff ? cutoff[queryStyle(q)] : null;
}
