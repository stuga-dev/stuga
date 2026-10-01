/**
 * The rule a password must meet to sign in at the remote address: at least REMOTE_MIN_CODE_POINTS
 * Unicode code points, and a zxcvbn score of at least REMOTE_MIN_SCORE. The node enforces it before
 * hashing; the web app runs the same function for the hint under a password field, with a superset
 * of the inputs, so a password the form says works from anywhere does.
 *
 * Only the first MAX_SCORED characters are scored, and the edit-distance matcher is off: it would
 * multiply the cost of a check the node runs before anyone has signed in.
 */
import { ZxcvbnFactory } from "@zxcvbn-ts/core";
import { adjacencyGraphs, dictionary } from "@zxcvbn-ts/language-common";

export const REMOTE_MIN_CODE_POINTS = 15;
export const REMOTE_MIN_SCORE = 3;
/** UTF-16 code units scored, never splitting a character. */
export const MAX_SCORED = 64;
/** The shortest piece of an input worth matching on its own. */
const MIN_WORD = 3;

/** Built once: the dictionaries are decompressed on first use and kept. */
let factory: ZxcvbnFactory | null = null;
function zxcvbn(): ZxcvbnFactory {
  factory ??= new ZxcvbnFactory({
    dictionary,
    graphs: adjacencyGraphs,
    maxLength: MAX_SCORED,
    useLevenshteinDistance: false,
  });
  return factory;
}

/** Characters as a person counts them: an emoji or an accented letter is one. */
export function codePoints(password: string): number {
  let n = 0;
  for (const _ of password) n += 1;
  return n;
}

/** The leading characters that fit in MAX_SCORED code units. */
function scored(password: string): string {
  let out = "";
  for (const ch of password) {
    if (out.length + ch.length > MAX_SCORED) break;
    out += ch;
  }
  return out;
}

export interface RemotePasswordResult {
  ok: boolean;
  codePoints: number;
  /** zxcvbn's 0-4; null when the password was too short to be worth scoring. */
  score: number | null;
  warning: string | null;
  suggestions: string[];
}

/** Whether `password` may be used to sign in at the remote address. Scores only what is long enough. */
export function remotePasswordOk(password: string, userInputs: readonly string[]): RemotePasswordResult {
  const count = codePoints(password);
  if (count < REMOTE_MIN_CODE_POINTS) return { ok: false, codePoints: count, score: null, warning: null, suggestions: [] };
  const result = zxcvbn().check(scored(password), [...userInputs]);
  return {
    ok: result.score >= REMOTE_MIN_SCORE,
    codePoints: count,
    score: result.score,
    warning: result.feedback.warning,
    suggestions: result.feedback.suggestions,
  };
}

export interface StrengthInputSource {
  /** Normalized, as typed or the account's. */
  username: string;
  nodeName?: string | null;
  /** The first label of the remote address's hostname. */
  hostLabel?: string | null;
  /** Only where the account is known: the web form's, never the node's before sign-in. */
  displayName?: string | null;
}

/**
 * What a guesser already knows, as zxcvbn's user inputs: each value whole and lowercased, and each
 * of its words of MIN_WORD or more characters, since zxcvbn matches an input only as a whole.
 */
export function strengthInputs(source: StrengthInputSource): string[] {
  const out = new Set<string>();
  for (const raw of [source.username, source.nodeName, source.hostLabel, source.displayName]) {
    const value = raw?.trim().toLowerCase();
    if (!value) continue;
    out.add(value);
    for (const word of value.split(/[\s\p{P}\p{S}]+/u)) {
      if (codePoints(word) >= MIN_WORD) out.add(word);
    }
  }
  return [...out];
}
