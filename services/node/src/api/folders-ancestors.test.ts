/** A folder's breadcrumb gives the titles of the folders above it only to a caller who may read them. */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@stuga/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@stuga/db")>()),
  getFolder: vi.fn(),
  getFolderAncestors: vi.fn(),
}));

const { getFolder, getFolderAncestors } = await import("@stuga/db");
const { routeWorkspaceRequest } = await import("../http/dispatch.js");
import type { Ctx } from "../auth/context.js";
import { agentCtx, personCtx } from "../testing/ctx.js";

const mockGetFolder = getFolder as unknown as ReturnType<typeof vi.fn>;
const mockGetFolderAncestors = getFolderAncestors as unknown as ReturnType<typeof vi.fn>;

function folder(folderId: string, title: string, parentId: string | null, readers: string[]) {
  return {
    folder_id: folderId,
    workspace_id: "ws1",
    owner: "user:owner-1",
    title,
    parent_id: parentId,
    inherits_perms: false,
    acl_principals: ["user:owner-1", ...readers],
    acl_writers: ["user:owner-1"],
    own_grants: { p: [], w: [], c: [] },
    agent_instructions: "Keep it short.",
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-02T00:00:00.000Z",
  };
}

// Company/Team/Shared, with only Shared shared with bob.
const CHAIN = [
  folder("f_company", "Company", null, []),
  folder("f_team", "Team", "f_company", []),
  folder("f_shared", "Shared", "f_team", ["user:bob"]),
];

const owner = personCtx({ alias: "owner-1" });
const bob = personCtx({ alias: "bob" });

async function ancestors(ctx: Ctx, folderId = "f_shared"): Promise<Response> {
  return routeWorkspaceRequest(ctx, new Request(`https://node.test/api/folders/${folderId}/ancestors`));
}

async function chain(ctx: Ctx): Promise<Record<string, unknown>[]> {
  const res = await ancestors(ctx);
  expect(res.status).toBe(200);
  return ((await res.json()) as { ancestors: Record<string, unknown>[] }).ancestors;
}

const redacted = (folderId: string, parentId: string | null) => ({
  folder_id: folderId,
  parent_id: parentId,
  title: null,
  owner: null,
  created_at: null,
  updated_at: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockGetFolder.mockImplementation(async (_sql: unknown, id: string) => CHAIN.find((f) => f.folder_id === id) ?? null);
  mockGetFolderAncestors.mockResolvedValue(CHAIN);
});

describe("GET /api/folders/:id/ancestors", () => {
  it("names every folder for a reader of the whole chain", async () => {
    expect((await chain(owner)).map((f) => f.title)).toEqual(["Company", "Team", "Shared"]);
  });

  it("redacts the parents of a subfolder shared on its own, keeping the chain's shape", async () => {
    const got = await chain(bob);
    expect(got.slice(0, 2)).toStrictEqual([redacted("f_company", null), redacted("f_team", "f_company")]);
    expect(got[2]).toMatchObject({ folder_id: "f_shared", title: "Shared", owner: "user:owner-1" });
  });

  it("never sends grants or instructions, even for a folder the caller reads", async () => {
    for (const f of await chain(owner)) {
      expect(f).not.toHaveProperty("acl_principals");
      expect(f).not.toHaveProperty("agent_instructions");
    }
  });

  it("redacts a parent outside a key's folder scope, though its person may read it", async () => {
    const scoped = agentCtx({ onBehalfOf: "owner-1", scope: { folders: ["f_shared"], readOnly: false, credentialId: "k1" } });
    const got = await chain(scoped);
    expect(got.map((f) => f.title)).toEqual([null, null, "Shared"]);
  });

  it("answers 404 to a caller who cannot read the folder itself", async () => {
    expect((await ancestors(bob, "f_team")).status).toBe(404);
    expect(mockGetFolderAncestors).not.toHaveBeenCalled();
  });
});
