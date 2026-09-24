/**
 * A refusal answered with 403, 423 or 429 is recorded once, by the front door,
 * from the identity the request resolved to; the route that refused records nothing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const buildContext = vi.fn();
const buildAccountContext = vi.fn();
const handleRoute = vi.fn();
const handleAccountRoute = vi.fn();
const routeWebSocket = vi.fn();

vi.mock("../auth/context.js", async (orig) => ({
  ...(await orig<typeof import("../auth/context.js")>()),
  buildContext,
  buildAccountContext,
}));

// Only the route table is replaced; the real ledger writer builds the messages asserted below.
vi.mock("./routes.js", () => ({
  APP_ROUTES: [
    { method: "*", path: "/api/workspaces", auth: "account", handler: handleAccountRoute },
    { method: "*", path: /^\/api\//, auth: "workspace", handler: handleRoute },
  ],
}));
vi.mock("../api/ws.js", () => ({ routeWebSocket }));

const { createApp } = await import("./dispatch.js");
const { error } = await import("./respond.js");
import type { NodeEnv } from "../env.js";

const send = vi.fn(async (_message: unknown) => {});
let allowRequest = true;

const env = {
  publicOrigin: "http://localhost:8787",
  extraOrigins: [],
  rateLimit: { limit: async () => ({ success: allowRequest }) },
  jobs: { send },
} as unknown as NodeEnv;

const app = createApp(env);

const CTX = {
  sql: {},
  alias: "ada",
  displayName: "Ada",
  email: null,
  isAgent: false,
  principals: ["user:ada", "org:ws1"],
  workspaceId: "ws1",
  role: "member",
  surface: "web",
  env,
};

/** The account path resolves an identity and no workspace. */
const ACCOUNT_CTX = { sql: {}, alias: "ada", displayName: "Ada", email: null, isAgent: false, surface: "web", env };

const call = (path = "/api/audit") => app.handle(new Request(`http://localhost:8787${path}`));

const upgrade = (path = "/ws/doc1") =>
  app.upgrade(new Request(`http://localhost:8787${path}`, { headers: { upgrade: "websocket" } }));

/** The ledger write happens on a later tick. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const rows = () => send.mock.calls.map(([m]) => m as Record<string, unknown>);

/** The dedup window is process-wide, so each case starts a window after the last. */
let clock = Date.now();
const advancePastWindow = () => {
  clock += 120_000;
  vi.spyOn(Date, "now").mockReturnValue(clock);
};

beforeEach(() => {
  vi.clearAllMocks();
  allowRequest = true;
  buildContext.mockImplementation(async (_req: Request, _env: unknown, transport?: string) => ({
    ...CTX,
    surface: transport === "ws" ? "ws" : "web",
  }));
  buildAccountContext.mockResolvedValue(ACCOUNT_CTX);
  advancePastWindow();
});

describe("a 403 answered by a route", () => {
  it("is recorded once, naming the caller, the route and the sentence they were given", async () => {
    handleRoute.mockResolvedValue(error(403, "only a workspace owner or admin can read the audit ledger"));
    const res = await call();
    expect(res.status).toBe(403);
    await settle();

    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({
      kind: "audit",
      workspaceId: "ws1",
      actor: "ada",
      actorKind: "human",
      action: "access.denied",
      status: "denied",
      targetKind: "route",
      targetId: "/api/audit",
      detail: {
        method: "GET",
        http_status: 403,
        message: "only a workspace owner or admin can read the audit ledger",
      },
    });
  });

  it("leaves the caller's own response readable", async () => {
    handleRoute.mockResolvedValue(error(403, "forbidden"));
    const res = await call();
    expect(await res.json()).toEqual({ error: "forbidden" });
    expect(res.headers.get("x-request-id")).toMatch(/^[0-9a-f]{8}$/);
  });

  it("carries the request id, so the row and the log line meet", async () => {
    handleRoute.mockResolvedValue(error(403, "forbidden"));
    const res = await call();
    await settle();
    expect(rows()[0]).toMatchObject({ requestId: res.headers.get("x-request-id") });
  });
});

describe("what else the wrapper records", () => {
  it("records a 423 for a locked document", async () => {
    handleRoute.mockResolvedValue(error(423, "this document is locked"));
    await call("/api/docs/d1/propose");
    await settle();
    expect(rows()[0]).toMatchObject({ action: "access.denied", detail: { http_status: 423, method: "GET" } });
  });

  it("records the rate limiter's 429 before any route runs", async () => {
    allowRequest = false;
    await call();
    await settle();
    expect(handleRoute).not.toHaveBeenCalled();
    expect(rows()[0]).toMatchObject({ action: "access.denied", detail: { http_status: 429 } });
  });
});

describe("what the wrapper does NOT record", () => {
  it("says nothing about a request that succeeded", async () => {
    handleRoute.mockResolvedValue(new Response("{}", { status: 200 }));
    await call();
    await settle();
    expect(send).not.toHaveBeenCalled();
  });

  it("says nothing about a 404", async () => {
    handleRoute.mockResolvedValue(error(404, "not found"));
    await call("/api/docs/someone-elses");
    await settle();
    expect(send).not.toHaveBeenCalled();
  });

  it("says nothing about a 401, which names nobody", async () => {
    const { Unauthorized } = await import("../auth/context.js");
    buildContext.mockRejectedValue(new Unauthorized("invalid token"));
    const res = await call();
    expect(res.status).toBe(401);
    await settle();
    expect(send).not.toHaveBeenCalled();
  });

  it("says nothing about a 400 or a 500", async () => {
    handleRoute.mockResolvedValue(error(400, "since must be a timestamp"));
    await call();
    handleRoute.mockRejectedValue(new Error("boom"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await call();
    await settle();
    expect(send).not.toHaveBeenCalled();
  });
});

describe("the dedup window", () => {
  it("writes one row for a loop against the same refusal, and says what that row covers", async () => {
    handleRoute.mockResolvedValue(error(403, "forbidden"));
    for (let i = 0; i < 5; i++) await call("/api/keys");
    await settle();

    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ action: "access.denied", detail: { dedup_window_ms: 60_000 } });
  });

  it("still writes a row per route", async () => {
    handleRoute.mockResolvedValue(error(403, "forbidden"));
    await call("/api/keys");
    await call("/api/webhooks");
    await call("/api/agents/stats");
    await settle();

    expect(rows().map((r) => r.targetId)).toEqual(["/api/keys", "/api/webhooks", "/api/agents/stats"]);
  });

  it("records the same refusal again once the window has passed", async () => {
    handleRoute.mockResolvedValue(error(403, "forbidden"));
    await call("/api/keys");
    await settle();
    expect(rows()).toHaveLength(1);

    advancePastWindow();
    await call("/api/keys");
    await settle();
    expect(rows()).toHaveLength(2);
  });

  it("holds a looping 429 to one row too", async () => {
    allowRequest = false;
    for (let i = 0; i < 5; i++) await call("/api/docs");
    await settle();
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ detail: { http_status: 429 } });
  });

  it("keeps a 403 and a 429 on one route apart", async () => {
    handleRoute.mockResolvedValue(error(403, "forbidden"));
    await call("/api/docs");
    allowRequest = false;
    await call("/api/docs");
    await settle();
    expect(rows().map((r) => (r.detail as { http_status: number }).http_status)).toEqual([403, 429]);
  });
});

describe("the socket upgrade", () => {
  it("records the ACL's 403, naming the identity the ticket resolved to", async () => {
    routeWebSocket.mockResolvedValue(new Response("forbidden", { status: 403 }));
    const res = await upgrade();
    expect(res.status).toBe(403);
    await settle();

    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({
      action: "access.denied",
      actor: "ada",
      status: "denied",
      source: "ws",
      targetKind: "route",
      targetId: "/ws/doc1",
      detail: { method: "GET", http_status: 403, message: "forbidden" },
    });
  });

  it("hands a successful upgrade back untouched, without cloning the response that carries the socket", async () => {
    const upgraded = new Response(null, { status: 200 });
    const clone = vi.spyOn(upgraded, "clone");
    routeWebSocket.mockResolvedValue(upgraded);

    expect(await upgrade()).toBe(upgraded);
    await settle();
    expect(clone).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("says nothing about the upgrade's 404", async () => {
    routeWebSocket.mockResolvedValue(new Response("not found", { status: 404 }));
    await upgrade();
    await settle();
    expect(send).not.toHaveBeenCalled();
  });
});

describe("a refusal with no tenant behind it", () => {
  it("is filed as a node refusal with no workspace", async () => {
    handleAccountRoute.mockResolvedValue(error(403, "you are not a node administrator"));
    const res = await call("/api/workspaces");
    expect(res.status).toBe(403);
    await settle();

    // The node audit listing reads `workspace_id IS NULL AND action LIKE 'node.%'`.
    expect(rows()[0]).toMatchObject({
      kind: "audit",
      workspaceId: null,
      actor: "ada",
      action: "node.access.denied",
      status: "denied",
      targetKind: "route",
      targetId: "/api/workspaces",
      detail: { http_status: 403, message: "you are not a node administrator" },
    });
  });

  it("records the account path's 429 the same way", async () => {
    allowRequest = false;
    await call("/api/workspaces");
    await settle();
    expect(rows()[0]).toMatchObject({ action: "node.access.denied", workspaceId: null, detail: { http_status: 429 } });
  });

  it("leaves a workspace refusal on the workspace action", async () => {
    handleRoute.mockResolvedValue(error(403, "forbidden"));
    await call("/api/keys");
    await settle();
    expect(rows()[0]).toMatchObject({ action: "access.denied", workspaceId: "ws1" });
  });
});

/** The dedup key holds the caller-chosen path, so a per-principal budget bounds the rows. */
describe("the per-principal quota", () => {
  it("holds one principal to its budget and says, in the last row, that it stopped", async () => {
    handleRoute.mockResolvedValue(error(403, "forbidden"));
    for (let i = 0; i < 30; i++) await call(`/api/docs/${i}`);
    await settle();

    expect(rows()).toHaveLength(20);
    expect(rows().at(-1)).toMatchObject({
      detail: {
        quota_reached: {
          rows: 20,
          window_ms: 60_000,
          note: "further refusals from this principal in this window are not recorded",
        },
      },
    });
    expect(rows()[18]!.detail).not.toHaveProperty("quota_reached");
  });

  it("budgets each principal separately", async () => {
    handleRoute.mockResolvedValue(error(403, "forbidden"));
    for (let i = 0; i < 30; i++) await call(`/api/docs/${i}`);
    buildContext.mockResolvedValue({ ...CTX, alias: "bob" });
    await call("/api/keys");
    await settle();
    expect(rows().filter((r) => r.actor === "ada")).toHaveLength(20);
    expect(rows().filter((r) => r.actor === "bob")).toHaveLength(1);
  });

  it("budgets each workspace separately for the same alias", async () => {
    handleRoute.mockResolvedValue(error(403, "forbidden"));
    for (let i = 0; i < 30; i++) await call(`/api/docs/${i}`);
    buildContext.mockResolvedValue({ ...CTX, workspaceId: "ws2" });
    await call("/api/keys");
    await settle();
    expect(rows().filter((r) => r.workspaceId === "ws1")).toHaveLength(20);
    expect(rows().filter((r) => r.workspaceId === "ws2")).toHaveLength(1);
  });

  it("refills once the window has passed", async () => {
    handleRoute.mockResolvedValue(error(403, "forbidden"));
    for (let i = 0; i < 30; i++) await call(`/api/docs/${i}`);
    await settle();
    expect(rows()).toHaveLength(20);

    advancePastWindow();
    await call("/api/docs/0");
    await settle();
    expect(rows()).toHaveLength(21);
  });
});

describe("a failing ledger", () => {
  it("answers the caller even when the queue throws", async () => {
    send.mockImplementation(() => {
      throw new Error("queue down");
    });
    handleRoute.mockResolvedValue(error(403, "forbidden"));
    const res = await call();
    expect(res.status).toBe(403);
    await settle();
  });

  it("answers the caller even when the queue rejects", async () => {
    send.mockRejectedValue(new Error("queue down"));
    handleRoute.mockResolvedValue(error(403, "forbidden"));
    const res = await call();
    expect(res.status).toBe(403);
    await settle();
  });
});
