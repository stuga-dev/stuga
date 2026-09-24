/**
 * Per-principal budgets at the front door. The key is the credential, never the
 * IP: agents share data-centre addresses, and one person arrives from several.
 */
import { slidingWindowRateLimiter, type RateLimiter } from "../platform/rate-limit.js";
import { error } from "./respond.js";
import type { NodeEnv } from "../env.js";

const WINDOW_SECONDS = 60;
/** Requests per principal per window on the ordinary budget. */
const STANDARD_LIMIT = 600;
/**
 * Credential attempts per window, per source address and per targeted account:
 * the endpoints worth guessing against, loose enough for a household behind one NAT.
 */
const AUTH_LIMIT = 20;

/** The ordinary budget, and a separate one for the credential endpoints so neither can starve the other. */
export function createRateLimiters(): { standard: RateLimiter; auth: RateLimiter } {
  return {
    standard: slidingWindowRateLimiter({ limit: STANDARD_LIMIT, windowSeconds: WINDOW_SECONDS }),
    auth: slidingWindowRateLimiter({ limit: AUTH_LIMIT, windowSeconds: WINDOW_SECONDS }),
  };
}

/**
 * A 429 to answer with, or null to proceed. `principal` identifies the
 * credential (an agent's alias is its agent id), so a runaway agent does not
 * lock its human out; the workspace scopes it, so one tenant cannot stall another.
 */
export async function rateLimitRefusal(
  env: Pick<NodeEnv, "rateLimit">,
  principal: string,
  workspaceId: string,
): Promise<Response | null> {
  if ((await env.rateLimit.limit({ key: `${workspaceId}:${principal}` })).success) return null;
  const res = error(429, "too many requests; slow down and retry shortly");
  // The whole window: the limiter reports no reset instant, and retrying early only re-trips it.
  res.headers.set("retry-after", String(WINDOW_SECONDS));
  return res;
}
