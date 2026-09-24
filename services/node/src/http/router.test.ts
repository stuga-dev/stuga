import { describe, expect, it } from "vitest";
import { matchRoute, type Route } from "./router.js";

describe("matchRoute", () => {
  const routes: Array<Route & { name: string }> = [
    { method: "GET", path: "/api/docs", name: "list" },
    { method: ["POST", "DELETE"], path: /^\/api\/docs\/([^/]+)\/items$/, name: "items" },
    { method: "GET", path: /^\/api\/docs\/([^/]+)$/, name: "one" },
    { method: "*", path: /^\/api\/docs(\/.*)?$/, name: "catch-all" },
  ];

  it("takes the first route in table order whose method and path both match", () => {
    expect(matchRoute(routes, "GET", "/api/docs")?.route.name).toBe("list");
    expect(matchRoute(routes, "POST", "/api/docs")?.route.name).toBe("catch-all");
    expect(matchRoute(routes, "PATCH", "/api/docs/d1")?.route.name).toBe("catch-all");
  });

  it("hands back the captures where RegExp.exec puts them", () => {
    const found = matchRoute(routes, "DELETE", "/api/docs/d1/items");
    expect(found?.route.name).toBe("items");
    expect(found?.match[1]).toBe("d1");
    expect(matchRoute(routes, "GET", "/api/docs")?.match).toEqual(["/api/docs"]);
  });

  it("matches an exact path exactly", () => {
    expect(matchRoute(routes, "GET", "/api/docs/")?.route.name).toBe("catch-all");
    expect(matchRoute(routes, "GET", "/api/docsx")).toBeNull();
  });
});
