/**
 * buildContext's human path. @stuga/db is mocked; @stuga/auth is real, so the
 * shipped principalsFrom decides guest isolation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

let authRow: {
  user: { display_name: string; username: string; email: string | null } | null;
  membership: { workspace_id: string; role: string } | null;
  groupIds: string[];
};
const calls = {
  resolveHumanAuth: [] as Array<{ alias: string; principal: string; requested: string | null }>,
  getDirectoryRow: [] as string[],
};

vi.mock("@stuga/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@stuga/db")>()),
  resolveHumanAuth: (_sql: unknown, alias: string, principal: string, requested: string | null) => {
    calls.resolveHumanAuth.push({ alias, principal, requested });
    return Promise.resolve(authRow);
  },
  getDirectoryRow: (_sql: unknown, alias: string) => {
    calls.getDirectoryRow.push(alias);
    return Promise.resolve(authRow.user);
  },
}));

const { buildContext, buildAccountContext, Unauthorized, WorkspaceRequired } = await import("./context.js");

const env = {
  sql: {},
  verifier: { verify: () => Promise.resolve({ alias: "human-1", claims: { name: "Token Name" } }) },
} as never;

function request(opts: { ws?: string; query?: string } = {}): Request {
  const url = `https://node.test/api/docs${opts.query ?? ""}`;
  const headers: Record<string, string> = { authorization: "Bearer human-token" };
  if (opts.ws !== undefined) headers["x-stuga-workspace"] = opts.ws;
  return new Request(url, { headers });
}

beforeEach(() => {
  calls.resolveHumanAuth = [];
  calls.getDirectoryRow = [];
  authRow = {
    user: { display_name: "Chosen Name", username: "chosen", email: "a@b.test" },
    membership: { workspace_id: "ws-1", role: "member" },
    groupIds: ["group:eng"],
  };
});

describe("buildContext — human path", () => {
  it("resolves identity, workspace and principals from one query", async () => {
    const ctx = await buildContext(request(), env);
    expect(ctx.isAgent).toBe(false);
    expect(ctx.workspaceId).toBe("ws-1");
    expect(ctx.role).toBe("member");
    expect(ctx.principals).toEqual(
      expect.arrayContaining(["user:human-1", "org:ws-1", "group:eng"]),
    );
    expect(calls.resolveHumanAuth).toEqual([
      { alias: "human-1", principal: "user:human-1", requested: null },
    ]);
  });

  it("records a session's REST request as the web surface, and /mcp as its own", async () => {
    expect((await buildContext(request(), env)).surface).toBe("web");
    expect((await buildContext(request(), env, "mcp")).surface).toBe("mcp");
  });

  it("takes the name from the directory, never the token", async () => {
    expect((await buildContext(request(), env)).displayName).toBe("Chosen Name");
    authRow.user = { display_name: "", username: "chosen", email: null };
    expect((await buildContext(request(), env)).displayName).toBe("chosen");
  });

  it("refuses a verified token whose account no longer exists, and creates nothing", async () => {
    authRow.user = null;
    await expect(buildContext(request(), env)).rejects.toBeInstanceOf(Unauthorized);
  });

  it("passes the x-stuga-workspace override down to the query", async () => {
    authRow.membership = { workspace_id: "ws-2", role: "admin" };
    const ctx = await buildContext(request({ ws: "ws-2" }), env);
    expect(calls.resolveHumanAuth[0]!.requested).toBe("ws-2");
    expect(ctx.workspaceId).toBe("ws-2");
    expect(ctx.role).toBe("admin");
    expect(ctx.principals).toContain("org:ws-2");
  });

  it("treats an empty override as no override at all", async () => {
    await buildContext(request({ ws: "" }), env);
    expect(calls.resolveHumanAuth[0]!.requested).toBeNull();
  });

  it("chooses the workspace from the header only, never a ?ws= query parameter", async () => {
    await buildContext(request({ query: "?ws=ws-3" }), env);
    expect(calls.resolveHumanAuth[0]!.requested).toBeNull();

    calls.resolveHumanAuth = [];
    await buildContext(request({ query: "?ws=", ws: "ws-header" }), env);
    expect(calls.resolveHumanAuth[0]!.requested).toBe("ws-header");
  });

  it("keeps a non-member's override off the context", async () => {
    // The query answers a foreign override with the fallback membership.
    authRow.membership = { workspace_id: "ws-1", role: "member" };
    const ctx = await buildContext(request({ ws: "ws-someone-elses" }), env);
    expect(ctx.workspaceId).toBe("ws-1");
    expect(ctx.principals).not.toContain("org:ws-someone-elses");
  });

  it("withholds org:<wid> from a guest", async () => {
    authRow.membership = { workspace_id: "ws-1", role: "guest" };
    authRow.groupIds = [];
    const ctx = await buildContext(request(), env);
    expect(ctx.role).toBe("guest");
    expect(ctx.principals).toEqual(["user:human-1"]);
    expect(ctx.principals).not.toContain("org:ws-1");
  });

  it("resolves the directory name for the account-level routes too, and refuses an account that is gone", async () => {
    const account = await buildAccountContext(request(), env);
    expect(account.displayName).toBe("Chosen Name");
    expect(calls.getDirectoryRow).toEqual(["human-1"]);
    expect(account).not.toHaveProperty("email");
    authRow.user = null;
    await expect(buildAccountContext(request(), env)).rejects.toBeInstanceOf(Unauthorized);
  });

  it("demands onboarding when the caller belongs to no workspace", async () => {
    authRow.membership = null;
    await expect(buildContext(request(), env)).rejects.toBeInstanceOf(WorkspaceRequired);
  });

  it("refuses an account that is gone before sending anyone to onboarding", async () => {
    authRow.membership = null;
    authRow.user = null;
    await expect(buildContext(request(), env)).rejects.toBeInstanceOf(Unauthorized);
  });
});
