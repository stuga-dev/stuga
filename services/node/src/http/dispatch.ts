/**
 * The node's front door: decides who answers a request (identity router, route
 * table or app bundle) and applies what every answer shares — security headers,
 * the origin gate and CORS, the credential a route asks for, the per-principal
 * budget, the denial ledger and the mapping of a failed context to a response.
 */
import {
  buildAccountContext,
  buildContext,
  buildSocketContext,
  Unauthorized,
  WorkspaceRequired,
  workspaceRequiredResponse,
  type Ctx,
  type Transport,
} from "../auth/context.js";
import { verifyWsTicket } from "../auth/ws-ticket.js";
import { noteDenial } from "../audit/record.js";
import { isWorkspaceAdmin, nodeAdminRequired, READ_ONLY_MESSAGE } from "../authz/authz.js";
import { routeWebSocket } from "../api/ws.js";
import type { NodeEnv } from "../env.js";
import type { IdentityRouter } from "../identity/index.js";
import { requestId } from "../ids.js";
import { unauthorizedChallenge } from "../mcp/oauth.js";
import type { RequestHandler } from "../platform/http-server.js";
import { allowedCorsOrigin, reportRefusedOrigin, withCors } from "./cors.js";
import { rateLimitRefusal } from "./rate-limit.js";
import { error } from "./respond.js";
import { matchRoute, type AccountCall, type PublicCall, type Route, type WorkspaceCall } from "./router.js";
import { APP_ROUTES } from "./routes.js";
import { withSecurityHeaders } from "./security-headers.js";

type Handler<C> = (call: C) => Promise<Response>;

interface Gates {
  /** Refuse an agent credential with this sentence. */
  humanOnly?: string;
  /** Not a GET, yet open to a read-only key: it only reads, or it changes only the key's own Ask threads. */
  readOnlyKeys?: true;
  /** Refuse a guest; the sentence completes "guests cannot …". */
  guestForbidden?: string;
  /** Only a workspace owner or admin; the sentence completes "only a workspace owner or admin can …". */
  workspaceAdmin?: string;
  /** Only a node administrator. */
  nodeAdmin?: boolean;
}

export type AppRoute = Route &
  Gates &
  (
    | { auth: "none"; handler: Handler<PublicCall> }
    | { auth: "account"; handler: Handler<AccountCall> }
    | {
        auth: "workspace";
        handler: Handler<WorkspaceCall>;
        /** The /mcp endpoint: its 401 starts OAuth discovery, and its responses carry no identity headers. */
        transport?: "mcp";
        /** No per-principal budget, no identity headers, no denial ledger (the media ticket the SPA mints at boot). */
        unmetered?: boolean;
      }
  );

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** The three handlers that answer an ordinary request, in the order they are asked. */
interface NodeRoutes {
  identity: Pick<IdentityRouter, "matches" | "handle">;
  app: Pick<App, "handle">;
  /** The built app bundle, which answers everything left over. */
  spa: RequestHandler;
}

/** Paths under an API prefix that the app bundle renders: the API answers the consent screen's POST, a person opens its GET. */
function isAppOwnedPage(method: string, pathname: string): boolean {
  return method === "GET" && pathname === "/oauth/consent";
}

const APP_PREFIXES = ["/api", "/mcp", "/oauth", "/ready", "/ws"];

export function isAppPath(method: string, pathname: string): boolean {
  if (isAppOwnedPage(method, pathname)) return false;
  if (pathname.startsWith("/.well-known/oauth-")) return true;
  return APP_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

/** One entry point for every ordinary request, wrapped once so no path is served without the security headers. */
export function createRequestHandler(routes: NodeRoutes): RequestHandler {
  return withSecurityHeaders(async (req) => {
    const pathname = new URL(req.url).pathname;
    if (routes.identity.matches(pathname)) return routes.identity.handle(req);
    if (isAppPath(req.method, pathname)) return routes.app.handle(req);
    return routes.spa(req);
  });
}

interface App {
  /** Answer an ordinary HTTP request. */
  handle(req: Request): Promise<Response>;
  /** Answer a WebSocket upgrade (`/ws/:docId`) with the actor's upgrade response. */
  upgrade(req: Request): Promise<Response>;
}

export function createApp(env: NodeEnv): App {
  return {
    handle: (req) => handle(req, env),
    upgrade: (req) => upgrade(req, env),
  };
}

async function handle(req: Request, env: NodeEnv): Promise<Response> {
  const requested = req.headers.get("origin");
  const origin = allowedCorsOrigin(req, env);
  // Refused before auth or any route runs; non-browser clients send no Origin.
  if (requested && !origin) {
    reportRefusedOrigin(requested, env);
    return withCors(error(403, "origin not allowed"), null);
  }
  return withCors(await answer(req, env), origin);
}

async function answer(req: Request, env: NodeEnv): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });
  const url = new URL(req.url);
  const found = matchRoute(APP_ROUTES, req.method, url.pathname);
  if (!found) return error(404, "not found");
  const { route, match } = found;
  switch (route.auth) {
    case "none":
      try {
        return await route.handler({ env, req, url, match });
      } catch (e) {
        return unexpectedError(e, { req });
      }
    case "account":
      return accountRequest(route, { req, url, match }, env);
    case "workspace":
      return workspaceRequest(route, { req, url, match }, env);
  }
}

type Unauthed = Omit<WorkspaceCall, "ctx">;

async function accountRequest(route: Extract<AppRoute, { auth: "account" }>, call: Unauthed, env: NodeEnv): Promise<Response> {
  const { req, url } = call;
  let ctx;
  try {
    ctx = await buildAccountContext(req, env);
  } catch (e) {
    return contextFailure(e, "http", env, req);
  }
  // No membership exists yet, so the alias alone keys the budget.
  const limited = await rateLimitRefusal(env, ctx.alias, "account");
  if (limited) {
    noteDenial(ctx, limited, { method: req.method, path: url.pathname });
    return limited;
  }
  const reqId = requestId();
  ctx.requestId = reqId;
  try {
    const res = route.humanOnly && ctx.isAgent ? error(403, route.humanOnly) : await route.handler({ ...call, ctx });
    stampIdentity(res, ctx.alias, ctx.displayName, reqId);
    noteDenial(ctx, res, { method: req.method, path: url.pathname, requestId: reqId });
    return res;
  } catch (e) {
    return unexpectedError(e, { id: reqId, req });
  }
}

async function workspaceRequest(route: Extract<AppRoute, { auth: "workspace" }>, call: Unauthed, env: NodeEnv): Promise<Response> {
  const { req, url } = call;
  const transport: Transport = route.transport ?? "http";
  let ctx: Ctx;
  try {
    ctx = await buildContext(req, env, transport);
  } catch (e) {
    return contextFailure(e, transport, env, req);
  }
  if (route.unmetered) {
    try {
      return await route.handler({ ...call, ctx });
    } catch (e) {
      return unexpectedError(e, { req });
    }
  }
  const limited = await rateLimitRefusal(env, ctx.alias, ctx.workspaceId);
  if (limited) {
    noteDenial(ctx, limited, { method: req.method, path: url.pathname });
    return limited;
  }
  if (transport === "mcp") {
    try {
      return await route.handler({ ...call, ctx });
    } catch (e) {
      return unexpectedError(e, { req });
    }
  }
  const reqId = requestId();
  // On the context, so a ledger row the route writes names the request the response names.
  ctx.requestId = reqId;
  try {
    const res = await runWorkspaceRoute(route, { ...call, ctx });
    stampIdentity(res, ctx.alias, ctx.displayName, reqId);
    noteDenial(ctx, res, { method: req.method, path: url.pathname, requestId: reqId });
    return res;
  } catch (e) {
    return unexpectedError(e, { id: reqId, req, workspaceId: ctx.workspaceId });
  }
}

/** The refusal of the first gate a workspace route declares that this call fails, in the order they apply, or null. */
export async function gateRefusal(route: Gates, ctx: Ctx, method: string): Promise<Response | null> {
  // A read-only key never writes, whatever route it names.
  if (ctx.isAgent && ctx.scope?.readOnly && !(SAFE_METHODS.has(method) || route.readOnlyKeys)) {
    return error(403, READ_ONLY_MESSAGE);
  }
  if (route.humanOnly && ctx.isAgent) return error(403, route.humanOnly);
  if (route.guestForbidden && ctx.role === "guest") return error(403, `guests cannot ${route.guestForbidden}`);
  if (route.workspaceAdmin && !isWorkspaceAdmin(ctx)) {
    return error(403, `only a workspace owner or admin can ${route.workspaceAdmin}`);
  }
  if (route.nodeAdmin) return nodeAdminRequired(ctx);
  return null;
}

async function runWorkspaceRoute(route: Gates & { handler: Handler<WorkspaceCall> }, call: WorkspaceCall): Promise<Response> {
  return (await gateRefusal(route, call.ctx, call.req.method)) ?? route.handler(call);
}

/**
 * Route one request for an already-resolved workspace context: the part of the
 * front door after authentication and the budget.
 */
export async function routeWorkspaceRequest(ctx: Ctx, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const found = matchRoute(APP_ROUTES, req.method, url.pathname);
  const route = found?.route;
  if (!found || route?.auth !== "workspace" || route.transport || route.unmetered) {
    return runWorkspaceRoute({ handler: async () => error(404, "no such route") }, { ctx, req, url, match: [url.pathname] });
  }
  return runWorkspaceRoute(route, { ctx, req, url, match: found.match });
}

function stampIdentity(res: Response, alias: string, displayName: string, reqId: string): void {
  res.headers.set("x-stuga-user", alias);
  // URI-encoded: names may contain non-ASCII.
  res.headers.set("x-stuga-name", encodeURIComponent(displayName));
  res.headers.set("x-request-id", reqId);
}

/** A context that could not be built, as the response its transport speaks. */
function contextFailure(e: unknown, transport: Transport, env: NodeEnv, req: Request): Response {
  if (transport === "ws") {
    if (e instanceof Unauthorized) return new Response("unauthorized", { status: 401 });
    if (e instanceof WorkspaceRequired) return new Response(e.message, { status: 409 });
    return new Response("error", { status: 500 });
  }
  if (e instanceof Unauthorized) return transport === "mcp" ? unauthorizedChallenge(env) : error(401, e.message);
  if (e instanceof WorkspaceRequired) return workspaceRequiredResponse(error(409, e.message));
  return unexpectedError(e, { req });
}

function unexpectedError(err: unknown, opts: { id?: string; req: Request; workspaceId?: string }): Response {
  const id = opts.id ?? requestId();
  // Route, method and tenant, so one broken route can be told from a tenant-wide outage.
  console.error("request failed", {
    requestId: id,
    route: new URL(opts.req.url).pathname,
    method: opts.req.method,
    workspaceId: opts.workspaceId ?? null,
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  const response = error(500, "internal server error");
  response.headers.set("x-request-id", id);
  return response;
}

// ---- WebSocket upgrades ------------------------------------------------------

interface UpgradeRoute extends Route {
  handler: (req: Request, url: URL, match: readonly string[], env: NodeEnv) => Promise<Response>;
}

const UPGRADE_ROUTES: readonly UpgradeRoute[] = [{ method: "*", path: /^\/ws\/([^/]+)$/, handler: upgradeDocumentSocket }];

/**
 * Refusals on this path are plain text: there is no JSON contract with a client that is not connected yet.
 * The exception is the rate limiter's 429, the same JSON refusal as on the request path.
 */
async function upgrade(req: Request, env: NodeEnv): Promise<Response> {
  const url = new URL(req.url);
  // Same origin gate as the request path, so a foreign page cannot open a socket with a stolen ticket.
  if (req.headers.get("origin") && !allowedCorsOrigin(req, env)) return new Response("origin not allowed", { status: 403 });
  const found = matchRoute(UPGRADE_ROUTES, req.method, url.pathname);
  if (!found) return new Response("not found", { status: 404 });
  if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("expected websocket", { status: 426 });
  }
  return found.route.handler(req, url, found.match, env);
}

/**
 * /ws/:docId. The only credential a socket URL may carry is a socket ticket
 * (auth/ws-ticket.ts); anything else authenticates with an Authorization header.
 */
async function upgradeDocumentSocket(req: Request, url: URL, match: readonly string[], env: NodeEnv): Promise<Response> {
  const docId = match[1]!;
  let ctx: Ctx;
  let writeCeiling = true;
  const socketTicket = url.searchParams.get("ticket");
  if (socketTicket) {
    const ticket = verifyWsTicket(env.internalSecret, socketTicket);
    // A document mismatch and a bad signature answer identically.
    if (!ticket || ticket.docId !== docId) return new Response("unauthorized", { status: 401 });
    try {
      ctx = await buildSocketContext(env, ticket);
    } catch (e) {
      return contextFailure(e, "ws", env, req);
    }
    writeCeiling = ticket.canWrite;
  } else {
    try {
      ctx = await buildContext(req, env, "ws");
    } catch (e) {
      return contextFailure(e, "ws", env, req);
    }
  }
  // Per connection: the actor limits traffic on an open socket, not how many are opened.
  const limited = await rateLimitRefusal(env, ctx.alias, ctx.workspaceId);
  if (limited) {
    noteDenial(ctx, limited, { method: req.method, path: url.pathname });
    return limited;
  }
  // A 101 is not a denial and is never cloned.
  const res = await routeWebSocket(ctx, env, docId, url.searchParams.get("agent"), writeCeiling);
  noteDenial(ctx, res, { method: req.method, path: url.pathname });
  return res;
}
