/** `/api/me/connections` through the front door: a person's own OAuth grants, owner-gated, narrowed never widened, and closed to agents. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OauthGrantRow } from "@stuga/db";

const buildAccountContext = vi.fn();

vi.mock("../auth/context.js", async (orig) => ({
  ...(await orig<typeof import("../auth/context.js")>()),
  buildAccountContext,
}));
vi.mock("@stuga/db", () => ({
  listOauthGrants: vi.fn(async () => []),
  updateOauthGrant: vi.fn(async () => null),
  revokeOauthGrant: vi.fn(async () => false),
}));

const db = await import("@stuga/db");
const { createApp } = await import("../http/dispatch.js");
import type { NodeEnv } from "../env.js";

const mockList = vi.mocked(db.listOauthGrants);
const mockUpdate = vi.mocked(db.updateOauthGrant);
const mockRevoke = vi.mocked(db.revokeOauthGrant);

const ORIGIN = "http://livs-air.local:8787";
const jobsSend = vi.fn(async (_message: unknown) => {});

const env = {
  publicOrigin: ORIGIN,
  extraOrigins: [],
  rateLimit: { limit: async () => ({ success: true }) },
  jobs: { send: jobsSend },
  settings: { current: () => ({ nodeLabel: "Liv’s Mac" }) },
} as unknown as NodeEnv;

const app = createApp(env);

const PERSON = { sql: {}, alias: "u_liv", displayName: "Liv", isAgent: false, surface: "web", env };
const AGENT = { sql: {}, alias: "agent-conn-abc", displayName: "Claude", isAgent: true, onBehalfOf: "u_liv", surface: "api-key", env };

function grant(over: Partial<OauthGrantRow> = {}): OauthGrantRow {
  return {
    grant_id: "grt_1",
    client_id: "https://claude.ai/oauth/client.json",
    name: "Claude",
    client_host: "claude.ai",
    owner: "u_liv",
    agent_id: "agent-conn-abc",
    workspace_scope: ["ws1"],
    access: "propose",
    created_at: "2026-09-20T10:00:00Z",
    last_used_at: "2026-09-25T09:00:00Z",
    revoked_at: null,
    revoked_by: null,
    ...over,
  };
}

function call(method: string, path: string, body?: unknown): Promise<Response> {
  return app.handle(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

const patch = (body: unknown, id = "grt_1") => call("PATCH", `/api/me/connections/${id}`, body);

/** The connection.* rows sent to the audit ledger, by action. */
const audited = () =>
  jobsSend.mock.calls
    .map(([m]) => m as { kind: string; action?: string; targetId?: string | null })
    .filter((m) => m.kind === "audit" && m.action?.startsWith("connection."));

beforeEach(() => {
  vi.clearAllMocks();
  buildAccountContext.mockResolvedValue(PERSON);
  mockUpdate.mockImplementation(async (_sql, grantId, owner, p) =>
    grantId === "grt_1" && owner === "u_liv" ? grant(p) : null,
  );
  mockRevoke.mockImplementation(async (_sql, grantId, owner) => grantId === "grt_1" && owner === "u_liv");
});

describe("GET /api/me/connections", () => {
  it("lists the caller's own grants, revoked ones included, without owner fields", async () => {
    mockList.mockResolvedValue([grant(), grant({ grant_id: "grt_0", client_host: null, workspace_scope: null, access: "read", revoked_at: "2026-09-21T00:00:00Z", revoked_by: "u_liv" })]);
    const res = await call("GET", "/api/me/connections");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      connections: [
        {
          grant_id: "grt_1",
          agent_id: "agent-conn-abc",
          name: "Claude",
          client_id: "https://claude.ai/oauth/client.json",
          verified_host: "claude.ai",
          workspaces: ["ws1"],
          access: "propose",
          created_at: "2026-09-20T10:00:00Z",
          last_used_at: "2026-09-25T09:00:00Z",
          revoked_at: null,
        },
        expect.objectContaining({ grant_id: "grt_0", verified_host: null, workspaces: null, access: "read", revoked_at: "2026-09-21T00:00:00Z" }),
      ],
    });
    expect(mockList).toHaveBeenCalledWith(PERSON.sql, "u_liv");
  });
});

describe("PATCH /api/me/connections/:id", () => {
  it("renames a connection, trimmed and capped at 100 characters", async () => {
    const res = await patch({ name: "  Claude at work  " });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ grant_id: "grt_1", name: "Claude at work" });
    expect(mockUpdate).toHaveBeenCalledWith(PERSON.sql, "grt_1", "u_liv", { name: "Claude at work" });

    await patch({ name: "x".repeat(150) });
    expect(mockUpdate.mock.calls[1]![3]).toEqual({ name: "x".repeat(100) });
    expect(audited().map((m) => m.action)).toEqual(["connection.update", "connection.update"]);
  });

  it("narrows a connection to read only", async () => {
    const res = await patch({ access: "read" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ access: "read" });
    expect(mockUpdate).toHaveBeenCalledWith(PERSON.sql, "grt_1", "u_liv", { access: "read" });
  });

  it("refuses widening, which takes a new sign-in, and any other access level", async () => {
    for (const access of ["propose", "admin", null, 1]) {
      const res = await patch({ access });
      expect(res.status, JSON.stringify(access)).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/sign in again/);
    }
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(audited()).toEqual([]);
  });

  it("refuses an empty name or one that is not text", async () => {
    for (const name of ["", "   ", 7, null]) {
      expect((await patch({ name })).status, JSON.stringify(name)).toBe(400);
    }
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("answers another person's grant, or an unknown one, as not found", async () => {
    const res = await patch({ name: "Mine now" }, "grt_theirs");
    expect(res.status).toBe(404);
    // The owner is the caller, whatever the body says.
    await patch({ name: "Mine now", owner: "u_other" }, "grt_theirs");
    expect(mockUpdate.mock.calls.map(([, id, owner]) => [id, owner])).toEqual([
      ["grt_theirs", "u_liv"],
      ["grt_theirs", "u_liv"],
    ]);
    expect(audited()).toEqual([]);
  });
});

describe("DELETE /api/me/connections/:id", () => {
  it("revokes the caller's own grant and records it", async () => {
    const res = await call("DELETE", "/api/me/connections/grt_1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: true });
    expect(mockRevoke).toHaveBeenCalledWith(PERSON.sql, "grt_1", "u_liv");
    expect(audited()).toEqual([expect.objectContaining({ action: "connection.revoke", targetId: "grt_1" })]);
  });

  it("answers another person's grant, or one already revoked, as not found", async () => {
    const res = await call("DELETE", "/api/me/connections/grt_theirs");
    expect(res.status).toBe(404);
    expect(mockRevoke).toHaveBeenCalledWith(PERSON.sql, "grt_theirs", "u_liv");
    expect(audited()).toEqual([]);
  });
});

describe("an agent credential", () => {
  it("is refused on every route before it reads or changes anything", async () => {
    buildAccountContext.mockResolvedValue(AGENT);
    for (const [method, body] of [
      ["GET", undefined],
      ["PATCH", { access: "read" }],
      ["DELETE", undefined],
    ] as const) {
      const res = await call(method, method === "GET" ? "/api/me/connections" : "/api/me/connections/grt_1", body);
      expect(res.status, method).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe("agents cannot manage connections");
    }
    expect(mockList).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockRevoke).not.toHaveBeenCalled();
  });
});
