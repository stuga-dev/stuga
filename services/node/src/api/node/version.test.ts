/** /api/node/version: this build, the schema, the previous build and what is known of newer ones, behind the node-admin gate. */
import { describe, expect, it, vi } from "vitest";

vi.mock("@stuga/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@stuga/db")>()),
  isNodeAdminAlias: vi.fn(async () => true),
  getNodeState: vi.fn(async () => ({
    app_version: "0.0.0-dev",
    first_boot_at: new Date("2026-01-01T00:00:00Z"),
    last_boot_at: new Date("2026-08-28T00:00:00Z"),
  })),
}));

const { SCHEMA_VERSION } = await import("@stuga/db");
const { routeWorkspaceRequest } = await import("../../http/dispatch.js");
const { getNodeState } = await import("@stuga/db");
import type { Ctx } from "../../auth/context.js";

function ctx(previousVersion: string | null = "0.2.0"): Ctx {
  return {
    sql: {},
    alias: "admin-1",
    isAgent: false,
    principals: ["user:admin-1"],
    env: { previousVersion, upgradeHint: "Run ./stuga upgrade." },
  } as unknown as Ctx;
}

async function get(c: Ctx): Promise<Response> {
  const url = new URL("https://node.test/api/node/version");
  return (await routeWorkspaceRequest(c, new Request(url)))!;
}

async function check(c: Ctx): Promise<Response> {
  const url = new URL("https://node.test/api/node/version/check");
  return (await routeWorkspaceRequest(c, new Request(url, { method: "POST" })))!;
}

describe("GET /api/node/version", () => {
  it("reports this build, the schema it expects, and the build before it", async () => {
    const res = await get(ctx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.version).toBe("0.0.0-dev");
    expect(body.build).toBe("source");
    expect(body.source_url).toBe("https://github.com/stuga-dev/stuga");
    expect(body.schema_version).toBe(SCHEMA_VERSION);
    expect(body.previous_version).toBe("0.2.0");
    expect(body.first_boot_at).not.toBeNull();
  });

  it("says a build from source has no release to compare with, and how this packaging upgrades", async () => {
    const body = (await (await get(ctx())).json()) as { released_at: unknown; update: Record<string, unknown> };
    expect(body.released_at).toBeNull();
    expect(body.update).toEqual({
      comparable: false,
      checked_at: null,
      error: null,
      available: null,
      releases_url: "https://github.com/stuga-dev/stuga/releases",
      upgrade_hint: "Run ./stuga upgrade.",
      install: { available: false, status: null },
    });
  });

  it("reports no previous build on a database no node has booted", async () => {
    (getNodeState as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const body = (await (await get(ctx(null))).json()) as Record<string, unknown>;
    expect(body.previous_version).toBeNull();
    expect(body.last_boot_at).toBeNull();
    expect(body.version).toBe("0.0.0-dev");
  });

  it("is behind the node-admin gate, like the rest of /api/node/*", async () => {
    vi.mocked(await import("@stuga/db")).isNodeAdminAlias.mockResolvedValueOnce(false);
    expect((await get(ctx())).status).toBe(403);
  });
});

describe("POST /api/node/version/install", () => {
  const install = (c: Ctx, body: unknown) =>
    routeWorkspaceRequest(
      c,
      new Request("https://node.test/api/node/version/install", { method: "POST", body: JSON.stringify(body) }),
    ) as Promise<Response>;

  it("refuses where the packaging installs nothing from here, and says how it upgrades instead", async () => {
    const res = await install(ctx(), { version: "1.2.3" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/Run \.\/stuga upgrade\./);
  });

  it("refuses when the node knows of no newer version, whatever version is asked for", async () => {
    const c = ctx();
    (c.env as { upgradeHelper?: unknown }).upgradeHelper = { requests: "/nowhere", status: "/nowhere/status.json" };
    const res = await install(c, { version: "9.9.9" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/no newer version/);
  });
});

describe("POST /api/node/version/check", () => {
  it("answers like the GET, and a build from source reaches for nothing", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const res = await check(ctx());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { version: string; update: { comparable: boolean } };
    expect(body.version).toBe("0.0.0-dev");
    expect(body.update.comparable).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
  });

  it("is behind the node-admin gate", async () => {
    vi.mocked(await import("@stuga/db")).isNodeAdminAlias.mockResolvedValueOnce(false);
    expect((await check(ctx())).status).toBe(403);
  });
});
