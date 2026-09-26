/** The gates on /api/databases/*, the only road to the database actor, which trusts the identity it is handed. */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@stuga/db", async (importOriginal) => ({
  // Everything that would touch Postgres is scripted below.
  ...(await importOriginal<typeof import("@stuga/db")>()),
  getDoc: vi.fn(),
  touchDoc: vi.fn(async () => {}),
  createDoc: vi.fn(),
  deleteDoc: vi.fn(async () => {}),
  updateDoc: vi.fn(async (_sql: unknown, id: string, patch: Record<string, unknown>) => ({ ...DB_DOC, doc_id: id, ...patch })),
  docTrashStates: vi.fn(async () => []),
  listPagesOf: vi.fn(async () => []),
  detachPage: vi.fn(async () => {}),
  getFolder: vi.fn(async () => null),
  getWorkspace: vi.fn(async () => ({ default_doc_access: "workspace_edit" })),
  getMemberRole: vi.fn(async () => "member"),
  getFolderAncestors: vi.fn(async () => []),
}));
vi.mock("../jobs/snapshot-sweep.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../jobs/snapshot-sweep.js")>()),
  queueSnapshotSweep: vi.fn(async () => {}),
}));
vi.mock("@stuga/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@stuga/auth")>()),
  materializeAcl: vi.fn(() => ({
    principals: ["user:owner-1", "org:ws1"],
    writers: ["user:owner-1", "org:ws1"],
    commenters: [],
  })),
}));

const { getDoc, touchDoc, createDoc, deleteDoc, updateDoc, getFolder, docTrashStates, listPagesOf, detachPage } = await import("@stuga/db");
const { queueSnapshotSweep } = await import("../jobs/snapshot-sweep.js");
const { routeWorkspaceRequest } = await import("../http/dispatch.js");
const { openRowPages, rowPageTitle } = await import("./row-pages.js");
const { READ_ONLY_MESSAGE } = await import("../authz/authz.js");
import { DATABASE_MAX_COLUMN_DESCRIPTION_CHARS } from "@stuga/protocol/databases/limits";
import type { Ctx } from "../auth/context.js";

const mockGetDoc = getDoc as unknown as ReturnType<typeof vi.fn>;
const mockTouchDoc = touchDoc as unknown as ReturnType<typeof vi.fn>;
const jobsSend = vi.fn(async (_message: Record<string, unknown>) => {});
const mockCreateDoc = createDoc as unknown as ReturnType<typeof vi.fn>;
const mockDeleteDoc = deleteDoc as unknown as ReturnType<typeof vi.fn>;
const mockUpdateDoc = updateDoc as unknown as ReturnType<typeof vi.fn>;
const mockGetFolder = getFolder as unknown as ReturnType<typeof vi.fn>;
const mockDocTrashStates = docTrashStates as unknown as ReturnType<typeof vi.fn>;
const mockListPagesOf = listPagesOf as unknown as ReturnType<typeof vi.fn>;
const mockDetachPage = detachPage as unknown as ReturnType<typeof vi.fn>;
const mockQueueSweep = queueSnapshotSweep as unknown as ReturnType<typeof vi.fn>;

const DB_DOC = {
  doc_id: "db1",
  workspace_id: "ws1",
  owner: "user:owner-1",
  title: "Projects",
  doc_type: "database",
  trashed: false,
  locked: false,
  parent_id: null as string | null,
  inherits_perms: true,
  own_grants: { p: [] as string[], w: [] as string[], c: [] as string[] },
  acl_principals: ["user:owner-1", "user:bob", "user:viv", "agent:agent-1", "org:ws1"],
  acl_writers: ["user:owner-1", "user:bob", "agent:agent-1"],
  acl_commenters: [] as string[],
};

/** The actor's scripted answers, one per path in `actorRoutes`, else `actorStatus`/`actorBody`, and every call it received. */
let actorStatus: number;
let actorBody: unknown;
let actorRoutes: Record<string, { status?: number; body: unknown }>;
const actorCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
const actorFetch = vi.fn(async (url: string, init?: RequestInit) => {
  actorCalls.push({
    url,
    body: init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {},
  });
  const hit = actorRoutes[new URL(url).pathname];
  return new Response(JSON.stringify(hit ? hit.body : actorBody), {
    status: hit ? (hit.status ?? 200) : actorStatus,
    headers: { "content-type": "application/json" },
  });
});

function ctxOf(overrides: Partial<Ctx> = {}): Ctx {
  return {
    sql: {},
    alias: "bob",
    displayName: "Bob",
    isAgent: false,
    principals: ["user:bob"],
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

const viewer = () => ctxOf({ alias: "viv", principals: ["user:viv"] });
const agent = () =>
  ctxOf({ alias: "agent-1", displayName: "Codey", isAgent: true, onBehalfOf: "owner-1", principals: ["agent:agent-1"] });
const readOnlyKey = () => ctxOf({ ...agent(), scope: { folders: null, readOnly: true, credentialId: "k1" } } as Partial<Ctx>);

async function call(ctx: Ctx, method: string, path: string, body?: unknown): Promise<Response> {
  const req = new Request(`https://node.test${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  return routeWorkspaceRequest(ctx, req);
}

beforeEach(() => {
  actorCalls.length = 0;
  actorFetch.mockClear();
  actorStatus = 200;
  actorBody = { ok: true };
  actorRoutes = {};
  mockGetDoc.mockReset();
  mockGetDoc.mockResolvedValue({ ...DB_DOC });
  mockTouchDoc.mockClear();
  jobsSend.mockClear();
  mockCreateDoc.mockReset();
  mockDeleteDoc.mockClear();
  mockQueueSweep.mockReset();
  mockQueueSweep.mockResolvedValue(undefined);
  mockUpdateDoc.mockClear();
  mockGetFolder.mockReset();
  mockGetFolder.mockResolvedValue(null);
  mockDocTrashStates.mockReset();
  mockDocTrashStates.mockResolvedValue([]);
  mockDetachPage.mockClear();
});

describe("who gets through the data plane", () => {
  it("lets a viewer read (schema, rows/list, query) but never mutate", async () => {
    expect((await call(viewer(), "GET", "/api/databases/db1/schema")).status).toBe(200);
    expect((await call(viewer(), "POST", "/api/databases/db1/tables/t1/rows/list", {})).status).toBe(200);
    expect((await call(viewer(), "POST", "/api/databases/db1/query", { sql: "SELECT 1" })).status).toBe(200);
    const before = actorCalls.length;
    for (const [method, path, body] of [
      ["POST", "/api/databases/db1/tables", { display: "X" }],
      ["POST", "/api/databases/db1/tables/t1/rows", { rows: [{}] }],
      ["PATCH", "/api/databases/db1/tables/t1/rows", { updates: [] }],
      ["POST", "/api/databases/db1/tables/t1/rows/delete", { row_ids: ["r1"] }],
      ["DELETE", "/api/databases/db1/tables/t1", undefined],
      ["PATCH", "/api/databases/db1/tables/t1/columns/c1", { display: "Y" }],
    ] as const) {
      expect((await call(viewer(), method, path, body)).status).toBe(403);
    }
    expect(actorCalls.length).toBe(before);
  });

  it("hides a prose doc behind /api/databases without reaching a database actor", async () => {
    mockGetDoc.mockResolvedValue({ ...DB_DOC, doc_type: "prose" });
    expect((await call(ctxOf(), "GET", "/api/databases/db1/schema")).status).toBe(404);
    expect(actorCalls).toEqual([]);
  });

  it("hides a database from another workspace and while trashed", async () => {
    mockGetDoc.mockResolvedValue({ ...DB_DOC, workspace_id: "ws2" });
    expect((await call(ctxOf(), "GET", "/api/databases/db1/schema")).status).toBe(404);
    mockGetDoc.mockResolvedValue({ ...DB_DOC, trashed: true });
    expect((await call(ctxOf(), "GET", "/api/databases/db1/schema")).status).toBe(404);
    expect(actorCalls).toEqual([]);
  });

  it("refuses mutations on a locked database with 423", async () => {
    mockGetDoc.mockResolvedValue({ ...DB_DOC, locked: true });
    const res = await call(ctxOf(), "POST", "/api/databases/db1/tables/t1/rows", { rows: [{}] });
    expect(res.status).toBe(423);
    expect(actorCalls).toEqual([]);
    expect((await call(ctxOf(), "GET", "/api/databases/db1/schema")).status).toBe(200);
  });
});

/** A minimal run summary, as the actor's propose endpoint answers. */
const RUN = {
  id: "run_abc123def456",
  database_id: "db1",
  source: "stdio",
  agent: "Codey",
  agent_alias: "agent-1",
  reviewer: "owner-1",
  status: "open",
  ops: [{ id: "o1", kind: "rows.insert", table_id: "t1", summary: 'Insert 1 row into "T"', status: "pending" }],
  acknowledged: false,
  auto_applied: false,
  created_at: 1,
  updated_at: 1,
};

describe("identity and side-effects riding along", () => {
  it("routes an agent mutation through the run ledger with the trusted identity", async () => {
    actorBody = { mode: "proposed", run: RUN, pending: 1, minted: { row_ids: ["row_a"] } };
    const res = await call(agent(), "POST", "/api/databases/db1/tables/t1/rows", { rows: [{ Name: "x" }] });
    expect(res.status).toBe(200);
    expect(actorCalls).toHaveLength(1);
    expect(actorCalls[0]!.url).toContain("/runs/propose");
    expect(actorCalls[0]!.body.actor).toEqual({ alias: "agent-1", is_agent: true, on_behalf_of: "owner-1" });
    expect(actorCalls[0]!.body.op).toEqual({ kind: "rows.insert", table: "t1", rows: [{ Name: "x" }] });
    expect(actorCalls[0]!.body.reviewer).toBe("owner-1");
    expect(actorCalls[0]!.body.source).toBe("stdio");
    const out = (await res.json()) as { mode: string; minted: { row_ids: string[] } };
    expect(out.mode).toBe("proposed");
    expect(out.minted.row_ids).toEqual(["row_a"]);
  });

  it("keeps a human mutation on the direct path with the trusted actor", async () => {
    await call(ctxOf(), "POST", "/api/databases/db1/tables/t1/rows", { rows: [{ Name: "x" }] });
    expect(actorCalls).toHaveLength(1);
    expect(actorCalls[0]!.url).toContain("/rows/insert");
    expect(actorCalls[0]!.body.actor).toEqual({ alias: "bob", is_agent: false });
    expect(actorCalls[0]!.body.ops_keep).toBe(500);
    expect(actorCalls[0]!.body.table_id).toBe("t1");
  });

  it("a proposed agent mutation bumps recency and leaves the notification to the actor", async () => {
    actorBody = { mode: "proposed", run: RUN, pending: 1, minted: {} };
    await call(agent(), "POST", "/api/databases/db1/tables/t1/rows", { rows: [{ Name: "x" }] });
    expect(mockTouchDoc).toHaveBeenCalledWith(expect.anything(), "db1");
    expect(jobsSend).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "notify" }));
  });

  it("an applied agent mutation bumps recency and notifies the owner", async () => {
    actorBody = {
      mode: "applied",
      run: { ...RUN, auto_applied: true, ops: [{ ...RUN.ops[0], status: "auto_applied" }] },
      result: { inserted: 1, row_ids: ["row_a"] },
      minted: { row_ids: ["row_a"] },
    };
    await call(agent(), "POST", "/api/databases/db1/tables/t1/rows", { rows: [{ Name: "x" }] });
    expect(mockTouchDoc).toHaveBeenCalledWith(expect.anything(), "db1");
    expect(jobsSend).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "notify", eventType: "DATABASE_AGENT_EDIT", recipient: "owner-1", docId: "db1" }),
    );
  });

  it("a human mutation bumps recency and notifies nobody", async () => {
    await call(ctxOf(), "POST", "/api/databases/db1/tables/t1/rows", { rows: [{ Name: "x" }] });
    expect(mockTouchDoc).toHaveBeenCalled();
    expect(jobsSend).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "notify" }));
  });

  it("a failed actor mutation bumps nothing and notifies nobody", async () => {
    actorStatus = 409;
    actorBody = { error: "row_cap", message: "row cap reached" };
    const res = await call(agent(), "POST", "/api/databases/db1/tables/t1/rows", { rows: [{}] });
    expect(res.status).toBe(409);
    expect(mockTouchDoc).not.toHaveBeenCalled();
    expect(jobsSend).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "notify" }));
  });
});

describe("views", () => {
  it("an agent's view create / update rides the run ledger; its delete is refused", async () => {
    actorBody = { mode: "proposed", run: RUN, pending: 1, minted: { view_id: "view_a" } };
    const created = await call(agent(), "POST", "/api/databases/db1/tables/t1/views", {
      name: "Open",
      filter: { column_id: "c1", op: "eq", value: "x" },
      hidden_columns: ["c2"],
      extra: "ignored",
    });
    expect(created.status).toBe(200);
    expect(actorCalls[0]!.url).toContain("/runs/propose");
    expect(actorCalls[0]!.body.op).toEqual({
      kind: "views.create",
      table: "t1",
      name: "Open",
      filter: { column_id: "c1", op: "eq", value: "x" },
      hidden_columns: ["c2"],
    });
    const updated = await call(agent(), "PATCH", "/api/databases/db1/tables/t1/views/view_a", { sorts: [{ column_id: "c1", dir: "desc" }] });
    expect(updated.status).toBe(200);
    expect(actorCalls[1]!.body.op).toEqual({ kind: "views.update", table: "t1", view: "view_a", sorts: [{ column_id: "c1", dir: "desc" }] });
    const before = actorCalls.length;
    const deleted = await call(agent(), "DELETE", "/api/databases/db1/tables/t1/views/view_a");
    expect(deleted.status).toBe(403);
    expect(actorCalls.length).toBe(before);
  });

  it("a writer's view ops go straight to the actor; a viewer's are refused", async () => {
    await call(ctxOf(), "POST", "/api/databases/db1/tables/t1/views", { name: "Open", group_by: "c1" });
    expect(actorCalls[0]!.url).toContain("/views/create");
    expect(actorCalls[0]!.body).toMatchObject({ table_id: "t1", name: "Open", group_by: "c1", actor: { alias: "bob", is_agent: false } });
    await call(ctxOf(), "PATCH", "/api/databases/db1/tables/t1/views/view_a", { name: "Renamed" });
    expect(actorCalls[1]!.url).toContain("/views/update");
    expect(actorCalls[1]!.body).toMatchObject({ table_id: "t1", view_id: "view_a", name: "Renamed" });
    await call(ctxOf(), "DELETE", "/api/databases/db1/tables/t1/views/view_a");
    expect(actorCalls[2]!.url).toContain("/views/delete");
    expect(mockTouchDoc).toHaveBeenCalledTimes(3);
    const before = actorCalls.length;
    expect((await call(viewer(), "POST", "/api/databases/db1/tables/t1/views", { name: "x" })).status).toBe(403);
    expect((await call(viewer(), "DELETE", "/api/databases/db1/tables/t1/views/view_a")).status).toBe(403);
    expect(actorCalls.length).toBe(before);
  });

  it("rows/list forwards the view, grouping and multi-key sort to the actor", async () => {
    await call(viewer(), "POST", "/api/databases/db1/tables/t1/rows/list", {
      view_id: "view_a",
      group_by: "c1",
      sort: [{ column_id: "c1", dir: "asc" }, { column_id: "c2", dir: "desc" }],
      filter: { or: [{ column_id: "c1", op: "empty" }] },
    });
    expect(actorCalls[0]!.url).toContain("/rows/list");
    expect(actorCalls[0]!.body).toMatchObject({
      table_id: "t1",
      view_id: "view_a",
      group_by: "c1",
      sort: [{ column_id: "c1", dir: "asc" }, { column_id: "c2", dir: "desc" }],
      filter: { or: [{ column_id: "c1", op: "empty" }] },
    });
  });
});

describe("row pages", () => {
  const COLUMNS = [
    { column_id: "c_done", name: "done", display: "Done", type: "checkbox", position: 0, options: null },
    { column_id: "c_name", name: "name", display: "Name", type: "text", position: 1, options: null },
    { column_id: "c_notes", name: "notes", display: "Notes", type: "text", position: 2, options: null },
  ];
  const SCHEMA = { database_id: "db1", tables: [{ table_id: "t1", name: "tasks", display: "Tasks", position: 0, row_count: 1, columns: COLUMNS, views: [] }] };
  /** A prose page as Postgres holds it. */
  const PAGE = { ...DB_DOC, doc_id: "page1", doc_type: "prose", title: "Task 11", trashed: false, locked: false };
  /** getDoc by id: the database, its page, or nothing. */
  const docsById = (pages: Record<string, unknown>, db: Record<string, unknown> = DB_DOC) =>
    mockGetDoc.mockImplementation(async (_sql: unknown, id: string) => (id === "db1" ? { ...db } : (pages[id] ?? null)));
  /** The actor's answers for one row page request. */
  const pageRoutes = (row: Record<string, unknown>) => ({
    "/rows/list": { body: { rows: [row], total: 1 } },
    "/schema": { body: SCHEMA },
    "/rows/link-doc": { body: { linked: true, doc_id: "page-new", replaced: null } },
  });

  it("titles a page from the row's first text column, whatever the column order, else a placeholder", () => {
    expect(rowPageTitle(COLUMNS as never, { c_done: 1, c_name: "  Task 11 ", c_notes: "later" })).toBe("Task 11");
    expect(rowPageTitle(COLUMNS as never, { c_done: 1, c_name: null, c_notes: "only notes" })).toBe("only notes");
    expect(rowPageTitle(COLUMNS as never, { c_done: 1 })).toBe("Untitled row");
  });

  it("creates the page through the documents path — filed beside the database, with its sharing — and links it", async () => {
    const db = { ...DB_DOC, parent_id: "f1", inherits_perms: false, own_grants: { p: ["user:viv"], w: ["user:bob"], c: ["user:cam"] } };
    docsById({}, db);
    mockGetFolder.mockResolvedValue({ folder_id: "f1", workspace_id: "ws1", acl_principals: ["org:ws1"], acl_writers: [] });
    mockCreateDoc.mockImplementation(async (_sql: unknown, input: Record<string, unknown>) => ({
      ...PAGE,
      doc_id: input.docId,
      title: input.title,
      parent_id: input.parentId,
    }));
    actorRoutes = pageRoutes({ _id: "r1", c_done: 0, c_name: "Task 11", c_notes: "x", _doc_id: null });

    const res = await call(ctxOf(), "POST", "/api/databases/db1/tables/t1/rows/r1/page");
    expect(res.status).toBe(201);
    const out = (await res.json()) as { doc_id: string; created: boolean };
    expect(out.created).toBe(true);

    // The live row, by its id, with no agent projection.
    expect(actorCalls[0]!.url).toContain("/rows/list");
    expect(actorCalls[0]!.body).toMatchObject({ table_id: "t1", filter: { column_id: "_id", op: "eq", value: "r1" }, limit: 1 });
    expect(mockCreateDoc).toHaveBeenCalledTimes(1);
    const created = mockCreateDoc.mock.calls[0]![1] as Record<string, unknown>;
    expect(created).toMatchObject({
      docId: out.doc_id,
      workspaceId: "ws1",
      owner: "user:bob",
      title: "Task 11",
      docType: "prose",
      parentId: "f1",
      inheritsPerms: false,
      createdBy: "user:bob",
      pageOf: "db1",
      pageRow: "t1.r1",
    });
    expect(created.ownGrants).toEqual({ p: ["user:viv", "user:owner-1"], w: ["user:bob", "user:owner-1"], c: ["user:cam"] });
    expect(jobsSend).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "index_doc" }));
    const link = actorCalls.find((c) => c.url.includes("/rows/link-doc"))!;
    expect(link.body).toMatchObject({ table_id: "t1", row_id: "r1", doc_id: out.doc_id, actor: { alias: "bob", is_agent: false } });
    expect(link.body.replaces).toBeUndefined();
    expect(mockTouchDoc).toHaveBeenCalledWith(expect.anything(), "db1");
  });

  it("hands back the page a row already has, restoring it from the trash; a page that is gone is replaced", async () => {
    docsById({ page1: { ...PAGE, trashed: true } });
    actorRoutes = pageRoutes({ _id: "r1", c_name: "Task 11", _doc_id: "page1" });
    const res = await call(ctxOf(), "POST", "/api/databases/db1/tables/t1/rows/r1/page");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ doc_id: "page1", created: false, restored: true });
    expect(mockUpdateDoc).toHaveBeenCalledWith(expect.anything(), "page1", { trashed: false });
    expect(mockCreateDoc).not.toHaveBeenCalled();
    expect(actorCalls.some((c) => c.url.includes("/rows/link-doc"))).toBe(false);

    mockUpdateDoc.mockClear();
    actorCalls.length = 0;
    docsById({});
    mockCreateDoc.mockImplementation(async (_sql: unknown, input: Record<string, unknown>) => ({ ...PAGE, doc_id: input.docId }));
    const again = await call(ctxOf(), "POST", "/api/databases/db1/tables/t1/rows/r1/page");
    expect(again.status).toBe(201);
    const link = actorCalls.find((c) => c.url.includes("/rows/link-doc"))!;
    expect(link.body.replaces).toBe("page1");
    expect(mockUpdateDoc).not.toHaveBeenCalled();
  });

  it("replace_trashed gives a row whose page is in the trash a new page, and the old one stops naming the row", async () => {
    const path = "/api/databases/db1/tables/t1/rows/r1/page";
    // Locked too: the lock freezes the old page's trash state, which stays as it is.
    docsById({ page1: { ...PAGE, trashed: true, locked: true } });
    mockCreateDoc.mockImplementation(async (_sql: unknown, input: Record<string, unknown>) => ({ ...PAGE, doc_id: input.docId }));
    actorRoutes = pageRoutes({ _id: "r1", c_name: "Task 11", _doc_id: "page1" });

    const res = await call(ctxOf(), "POST", path, { replace_trashed: true });
    expect(res.status).toBe(201);
    const out = (await res.json()) as { doc_id: string; created: boolean };
    expect(out.created).toBe(true);
    expect(out.doc_id).not.toBe("page1");
    expect(mockCreateDoc.mock.calls[0]![1]).toMatchObject({ docId: out.doc_id, pageOf: "db1", pageRow: "t1.r1" });
    const link = actorCalls.find((c) => c.url.includes("/rows/link-doc"))!;
    expect(link.body).toMatchObject({ table_id: "t1", row_id: "r1", doc_id: out.doc_id, replaces: "page1" });
    expect(mockUpdateDoc).not.toHaveBeenCalled();
    expect(mockDetachPage).toHaveBeenCalledWith(expect.anything(), "ws1", "db1", "page1");

    // A viewer may not; a live page is still the one handed back; a bad flag is refused.
    mockDetachPage.mockClear();
    mockCreateDoc.mockClear();
    expect((await call(viewer(), "POST", path, { replace_trashed: true })).status).toBe(403);
    docsById({ page1: { ...PAGE } });
    const live = await call(ctxOf(), "POST", path, { replace_trashed: true });
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ doc_id: "page1", created: false });
    expect((await call(ctxOf(), "POST", path, { replace_trashed: "yes" })).status).toBe(400);
    expect(mockCreateDoc).not.toHaveBeenCalled();
    expect(mockDetachPage).not.toHaveBeenCalled();

    // Someone else linked a page first: theirs is handed over, and the trashed one keeps its row.
    docsById({ page1: { ...PAGE, trashed: true } });
    mockCreateDoc.mockImplementation(async (_sql: unknown, input: Record<string, unknown>) => ({ ...PAGE, doc_id: input.docId }));
    actorRoutes = {
      ...pageRoutes({ _id: "r1", c_name: "Task 11", _doc_id: "page1" }),
      "/rows/link-doc": { status: 409, body: { message: "row r1 already has a page", doc_id: "page-theirs" } },
    };
    const raced = await call(ctxOf(), "POST", path, { replace_trashed: true });
    expect(raced.status).toBe(200);
    expect(await raced.json()).toEqual({ doc_id: "page-theirs", created: false });
    expect(mockDetachPage).not.toHaveBeenCalled();
  });

  it("an agent may create a page (its link rides the ledger identity); a missing row is 404", async () => {
    docsById({});
    mockCreateDoc.mockImplementation(async (_sql: unknown, input: Record<string, unknown>) => ({ ...PAGE, doc_id: input.docId }));
    actorRoutes = pageRoutes({ _id: "r1", c_name: "Task 11", _doc_id: null });
    const res = await call(agent(), "POST", "/api/databases/db1/tables/t1/rows/r1/page");
    expect(res.status).toBe(201);
    const created = mockCreateDoc.mock.calls[0]![1] as Record<string, unknown>;
    expect(created).toMatchObject({ owner: "user:owner-1", createdBy: "agent:agent-1" });
    expect((created.ownGrants as { w: string[] }).w).toContain("agent:agent-1");
    const link = actorCalls.find((c) => c.url.includes("/rows/link-doc"))!;
    expect(link.body.actor).toEqual({ alias: "agent-1", is_agent: true, on_behalf_of: "owner-1" });
    expect(jobsSend).toHaveBeenCalledWith(expect.objectContaining({ kind: "notify", eventType: "DATABASE_AGENT_EDIT", docId: "db1" }));

    actorRoutes = { ...pageRoutes({}), "/rows/list": { body: { rows: [], total: 0 } } };
    expect((await call(ctxOf(), "POST", "/api/databases/db1/tables/t1/rows/r9/page")).status).toBe(404);
  });

  it.each([
    ["a viewer", viewer, "view-only access"],
    ["a read-only key", readOnlyKey, READ_ONLY_MESSAGE],
  ])("%s opens a row's live page, and is refused restoring or creating one", async (_who, who, refusal) => {
    docsById({ page1: { ...PAGE } });
    actorRoutes = pageRoutes({ _id: "r1", c_name: "Task 11", _doc_id: "page1" });
    const live = await call(who(), "POST", "/api/databases/db1/tables/t1/rows/r1/page");
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ doc_id: "page1", created: false });

    docsById({ page1: { ...PAGE, trashed: true } });
    const trashed = await call(who(), "POST", "/api/databases/db1/tables/t1/rows/r1/page");
    expect(trashed.status).toBe(403);
    expect(await trashed.json()).toEqual({ error: refusal });

    docsById({});
    actorRoutes = pageRoutes({ _id: "r1", c_name: "Task 11", _doc_id: null });
    const missing = await call(who(), "POST", "/api/databases/db1/tables/t1/rows/r1/page");
    expect(missing.status).toBe(403);
    expect(await missing.json()).toEqual({ error: refusal });

    expect(mockUpdateDoc).not.toHaveBeenCalled();
    expect(mockCreateDoc).not.toHaveBeenCalled();
    expect(actorCalls.some((c) => c.url.includes("/rows/link-doc") || c.url.includes("/schema"))).toBe(false);
  });

  it("opens a locked database's live page, and refuses creating one there with 423", async () => {
    docsById({ page1: { ...PAGE } }, { ...DB_DOC, locked: true });
    actorRoutes = pageRoutes({ _id: "r1", c_name: "Task 11", _doc_id: "page1" });
    expect((await call(ctxOf(), "POST", "/api/databases/db1/tables/t1/rows/r1/page")).status).toBe(200);
    actorRoutes = pageRoutes({ _id: "r1", c_name: "Task 11", _doc_id: null });
    expect((await call(ctxOf(), "POST", "/api/databases/db1/tables/t1/rows/r1/page")).status).toBe(423);
    expect(mockCreateDoc).not.toHaveBeenCalled();
  });

  it("rolls the new document back when the link is refused, handing over the page that won the race", async () => {
    docsById({});
    mockCreateDoc.mockImplementation(async (_sql: unknown, input: Record<string, unknown>) => ({ ...PAGE, doc_id: input.docId }));
    actorRoutes = {
      ...pageRoutes({ _id: "r1", c_name: "Task 11", _doc_id: null }),
      "/rows/link-doc": { status: 409, body: { error: "already_linked", message: "this row already has a page", doc_id: "page-theirs" } },
    };
    const res = await call(ctxOf(), "POST", "/api/databases/db1/tables/t1/rows/r1/page");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ doc_id: "page-theirs", created: false });
    const orphan = mockCreateDoc.mock.calls[0]![1] as { docId: string };
    expect(mockQueueSweep).toHaveBeenCalledWith(expect.anything(), orphan.docId);
    expect(mockDeleteDoc).toHaveBeenCalledWith(expect.anything(), orphan.docId);
    expect(actorCalls.some((c) => c.url.includes(`/destroy?docId=${orphan.docId}`))).toBe(true);
  });

  it("deleting rows sends their pages to the trash through the actor's inbox, read after the write", async () => {
    docsById({ page1: { ...PAGE }, page2: { ...PAGE, doc_id: "page2", locked: true } });
    actorRoutes = {
      "/rows/delete": { body: { deleted: 2 } },
      "/doc-links/take": {
        body: { trash: [{ doc_id: "page1", row_id: "r1", table_id: "t1" }, { doc_id: "page2", row_id: "r2", table_id: "t1" }], restore: [] },
      },
    };
    const res = await call(ctxOf(), "POST", "/api/databases/db1/tables/t1/rows/delete", { row_ids: ["r1", "r2"] });
    expect(res.status).toBe(200);
    expect(actorCalls.map((c) => new URL(c.url).pathname)).toEqual(["/rows/delete", "/doc-links/take"]);
    // page2 is locked and keeps its state.
    expect(mockUpdateDoc).toHaveBeenCalledTimes(1);
    expect(mockUpdateDoc).toHaveBeenCalledWith(expect.anything(), "page1", { trashed: true });
  });

  it("reverting brings pages back; every write route that can move rows reads the inbox", async () => {
    docsById({ page1: { ...PAGE, trashed: true } });
    const restore = { body: { trash: [], restore: [{ doc_id: "page1", row_id: "r1", table_id: "t1" }] } };
    actorRoutes = { "/doc-links/take": restore, "/ops/revert": { body: { reverted: true, restored: 1, missing: 0 } } };
    await call(ctxOf(), "POST", "/api/databases/db1/ops/op_1/revert", {});
    expect(mockUpdateDoc).toHaveBeenCalledWith(expect.anything(), "page1", { trashed: false });

    for (const [path, body] of [
      ["/api/databases/db1/runs/run_1/decision", { decision: "accept" }],
      ["/api/databases/db1/runs/run_1/revert", {}],
      ["/api/databases/db1/tables/t1", undefined],
    ] as const) {
      actorCalls.length = 0;
      actorRoutes = { "/doc-links/take": restore, "/runs/decide": { body: { run: RUN, applied: 1 } }, "/runs/revert": { body: { run: RUN } } };
      const res = await call(ctxOf({ alias: "owner-1", principals: ["user:owner-1"] }), body === undefined ? "DELETE" : "POST", path, body);
      expect(res.status, path).toBe(200);
      expect(actorCalls.some((c) => c.url.includes("/doc-links/take")), path).toBe(true);
    }

    // A proposal that applied at once reads it too; a parked one moved nothing.
    actorCalls.length = 0;
    actorRoutes = {
      "/runs/propose": { body: { mode: "applied", run: RUN, result: { deleted: 1 }, minted: {} } },
      "/doc-links/take": { body: { trash: [{ doc_id: "page1", row_id: "r1", table_id: "t1" }], restore: [] } },
    };
    await call(agent(), "POST", "/api/databases/db1/tables/t1/rows/delete", { row_ids: ["r1"] });
    expect(actorCalls.map((c) => new URL(c.url).pathname)).toEqual(["/runs/propose", "/doc-links/take"]);
    actorCalls.length = 0;
    actorRoutes = { "/runs/propose": { body: { mode: "proposed", run: RUN, pending: 1, minted: {} } } };
    await call(agent(), "POST", "/api/databases/db1/tables/t1/rows/delete", { row_ids: ["r1"] });
    expect(actorCalls.map((c) => new URL(c.url).pathname)).toEqual(["/runs/propose"]);
  });

  it("a listing shows a page only while it stands: a trashed page is marked, a deleted one is dropped", async () => {
    actorRoutes = {
      "/rows/list": {
        body: {
          rows: [
            { _id: "r1", name: "live", _doc_id: "page1" },
            { _id: "r2", name: "trashed", _doc_id: "page2" },
            { _id: "r3", name: "gone", _doc_id: "page3" },
            { _id: "r4", name: "none", _doc_id: null },
          ],
          total: 4,
        },
      },
    };
    mockDocTrashStates.mockResolvedValue([
      { doc_id: "page1", trashed: false },
      { doc_id: "page2", trashed: true },
    ]);
    const res = await call(viewer(), "POST", "/api/databases/db1/tables/t1/rows/list", {});
    expect(res.status).toBe(200);
    const out = (await res.json()) as { rows: Array<Record<string, unknown>>; total: number };
    expect(out.total).toBe(4);
    expect(out.rows).toEqual([
      { _id: "r1", name: "live", _doc_id: "page1" },
      { _id: "r2", name: "trashed", _doc_id: "page2", _doc_trashed: true },
      { _id: "r3", name: "gone", _doc_id: null },
      { _id: "r4", name: "none", _doc_id: null },
    ]);
    expect(mockDocTrashStates).toHaveBeenCalledTimes(1);
    expect(mockDocTrashStates).toHaveBeenCalledWith(expect.anything(), "ws1", ["page1", "page2", "page3"]);
    actorRoutes = { "/rows/list": { body: { rows: [{ _id: "r4", _doc_id: null }], total: 1 } } };
    await call(viewer(), "POST", "/api/databases/db1/tables/t1/rows/list", {});
    expect(mockDocTrashStates).toHaveBeenCalledTimes(1);
  });

  it("Delete forever on a database trashes every page it still links before its row and actor go", async () => {
    docsById({ page1: { ...PAGE }, page2: { ...PAGE, doc_id: "page2", page_of: "db1", page_row: "t1.r2" } });
    mockListPagesOf.mockResolvedValueOnce([{ doc_id: "page1", page_row: "t1.r1" }, { doc_id: "page2", page_row: "t1.r2" }]);
    actorRoutes = { "/destroy": { body: { destroyed: true } } };
    const res = await call(ctxOf({ alias: "owner-1", principals: ["user:owner-1"] }), "DELETE", "/api/docs/db1");
    expect(res.status).toBe(200);
    expect(mockListPagesOf).toHaveBeenCalledWith(expect.anything(), "ws1", "db1");
    const pageTrash = mockUpdateDoc.mock.calls
      .map((c, n) => ({ id: c[1] as string, trashed: (c[2] as { trashed?: boolean }).trashed, order: mockUpdateDoc.mock.invocationCallOrder[n]! }))
      .filter((c) => c.trashed === true);
    expect(pageTrash.map((c) => c.id).sort()).toEqual(["page1", "page2"]);
    const destroyAt = actorFetch.mock.calls.findIndex(([url]) => new URL(url).pathname === "/destroy");
    expect(Math.max(...pageTrash.map((c) => c.order))).toBeLessThan(actorFetch.mock.invocationCallOrder[destroyAt]!);
    expect(mockDeleteDoc).toHaveBeenCalledWith(expect.anything(), "db1");
    // The row delete's foreign key clears page_of, after which the lookup finds nothing.
    expect(mockListPagesOf.mock.invocationCallOrder[0]!).toBeLessThan(mockDeleteDoc.mock.invocationCallOrder[0]!);
    expect(Math.max(...pageTrash.map((c) => c.order))).toBeLessThan(mockDeleteDoc.mock.invocationCallOrder[0]!);
  });

  it("moving a database to the trash takes its pages along; restoring it brings back the ones that went with it", async () => {
    docsById({ page1: { ...PAGE }, page2: { ...PAGE, doc_id: "page2" }, page3: { ...PAGE, doc_id: "page3" } });
    mockListPagesOf.mockResolvedValueOnce([
      { doc_id: "page1", page_row: "t1.r1", trashed: false },
      { doc_id: "page2", page_row: "t1.r2", trashed: false },
      { doc_id: "page3", page_row: "t1.r3", trashed: false },
    ]);
    const res = await call(ctxOf(), "PATCH", "/api/docs/db1", { trashed: true });
    expect(res.status).toBe(200);
    // The database's own update comes first: its trashed_at is what a restore compares with.
    const trashCalls = mockUpdateDoc.mock.calls.filter((c) => (c[2] as { trashed?: boolean }).trashed === true).map((c) => c[1]);
    expect(trashCalls).toEqual(["db1", "page1", "page2", "page3"]);

    // page2 was trashed on its own before the database; page1 and page3 went with it.
    mockUpdateDoc.mockClear();
    const trashedAt = "2026-09-11T10:00:00.000Z";
    docsById(
      { page1: { ...PAGE, trashed: true }, page2: { ...PAGE, doc_id: "page2", trashed: true }, page3: { ...PAGE, doc_id: "page3", trashed: true } },
      { ...DB_DOC, trashed: true, trashed_at: trashedAt },
    );
    mockListPagesOf.mockResolvedValueOnce([
      { doc_id: "page1", page_row: "t1.r1", trashed: true },
      { doc_id: "page3", page_row: "t1.r3", trashed: true },
    ]);
    const back = await call(ctxOf(), "PATCH", "/api/docs/db1", { trashed: false });
    expect(back.status).toBe(200);
    expect(mockListPagesOf).toHaveBeenLastCalledWith(expect.anything(), "ws1", "db1", { trashed: true, trashedWithDatabase: true });
    const dbRestore = mockUpdateDoc.mock.calls.findIndex((c) => c[1] === "db1" && (c[2] as { trashed?: boolean }).trashed === false);
    expect(mockListPagesOf.mock.invocationCallOrder.at(-1)!).toBeLessThan(mockUpdateDoc.mock.invocationCallOrder[dbRestore]!);
    const restoreCalls = mockUpdateDoc.mock.calls.filter((c) => (c[2] as { trashed?: boolean }).trashed === false).map((c) => c[1]);
    expect(restoreCalls).toEqual(["db1", "page1", "page3"]);
    expect(actorCalls.filter((c) => c.url.includes("/doc-links/take"))).toHaveLength(0);
  });

  it("a prose document's trash and restore touch no pages", async () => {
    docsById({ page1: { ...PAGE } });
    await call(ctxOf(), "PATCH", "/api/docs/page1", { trashed: true });
    expect(mockListPagesOf).not.toHaveBeenCalled();
    expect(actorCalls).toHaveLength(0);
  });
});

describe("the revert gate", () => {
  it("refuses agents before any actor call", async () => {
    const res = await call(agent(), "POST", "/api/databases/db1/ops/op_1/revert", {});
    expect(res.status).toBe(403);
    expect(actorCalls).toEqual([]);
  });

  it("forwards a writer's revert with the op id", async () => {
    const res = await call(ctxOf(), "POST", "/api/databases/db1/ops/op_1/revert", {});
    expect(res.status).toBe(200);
    expect(actorCalls[0]!.url).toContain("/ops/revert");
    expect(actorCalls[0]!.body.op_id).toBe("op_1");
  });

  it("passes the actor's already-reverted refusal through as 409", async () => {
    actorStatus = 409;
    actorBody = { error: "already_reverted", message: "this edit was already reverted" };
    const res = await call(ctxOf(), "POST", "/api/databases/db1/ops/op_1/revert", {});
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("already reverted");
  });
});

describe("column descriptions", () => {
  it("sends a lone `description` to columns/set-description with the trusted actor", async () => {
    const res = await call(ctxOf(), "PATCH", "/api/databases/db1/tables/t1/columns/c1", { description: "USD, net of refunds" });
    expect(res.status).toBe(200);
    expect(actorCalls[0]!.url).toContain("/columns/set-description");
    expect(actorCalls[0]!.body).toMatchObject({
      table_id: "t1",
      column_id: "c1",
      description: "USD, net of refunds",
      actor: { alias: "bob", is_agent: false },
    });
    expect(mockTouchDoc).toHaveBeenCalledWith(expect.anything(), "db1");
  });

  it("clears a description with an empty string, still through set-description", async () => {
    await call(ctxOf(), "PATCH", "/api/databases/db1/tables/t1/columns/c1", { description: "" });
    expect(actorCalls[0]!.url).toContain("/columns/set-description");
    expect(actorCalls[0]!.body.description).toBe("");
  });

  it("refuses any two of type / display / description in one request", async () => {
    for (const body of [
      { type: "number", display: "Y" },
      { type: "number", description: "d" },
      { display: "Y", description: "d" },
      { type: "number", display: "Y", description: "d" },
    ]) {
      const res = await call(ctxOf(), "PATCH", "/api/databases/db1/tables/t1/columns/c1", body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain("separate requests");
    }
    expect(actorCalls).toEqual([]);
  });

  it("carries a description on a person's and an agent's add_column", async () => {
    await call(ctxOf(), "POST", "/api/databases/db1/tables/t1/columns", { display: "Amount", type: "number", description: "USD" });
    expect(actorCalls[0]!.url).toContain("/columns/add");
    expect(actorCalls[0]!.body).toMatchObject({ table_id: "t1", display: "Amount", type: "number", description: "USD" });

    actorBody = { mode: "proposed", run: RUN, pending: 1, minted: { column_id: "col_a" } };
    await call(agent(), "POST", "/api/databases/db1/tables/t1/columns", { display: "Amount", type: "number", description: "USD" });
    expect(actorCalls[1]!.url).toContain("/runs/propose");
    expect(actorCalls[1]!.body.op).toMatchObject({ kind: "columns.add", table: "t1", display: "Amount", description: "USD" });
  });

  it("refuses an agent describing a column it did not just add, before any actor call", async () => {
    const res = await call(agent(), "PATCH", "/api/databases/db1/tables/t1/columns/c1", { description: "mine now" });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("agents cannot rename, retype, or delete");
    expect(actorCalls).toEqual([]);
  });

  it("refuses a description past the cap in a declarative create, without reaching the actor", async () => {
    const res = await call(ctxOf(), "POST", "/api/databases/db1/tables", {
      display: "Ledger",
      columns: [{ name: "Amount", type: "number", description: "x".repeat(DATABASE_MAX_COLUMN_DESCRIPTION_CHARS + 1) }],
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain(`max ${DATABASE_MAX_COLUMN_DESCRIPTION_CHARS} chars`);
    expect(actorCalls).toEqual([]);
  });
});

describe("agent SQL pre-validation", () => {
  it("rejects a write statement with 400 before the actor is consulted", async () => {
    const res = await call(ctxOf(), "POST", "/api/databases/db1/query", { sql: "DROP TABLE projects" });
    expect(res.status).toBe(400);
    expect(actorCalls).toEqual([]);
  });

  it("forwards a clean SELECT with its params", async () => {
    await call(ctxOf(), "POST", "/api/databases/db1/query", { sql: "SELECT * FROM p WHERE n = ?", params: [3] });
    expect(actorCalls[0]!.url).toContain("/query");
    expect(actorCalls[0]!.body.sql).toBe("SELECT * FROM p WHERE n = ?");
    expect(actorCalls[0]!.body.params).toEqual([3]);
  });
});

describe("lifecycle: create and delete", () => {
  it("rejects an unknown doc_type at the door", async () => {
    const res = await call(ctxOf(), "POST", "/api/docs", { title: "X", doc_type: "spreadsheet" });
    expect(res.status).toBe(400);
    expect(mockCreateDoc).not.toHaveBeenCalled();
  });

  it("creates a database eagerly initialized with a starter table", async () => {
    mockCreateDoc.mockResolvedValue({ ...DB_DOC, doc_id: "db-new" });
    const res = await call(ctxOf(), "POST", "/api/docs", { title: "Projects", doc_type: "database" });
    expect(res.status).toBe(201);
    const init = actorCalls.find((c) => c.url.includes("/schema/init"));
    expect(init).toBeTruthy();
    expect(init!.body.display).toBe("Projects");
    // Identity and the Activity retention ride the init, as on any write.
    expect(init!.body).toMatchObject({ actor: { alias: "bob", is_agent: false }, ops_keep: 500 });
  });

  it("rolls the row back when actor initialization fails", async () => {
    mockCreateDoc.mockResolvedValue({ ...DB_DOC, doc_id: "db-new" });
    actorStatus = 500;
    const res = await call(ctxOf(), "POST", "/api/docs", { title: "Projects", doc_type: "database" });
    expect(res.status).toBe(502);
    // The handler mints its own doc id; the sweep, the delete and the destroy must name the same one.
    expect(mockDeleteDoc).toHaveBeenCalledTimes(1);
    const deletedId = mockDeleteDoc.mock.calls[0]![1] as string;
    expect(mockQueueSweep).toHaveBeenCalledWith(expect.anything(), deletedId);
    expect(actorCalls.some((c) => c.url.includes(`/destroy?dbId=${deletedId}`))).toBe(true);
  });

  it("destroys the actor's storage on Delete forever", async () => {
    const res = await call(ctxOf({ alias: "owner-1", principals: ["user:owner-1"] }), "DELETE", "/api/docs/db1");
    expect(res.status).toBe(200);
    expect(actorCalls.some((c) => c.url.includes("/destroy") && c.url.includes("dbId=db1"))).toBe(true);
    expect(mockDeleteDoc).toHaveBeenCalledWith(expect.anything(), "db1");
  });

  it("queues the snapshot sweep before the row is deleted, and destroys the actor after", async () => {
    await call(ctxOf({ alias: "owner-1", principals: ["user:owner-1"] }), "DELETE", "/api/docs/db1");
    expect(mockQueueSweep).toHaveBeenCalledWith(expect.anything(), "db1");
    const destroyAt = actorFetch.mock.calls.findIndex(([url]) => new URL(url).pathname === "/destroy");
    expect(mockQueueSweep.mock.invocationCallOrder[0]!).toBeLessThan(mockDeleteDoc.mock.invocationCallOrder[0]!);
    expect(mockDeleteDoc.mock.invocationCallOrder[0]!).toBeLessThan(actorFetch.mock.invocationCallOrder[destroyAt]!);
  });

  it("fails the delete, with nothing deleted, when the snapshot sweep cannot be queued", async () => {
    mockQueueSweep.mockRejectedValue(new Error("jobs insert failed"));
    await expect(call(ctxOf({ alias: "owner-1", principals: ["user:owner-1"] }), "DELETE", "/api/docs/db1")).rejects.toThrow("jobs insert failed");
    expect(mockDeleteDoc).not.toHaveBeenCalled();
    expect(actorCalls.some((c) => c.url.includes("/destroy"))).toBe(false);
  });

  it("destroys a prose doc's actor too, addressed as a document", async () => {
    // Pinned by parameter: a prose doc must never reach the database namespace.
    mockGetDoc.mockResolvedValue({ ...DB_DOC, doc_type: "prose" });
    await call(ctxOf({ alias: "owner-1", principals: ["user:owner-1"] }), "DELETE", "/api/docs/db1");
    expect(actorCalls).toHaveLength(1);
    expect(actorCalls[0]!.url).toContain("/destroy?docId=db1");
    expect(actorCalls[0]!.url).not.toContain("dbId=");
  });
});

describe("doc-only surfaces refuse databases cleanly", () => {
  it("markdown read → 400 with a redirect to the databases/query tools", async () => {
    const res = await call(ctxOf(), "GET", "/api/docs/db1/markdown");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/databases.*query|structured database/);
    expect(actorCalls).toEqual([]); // and no stray document actor materialized
  });

  it("versions, restore and runs → not found, no document-actor call", async () => {
    for (const [method, path, body] of [
      ["GET", "/api/docs/db1/versions/3", undefined],
      ["DELETE", "/api/docs/db1/versions/3", undefined],
      ["POST", "/api/docs/db1/restore", { seq: 3 }],
      ["GET", "/api/docs/db1/runs", undefined],
    ] as const) {
      const res = await call(ctxOf(), method, path, body);
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    expect(actorCalls).toEqual([]);
  });
});

describe("many row pages at once", () => {
  const PAGE = { ...DB_DOC, doc_type: "prose" };
  const pages = (n: number) => Array.from({ length: n }, (_, i) => ({ rowId: `r${i}`, title: ` Row ${i} ` }));

  beforeEach(() => {
    mockCreateDoc.mockImplementation(async (_sql: unknown, input: Record<string, unknown>) => ({ ...PAGE, doc_id: input.docId, title: input.title }));
  });

  it("files each page beside the database with its sharing, and links a batch in one mutation", async () => {
    const db = { ...DB_DOC, parent_id: "f1", own_grants: { p: ["user:viv"], w: [], c: [] } };
    mockGetFolder.mockResolvedValue({ folder_id: "f1", workspace_id: "ws1", acl_principals: ["org:ws1"], acl_writers: [] });
    actorRoutes = { "/rows/link-docs": { body: { linked: 501 } } };

    const out = await openRowPages(ctxOf(), db as never, "t1", pages(501));
    expect(out.kind).toBe("ok");
    const ids = (out as { doc_ids: string[] }).doc_ids;
    expect(ids).toHaveLength(501);
    expect(mockCreateDoc).toHaveBeenCalledTimes(501);
    expect(mockCreateDoc.mock.calls[0]![1]).toMatchObject({ docId: ids[0], title: "Row 0", parentId: "f1", pageOf: "db1", pageRow: "t1.r0" });
    expect((mockCreateDoc.mock.calls[0]![1] as { ownGrants: unknown }).ownGrants).toEqual({ p: ["user:viv", "user:owner-1"], w: ["user:owner-1"], c: [] });
    // No row read and no schema read: the caller names each title.
    expect(actorCalls.map((c) => new URL(c.url).pathname)).toEqual(["/rows/link-docs", "/rows/link-docs"]);
    expect(actorCalls[0]!.body.links).toHaveLength(500);
    expect((actorCalls[1]!.body.links as unknown[])[0]).toEqual({ row_id: "r500", doc_id: ids[500] });
    expect(actorCalls[0]!.body).toMatchObject({ table_id: "t1", actor: { alias: "bob", is_agent: false } });
  });

  it("discards a batch the actor refuses and answers with its refusal", async () => {
    actorRoutes = { "/rows/link-docs": { status: 429, body: { error: "rate_limited", message: "too many mutations (max 120/min per actor)" } } };
    const out = await openRowPages(ctxOf(), { ...DB_DOC } as never, "t1", pages(3));
    expect(out).toEqual({ kind: "error", status: 429, message: "too many mutations (max 120/min per actor)" });
    expect(mockDeleteDoc).toHaveBeenCalledTimes(3);
    expect(mockTouchDoc).not.toHaveBeenCalled();
  });

  it("creates nothing for a caller who may not write the database, or while it is locked", async () => {
    expect(await openRowPages(viewer(), { ...DB_DOC } as never, "t1", pages(2))).toMatchObject({ kind: "error", status: 403 });
    expect(await openRowPages(ctxOf(), { ...DB_DOC, locked: true } as never, "t1", pages(2))).toMatchObject({ kind: "error", status: 423 });
    expect(mockCreateDoc).not.toHaveBeenCalled();
    expect(actorCalls).toEqual([]);
  });
});
