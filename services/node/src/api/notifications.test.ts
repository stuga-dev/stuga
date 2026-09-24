/**
 * The tray reaches every workspace the person belongs to, each with the principals held there
 * (a guest membership adds no org floor); an agent stays in its key's one workspace. Rows about
 * the node itself are read only by someone who administers it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@stuga/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@stuga/db")>()),
  isNodeAdminAlias: vi.fn(),
  listNotifications: vi.fn(),
  listMembershipGroups: vi.fn(),
  markNotificationsRead: vi.fn(),
  unreadNotificationCount: vi.fn(),
}));

const { isNodeAdminAlias, listNotifications, listMembershipGroups, markNotificationsRead, unreadNotificationCount } =
  await import("@stuga/db");
const { routeWorkspaceRequest } = await import("../http/dispatch.js");
import type { Ctx } from "../auth/context.js";

const mockList = listNotifications as unknown as ReturnType<typeof vi.fn>;
const mockMark = markNotificationsRead as unknown as ReturnType<typeof vi.fn>;
const mockCount = unreadNotificationCount as unknown as ReturnType<typeof vi.fn>;
const mockMemberships = listMembershipGroups as unknown as ReturnType<typeof vi.fn>;
const mockNodeAdmin = isNodeAdminAlias as unknown as ReturnType<typeof vi.fn>;

/** A member of ws1 (org floor and a group) and a guest of ws2 (no org floor). */
const REACH = {
  ws1: ["user:human-1", "org:ws1", "group:eng"],
  ws2: ["user:human-1"],
};

function ctx(over: Partial<Ctx> = {}): Ctx {
  return {
    sql: {},
    alias: "human-1",
    displayName: "Ali",
    email: "alice@example.test",
    isAgent: false,
    principals: ["user:human-1"],
    workspaceId: "ws1",
    role: "member",
    env: {},
    ...over,
  } as unknown as Ctx;
}

async function route(c: Ctx, method: string, path: string, body?: unknown): Promise<Response> {
  const url = new URL(`https://node.test${path}`);
  const req = new Request(url, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  return routeWorkspaceRequest(c, req);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockList.mockResolvedValue([]);
  mockMark.mockResolvedValue(0);
  mockCount.mockResolvedValue(0);
  mockNodeAdmin.mockResolvedValue(false);
  mockMemberships.mockResolvedValue([
    { workspace_id: "ws1", role: "member", group_ids: ["group:eng"] },
    { workspace_id: "ws2", role: "guest", group_ids: [] },
  ]);
});

describe("GET /api/notifications/unread", () => {
  it("returns just the count, across every workspace the caller belongs to", async () => {
    mockCount.mockResolvedValue(7);
    const res = await route(ctx(), "GET", "/api/notifications/unread");
    expect(res.status).toBe(200);
    expect(mockMemberships).toHaveBeenCalledWith({}, "human-1", "user:human-1");
    expect(mockCount).toHaveBeenCalledWith({}, "human-1", REACH, false);
    expect(await res.json()).toEqual({ unread: 7 });
    expect(mockList).not.toHaveBeenCalled();
  });

  it("keeps an agent to its key's one workspace", async () => {
    const agent = ctx({ isAgent: true, alias: "agent-1", principals: ["agent:agent-1", "user:human-1"] });
    await route(agent, "GET", "/api/notifications/unread");
    expect(mockMemberships).not.toHaveBeenCalled();
    expect(mockCount).toHaveBeenCalledWith({}, "agent-1", { ws1: ["agent:agent-1", "user:human-1"] }, false);
  });
});

describe("GET /api/notifications", () => {
  it("lists the caller's rows across their workspaces", async () => {
    const rows = [{ id: "n1", event_type: "REQUEST_ACCESS", read: false }];
    mockList.mockResolvedValue(rows);
    const res = await route(ctx(), "GET", "/api/notifications");
    expect(res.status).toBe(200);
    expect(mockList).toHaveBeenCalledWith({}, "human-1", REACH, 20, false);
    expect(await res.json()).toMatchObject({ notifications: rows });
  });

  it("passes a caller-chosen limit through", async () => {
    await route(ctx(), "GET", "/api/notifications?limit=5");
    expect(mockList).toHaveBeenCalledWith({}, "human-1", REACH, 5, false);
  });

  it.each([
    ["abc", 20],
    ["", 20],
    ["2.5", 20],
    ["-3", 1],
    ["0", 1],
    ["500", 100],
  ])("reads ?limit=%s as %i", async (raw, expected) => {
    const res = await route(ctx(), "GET", `/api/notifications?limit=${raw}`);
    expect(res.status).toBe(200);
    expect(mockList).toHaveBeenCalledWith({}, "human-1", REACH, expected, false);
  });
});

describe("POST /api/notifications/read", () => {
  it("marks the whole backlog when no ids are given", async () => {
    mockMark.mockResolvedValue(3);
    const res = await route(ctx(), "POST", "/api/notifications/read", {});
    expect(res.status).toBe(200);
    expect(mockMark).toHaveBeenCalledWith({}, "human-1", ["ws1", "ws2"], undefined, undefined, false);
    expect(await res.json()).toMatchObject({ ok: true, updated: 3 });
  });

  it("marks all when the body is missing", async () => {
    const res = await route(ctx(), "POST", "/api/notifications/read");
    expect(res.status).toBe(200);
    expect(mockMark).toHaveBeenCalledWith({}, "human-1", ["ws1", "ws2"], undefined, undefined, false);
  });

  it("scopes the write to the given ids", async () => {
    mockMark.mockResolvedValue(2);
    const res = await route(ctx(), "POST", "/api/notifications/read", { ids: ["n1", "n2"] });
    expect(res.status).toBe(200);
    expect(mockMark).toHaveBeenCalledWith({}, "human-1", ["ws1", "ws2"], ["n1", "n2"], undefined, false);
    expect(await res.json()).toMatchObject({ ok: true, updated: 2 });
  });

  it("bounds a mark-all by the client's created_at watermark", async () => {
    mockMark.mockResolvedValue(4);
    const res = await route(ctx(), "POST", "/api/notifications/read", { before: "2026-08-19T10:00:00.000Z" });
    expect(res.status).toBe(200);
    expect(mockMark).toHaveBeenCalledWith({}, "human-1", ["ws1", "ws2"], undefined, "2026-08-19T10:00:00.000Z", false);
  });

  it("refuses malformed ids instead of treating them as mark-all", async () => {
    for (const ids of ["n1", 42, [42], [null], { n: 1 }]) {
      const res = await route(ctx(), "POST", "/api/notifications/read", { ids });
      expect(res.status).toBe(400);
    }
    expect(mockMark).not.toHaveBeenCalled();
  });

  it("refuses a malformed watermark and a null body without touching anything", async () => {
    for (const body of [{ before: 42 }, { before: "not a date" }, null]) {
      const res = await route(ctx(), "POST", "/api/notifications/read", body);
      expect(res.status).toBe(body === null ? 200 : 400);
    }
    expect(mockMark).toHaveBeenCalledTimes(1);
    expect(mockMark).toHaveBeenCalledWith({}, "human-1", ["ws1", "ws2"], undefined, undefined, false);
  });

  it("treats an explicitly empty ids array as a no-op, not mark-all", async () => {
    const res = await route(ctx(), "POST", "/api/notifications/read", { ids: [] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, updated: 0 });
    expect(mockMark).not.toHaveBeenCalled();
  });
});

describe("rows about the node itself", () => {
  it("are counted, listed and marked for someone who administers the node", async () => {
    mockNodeAdmin.mockResolvedValue(true);
    await route(ctx(), "GET", "/api/notifications/unread");
    await route(ctx(), "GET", "/api/notifications");
    await route(ctx(), "POST", "/api/notifications/read", {});
    expect(mockNodeAdmin).toHaveBeenCalledWith({}, "human-1");
    expect(mockCount).toHaveBeenCalledWith({}, "human-1", REACH, true);
    expect(mockList).toHaveBeenCalledWith({}, "human-1", REACH, 20, true);
    expect(mockMark).toHaveBeenCalledWith({}, "human-1", ["ws1", "ws2"], undefined, undefined, true);
  });

  it("are never an agent's, whoever it acts for", async () => {
    mockNodeAdmin.mockResolvedValue(true);
    const agent = ctx({ isAgent: true, alias: "agent-1", principals: ["agent:agent-1", "user:human-1"] });
    await route(agent, "GET", "/api/notifications");
    expect(mockNodeAdmin).not.toHaveBeenCalled();
    expect(mockList).toHaveBeenCalledWith({}, "agent-1", { ws1: ["agent:agent-1", "user:human-1"] }, 20, false);
  });
});
