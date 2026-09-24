/**
 * Collections, search scope and retrieval as a person and their agent keys reach them: one set of
 * collections per person, managed by the person and by every agent acting for them, with each caller
 * seeing and changing only the members it can read.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@stuga/db", async (orig) => ({
  ...(await orig<typeof import("@stuga/db")>()),
  listCollections: vi.fn(),
  getCollection: vi.fn(),
  expandCollectionScope: vi.fn(),
  searchDocs: vi.fn(),
  renameCollection: vi.fn(),
  createCollection: vi.fn(),
  deleteCollection: vi.fn(),
  listCollectionItems: vi.fn(),
  filterVisibleRefs: vi.fn(),
  addCollectionItems: vi.fn(),
  removeCollectionItems: vi.fn(),
  readsEveryMember: vi.fn(),
  getDoc: vi.fn(),
}));
vi.mock("../retrieval/retrieve.js", () => ({ retrieveAndRerank: vi.fn() }));

const db = await import("@stuga/db");
const { retrieveAndRerank } = await import("../retrieval/retrieve.js");
const { routeWorkspaceRequest } = await import("../http/dispatch.js");
const { READ_ONLY_MESSAGE } = await import("../authz/authz.js");
import type { Ctx } from "../auth/context.js";

const mockList = vi.mocked(db.listCollections);
const mockGet = vi.mocked(db.getCollection);
const mockExpand = vi.mocked(db.expandCollectionScope);
const mockSearch = vi.mocked(db.searchDocs);
const mockRename = vi.mocked(db.renameCollection);
const mockCreate = vi.mocked(db.createCollection);
const mockDelete = vi.mocked(db.deleteCollection);
const mockItems = vi.mocked(db.listCollectionItems);
const mockVisible = vi.mocked(db.filterVisibleRefs);
const mockAdd = vi.mocked(db.addCollectionItems);
const mockRemove = vi.mocked(db.removeCollectionItems);
const mockReadsEvery = vi.mocked(db.readsEveryMember);
const mockGetDoc = vi.mocked(db.getDoc);
const mockRetrieve = vi.mocked(retrieveAndRerank);
const jobsSend = vi.fn(async (_message: Record<string, unknown>) => {});

/** A human's own session. */
function human(over: Partial<Ctx> = {}): Ctx {
  return {
    sql: {},
    alias: "user-liv",
    displayName: "Liv",
    surface: "web",
    isAgent: false,
    principals: ["user:user-liv", "org:ws1"],
    workspaceId: "ws1",
    role: "member",
    env: {
      jobs: { send: jobsSend },
      aiSettings: { current: () => ({ enabled: false, chat: { enabled: false }, embed: { enabled: false } }) },
    },
    ...over,
  } as unknown as Ctx;
}

/** A key that human minted: its own principal, acting on their behalf. */
function agent(over: Partial<Ctx> = {}): Ctx {
  return human({ alias: "agent:a1", surface: "api-key", isAgent: true, onBehalfOf: "user-liv", principals: ["agent:a1"], ...over } as Partial<Ctx>);
}

const scoped = (folders: string[] | null, readOnly = false): Partial<Ctx> =>
  ({ scope: { folders, readOnly, keyId: "a1" } }) as unknown as Partial<Ctx>;

const send = (ctx: Ctx, method: string, path: string, body?: unknown): Promise<Response> => {
  const url = new URL(`https://node.test${path}`);
  const req = new Request(url, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  });
  return routeWorkspaceRequest(ctx, req);
};

/** Retrieval needs the node's AI switch on; search deliberately does not. */
const aiOn = (over: Partial<Ctx> = {}): Ctx =>
  agent({
    env: { jobs: { send: jobsSend }, aiSettings: { current: () => ({ enabled: true, chat: { enabled: true }, embed: { enabled: true } }) } },
    ...over,
  } as unknown as Partial<Ctx>);

/** A collection owned by the human, as the DB hands it back. */
const owned = { collection_id: "col_1", workspace_id: "ws1", owner: "user-liv", name: "Handbook", created_at: "", updated_at: "" };

const audits = () => jobsSend.mock.calls.map(([m]) => m).filter((m) => m.kind === "audit");

beforeEach(() => {
  vi.clearAllMocks();
  mockList.mockResolvedValue([]);
  mockGet.mockResolvedValue(owned);
  mockExpand.mockResolvedValue(["d1"]);
  mockSearch.mockResolvedValue([]);
  mockRetrieve.mockResolvedValue({ chunks: [], degraded: false } as never);
  mockCreate.mockImplementation(async (_sql, c) => ({ ...owned, collection_id: c.collectionId, owner: c.owner, name: c.name }));
  mockRename.mockImplementation(async (_sql, id, name) => ({ ...owned, collection_id: id, name }));
  mockItems.mockResolvedValue([]);
  mockVisible.mockImplementation(async (_sql, _reach, docIds, folderIds) => ({ docIds, folderIds }));
  mockAdd.mockImplementation(async (_sql, _id, refs) => (refs.docIds?.length ?? 0) + (refs.folderIds?.length ?? 0));
  mockRemove.mockImplementation(async (_sql, _id, refs) => (refs.docIds?.length ?? 0) + (refs.folderIds?.length ?? 0));
  mockReadsEvery.mockResolvedValue(true);
});

describe("GET /api/collections", () => {
  it("lists the authorizing human's collections for an agent key, through the key's reach", async () => {
    const res = await send(agent(scoped(["f1"])), "GET", "/api/collections");
    expect(res.status).toBe(200);
    expect(mockList).toHaveBeenCalledWith({}, "user-liv", { principals: ["agent:a1"], workspaceId: "ws1", scopeFolderIds: ["f1"] });
  });

  it("lists a human's own collections as themselves", async () => {
    await send(human(), "GET", "/api/collections");
    expect(mockList).toHaveBeenCalledWith({}, "user-liv", { principals: ["user:user-liv", "org:ws1"], workspaceId: "ws1", scopeFolderIds: null });
  });
});

describe("collection scope on POST /api/search", () => {
  it("resolves a collection its owner shares with the agent's credential", async () => {
    const res = await send(agent(), "POST", "/api/search", { q: "expenses", collection_id: "col_1" });
    expect(res.status).toBe(200);
    // The collection narrows the agent's own principals, never widens them.
    expect(mockExpand).toHaveBeenCalledWith({}, "col_1", { principals: ["agent:a1"], workspaceId: "ws1", scopeFolderIds: null });
    expect(mockSearch).toHaveBeenCalledWith({}, expect.objectContaining({ scopeDocIds: ["d1"], principals: ["agent:a1"] }));
  });

  it("refuses a collection belonging to someone else with 404", async () => {
    mockGet.mockResolvedValue({ ...owned, owner: "user-someone-else" });
    const res = await send(agent(), "POST", "/api/search", { q: "x", collection_id: "col_1" });
    expect(res.status).toBe(404);
  });

  it("refuses a collection from another workspace", async () => {
    mockGet.mockResolvedValue({ ...owned, workspace_id: "ws2" });
    expect((await send(agent(), "POST", "/api/search", { q: "x", collection_id: "col_1" })).status).toBe(404);
  });
});

describe("an empty scope is reported, not left to be guessed", () => {
  it("flags a search whose collection resolved to nothing this credential can read", async () => {
    mockExpand.mockResolvedValue([]);
    const res = await send(agent(), "POST", "/api/search", { q: "x", collection_id: "col_1" });
    expect(await res.json()).toMatchObject({ results: [], empty_scope: true });
  });

  it("expands a folder-scoped key's collection within its folders, so members elsewhere count as empty", async () => {
    mockExpand.mockResolvedValue([]);
    const res = await send(agent(scoped(["f1"])), "POST", "/api/search", { q: "x", collection_id: "col_1" });
    expect(mockExpand).toHaveBeenCalledWith({}, "col_1", { principals: ["agent:a1"], workspaceId: "ws1", scopeFolderIds: ["f1"] });
    expect(await res.json()).toMatchObject({ results: [], empty_scope: true });
    const retrieved = await send(aiOn(scoped(["f1"])), "POST", "/api/retrieve", { q: "x", collection_id: "col_1" });
    expect(await retrieved.json()).toMatchObject({ chunks: [], empty_scope: true });
    expect(mockExpand).toHaveBeenLastCalledWith({}, "col_1", { principals: ["agent:a1"], workspaceId: "ws1", scopeFolderIds: ["f1"] });
  });

  it("does not flag an ordinary miss inside a collection that resolved fine", async () => {
    mockExpand.mockResolvedValue(["d1", "d2"]);
    mockSearch.mockResolvedValue([]);
    expect(await (await send(agent(), "POST", "/api/search", { q: "x", collection_id: "col_1" })).json()).not.toHaveProperty(
      "empty_scope",
    );
  });

  it("does not flag an unscoped search at all", async () => {
    expect(await (await send(agent(), "POST", "/api/search", { q: "x" })).json()).not.toHaveProperty("empty_scope");
  });

  it("flags the same on retrieve, and leaves an unscoped retrieval unflagged", async () => {
    mockExpand.mockResolvedValue([]);
    const scoped = await send(aiOn(), "POST", "/api/retrieve", { q: "x", collection_id: "col_1" });
    expect(await scoped.json()).toMatchObject({ chunks: [], empty_scope: true });
    expect(await (await send(aiOn(), "POST", "/api/retrieve", { q: "x" })).json()).not.toHaveProperty("empty_scope");
  });
});

describe("POST /api/retrieve", () => {
  it("retrieves across everything the caller can read when no collection is named", async () => {
    const res = await send(aiOn(), "POST", "/api/retrieve", { q: "how do expenses work?" });
    expect(res.status).toBe(200);
    expect(mockRetrieve).toHaveBeenCalledWith(expect.objectContaining({ scopeDocIds: null, query: "how do expenses work?" }));
    expect(mockExpand).not.toHaveBeenCalled();
  });

  it("narrows to a named collection, resolved for the human behind the key", async () => {
    await send(aiOn(), "POST", "/api/retrieve", { q: "x", collection_id: "col_1" });
    expect(mockRetrieve).toHaveBeenCalledWith(expect.objectContaining({ scopeDocIds: ["d1"] }));
  });

  it("says AI is disabled rather than answering an empty list", async () => {
    const res = await send(agent(), "POST", "/api/retrieve", { q: "x" });
    expect(await res.json()).toEqual({ chunks: [], ai_disabled: true });
    expect(mockRetrieve).not.toHaveBeenCalled();
  });
});

describe("a person and their agents share one set of collections", () => {
  it("creates an agent's collection for the person it acts for", async () => {
    const res = await send(agent(), "POST", "/api/collections", { name: "Bot's picks" });
    expect(res.status).toBe(201);
    expect(mockCreate).toHaveBeenCalledWith({}, expect.objectContaining({ owner: "user-liv", workspaceId: "ws1", name: "Bot's picks" }));
  });

  it("lets the person open, rename and delete a collection their agent made", async () => {
    await send(agent(), "POST", "/api/collections", { name: "Bot's picks" });
    const made = mockCreate.mock.calls[0]![1];
    mockGet.mockResolvedValue({ ...owned, collection_id: made.collectionId, owner: made.owner });
    expect((await send(human(), "GET", `/api/collections/${made.collectionId}`)).status).toBe(200);
    expect((await send(human(), "PATCH", `/api/collections/${made.collectionId}`, { name: "Mine now" })).status).toBe(200);
    expect((await send(human(), "DELETE", `/api/collections/${made.collectionId}`)).status).toBe(200);
    expect(mockDelete).toHaveBeenCalledWith({}, made.collectionId);
  });

  it("lets an agent open, rename, repopulate and delete the person's collection", async () => {
    expect((await send(agent(), "GET", "/api/collections/col_1")).status).toBe(200);
    expect(await (await send(agent(), "PATCH", "/api/collections/col_1", { name: "Renamed" })).json()).toMatchObject({ name: "Renamed" });
    expect((await send(agent(), "POST", "/api/collections/col_1/items", { doc_ids: ["d1"] })).status).toBe(201);
    expect((await send(agent(), "DELETE", "/api/collections/col_1/items", { doc_ids: ["d1"] })).status).toBe(200);
    expect((await send(agent(), "DELETE", "/api/collections/col_1")).status).toBe(200);
  });

  it.each([
    ["GET", "/api/collections/col_1", undefined],
    ["PATCH", "/api/collections/col_1", { name: "x" }],
    ["DELETE", "/api/collections/col_1", undefined],
    ["POST", "/api/collections/col_1/items", { doc_ids: ["d1"] }],
    ["DELETE", "/api/collections/col_1/items", { doc_ids: ["d1"] }],
  ])("answers %s %s with 404 for someone else's collection, human or agent", async (method, path, body) => {
    mockGet.mockResolvedValue({ ...owned, owner: "user-someone-else" });
    expect((await send(human(), method, path, body)).status).toBe(404);
    expect((await send(agent(), method, path, body)).status).toBe(404);
    expect(mockRename).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
    expect(mockAdd).not.toHaveBeenCalled();
    expect(mockRemove).not.toHaveBeenCalled();
    expect(mockItems).not.toHaveBeenCalled();
  });

  it("answers 404 for a collection in another workspace", async () => {
    mockGet.mockResolvedValue({ ...owned, workspace_id: "ws2" });
    expect((await send(agent(), "GET", "/api/collections/col_1")).status).toBe(404);
  });

  it("refuses a guest's key a new collection", async () => {
    const res = await send(agent({ role: "guest" } as Partial<Ctx>), "POST", "/api/collections", { name: "x" });
    expect(res.status).toBe(403);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it.each([
    ["PATCH", { name: "x" }],
    ["DELETE", undefined],
  ])("answers a folder-scoped key's %s of a collection holding members outside its folders with 404", async (method, body) => {
    mockReadsEvery.mockResolvedValue(false);
    expect((await send(agent(scoped(["f1"])), method, "/api/collections/col_1", body)).status).toBe(404);
    expect(mockReadsEvery).toHaveBeenCalledWith({}, "col_1", { principals: ["agent:a1"], workspaceId: "ws1", scopeFolderIds: ["f1"] });
    expect(mockRename).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
    expect(audits()).toEqual([]);
  });

  it("lets a folder-scoped key rename and delete a collection whose every member it reads", async () => {
    expect((await send(agent(scoped(["f1"])), "PATCH", "/api/collections/col_1", { name: "Renamed" })).status).toBe(200);
    expect((await send(agent(scoped(["f1"])), "DELETE", "/api/collections/col_1")).status).toBe(200);
    expect(mockDelete).toHaveBeenCalledWith({}, "col_1");
  });

  it("never asks whether an unconfined caller reads every member", async () => {
    mockReadsEvery.mockResolvedValue(false);
    expect((await send(agent(), "PATCH", "/api/collections/col_1", { name: "Renamed" })).status).toBe(200);
    expect((await send(human(), "DELETE", "/api/collections/col_1")).status).toBe(200);
    expect(mockReadsEvery).not.toHaveBeenCalled();
  });

  it("refuses a rename without a name", async () => {
    expect((await send(agent(), "PATCH", "/api/collections/col_1", { name: "  " })).status).toBe(400);
    expect(mockRename).not.toHaveBeenCalled();
  });
});

describe("members through the caller's reach", () => {
  it("adds only what a folder-scoped key can read, and says how many it skipped", async () => {
    mockVisible.mockResolvedValue({ docIds: ["d1"], folderIds: [] });
    const res = await send(agent(scoped(["f1"])), "POST", "/api/collections/col_1/items", { doc_ids: ["d1", "d-out", "d1"], folder_ids: ["f-out"] });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ added: 1, skipped: 2 });
    expect(mockVisible).toHaveBeenCalledWith({}, { principals: ["agent:a1"], workspaceId: "ws1", scopeFolderIds: ["f1"] }, ["d1", "d-out"], ["f-out"]);
    expect(mockAdd).toHaveBeenCalledWith({}, "col_1", { docIds: ["d1"], folderIds: [] });
  });

  it("removes only members the caller can read", async () => {
    mockVisible.mockResolvedValue({ docIds: [], folderIds: ["f1"] });
    const res = await send(agent(scoped(["f1"])), "DELETE", "/api/collections/col_1/items", { doc_ids: ["d-out"], folder_ids: ["f1"] });
    expect(await res.json()).toEqual({ removed: 1 });
    expect(mockRemove).toHaveBeenCalledWith({}, "col_1", { docIds: [], folderIds: ["f1"] });
  });

  it("opens a collection with only the members the caller can read", async () => {
    mockItems.mockResolvedValue([{ doc_id: "d1", folder_id: null, title: "In scope", added_at: "" }]);
    const res = await send(agent(scoped(["f1"])), "GET", "/api/collections/col_1");
    expect(await res.json()).toMatchObject({ collection: { collection_id: "col_1" }, items: [{ doc_id: "d1" }] });
    expect(mockItems).toHaveBeenCalledWith({}, "col_1", { principals: ["agent:a1"], workspaceId: "ws1", scopeFolderIds: ["f1"] });
  });

  it("asks for ids rather than changing nothing", async () => {
    expect((await send(agent(), "POST", "/api/collections/col_1/items", {})).status).toBe(400);
    expect(mockAdd).not.toHaveBeenCalled();
  });
});

describe("a read-only key", () => {
  const readOnly = () => agent(scoped(null, true));

  it("lists and opens collections", async () => {
    expect((await send(readOnly(), "GET", "/api/collections")).status).toBe(200);
    expect((await send(readOnly(), "GET", "/api/collections/col_1")).status).toBe(200);
  });

  it.each([
    ["POST", "/api/collections", { name: "x" }],
    ["PATCH", "/api/collections/col_1", { name: "x" }],
    ["DELETE", "/api/collections/col_1", undefined],
    ["POST", "/api/collections/col_1/items", { doc_ids: ["d1"] }],
    ["DELETE", "/api/collections/col_1/items", { doc_ids: ["d1"] }],
  ])("is refused %s %s", async (method, path, body) => {
    const res = await send(readOnly(), method, path, body);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: READ_ONLY_MESSAGE });
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockRename).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
    expect(mockAdd).not.toHaveBeenCalled();
    expect(mockRemove).not.toHaveBeenCalled();
  });
});

describe("the shared operations", () => {
  it("refuse a read-only key's change on every surface, not only behind the route table", async () => {
    const { createPersonCollection, renamePersonCollection, deletePersonCollection, changePersonCollectionItems } = await import("./collections.js");
    const ctx = agent(scoped(null, true));
    const refusal = { status: 403, error: READ_ONLY_MESSAGE };
    expect(await createPersonCollection(ctx, "x")).toEqual(refusal);
    expect(await renamePersonCollection(ctx, "col_1", "x")).toEqual(refusal);
    expect(await deletePersonCollection(ctx, "col_1")).toEqual(refusal);
    expect(await changePersonCollectionItems(ctx, "col_1", "add", { docIds: ["d1"], folderIds: [] })).toEqual(refusal);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockAdd).not.toHaveBeenCalled();
  });
});

describe("the audit ledger", () => {
  it("attributes every change to the agent, acting for its person", async () => {
    await send(agent(), "POST", "/api/collections", { name: "Picks" });
    await send(agent(), "PATCH", "/api/collections/col_1", { name: "Renamed" });
    await send(agent(), "POST", "/api/collections/col_1/items", { doc_ids: ["d1"] });
    await send(agent(), "DELETE", "/api/collections/col_1/items", { doc_ids: ["d1"] });
    await send(agent(), "DELETE", "/api/collections/col_1");
    const rows = audits();
    expect(rows.map((r) => r.action)).toEqual([
      "collection.create",
      "collection.rename",
      "collection.items.add",
      "collection.items.remove",
      "collection.delete",
    ]);
    for (const row of rows) {
      expect(row).toMatchObject({ actor: "agent:a1", actorKind: "agent", onBehalfOf: "user-liv", targetKind: "collection", status: "ok" });
    }
    expect(rows[1]).toMatchObject({ targetId: "col_1" });
    expect(rows[2]).toMatchObject({ detail: { added: 1, skipped: 0 } });
  });

  it("names a collection by id only, since the admins who read the ledger may not see it", async () => {
    await send(human(), "POST", "/api/collections", { name: "Picks" });
    await send(human(), "PATCH", "/api/collections/col_1", { name: "Renamed" });
    await send(human(), "POST", "/api/collections/col_1/items", { doc_ids: ["d1"] });
    await send(human(), "DELETE", "/api/collections/col_1");
    const rows = audits();
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.targetLabel).toBeNull();
      expect(JSON.stringify(row)).not.toMatch(/Picks|Renamed|Handbook/);
    }
  });

  it("records a person's change as theirs", async () => {
    await send(human(), "DELETE", "/api/collections/col_1");
    expect(audits()).toEqual([expect.objectContaining({ action: "collection.delete", actor: "user-liv", actorKind: "human", onBehalfOf: null })]);
  });

  it("records nothing for a read", async () => {
    await send(agent(), "GET", "/api/collections");
    await send(agent(), "GET", "/api/collections/col_1");
    expect(audits()).toEqual([]);
  });
});

describe("POST /api/docs/:id/media", () => {
  it("refuses a structured database, whose images nothing references or reclaims", async () => {
    mockGetDoc.mockResolvedValue({
      doc_id: "db1",
      workspace_id: "ws1",
      doc_type: "database",
      acl_principals: ["agent:a1"],
      acl_writers: ["agent:a1"],
      trashed: false,
    } as never);
    const res = await send(agent(), "POST", "/api/docs/db1/media");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("structured database");
  });
});
