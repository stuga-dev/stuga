/**
 * DELETE /api/docs/:id/versions/:seq: who may call it, never the head (the actor would hydrate an
 * empty document), and the blob before the row so a crash leaves a row that reads as pruned.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@stuga/db", () => ({
  getDoc: vi.fn(),
  deleteVersion: vi.fn(),
  listVersions: vi.fn(async () => []),
}));

const { getDoc, deleteVersion, listVersions } = await import("@stuga/db");
const { routeWorkspaceRequest } = await import("../http/dispatch.js");
import type { Ctx } from "../auth/context.js";

const mockGetDoc = getDoc as unknown as ReturnType<typeof vi.fn>;
const mockDeleteVersion = deleteVersion as unknown as ReturnType<typeof vi.fn>;
const mockListVersions = listVersions as unknown as ReturnType<typeof vi.fn>;

const DOC = {
  doc_id: "d1",
  workspace_id: "ws1",
  owner: "user:owner-1",
  title: "Notes",
  doc_type: "prose",
  trashed: false,
  locked: false,
  snapshot_seq: 42,
  acl_principals: ["user:owner-1", "user:viv", "agent:agent-1", "org:ws1"],
  acl_writers: ["user:owner-1", "agent:agent-1"],
};

/** Every side effect, in the order it happened. */
let effects: string[] = [];
const snapshotDelete = vi.fn(async (key: string) => {
  effects.push(`blob:${key}`);
});
/** The document actor plays no part in deleting history. */
const actorFetch = vi.fn(async () => new Response("{}", { headers: { "content-type": "application/json" } }));

function ctxOf(overrides: Partial<Ctx> = {}): Ctx {
  return {
    sql: {},
    alias: "owner-1",
    displayName: "Ozzie",
    isAgent: false,
    principals: ["user:owner-1"],
    workspaceId: "ws1",
    role: "member",
    env: {
      snapshots: { delete: snapshotDelete },
      docs: { get: () => ({ fetch: actorFetch }) },
    },
    ...overrides,
  } as unknown as Ctx;
}

const owner = () => ctxOf();
const admin = () => ctxOf({ alias: "adm", principals: ["org:ws1"], role: "admin" });
const member = () => ctxOf({ alias: "viv", principals: ["user:viv"], role: "member" });
const agent = () =>
  ctxOf({ alias: "agent-1", isAgent: true, onBehalfOf: "owner-1", principals: ["agent:agent-1"] });

async function call(ctx: Ctx, method: string, path: string): Promise<Response> {
  const req = new Request(`https://node.test${path}`, { method });
  return routeWorkspaceRequest(ctx, req);
}

const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error;

beforeEach(() => {
  effects = [];
  snapshotDelete.mockClear();
  actorFetch.mockClear();
  mockGetDoc.mockReset();
  mockGetDoc.mockResolvedValue({ ...DOC });
  mockListVersions.mockClear();
  mockDeleteVersion.mockReset();
  mockDeleteVersion.mockImplementation(async () => {
    effects.push("sql:delete");
    return true;
  });
});

describe("DELETE /api/docs/:id/versions/:seq", () => {
  it("removes the snapshot blob before the row, and reports the deleted seq", async () => {
    const res = await call(owner(), "DELETE", "/api/docs/d1/versions/7");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 7 });
    expect(effects).toEqual(["blob:d1/7.bin", "sql:delete"]);
    expect(mockDeleteVersion).toHaveBeenCalledWith({}, "d1", 7);
    expect(actorFetch).not.toHaveBeenCalled();
  });

  it("lets a workspace admin delete a doc they do not own", async () => {
    expect((await call(admin(), "DELETE", "/api/docs/d1/versions/7")).status).toBe(200);
  });

  it("refuses HEAD and every seq above it, touching nothing", async () => {
    // 42 is docs.snapshot_seq; the actor may already have flushed 43.
    for (const seq of [42, 43, 9001]) {
      const res = await call(owner(), "DELETE", `/api/docs/d1/versions/${seq}`);
      expect(res.status, `seq ${seq}`).toBe(409);
      expect(await errorOf(res)).toMatch(/current version/);
    }
    expect(effects).toEqual([]);
  });

  it("refuses a caller who does not manage the doc, and an agent always", async () => {
    for (const ctx of [member(), agent()]) {
      const res = await call(ctx, "DELETE", "/api/docs/d1/versions/7");
      expect(res.status).toBe(403);
      expect(await errorOf(res)).toMatch(/owner or a workspace admin/);
    }
    expect(effects).toEqual([]);
  });

  it("refuses while the doc is locked", async () => {
    mockGetDoc.mockResolvedValue({ ...DOC, locked: true });
    const res = await call(owner(), "DELETE", "/api/docs/d1/versions/7");
    expect(res.status).toBe(423);
    expect(effects).toEqual([]);
  });

  it("hides a database doc and a doc from another workspace", async () => {
    mockGetDoc.mockResolvedValue({ ...DOC, doc_type: "database" });
    expect((await call(owner(), "DELETE", "/api/docs/d1/versions/7")).status).toBe(404);

    mockGetDoc.mockResolvedValue({ ...DOC, workspace_id: "ws2" });
    expect((await call(owner(), "DELETE", "/api/docs/d1/versions/7")).status).toBe(404);

    expect(effects).toEqual([]);
  });

  it("404s when no such version row exists", async () => {
    mockDeleteVersion.mockImplementation(async () => {
      effects.push("sql:delete");
      return false;
    });
    const res = await call(owner(), "DELETE", "/api/docs/d1/versions/7");
    expect(res.status).toBe(404);
  });

  it("removes the row for a version whose blob was already pruned", async () => {
    const res = await call(owner(), "DELETE", "/api/docs/d1/versions/5");
    expect(res.status).toBe(200);
    expect(effects).toEqual(["blob:d1/5.bin", "sql:delete"]);
  });
});

describe("GET /api/docs/:id/versions", () => {
  it("is readable by any principal on the ACL, not just a manager", async () => {
    const res = await call(member(), "GET", "/api/docs/d1/versions");
    expect(res.status).toBe(200);
    expect(mockListVersions).toHaveBeenCalledWith({}, "d1");
  });
});
