/**
 * buildContext's human path. @stuga/db is mocked; @stuga/auth is real, so the
 * shipped principalsFrom decides guest isolation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { ARRIVAL_HEADER } from "../platform/http-server.js";

let authRow: {
  user: { display_name: string; username: string; email: string | null } | null;
  membership: { workspace_id: string; role: string } | null;
  groupIds: string[];
  sessionLive: boolean | null;
};
type Session = { sessionId: string; arrival: string };
const calls = {
  resolveHumanAuth: [] as Array<{ alias: string; principal: string; requested: string | null; session?: Session }>,
  getDirectoryRow: [] as string[],
  isSessionLive: [] as Array<Session & { alias: string }>,
  verify: [] as unknown[],
};

vi.mock("@stuga/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@stuga/db")>()),
  resolveHumanAuth: (_sql: unknown, alias: string, principal: string, requested: string | null, session?: Session) => {
    calls.resolveHumanAuth.push({ alias, principal, requested, ...(session ? { session } : {}) });
    return Promise.resolve(session ? authRow : { ...authRow, sessionLive: null });
  },
  getDirectoryRow: (_sql: unknown, alias: string) => {
    calls.getDirectoryRow.push(alias);
    return Promise.resolve(authRow.user);
  },
  isSessionLive: (_sql: unknown, session: Session & { alias: string }) => {
    calls.isSessionLive.push(session);
    return Promise.resolve(authRow.sessionLive === true);
  },
}));

const { buildContext, buildAccountContext, Unauthorized, WorkspaceRequired } = await import("./context.js");

const env = {
  sql: {},
  verifier: {
    verify: (_token: string, where: unknown) => {
      calls.verify.push(where);
      return Promise.resolve({ alias: "human-1", sid: "sess-1", claims: { name: "Token Name" } });
    },
  },
} as never;

function request(opts: { ws?: string; query?: string; remote?: boolean } = {}): Request {
  const url = `${opts.remote ? "https://k7f3q2.stuga.test" : "https://node.test"}/api/docs${opts.query ?? ""}`;
  const headers: Record<string, string> = { authorization: "Bearer human-token" };
  if (opts.ws !== undefined) headers["x-stuga-workspace"] = opts.ws;
  if (opts.remote) headers[ARRIVAL_HEADER] = "remote";
  return new Request(url, { headers });
}

const LAN_SESSION = { sessionId: "sess-1", arrival: "local" };

beforeEach(() => {
  calls.resolveHumanAuth = [];
  calls.getDirectoryRow = [];
  calls.isSessionLive = [];
  calls.verify = [];
  authRow = {
    user: { display_name: "Chosen Name", username: "chosen", email: "a@b.test" },
    membership: { workspace_id: "ws-1", role: "member" },
    groupIds: ["group:eng"],
    sessionLive: true,
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
      { alias: "human-1", principal: "user:human-1", requested: null, session: LAN_SESSION },
    ]);
    expect(ctx).toMatchObject({ sid: "sess-1", arrival: "local" });
  });

  it("refuses a token whose session has ended, in the same query, whatever else it finds", async () => {
    authRow.sessionLive = false;
    await expect(buildContext(request(), env)).rejects.toBeInstanceOf(Unauthorized);
    expect(calls.resolveHumanAuth).toHaveLength(1);
  });

  it("checks the token for the listener it arrived at, and looks its session up there", async () => {
    const ctx = await buildContext(request({ remote: true }), env);
    expect(calls.verify).toEqual([{ arrival: "remote", origin: "https://k7f3q2.stuga.test" }]);
    expect(calls.resolveHumanAuth[0]!.session).toEqual({ sessionId: "sess-1", arrival: "remote" });
    expect(ctx.arrival).toBe("remote");
    await buildContext(request(), env);
    expect(calls.verify[1]).toEqual({ arrival: "local" });
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

  it("refuses an ended session on the account-level routes too", async () => {
    authRow.sessionLive = false;
    await expect(buildAccountContext(request(), env)).rejects.toBeInstanceOf(Unauthorized);
    expect(calls.isSessionLive).toEqual([{ ...LAN_SESSION, alias: "human-1" }]);
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
