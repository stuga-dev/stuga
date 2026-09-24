/**
 * An ACL change reaches open sockets only if the route hands the actor the writer set with the
 * reader set. The actor refuses a revoke without `writersStated`, so an empty writer set still says so.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@stuga/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@stuga/db")>()),
  getDoc: vi.fn(),
  setDocAcl: vi.fn(),
  getFolder: vi.fn(),
  setFolderAcl: vi.fn(),
  folderEffectiveAcl: vi.fn(),
  childInheritingDocs: vi.fn(),
  childInheritingFolders: vi.fn(),
  isWorkspaceMember: vi.fn(),
}));

const { getDoc, setDocAcl, getFolder, setFolderAcl, folderEffectiveAcl, childInheritingDocs, childInheritingFolders, isWorkspaceMember } =
  await import("@stuga/db");
const { routeWorkspaceRequest } = await import("../http/dispatch.js");
import type { Ctx } from "../auth/context.js";

const m = (fn: unknown) => fn as unknown as ReturnType<typeof vi.fn>;

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
  acl_principals: ["user:owner-1", "user:bob"],
  acl_writers: ["user:owner-1", "user:bob"],
  acl_commenters: [],
  own_grants: { p: [], w: ["user:bob"], c: [] },
};

/** Every actor URL the request issued. */
let actorCalls: string[];

function ctxFor(): Ctx {
  return {
    sql: { unsafe: (q: string) => q },
    alias: "owner-1",
    displayName: "Ada",
    isAgent: false,
    principals: ["user:owner-1", "org:ws1"],
    workspaceId: "ws1",
    role: "owner",
    env: {
      jobs: { send: vi.fn(async () => {}) },
      docs: {
        get: () => ({
          fetch: vi.fn(async (url: string) => {
            actorCalls.push(url);
            return new Response("{}");
          }),
        }),
      },
    },
  } as unknown as Ctx;
}

/** The one /revoke this request pushed, parsed. */
function revoke(): URL {
  const hit = actorCalls.filter((u) => u.includes("/revoke"));
  expect(hit).toHaveLength(1);
  return new URL(hit[0]!);
}

async function put(path: string, body: unknown): Promise<Response> {
  const url = new URL(`https://node.test${path}`);
  const req = new Request(url, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return routeWorkspaceRequest(ctxFor(), req);
}

beforeEach(() => {
  vi.clearAllMocks();
  actorCalls = [];
  m(getDoc).mockResolvedValue({ ...DOC });
  m(setDocAcl).mockResolvedValue({ ...DOC });
  m(isWorkspaceMember).mockResolvedValue(true);
});

describe("PUT /api/docs/:id/acl", () => {
  it("hands the actor the new writer set, not just the readers", async () => {
    const res = await put("/api/docs/d1/acl", { grants: ["user:bob"], writer_grants: [], commenter_grants: [] });
    expect(res.status).toBe(200);
    const u = revoke();
    // Bob keeps read access and loses write.
    expect(u.searchParams.get("writersStated")).toBe("1");
    expect(u.searchParams.getAll("principal")).toContain("user:bob");
    expect(u.searchParams.getAll("writer")).not.toContain("user:bob");
  });

  it("states an empty writer set rather than omitting it", async () => {
    m(getDoc).mockResolvedValue({ ...DOC, owner: "user:owner-1" });
    const res = await put("/api/docs/d1/acl", { grants: ["user:bob"], writer_grants: [], commenter_grants: [] });
    expect(res.status).toBe(200);
    expect(revoke().searchParams.get("writersStated")).toBe("1");
  });
});

describe("PUT /api/folders/:id/acl", () => {
  it("carries the writer set down the cascade to each document", async () => {
    m(getFolder).mockResolvedValue({
      folder_id: "f1",
      workspace_id: "ws1",
      owner: "user:owner-1",
      title: "Team",
      parent_id: null,
      inherits_perms: false,
      acl_principals: ["user:owner-1", "user:bob"],
      acl_writers: ["user:owner-1"],
      own_grants: { p: ["user:bob"], w: [], c: [] },
    });
    m(setFolderAcl).mockResolvedValue({});
    m(folderEffectiveAcl).mockResolvedValue({ principals: ["user:owner-1", "user:bob"], writers: ["user:owner-1"] });
    m(childInheritingDocs).mockResolvedValue([{ ...DOC, inherits_perms: true, parent_id: "f1" }]);
    m(childInheritingFolders).mockResolvedValue([]);

    const res = await put("/api/folders/f1/acl", { grants: ["user:bob"], writer_grants: [], commenter_grants: [] });
    expect(res.status).toBe(200);
    // A document inheriting the folder's writers is re-tiered too.
    expect(revoke().searchParams.get("writersStated")).toBe("1");
  });
});
