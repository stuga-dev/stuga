/** GET of an ACL names the folder inherited access comes from, and hides its title from a caller who can't read it. */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@stuga/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@stuga/db")>()),
  getDoc: vi.fn(),
  getFolder: vi.fn(),
}));

const { getDoc, getFolder } = await import("@stuga/db");
const { routeWorkspaceRequest } = await import("../http/dispatch.js");
import type { Ctx } from "../auth/context.js";

const mockGetDoc = getDoc as unknown as ReturnType<typeof vi.fn>;
const mockGetFolder = getFolder as unknown as ReturnType<typeof vi.fn>;

const DOC = {
  doc_id: "d1",
  workspace_id: "ws1",
  owner: "user:owner-1",
  title: "Roadmap",
  doc_type: "prose",
  parent_id: "f1",
  trashed: false,
  locked: false,
  inherits_perms: true,
  acl_principals: ["user:owner-1", "user:bob"],
  acl_writers: ["user:owner-1"],
  acl_commenters: [],
  own_grants: { p: [], w: [], c: [] },
};

const FOLDER = {
  folder_id: "f1",
  workspace_id: "ws1",
  owner: "user:owner-1",
  title: "Planning",
  parent_id: null,
  trashed: false,
  inherits_perms: false,
  acl_principals: ["user:owner-1"],
  acl_writers: ["user:owner-1"],
  own_grants: { p: [], w: [], c: [] },
};

function ctxFor(over: Partial<Ctx> = {}): Ctx {
  return {
    sql: {},
    alias: "owner-1",
    displayName: "Ada",
    isAgent: false,
    principals: ["user:owner-1", "org:ws1"],
    workspaceId: "ws1",
    role: "member",
    env: {},
    ...over,
  } as unknown as Ctx;
}

async function get(ctx: Ctx = ctxFor()): Promise<Record<string, unknown>> {
  const res = await routeWorkspaceRequest(ctx, new Request("https://node.test/api/docs/d1/acl"));
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetDoc.mockResolvedValue({ ...DOC });
  mockGetFolder.mockResolvedValue({ ...FOLDER });
});

describe("GET /api/docs/:id/acl", () => {
  it("names the parent folder a reader of it can see", async () => {
    expect((await get()).parent).toEqual({ folder_id: "f1", title: "Planning" });
  });

  it("withholds the parent's title from a caller who cannot read the folder", async () => {
    const bob = ctxFor({ alias: "bob", principals: ["user:bob", "org:ws1"] });
    expect((await get(bob)).parent).toEqual({ folder_id: "f1", title: null });
  });

  it("names the owner, who is in neither the direct grants nor the parent's", async () => {
    expect((await get()).owner).toBe("user:owner-1");
  });

  it("has no parent at the top level", async () => {
    mockGetDoc.mockResolvedValue({ ...DOC, parent_id: null, inherits_perms: false });
    expect((await get()).parent).toBeNull();
  });
});
