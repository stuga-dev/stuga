/**
 * The remote address's front door (docs/remote-access.md): what a request there gets before a byte
 * of its body is read. A visitor who has not signed in reaches only what signing in takes, each with
 * a small body; everything else needs a credential that works at this address first, and is refused
 * with the body unread and the connection closed when it has none. The node's own network has no
 * front door: what it answers there does not change.
 *
 *   pages and static files, GET /auth/*, discovery, /oauth/authorize, /oauth/client,
 *     /api/agent-install/*, media reads (their ticket is checked by the route)   open, no body
 *   POST /auth/login, register, reset, oidc/start, handoff, ticket, complete, link,
 *     passkey/options, passkey/sign-in                                               16 KiB
 *   POST /auth/refresh, /auth/logout (they present a session)                          4 KiB
 *   POST /oauth/register (and at most REGISTRATIONS_PER_HOUR an hour), token, revoke   16 KiB
 *   PUT of a signed upload                          its signature, for this address, first
 *   /mcp                                            a credential, or the OAuth challenge
 *   /.well-known/jwks.json, /.well-known/openid-configuration, /ready                  404
 *   everything else                                 a credential that works here, or 401
 *
 * A POST to /auth/* must also come from this address's own pages when it names an Origin, and be
 * JSON. Bodies of anonymous requests share the listener's budget (Admission.anonymous). A request
 * let through with a credential is authenticated again by its route; the second look costs one
 * query, and only for remote requests with a body.
 */
import { extractToken } from "@stuga/auth";
import { PASSWORD_PATHS, type PasswordNetworkCheck } from "../identity/off-network.js";
import { MEDIA_GET_PATH } from "@stuga/protocol/api/media";
import { bearerAuthenticates } from "../auth/context.js";
import { verifyUpload } from "../databases/imports/format.js";
import type { NodeEnv } from "../env.js";
import { mediaUploadSigned } from "../media/uploads.js";
import { unauthorizedChallenge } from "../mcp/oauth.js";
import type { Admission, FrontDoor } from "../platform/http-server.js";
import { arrivalOf, servedOrigin } from "./arrival.js";
import { isAppPath } from "./dispatch.js";
import { error } from "./respond.js";
import { matchRoute } from "./router.js";
import { APP_ROUTES, DATABASE_IMPORT_UPLOAD_PATH, MEDIA_UPLOAD_PATH } from "./routes.js";

/** A sign-in's body: a username, a password, a ticket or two. */
export const PUBLIC_BODY_BYTES = 16 * 1024;
/** A refresh token and little else. */
export const SESSION_BODY_BYTES = 4 * 1024;
/** Clients registered at the remote address in any hour; DCR takes no credential by design (RFC 7591). */
export const REGISTRATIONS_PER_HOUR = 200;

/** Answered by nothing at the remote address: the issuer documents name PUBLIC_ORIGIN, and readiness is the LAN's. */
const GONE = new Set(["/.well-known/jwks.json", "/.well-known/openid-configuration", "/ready"]);

const SIGN_IN = new Set([
  "/auth/login",
  "/auth/register",
  "/auth/reset",
  "/auth/oidc/start",
  "/auth/oidc/handoff",
  "/auth/oidc/ticket",
  "/auth/oidc/complete",
  "/auth/oidc/link",
  "/auth/passkey/options",
  "/auth/passkey/sign-in",
]);
const SESSION = new Set(["/auth/refresh", "/auth/logout"]);
const OAUTH = new Set(["/oauth/register", "/oauth/token", "/oauth/revoke"]);

/** Bodyless app paths anyone may ask for; GET /auth/* and the app's pages are open too. */
const OPEN_READS: readonly (string | RegExp)[] = [
  "/.well-known/oauth-authorization-server",
  /^\/\.well-known\/oauth-protected-resource(?:\/mcp)?$/,
  "/oauth/authorize",
  "/oauth/client",
  /^\/api\/agent-install\/[^/]+$/,
  MEDIA_GET_PATH,
];

const BODYLESS = new Set(["GET", "HEAD", "OPTIONS"]);

const isAuthPath = (path: string): boolean => path === "/auth" || path.startsWith("/auth/");
const matches = (path: string, patterns: readonly (string | RegExp)[]): boolean =>
  patterns.some((p) => (typeof p === "string" ? p === path : p.test(path)));

/** The media type of a Content-Type header, lowercase, without its parameters. */
function mediaType(header: string | null): string {
  return (header ?? "").split(";")[0]!.trim().toLowerCase();
}

export interface FrontDoorDeps {
  env: NodeEnv;
  /** Registrations an hour; REGISTRATIONS_PER_HOUR by default. */
  registrationsPerHour?: number;
  /** Epoch milliseconds. Tests. */
  now?: () => number;
}

export function createFrontDoor(deps: FrontDoorDeps): FrontDoor {
  const { env } = deps;
  const now = deps.now ?? Date.now;
  const perHour = deps.registrationsPerHour ?? REGISTRATIONS_PER_HOUR;
  /** When each registration admitted in the last hour came, oldest first. */
  const registrations: number[] = [];

  const open: Admission = {};
  const anonymous = (maxBytes: number): Admission => ({ maxBytes, anonymous: true });
  const unauthorized = (): Response => error(401, "sign in first");

  /** One more client registration, or the 429 that says when the hour has room again. */
  function registration(): Response | null {
    const t = now();
    while (registrations.length > 0 && registrations[0]! <= t - 3_600_000) registrations.shift();
    if (registrations.length >= perHour) {
      const res = error(429, "too many client registrations; try again later");
      res.headers.set("retry-after", String(Math.max(1, Math.ceil((registrations[0]! + 3_600_000 - t) / 1000))));
      return res;
    }
    registrations.push(t);
    return null;
  }

  /** What /auth/* takes at the remote address before anything else: this address's own pages, sending JSON. */
  function authPostRefusal(head: Request): Response | null {
    const origin = head.headers.get("origin");
    if (origin && origin !== servedOrigin(head)) return error(403, "origin not allowed");
    if (mediaType(head.headers.get("content-type")) !== "application/json") return error(415, "expected application/json");
    return null;
  }

  /** A credential that works at this address, or the refusal. */
  async function credentialed(head: Request, path: string, verify: boolean): Promise<Admission | Response> {
    const refuse = (): Response => (path === "/mcp" ? unauthorizedChallenge(env, head) : unauthorized());
    if (!extractToken(head)) return refuse();
    if (verify && !(await bearerAuthenticates(head, env))) return refuse();
    return open;
  }

  return async (head) => {
    const url = new URL(head.url);
    const path = url.pathname;
    const method = head.method.toUpperCase();
    if (GONE.has(path)) return error(404, "not found");

    if (BODYLESS.has(method)) {
      // A preflight carries no credential, and the app's pages and sign-in reads need none.
      if (method === "OPTIONS" || isAuthPath(path) || !isAppPath(method, path) || matches(path, OPEN_READS)) return open;
      // The route checks the credential itself, so here it need only be there; a route that would not
      // check one (/api/models) has it checked here.
      const found = matchRoute(APP_ROUTES, method, path);
      return credentialed(head, path, found?.route.auth === "none");
    }

    if (isAuthPath(path)) {
      if (method === "POST") {
        const refused = authPostRefusal(head);
        if (refused) return refused;
        if (SIGN_IN.has(path)) return anonymous(PUBLIC_BODY_BYTES);
        if (SESSION.has(path)) return anonymous(SESSION_BODY_BYTES);
      }
      return credentialed(head, path, true);
    }
    if (method === "POST" && OAUTH.has(path)) {
      if (path === "/oauth/register") {
        const limited = registration();
        if (limited) return limited;
      }
      return anonymous(PUBLIC_BODY_BYTES);
    }
    // Sign-out clears the media cookie whether or not the session it belonged to is still on.
    if (method === "DELETE" && path === "/api/media/ticket") return anonymous(SESSION_BODY_BYTES);
    if (method === "PUT") {
      // Checked as the route checks it, on the path's own segments.
      const sig = url.searchParams.get("sig");
      const upload = MEDIA_UPLOAD_PATH.exec(path);
      if (upload) {
        return mediaUploadSigned(env.internalSecret, arrivalOf(head), upload[1]!, upload[2]!, sig)
          ? open
          : error(403, "invalid upload signature");
      }
      const imported = DATABASE_IMPORT_UPLOAD_PATH.exec(path);
      if (imported) {
        return verifyUpload(env.internalSecret, arrivalOf(head), imported[1]!, imported[2]!, sig)
          ? open
          : error(403, "invalid upload signature");
      }
    }
    return credentialed(head, path, true);
  };
}

/**
 * The node's own network has no front door but this: over plain http, a password from outside that
 * network is refused before it is read (../identity/off-network.ts). Everything else goes on as it was.
 */
export function createLocalFrontDoor(check: PasswordNetworkCheck): FrontDoor {
  const open: Admission = {};
  return async (head) => {
    if (head.method.toUpperCase() !== "POST" || !PASSWORD_PATHS.has(new URL(head.url).pathname)) return open;
    return check(head) ?? open;
  };
}
