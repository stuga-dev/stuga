/**
 * A group grant is resolved per request: a membership sync rewrites no resource ACL, and a share
 * with a group notifies its current members.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@stuga/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@stuga/db")>()),
  upsertGroup: vi.fn(async () => {}),
  listGroupMembers: vi.fn(async () => ["user:alice", "user:bob"]),
  getDoc: vi.fn(),
  setDocAcl: vi.fn(async () => {}),
  setFolderAcl: vi.fn(async () => {}),
  folderEffectiveAcl: vi.fn(async () => ({ principals: [], writers: [] })),
  isWorkspaceMember: vi.fn(async () => true),
  getUserAliasByHandle: vi.fn(async () => null),
}));

const { upsertGroup, listGroupMembers, getDoc, setDocAcl } = await import("@stuga/db");
const { routeWorkspaceRequest } = await import("../http/dispatch.js");
import type { Ctx } from "../auth/context.js";

const mockUpsertGroup = upsertGroup as unknown as ReturnType<typeof vi.fn>;
const mockListGroupMembers = listGroupMembers as unknown as ReturnType<typeof vi.fn>;
const jobsSend = vi.fn(async (_message: Record<string, unknown>) => {});
const mockGetDoc = getDoc as unknown as ReturnType<typeof vi.fn>;
const mockSetDocAcl = setDocAcl as unknown as ReturnType<typeof vi.fn>;

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
  own_grants: { p: [], w: [], c: [] },
  acl_principals: ["user:owner-1"],
  acl_writers: ["user:owner-1"],
  acl_commenters: [],
};

function ctxOf(): Ctx {
  return {
    sql: {},
    alias: "owner-1",
    principals: ["user:owner-1", "org:ws1"],
    workspaceId: "ws1",
    role: "owner",
    isAgent: false,
    env: { docs: { get: () => ({ fetch: async () => new Response("{}") }) }, jobs: { send: jobsSend } },
  } as unknown as Ctx;
}

async function put(path: string, body: unknown): Promise<Response> {
  const req = new Request(`https://node.test${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return routeWorkspaceRequest(ctxOf(), req);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetDoc.mockResolvedValue(DOC);
  mockListGroupMembers.mockResolvedValue(["user:alice", "user:bob"]);
});

describe("PUT /api/groups/:id", () => {
  it("writes the group's membership and rewrites no resource ACL", async () => {
    const res = await put("/api/groups/eng", { members: ["user:Alice", "bob"] });

    expect(res.status).toBe(200);
    expect(mockUpsertGroup).toHaveBeenCalledWith({}, "group:eng", ["user:alice", "user:bob"], "ws1");
    expect(mockSetDocAcl).not.toHaveBeenCalled();
  });
});

describe("sharing with a group", () => {
  it("stores the group principal, not its members", async () => {
    await put("/api/docs/d1/acl", { grants: ["group:eng"], writer_grants: [] });

    const [, , principals] = mockSetDocAcl.mock.calls[0]!;
    expect(principals).toContain("group:eng");
    expect(principals).not.toContain("user:alice");
    expect(principals).not.toContain("user:bob");
  });

  it("notifies the people in the group, resolved at send time", async () => {
    await put("/api/docs/d1/acl", { grants: ["group:eng"], writer_grants: [] });

    expect(mockListGroupMembers).toHaveBeenCalledWith({}, ["group:eng"], "ws1");
    const recipients = jobsSend.mock.calls
      .map(([message]) => message)
      .filter((message) => message.kind === "notify")
      .map((message) => message.recipient as string);
    expect(recipients.sort()).toEqual(["alice", "bob"]);
  });
});
