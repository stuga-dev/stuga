import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@stuga/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@stuga/db")>()),
  createDoc: vi.fn(),
  deleteDoc: vi.fn(async () => {}),
  getDoc: vi.fn(async () => null),
  getFolder: vi.fn(async () => null),
  getWorkspace: vi.fn(async () => ({ default_doc_access: "workspace_edit" })),
  getMemberRole: vi.fn(async () => "member"),
}));

vi.mock("../jobs/snapshot-sweep.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../jobs/snapshot-sweep.js")>()),
  queueSnapshotSweep: vi.fn(async () => {}),
}));

const { createDoc, deleteDoc, getDoc, getFolder, getWorkspace } = await import("@stuga/db");
const { queueSnapshotSweep } = await import("../jobs/snapshot-sweep.js");
const { createDocument } = await import("./create.js");
import type { Ctx } from "../auth/context.js";

const mockCreateDoc = vi.mocked(createDoc);
const mockDeleteDoc = vi.mocked(deleteDoc);
const mockGetDoc = vi.mocked(getDoc);
const mockGetFolder = vi.mocked(getFolder);
const mockGetWorkspace = vi.mocked(getWorkspace);
const mockQueueSweep = vi.mocked(queueSnapshotSweep);
const jobsSend = vi.fn(async (_message: Record<string, unknown>) => {});

let actorAnswer: { status: number; body: unknown };
const actorCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
const actorFetch = vi.fn(async (url: string, init?: RequestInit) => {
  actorCalls.push({ url, body: init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {} });
  return new Response(JSON.stringify(actorAnswer.body), { status: actorAnswer.status });
});

const FOLDER = {
  folder_id: "f1",
  workspace_id: "ws1",
  owner: "user:carol",
  acl_principals: ["user:carol", "user:bob", "group:ws1:design"],
  acl_writers: ["user:carol", "user:bob", "agent:agent-1"],
};

function ctxOf(overrides: Record<string, unknown> = {}): Ctx {
  return {
    sql: {},
    alias: "bob",
    displayName: "Bob",
    isAgent: false,
    principals: ["user:bob", "org:ws1"],
    workspaceId: "ws1",
    role: "member",
    env: {
      databases: { get: () => ({ fetch: actorFetch }) },
      docs: { get: () => ({ fetch: actorFetch }) },
      settings: { current: () => ({ databaseOpsKeep: 500 }) },
      jobs: { send: jobsSend },
    },
    ...overrides,
  } as unknown as Ctx;
}

const agent = (overrides: Record<string, unknown> = {}) =>
  ctxOf({ alias: "agent-1", isAgent: true, onBehalfOf: "bob", principals: ["agent:agent-1", "user:bob", "org:ws1"], ...overrides });

/** The createDoc input of the one row this call inserted. */
const inserted = () => mockCreateDoc.mock.calls[0]![1];

beforeEach(() => {
  vi.clearAllMocks();
  actorCalls.length = 0;
  actorAnswer = { status: 200, body: { applied: true } };
  mockCreateDoc.mockImplementation(async (_sql, input) => ({
    doc_id: input.docId,
    workspace_id: input.workspaceId,
    title: input.title,
    doc_type: input.docType ?? "prose",
    parent_id: input.parentId ?? null,
    owner: input.owner,
  }) as never);
  mockGetDoc.mockResolvedValue(null);
  mockGetFolder.mockResolvedValue(null);
  mockGetWorkspace.mockResolvedValue({ default_doc_access: "workspace_edit" } as never);
});

describe("createDocument", () => {
  it("inherits the parent folder's sharing, for an agent as for a person", async () => {
    mockGetFolder.mockResolvedValue(FOLDER as never);
    const out = await createDocument(agent(), { title: "Notes", parentId: "f1" });
    expect(out.ok).toBe(true);
    const row = inserted();
    expect(row.parentId).toBe("f1");
    expect(row.owner).toBe("user:bob");
    expect(row.aclPrincipals).toEqual(expect.arrayContaining(["user:bob", "agent:agent-1", "group:ws1:design", "user:carol"]));
    expect(row.aclWriters).toEqual(expect.arrayContaining(["user:bob", "agent:agent-1"]));
    // The agent is recorded as a direct grant, beside the workspace floor.
    expect(row.ownGrants).toEqual({ p: ["agent:agent-1", "org:ws1"], w: ["agent:agent-1", "org:ws1"], c: [] });
  });

  it("gives a person's document the workspace's default visibility", async () => {
    mockGetWorkspace.mockResolvedValue({ default_doc_access: "workspace_view" } as never);
    await createDocument(ctxOf(), { title: "Plan" });
    expect(inserted().ownGrants).toEqual({ p: ["org:ws1"], w: [], c: [] });
  });

  it("gives an agent's document the default its person's would get", async () => {
    await createDocument(agent(), { title: "Plan" });
    expect(inserted().owner).toBe("user:bob");
    expect(inserted().aclPrincipals).toEqual(expect.arrayContaining(["user:bob", "agent:agent-1", "org:ws1"]));
    expect(inserted().aclWriters).toEqual(expect.arrayContaining(["user:bob", "agent:agent-1", "org:ws1"]));

    vi.clearAllMocks();
    mockGetWorkspace.mockResolvedValue({ default_doc_access: "private" } as never);
    await createDocument(agent(), { title: "Plan" });
    expect(inserted().aclPrincipals).not.toContain("org:ws1");
  });

  it("proposes an agent's imported body for review, and deletes the row when the proposal fails", async () => {
    mockGetDoc.mockImplementation(async (_sql, docId) => ({
      doc_id: docId,
      workspace_id: "ws1",
      doc_type: "prose",
      title: "Minutes",
      parent_id: null,
      trashed: false,
      locked: false,
      agent_mode: "review",
      acl_principals: inserted().aclPrincipals,
      acl_writers: inserted().aclWriters,
      acl_commenters: [],
    }) as never);
    actorAnswer = { status: 200, body: { mode: "proposed", run: { id: "run-1" }, pending: 1 } };
    expect(await createDocument(agent(), { markdown: "# Minutes\n\nbody" })).toMatchObject({ ok: true });
    expect(actorCalls.map((c) => c.url)).toEqual([expect.stringContaining("/runs/propose")]);
    expect(actorCalls[0]!.body).toMatchObject({ action: "write", review: "review", reviewer: "bob" });

    vi.clearAllMocks();
    actorCalls.length = 0;
    actorAnswer = { status: 503, body: {} };
    expect(await createDocument(agent(), { markdown: "# Minutes" })).toMatchObject({ ok: false, status: 502 });
    expect(actorCalls.some((c) => c.url.includes("/apply-edits"))).toBe(false);
    expect(mockDeleteDoc).toHaveBeenCalledTimes(1);
  });

  it("refuses a guest, a parent the caller cannot write, and a scoped key at the root before inserting", async () => {
    expect(await createDocument(ctxOf({ role: "guest" }), { title: "x" })).toEqual({
      ok: false,
      status: 403,
      message: "guests cannot create documents in this workspace",
    });

    mockGetFolder.mockResolvedValue({ ...FOLDER, acl_principals: ["user:bob"], acl_writers: ["user:carol"] } as never);
    expect(await createDocument(ctxOf(), { title: "x", parentId: "f1" })).toMatchObject({ ok: false, status: 403 });

    mockGetFolder.mockResolvedValue({ ...FOLDER, workspace_id: "ws2" } as never);
    expect(await createDocument(ctxOf(), { title: "x", parentId: "f1" })).toMatchObject({ ok: false, status: 404 });

    const scoped = agent({ scope: { folders: ["f1"], readOnly: false } });
    expect(await createDocument(scoped, { title: "x", docType: "database" })).toMatchObject({ ok: false, status: 403 });

    expect(mockCreateDoc).not.toHaveBeenCalled();
  });

  it("refuses bad starter columns and a markdown database before inserting", async () => {
    expect(await createDocument(ctxOf(), { docType: "database", columns: [{ name: "A", type: "nope" }] })).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(await createDocument(ctxOf(), { table: "T" })).toMatchObject({ ok: false, status: 400 });
    expect(await createDocument(ctxOf(), { docType: "database", markdown: "# x" })).toMatchObject({ ok: false, status: 400 });
    expect(await createDocument(ctxOf(), { docType: "sheet" })).toMatchObject({ ok: false, status: 400 });
    expect(mockCreateDoc).not.toHaveBeenCalled();
  });

  it("initializes a database with its starter table, and deletes the row when the actor refuses", async () => {
    const created = await createDocument(ctxOf(), { title: "Tasks", docType: "database", table: "Backlog" });
    expect(created.ok).toBe(true);
    expect(actorCalls[0]!.url).toContain("/schema/init");
    expect(actorCalls[0]!.body.display).toBe("Backlog");

    vi.clearAllMocks();
    actorAnswer = { status: 500, body: {} };
    const failed = await createDocument(ctxOf(), { title: "Tasks", docType: "database" });
    expect(failed).toEqual({ ok: false, status: 502, message: "could not initialize the database" });
    const docId = mockCreateDoc.mock.calls[0]![1].docId;
    expect(mockQueueSweep).toHaveBeenCalledWith({}, docId);
    expect(mockDeleteDoc).toHaveBeenCalledWith({}, docId);
    const destroyAt = actorFetch.mock.calls.findIndex(([url]) => url === `http://actor/destroy?dbId=${docId}`);
    expect(destroyAt).toBeGreaterThanOrEqual(0);
    expect(mockQueueSweep.mock.invocationCallOrder[0]!).toBeLessThan(mockDeleteDoc.mock.invocationCallOrder[0]!);
    expect(mockDeleteDoc.mock.invocationCallOrder[0]!).toBeLessThan(actorFetch.mock.invocationCallOrder[destroyAt]!);
  });

  it("keeps the actor of a failed create whose row could not be deleted", async () => {
    actorAnswer = { status: 500, body: {} };
    mockDeleteDoc.mockRejectedValueOnce(new Error("connection lost"));
    expect(await createDocument(ctxOf(), { title: "Tasks", docType: "database" })).toMatchObject({ ok: false, status: 502 });
    expect(mockDeleteDoc).toHaveBeenCalledTimes(1);
    expect(actorCalls.some((c) => c.url.includes("/destroy"))).toBe(false);
  });

  it("seeds an imported body, titled from it, and deletes the row when nothing applied", async () => {
    const seeded = await createDocument(ctxOf(), { title: "ignored", markdown: "# Minutes\n\nbody" });
    expect(seeded.ok).toBe(true);
    expect(inserted().title).toBe("Minutes");
    expect(actorCalls[0]!.url).toContain("/apply-edits");

    vi.clearAllMocks();
    actorAnswer = { status: 200, body: { applied: false } };
    expect(await createDocument(ctxOf(), { markdown: "# Minutes" })).toMatchObject({ ok: false, status: 502 });
    const docId = mockCreateDoc.mock.calls[0]![1].docId;
    expect(mockQueueSweep).toHaveBeenCalledWith({}, docId);
    expect(mockDeleteDoc).toHaveBeenCalledTimes(1);
    expect(actorCalls.some((c) => c.url === `http://actor/destroy?docId=${docId}`)).toBe(true);
  });

  it("announces the document once it is complete", async () => {
    await createDocument(ctxOf(), { title: "Plan" });
    const kinds = jobsSend.mock.calls.map(([m]) => (m as { kind: string; action?: string; type?: string }));
    expect(kinds).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "event", type: "doc.created" }),
        expect.objectContaining({ kind: "audit", action: "doc.create" }),
      ]),
    );
  });
});
