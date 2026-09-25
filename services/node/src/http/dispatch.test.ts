import { describe, expect, it } from "vitest";
import { createApp, createRequestHandler, isAppPath, routeWorkspaceRequest } from "./dispatch.js";
import { READ_ONLY_MESSAGE } from "../authz/authz.js";
import type { Ctx } from "../auth/context.js";
import type { NodeEnv } from "../env.js";
import { CONSENT_PATH } from "../mcp/oauth.js";

describe("isAppPath", () => {
  it.each([
    ["GET", "/api/docs"],
    ["POST", "/mcp"],
    ["GET", "/ready"],
    ["GET", "/ws/doc123"],
    ["GET", "/oauth/authorize"],
    ["POST", "/oauth/token"],
    ["POST", "/oauth/register"],
    ["POST", "/oauth/revoke"],
    ["GET", "/oauth/client"],
    ["GET", "/.well-known/oauth-protected-resource"],
    ["GET", "/.well-known/oauth-protected-resource/mcp"],
  ])("routes %s %s to the API", (method, path) => {
    expect(isAppPath(method, path)).toBe(true);
  });

  it.each([
    ["GET", "/"],
    ["GET", "/docs/abc"],
    ["GET", "/assets/index.js"],
    ["GET", "/oauthx"],
    ["POST", "/internal/retrieve"],
  ])("routes %s %s to the app bundle", (method, path) => {
    expect(isAppPath(method, path)).toBe(false);
  });

  it("gives the consent screen to the app on GET and keeps POST for the API", () => {
    expect(isAppPath("GET", CONSENT_PATH)).toBe(false);
    expect(isAppPath("POST", CONSENT_PATH)).toBe(true);
  });
});

describe("createRequestHandler", () => {
  const answer = (body: string) => async () => new Response(body);
  const handler = createRequestHandler({
    identity: { matches: (p) => p === "/auth" || p.startsWith("/auth/"), handle: answer("identity") },
    app: { handle: answer("api") },
    spa: answer("bundle"),
  });

  it.each([
    ["/auth/login", "identity"],
    ["/api/docs", "api"],
    ["/docs/abc", "bundle"],
  ])("answers %s from the handler that owns it, with the headers on", async (path, body) => {
    const res = await handler(new Request(`https://node.example.test${path}`));
    expect(await res.text()).toBe(body);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });
});

describe("the route table's gates", () => {
  const ctx = (overrides: Record<string, unknown> = {}) =>
    ({
      sql: {},
      alias: "ada",
      displayName: "Ada",
      email: null,
      isAgent: false,
      surface: "web",
      principals: ["user:ada", "org:ws1"],
      workspaceId: "ws1",
      role: "member",
      env: {},
      ...overrides,
    }) as unknown as Ctx;
  const agent = (overrides: Record<string, unknown> = {}) =>
    ctx({ isAgent: true, alias: "agent-1", onBehalfOf: "ada", surface: "api-key", ...overrides });
  const request = (method: string, path: string) => new Request(`https://node.example.test${path}`, { method });

  it("refuses a read-only key on any write, including a path no route names", async () => {
    const readOnly = agent({ scope: { folders: null, readOnly: true, credentialId: "k1" } });
    const res = await routeWorkspaceRequest(readOnly, request("POST", "/api/no-such-thing"));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: READ_ONLY_MESSAGE });
    expect((await routeWorkspaceRequest(readOnly, request("GET", "/api/no-such-thing"))).status).toBe(404);
  });

  it("answers a group's unknown method as the group would: agents refused, people told the method is wrong", async () => {
    for (const path of ["/api/keys/k1/nope", "/api/workspaces/ws1/nope", "/api/webhooks/w1/nope"]) {
      expect((await routeWorkspaceRequest(agent(), request("PUT", path))).status).toBe(403);
    }
    expect((await routeWorkspaceRequest(ctx({ role: "admin" }), request("PUT", "/api/keys/k1/nope"))).status).toBe(405);
    expect((await routeWorkspaceRequest(ctx({ role: "admin" }), request("PUT", "/api/webhooks/w1/nope"))).status).toBe(405);
    const guest = await routeWorkspaceRequest(ctx({ role: "guest" }), request("GET", "/api/keys"));
    expect(await guest.json()).toEqual({ error: "guests cannot manage api keys" });
  });

  it("names a route no table entry claims as no such route", async () => {
    const res = await routeWorkspaceRequest(ctx(), request("DELETE", "/api/docs"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "no such route" });
  });
});

describe("CORS on every app answer", () => {
  const origin = "https://node.example.test";
  const app = createApp({ publicOrigin: origin, extraOrigins: [], sql: null } as unknown as NodeEnv);

  it("stamps an allowed origin onto a route that knows nothing about CORS", async () => {
    const res = await app.handle(new Request(`${origin}/ready`, { headers: { origin } }));
    expect(res.headers.get("access-control-allow-origin")).toBe(origin);
    expect(res.headers.get("access-control-expose-headers")).toContain("x-stuga-workspace-required");
  });

  it("answers a preflight for any path, and a refused context, with the same headers", async () => {
    const preflight = await app.handle(new Request(`${origin}/api/docs`, { method: "OPTIONS", headers: { origin } }));
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-credentials")).toBe("true");
    const unauthenticated = await app.handle(new Request(`${origin}/api/docs`, { headers: { origin } }));
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("access-control-allow-origin")).toBe(origin);
  });

  it("sends no allow-origin without an Origin, and still varies on it", async () => {
    const res = await app.handle(new Request(`${origin}/ready`));
    expect(res.headers.has("access-control-allow-origin")).toBe(false);
    expect(res.headers.get("vary")).toBe("Origin");
  });
});
