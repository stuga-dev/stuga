/** The route table shape every surface uses, and the one matcher that reads it. */
import type { AccountCtx, Ctx } from "../auth/context.js";
import type { NodeEnv } from "../env.js";

export type Method = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";

/** What a path matched: the whole path at 0, then each capture group, as `RegExp.exec` returns them. */
export type PathMatch = readonly string[];

export interface Route {
  method: Method | readonly Method[] | "*";
  /** An exact path, or a pattern anchored at both ends. */
  path: string | RegExp;
}

function methodMatches(route: Route, method: string): boolean {
  if (route.method === "*") return true;
  return typeof route.method === "string" ? route.method === method : route.method.includes(method as Method);
}

function pathMatch(route: Route, path: string): PathMatch | null {
  if (typeof route.path === "string") return route.path === path ? [path] : null;
  return route.path.exec(path);
}

/** The first route, in table order, whose method and path both match. */
export function matchRoute<R extends Route>(routes: readonly R[], method: string, path: string): { route: R; match: PathMatch } | null {
  for (const route of routes) {
    if (!methodMatches(route, method)) continue;
    const match = pathMatch(route, path);
    if (match) return { route, match };
  }
  return null;
}

/** What a handler for a route with no credential receives. */
export interface PublicCall {
  env: NodeEnv;
  req: Request;
  url: URL;
  match: PathMatch;
}

/** What a handler behind an identity without a workspace receives. */
export interface AccountCall {
  ctx: AccountCtx;
  req: Request;
  url: URL;
  match: PathMatch;
}

/** What a handler behind a workspace member's context receives. */
export interface WorkspaceCall {
  ctx: Ctx;
  req: Request;
  url: URL;
  match: PathMatch;
}
