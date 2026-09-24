/**
 * The headers every answer carries, applied to the composed handler rather than
 * per route. A header a handler already set is kept, so nothing here can widen
 * a policy it chose (the media route's `default-src 'none'; sandbox`).
 *
 * Deliberately not sent: HSTS (plain HTTP on a LAN address is supported, and
 * HSTS pins every port of a hostname); Cross-Origin-Resource-Policy (the media
 * route picks its own, and a blanket value would be an allow-set EXTRA_ORIGINS
 * cannot widen); Cross-Origin-Opener-Policy (it severs the window reference an
 * MCP client's OAuth popup relies on).
 */
import type { RequestHandler } from "../platform/http-server.js";
import { CONSENT_PATH } from "../mcp/oauth.js";

/** Nothing this node serves is meant to be framed. */
const FRAME_ANCESTORS = "frame-ancestors 'none'";

/** Applied to a response that does not already carry the name. */
const DEFAULT_HEADERS: Record<string, string> = {
  // For browsers that predate frame-ancestors.
  "x-frame-options": "DENY",
  "content-security-policy": FRAME_ANCESTORS,
  // Minted URLs carry ids and tokens, and consent ends in a navigation that would
  // hand the client the whole authorization request as a Referer.
  "referrer-policy": "no-referrer",
  // The bundle and the API share an origin, so a response sniffed as HTML runs as the app.
  "x-content-type-options": "nosniff",
};

/**
 * Stamp the policy onto one answer and return the same object: an upgrade
 * response carries its socket on the object and cannot be rebuilt.
 */
export function applySecurityHeaders(request: Request, response: Response): Response {
  const headers = response.headers;

  // The consent screen grants agents standing access, so it is never framed,
  // whatever its handler asked for. Appended: a second policy can only narrow the first.
  if (new URL(request.url).pathname === CONSENT_PATH) {
    headers.set("x-frame-options", "DENY");
    headers.append("content-security-policy", FRAME_ANCESTORS);
  }

  for (const [name, value] of Object.entries(DEFAULT_HEADERS)) {
    if (!headers.has(name)) headers.set(name, value);
  }
  return response;
}

/** Wrap a handler so every answer it gives goes out with the headers above. */
export function withSecurityHeaders(handler: RequestHandler): RequestHandler {
  return async (request) => applySecurityHeaders(request, await handler(request));
}
