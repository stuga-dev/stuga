/**
 * The audit rows of an ACL write and a group sync: the principals that entered and left the
 * direct grants, never the flattened arrays, and no row for a write that changes nobody's access.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@stuga/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@stuga/db")>()),
  getDoc: vi.fn(),
  setDocAcl: vi.fn(),
  isWorkspaceMember: vi.fn(),
  upsertGroup: vi.fn(),
}));

const {
  getDoc,
  setDocAcl,
  isWorkspaceMember,
  upsertGroup,
} = await import("@stuga/db");
const { routeWorkspaceRequest } = await import("../http/dispatch.js");
import type { Ctx } from "../auth/context.js";

const mockGetDoc = getDoc as unknown as ReturnType<typeof vi.fn>;
const mockSetDocAcl = setDocAcl as unknown as ReturnType<typeof vi.fn>;
const mockIsMember = isWorkspaceMember as unknown as ReturnType<typeof vi.fn>;
const mockUpsertGroup = upsertGroup as unknown as ReturnType<typeof vi.fn>;

/** Its effective arrays carry user:carol, inherited from a folder rather than granted directly. */
const DOC = {
  doc_id: "d1",
  workspace_id: "ws1",
  owner: "user:owner-1",
  title: "Roadmap",
  doc_type: "prose",
  parent_id: null,
  trashed: false,
  locked: false,
  inherits_perms: false,
  acl_principals: ["user:owner-1", "user:bob", "user:carol"],
  acl_writers: ["user:owner-1"],
  acl_commenters: [],
  own_grants: { p: ["user:bob"], w: [], c: [] },
};

/** Every job this request enqueued, audit rows included. */
let jobs: Array<Record<string, unknown>>;

function ctxFor(over: Partial<Ctx> = {}): Ctx {
  return {
    sql: {},
    alias: "owner-1",
    displayName: "Ada",
    isAgent: false,
    principals: ["user:owner-1", "org:ws1"],
    workspaceId: "ws1",
    role: "owner",
    env: {
      jobs: {
        send: vi.fn(async (message: Record<string, unknown>) => {
          jobs.push(message);
        }),
      },
      docs: { get: () => ({ fetch: vi.fn(async () => new Response("{}")) }) },
    },
    ...over,
  } as unknown as Ctx;
}

function auditRows(): Array<Record<string, unknown>> {
  return jobs.filter((message) => message.kind === "audit");
}

async function put(path: string, body: unknown, ctx: Ctx = ctxFor()): Promise<Response> {
  const url = new URL(`https://node.test${path}`);
  const req = new Request(url, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return routeWorkspaceRequest(ctx, req);
}

beforeEach(() => {
  vi.clearAllMocks();
  jobs = [];
  mockGetDoc.mockResolvedValue({ ...DOC });
  mockSetDocAcl.mockResolvedValue({ ...DOC });
  mockIsMember.mockResolvedValue(true);
  mockUpsertGroup.mockResolvedValue(null);
});

describe("PUT /api/docs/:id/acl", () => {
  it("records the principal it added from the direct grants, not the flattened arrays", async () => {
    const res = await put("/api/docs/d1/acl", {
      grants: ["user:bob", "user:alice"],
      writer_grants: [],
      commenter_grants: [],
    });
    expect(res.status).toBe(200);
    expect(auditRows()).toHaveLength(1);
    const row = auditRows()[0]!;
    expect(row.action).toBe("acl.set");
    // The title as it read when the change was made.
    expect(row.targetLabel).toBe("Roadmap");
    expect(row.detail).toEqual({
      added: { p: ["user:alice"], w: [], c: [] },
      removed: { p: [], w: [], c: [] },
      inherits: { before: false, after: false },
    });
  });
  it("writes no row for a save that moves nobody, and still writes the ACL", async () => {
    const res = await put("/api/docs/d1/acl", {
      grants: ["user:bob"],
      writer_grants: [],
      commenter_grants: [],
    });
    expect(res.status).toBe(200);
    expect(mockSetDocAcl).toHaveBeenCalledTimes(1);
    expect(auditRows()).toEqual([]);
  });
});
describe("PUT /api/groups/:id", () => {
  it("names the members the sync added and removed", async () => {
    mockUpsertGroup.mockResolvedValue(["user:alice", "user:bob"]);
    const res = await put("/api/groups/eng", { members: ["user:alice", "user:carol"] });
    expect(res.status).toBe(200);
    expect(auditRows()).toHaveLength(1);
    const row = auditRows()[0]!;
    expect(row.action).toBe("group.sync");
    expect(row.targetLabel).toBeNull();
    expect(row.detail).toEqual({
      added: ["user:carol"],
      removed: ["user:bob"],
      members: 2,
    });
  });
  it("writes no row for a re-sync that changes no membership", async () => {
    mockUpsertGroup.mockResolvedValue(["user:carol", "user:alice"]);
    const res = await put("/api/groups/eng", { members: ["user:alice", "user:carol"] });
    expect(res.status).toBe(200);
    expect(mockUpsertGroup).toHaveBeenCalledTimes(1);
    expect(auditRows()).toEqual([]);
  });
});