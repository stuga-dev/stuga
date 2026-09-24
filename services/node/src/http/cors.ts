/** The origin gate and the CORS headers, decided once per request by the dispatcher. */
import { isIpLiteral, isLocalName } from "../net/addresses.js";
import { REQUEST_HOST_HEADER } from "../platform/http-server.js";

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
  "access-control-allow-headers": "authorization,content-type,x-stuga-workspace",
  // Every custom header the browser client reads; an unexposed one reads back as null cross-origin.
  "access-control-expose-headers": "x-stuga-user,x-stuga-name,x-request-id,x-stuga-workspace-required",
};

interface CorsEnv {
  publicOrigin: string;
  extraOrigins: readonly string[];
}

/**
 * The request's Origin when it is the public origin or one the operator listed,
 * by exact match, or the address the request itself went to on a local network;
 * otherwise null. Null also means no Origin was sent, so callers tell a refusal
 * apart by reading the header themselves.
 */
export function allowedCorsOrigin(req: Request, env: CorsEnv): string | null {
  const requested = req.headers.get("origin");
  if (!requested) return null;
  if (requested === env.publicOrigin || env.extraOrigins.includes(requested)) return requested;
  return sameAddressHere(requested, req, env) ? requested : null;
}

/**
 * The page was served by this node at the very address the request went to: its Origin is the
 * request's own scheme and Host. So a phone that opens the node by its IP address works without
 * that address in EXTRA_ORIGINS. Only for an address a stranger cannot name: an IP literal, or a
 * name that resolves only on this machine or its network (localhost, .local, .home.arpa). A public
 * name could be DNS rebinding, a page on a stranger's name pointed at this node, where Origin and
 * Host agree too.
 */
function sameAddressHere(origin: string, req: Request, env: CorsEnv): boolean {
  const host = req.headers.get(REQUEST_HOST_HEADER);
  if (!host) return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== new URL(env.publicOrigin).protocol) return false;
  if (url.host !== host.toLowerCase()) return false;
  return isIpLiteral(url.hostname) || isLocalName(url.hostname);
}

/**
 * Stamp the CORS decision onto a response, in place. Credentials are allowed
 * because `origin` is only ever an echoed allowed origin, and the media-ticket
 * call needs its cookie.
 */
export function withCors(res: Response, origin: string | null): Response {
  const headers = res.headers;
  if (origin) {
    for (const [name, value] of Object.entries(CORS_HEADERS)) headers.set(name, value);
    headers.set("access-control-allow-origin", origin);
    headers.set("access-control-allow-credentials", "true");
  }
  headers.set("vary", "Origin");
  return res;
}

// A refused browser sees a bare CORS failure, so the node says why, once per
// origin. Capped because the origin is an untrusted header; JSON.stringify
// escapes the newlines that would forge log lines.
const REPORTED_ORIGIN_CAP = 20;
const reportedOrigins = new Set<string>();

export function reportRefusedOrigin(requested: string, env: CorsEnv): void {
  if (reportedOrigins.has(requested) || reportedOrigins.size > REPORTED_ORIGIN_CAP) return;
  reportedOrigins.add(requested);
  if (reportedOrigins.size > REPORTED_ORIGIN_CAP) {
    console.warn("[node] too many distinct refused origins; further ones are not reported");
    return;
  }
  console.warn(
    `[node] refused browser origin ${JSON.stringify(requested)}; this node's PUBLIC_ORIGIN is ${env.publicOrigin}. ` +
      "Every request URL is rebuilt on PUBLIC_ORIGIN, so it is also the origin allow-set — if that is where people " +
      "are meant to reach this node, set PUBLIC_ORIGIN to match, or add this origin to EXTRA_ORIGINS to answer at " +
      "both. See docs/network-access.md.",
  );
}
