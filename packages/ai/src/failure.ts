/**
 * A model call that failed: the provider's own words for the node's log, and
 * plain words for the person who asked, who never sees the provider's.
 */

/** What went wrong. `cut_off` and `unparseable` are answers that arrived but could not be used. */
export type ModelFailureKind = "quota" | "auth" | "rate_limit" | "unavailable" | "rejected" | "cut_off" | "unparseable" | "error";

export interface ModelFailure {
  kind: ModelFailureKind;
  /** e.g. openai-completions or systemone; null when no endpoint could be resolved. */
  protocol: string | null;
  model: string;
  /** The provider's message, without the key. For the log only: it can name an account. */
  message: string;
}

/** Checked before the status: running out of credit comes back as a 400, 402, 403 or 429. */
const QUOTA =
  /insufficient[_ ]quota|exceeded[_ ]current[_ ]quota|exceeded your current quota|credit balance|no credits|insufficient (?:balance|credits?|funds)|billing|payment required/i;
const AUTH = /invalid[_ ]api[_ ]key|incorrect api key|authentication|unauthori[sz]ed/i;
const RATE_LIMIT = /rate[_ ]?limit|too many requests/i;
/** Only for a failure with no status: the request never got an answer. */
const NO_ANSWER = /connection|network|timed? ?out|fetch failed|socket|terminated|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i;

/** The status leading an SDK's message: "401 …", "401: …", "OpenAI API error (429): …", "systemone 401: …". */
function statusOf(message: string): number | undefined {
  const m = /^(?:[^(:\d]*\(|\w+ )?([1-5]\d\d)\b/.exec(message);
  return m ? Number(m[1]) : undefined;
}

/** From the status, given or leading the message, and the provider's words. */
export function classifyFailure(message: string, status?: number): ModelFailureKind {
  const s = status || statusOf(message);
  if (s === 402 || QUOTA.test(message)) return "quota";
  if (s === 401 || s === 403 || AUTH.test(message)) return "auth";
  if (s === 429 || RATE_LIMIT.test(message)) return "rate_limit";
  if (s === undefined ? NO_ANSWER.test(message) : s === 408 || s >= 500) return "unavailable";
  return s !== undefined && s >= 400 ? "rejected" : "error";
}

/** A refused or failed request, classified; `key` is cut from the message wherever the provider echoed it. */
export function requestFailure(
  protocol: string | null,
  model: string,
  message: string,
  opts: { key?: string; status?: number } = {},
): ModelFailure {
  const key = opts.key ?? "";
  const clean = key.length >= 8 ? message.split(key).join("[key]") : message;
  return { kind: classifyFailure(clean, opts.status), protocol, model, message: clean };
}

const CHECK_SETTINGS = "An administrator can check Settings → This node → AI providers.";

/** The failure in plain words for whoever asked; null when there are none better than "it failed". */
export function failureReason(failure: ModelFailure | undefined): string | null {
  switch (failure?.kind) {
    case "quota":
      return `The AI provider says the account is out of credit. ${CHECK_SETTINGS}`;
    case "auth":
      return `The AI provider did not accept this node's key. ${CHECK_SETTINGS}`;
    case "rate_limit":
      return "The AI provider is limiting requests. Try again in a minute.";
    case "unavailable":
      return "The AI provider is unavailable right now. Try again shortly.";
    default:
      return null;
  }
}
