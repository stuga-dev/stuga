/**
 * Account recovery and the roster hand over ways in: appointing an administrator, a password link,
 * and Revoke everything for someone each take a sign-in confirmed in the last five minutes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@stuga/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@stuga/db")>()),
  isNodeAdminAlias: vi.fn(async () => true),
  sessionConfirmedAt: vi.fn(async () => new Date()),
  findAccountByAlias: vi.fn(async (_sql: unknown, alias: string) => ({ alias, username: alias.replace(/^u_/, ""), password_hash: "scrypt$x", oidc_sub: null })),
  findAccountByUsername: vi.fn(async (_sql: unknown, username: string) => ({ alias: `u_${username}`, username, password_hash: "scrypt$x", oidc_sub: null })),
  getUserDisplayName: vi.fn(async () => "Bo"),
  grantNodeAdmin: vi.fn(async () => true),
  createPasswordReset: vi.fn(async () => {}),
  revokeEverything: vi.fn(async () => ({
    sessions: 2,
    sessionIds: ["s1", "s2"],
    provider: true,
    apps: 1,
    api_keys: 3,
    invites: 1,
    share_links: 0,
    devices: 2,
    password_links: 0,
  })),
  revokeEverythingCounts: vi.fn(async () => ({ sessions: 2, provider: true, apps: 1, api_keys: 3, invites: 1, share_links: 0 })),
}));

vi.mock("../../audit/record.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../audit/record.js")>()),
  recordAudit: vi.fn(),
}));

const alerts = { revokedEverything: vi.fn(async () => {}), apiKeyCreated: vi.fn(async () => {}) };
vi.mock("../../identity/alerts.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../identity/alerts.js")>()),
  alertsFor: () => alerts,
}));

const db = await import("@stuga/db");
const { recordAudit } = await import("../../audit/record.js");
const { routeWorkspaceRequest } = await import("../../http/dispatch.js");
import type { Ctx } from "../../auth/context.js";
import { personCtx, type CtxOverrides } from "../../testing/ctx.js";

const confirmedAt = db.sessionConfirmedAt as unknown as ReturnType<typeof vi.fn>;
const revoke = db.revokeEverything as unknown as ReturnType<typeof vi.fn>;
const grant = db.grantNodeAdmin as unknown as ReturnType<typeof vi.fn>;
const reset = db.createPasswordReset as unknown as ReturnType<typeof vi.fn>;
const audit = recordAudit as unknown as ReturnType<typeof vi.fn>;

const closeAccount = vi.fn();
const settings = { current: () => ({ identityProvider: { issuer: "https://idp.test" }, notify: { sink: "none" } }) };
const admin = (over: CtxOverrides = {}): Ctx =>
  personCtx({
    alias: "u_liv",
    displayName: "Liv",
    env: { settings, sessionSockets: { closeAccount } } as unknown as CtxOverrides["env"],
    ...over,
  });

function call(c: Ctx, method: string, path: string, body?: unknown): Promise<Response> {
  const init = body === undefined ? { method } : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
  return routeWorkspaceRequest(c, new Request(`http://livs-air.local:8787${path}`, init));
}

const stale = () => confirmedAt.mockResolvedValue(new Date(Date.now() - 6 * 60_000));

beforeEach(() => {
  vi.clearAllMocks();
  confirmedAt.mockResolvedValue(new Date());
});

describe("appointing an administrator and minting a password link", () => {
  it("take a sign-in confirmed in the last five minutes", async () => {
    stale();
    for (const [path, body] of [
      ["/api/node/admins", { username: "bo" }],
      ["/api/node/password-resets", { username: "bo" }],
    ] as const) {
      const res = await call(admin(), "POST", path, body);
      expect(res.status, path).toBe(401);
      expect(res.headers.get("x-stuga-reauth")).toBe("1");
      expect(await res.json()).toEqual({ error: "reauth_required", message: "confirm it's you", methods: ["password"] });
    }
    expect(grant).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();

    confirmedAt.mockResolvedValue(new Date());
    expect((await call(admin(), "POST", "/api/node/admins", { username: "bo" })).status).toBe(200);
    expect((await call(admin(), "POST", "/api/node/password-resets", { username: "bo" })).status).toBe(200);
  });
});

describe("Revoke everything for someone", () => {
  it("counts what it would take first", async () => {
    const res = await call(admin(), "GET", "/api/node/users/u_bo/revoke-everything");
    expect(await res.json()).toEqual({ sessions: 2, provider: true, apps: 1, api_keys: 3, invites: 1, share_links: 0 });
  });

  it("takes every way in, their password too, and answers a password link to hand them", async () => {
    const res = await call(admin(), "POST", "/api/node/users/u_bo/revoke-everything", {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { password_link: { url: string; expires_at: string } };
    expect(Object.keys(body)).toEqual(["password_link"]);
    // Where the administrator asked from: the link opens there.
    expect(body.password_link.url).toMatch(/^https:\/\/stuga\.test\/reset\/[0-9a-f]{64}$/);
    expect(Date.parse(body.password_link.expires_at)).toBeGreaterThan(Date.now());

    expect(revoke).toHaveBeenCalledWith(expect.anything(), { alias: "u_bo", by: "u_liv", passwordHash: null });
    expect(closeAccount).toHaveBeenCalledWith("u_bo");
    expect(reset).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ alias: "u_bo", createdBy: "u_liv" }));
    expect(audit.mock.calls.map((c) => c[1])).toEqual([
      expect.objectContaining({
        action: "node.account.revoke_everything",
        detail: expect.objectContaining({ alias: "u_bo", sessions: 2, api_keys: 3, by_admin: true }),
      }),
    ]);
    expect(alerts.revokedEverything).toHaveBeenCalledWith(expect.objectContaining({ alias: "u_bo", name: "Bo", by: { alias: "u_liv", name: "Liv" } }));
  });

  it("takes a recent confirmation, refuses oneself, and is a person's to do", async () => {
    stale();
    const res = await call(admin(), "POST", "/api/node/users/u_bo/revoke-everything", {});
    expect(res.status).toBe(401);
    expect((await res.json()).methods).toEqual(["password"]);
    expect(revoke).not.toHaveBeenCalled();

    // Oneself is told where to go before any confirmation is asked for.
    const self = await call(admin(), "POST", "/api/node/users/u_liv/revoke-everything", {});
    expect(self.status).toBe(400);
    expect(await self.json()).toEqual({ error: "use_profile", message: "Revoke everything for yourself in Settings → Profile." });
    confirmedAt.mockResolvedValue(new Date());

    const agent = await call(admin({ isAgent: true, onBehalfOf: "u_liv" }), "POST", "/api/node/users/u_bo/revoke-everything", {});
    expect(agent.status).toBe(403);
    expect(revoke).not.toHaveBeenCalled();
  });
});
