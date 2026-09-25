/** A new folder takes the workspace's default access, as a new document does. */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@stuga/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@stuga/db")>()),
  createFolder: vi.fn(),
  getWorkspace: vi.fn(async () => ({ default_doc_access: "workspace_edit" })),
  getMemberRole: vi.fn(async () => "member"),
}));

vi.mock("../audit/record.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../audit/record.js")>()),
  recordAudit: vi.fn(),
}));

const { createFolder, getWorkspace } = await import("@stuga/db");
const { createFolderRoute } = await import("./folders.js");
import type { Ctx } from "../auth/context.js";
import type { WorkspaceCall } from "../http/router.js";

const mockCreateFolder = vi.mocked(createFolder);
const mockGetWorkspace = vi.mocked(getWorkspace);

function ctxOf(overrides: Record<string, unknown> = {}): Ctx {
  return {
    sql: {},
    alias: "bob",
    isAgent: false,
    principals: ["user:bob", "org:ws1"],
    workspaceId: "ws1",
    role: "member",
    ...overrides,
  } as unknown as Ctx;
}

async function create(ctx: Ctx): Promise<Response> {
  const req = new Request("http://node/api/folders", { method: "POST", body: JSON.stringify({ title: "Plans" }) });
  return createFolderRoute({ ctx, req, url: new URL(req.url), match: [] } as unknown as WorkspaceCall);
}

/** The createFolder input of the one row this call inserted. */
const inserted = () => mockCreateFolder.mock.calls[0]![1];

beforeEach(() => {
  vi.clearAllMocks();
  mockGetWorkspace.mockResolvedValue({ default_doc_access: "workspace_edit" } as never);
  mockCreateFolder.mockImplementation(async (_sql, input) => ({
    folder_id: input.folderId,
    workspace_id: input.workspaceId,
    owner: input.owner,
    title: input.title,
    parent_id: input.parentId ?? null,
    acl_principals: input.aclPrincipals,
    acl_writers: input.aclWriters,
    agent_instructions: "",
  }) as never);
});

describe("POST /api/folders", () => {
  it("lets everyone in the workspace read and write under the default", async () => {
    expect((await create(ctxOf())).status).toBe(201);
    expect(inserted().ownGrants).toEqual({ p: ["org:ws1"], w: ["org:ws1"], c: [] });
    expect(inserted().aclPrincipals).toEqual(expect.arrayContaining(["user:bob", "org:ws1"]));
    expect(inserted().aclWriters).toEqual(expect.arrayContaining(["user:bob", "org:ws1"]));
  });

  it("follows a view-only default", async () => {
    mockGetWorkspace.mockResolvedValue({ default_doc_access: "workspace_view" } as never);
    await create(ctxOf());
    expect(inserted().ownGrants).toEqual({ p: ["org:ws1"], w: [], c: [] });
    expect(inserted().aclWriters).not.toContain("org:ws1");
  });

  it("keeps a folder private under a private default", async () => {
    mockGetWorkspace.mockResolvedValue({ default_doc_access: "private" } as never);
    await create(ctxOf());
    expect(inserted().aclPrincipals).not.toContain("org:ws1");
  });

  it("gives an agent's folder to its human, with the default the human's would get", async () => {
    await create(ctxOf({ alias: "agent-1", isAgent: true, onBehalfOf: "bob", principals: ["agent:agent-1", "user:bob", "org:ws1"] }));
    expect(inserted().owner).toBe("user:bob");
    expect(inserted().ownGrants).toEqual({ p: ["agent:agent-1", "org:ws1"], w: ["agent:agent-1", "org:ws1"], c: [] });
  });
});
