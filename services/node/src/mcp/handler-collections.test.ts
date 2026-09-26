/**
 * `collections` and `collections_edit` on /mcp: an agent manages its person's collections through the same
 * operations as REST, and a collection scope on `retrieve` and `search` is exactly the collection's documents,
 * in the one workspace the call names. A read-only key's calls are in handler-read-only.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@stuga/db", async (orig) => ({
  ...(await orig<typeof import("@stuga/db")>()),
  getWorkspace: vi.fn(async () => ({ workspace_id: "ws1", name: "io", agent_instructions: "" })),
  listWorkspacesForUser: vi.fn(async () => [{ workspace_id: "ws1", name: "io", role: "member" }]),
  getMemberRole: vi.fn(async () => "member"),
  listCollections: vi.fn(async () => []),
  getCollection: vi.fn(),
  createCollection: vi.fn(),
  renameCollection: vi.fn(),
  deleteCollection: vi.fn(async () => {}),
  listCollectionItems: vi.fn(async () => []),
  filterVisibleRefs: vi.fn(),
  addCollectionItems: vi.fn(async () => 1),
  removeCollectionItems: vi.fn(async () => 1),
  readsEveryMember: vi.fn(async () => true),
  expandCollectionScope: vi.fn(async () => ["d1", "d2"]),
  searchDocs: vi.fn(async () => []),
  insertAiUsage: vi.fn(async () => {}),
}));
vi.mock("../retrieval/retrieve.js", () => ({ retrieveAndRerank: vi.fn(async () => ({ chunks: [], degraded: false })) }));
vi.mock("@stuga/ai", async (orig) => ({
  ...(await orig<typeof import("@stuga/ai")>()),
  embed: vi.fn(async () => ({ embeddings: [[0.1, 0.2]], inputTokens: 1 })),
}));
vi.mock("../auth/context.js", async (orig) => ({ ...(await orig<typeof import("../auth/context.js")>()), workspaceContextFor: vi.fn() }));

const db = await import("@stuga/db");
const { retrieveAndRerank } = await import("../retrieval/retrieve.js");
const { workspaceContextFor } = await import("../auth/context.js");
const { callerFor, resolvingTo, inWorkspace, callToolAs } = await import("./testing/call.js");
import type { Ctx } from "../auth/context.js";
import { agentCtx, fixed, recordingJobs } from "../testing/ctx.js";

const jobs = recordingJobs();
const OWNED = { collection_id: "col_1", workspace_id: "ws1", owner: "human-1", name: "Research", created_at: "", updated_at: "" };

function connectorCtx(scope?: { folders: string[] | null; readOnly: boolean }): Ctx {
  return agentCtx({
    surface: "mcp",
    principals: ["agent:agent-1", "user:human-1"],
    ...(scope ? { scope: { ...scope, credentialId: "agent-1" } } : {}),
    env: {
      jobs,
      aiSettings: fixed({ chat: { enabled: true }, embed: { enabled: true, model: "embed-1" } }),
      settings: fixed({ nodeLabel: "Studio", maxBodyBytes: 1024 * 1024 }),
      embeddingDims: 2,
      searchLanguages: fixed([]),
    },
  });
}

async function callTool(ctx: Ctx, name: string, args: Record<string, unknown>) {
  vi.mocked(workspaceContextFor).mockImplementation(resolvingTo(ctx));
  return callToolAs(callerFor(ctx), name, inWorkspace(ctx.workspaceId, name, args));
}

function expectNothingChanged() {
  expect(vi.mocked(db.createCollection)).not.toHaveBeenCalled();
  expect(vi.mocked(db.renameCollection)).not.toHaveBeenCalled();
  expect(vi.mocked(db.deleteCollection)).not.toHaveBeenCalled();
  expect(vi.mocked(db.addCollectionItems)).not.toHaveBeenCalled();
  expect(vi.mocked(db.removeCollectionItems)).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.getCollection).mockResolvedValue(OWNED);
  vi.mocked(db.createCollection).mockImplementation(async (_sql, c) => ({ ...OWNED, collection_id: c.collectionId, owner: c.owner, name: c.name }));
  vi.mocked(db.renameCollection).mockImplementation(async (_sql, id, name) => ({ ...OWNED, collection_id: id, name }));
  vi.mocked(db.filterVisibleRefs).mockImplementation(async (_sql, _reach, docIds, folderIds) => ({ docIds, folderIds }));
});

describe("the collections tools", () => {
  it("creates a collection for the person the connector acts for", async () => {
    const r = await callTool(connectorCtx(), "collections_edit", { action: "create", name: "Launch notes" });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.text)).toMatchObject({ name: "Launch notes" });
    expect(vi.mocked(db.createCollection).mock.calls[0]![1]).toMatchObject({ owner: "human-1", workspaceId: "ws1" });
  });

  it("lists, opens, renames and deletes the person's collections", async () => {
    vi.mocked(db.listCollections).mockResolvedValue([{ ...OWNED, item_count: 2 }]);
    vi.mocked(db.listCollectionItems).mockResolvedValue([
      { doc_id: "d1", folder_id: null, title: "Doc", added_at: "" },
      { doc_id: null, folder_id: "f1", title: "Folder", added_at: "" },
    ]);
    expect(JSON.parse((await callTool(connectorCtx(), "collections", { action: "list" })).text)).toEqual({
      collections: [{ collection_id: "col_1", name: "Research", item_count: 2 }],
    });
    expect(vi.mocked(db.listCollections)).toHaveBeenCalledWith({}, "human-1", expect.objectContaining({ workspaceId: "ws1" }));
    expect(JSON.parse((await callTool(connectorCtx(), "collections", { action: "open", collection_id: "col_1" })).text)).toEqual({
      collection_id: "col_1",
      name: "Research",
      items: [
        { doc_id: "d1", title: "Doc" },
        { folder_id: "f1", title: "Folder" },
      ],
    });
    expect(JSON.parse((await callTool(connectorCtx(), "collections_edit", { action: "rename", collection_id: "col_1", name: "Renamed" })).text)).toEqual({
      collection_id: "col_1",
      name: "Renamed",
    });
    expect(JSON.parse((await callTool(connectorCtx(), "collections_edit", { action: "delete", collection_id: "col_1" })).text)).toEqual({ deleted: true });
    expect(vi.mocked(db.deleteCollection)).toHaveBeenCalledWith({}, "col_1");
  });

  it("adds only what a folder-scoped key can read, and tells the agent what it skipped", async () => {
    vi.mocked(db.filterVisibleRefs).mockResolvedValue({ docIds: ["d1"], folderIds: [] });
    const r = await callTool(connectorCtx({ folders: ["f1"], readOnly: false }), "collections_edit", {
      action: "add_items",
      collection_id: "col_1",
      doc_ids: ["d1", "d-elsewhere"],
    });
    expect(JSON.parse(r.text)).toEqual({ added: 1, skipped: 1, note: "1 id skipped: not found, or not readable by this connector." });
    expect(vi.mocked(db.filterVisibleRefs).mock.calls[0]![1]).toEqual({ principals: ["agent:agent-1", "user:human-1"], workspaceId: "ws1", scopeFolderIds: ["f1"] });
    expect(vi.mocked(db.addCollectionItems)).toHaveBeenCalledWith({}, "col_1", { docIds: ["d1"], folderIds: [] });
  });

  it("removes items", async () => {
    const r = await callTool(connectorCtx(), "collections_edit", { action: "remove_items", collection_id: "col_1", folder_ids: ["f1"] });
    expect(JSON.parse(r.text)).toEqual({ removed: 1 });
  });

  // Rename and delete share the check; api/collections.test.ts runs both.
  it("answers a folder-scoped key's rename of a collection holding members outside its folders as not found", async () => {
    vi.mocked(db.readsEveryMember).mockResolvedValueOnce(false);
    const rename = { action: "rename", collection_id: "col_1", name: "x" };
    expect(await callTool(connectorCtx({ folders: ["f1"], readOnly: false }), "collections_edit", rename)).toEqual({ isError: true, text: "error: collection not found" });
    expect(vi.mocked(db.readsEveryMember)).toHaveBeenCalledWith({}, "col_1", { principals: ["agent:agent-1", "user:human-1"], workspaceId: "ws1", scopeFolderIds: ["f1"] });
    expect(vi.mocked(db.renameCollection)).not.toHaveBeenCalled();
  });

  it("answers someone else's collection as not found", async () => {
    vi.mocked(db.getCollection).mockResolvedValue({ ...OWNED, owner: "someone-else" });
    expect(await callTool(connectorCtx(), "collections", { action: "open", collection_id: "col_1" })).toEqual({ isError: true, text: "error: collection not found" });
    expect(await callTool(connectorCtx(), "collections_edit", { action: "delete", collection_id: "col_1" })).toEqual({ isError: true, text: "error: collection not found" });
    expect(vi.mocked(db.deleteCollection)).not.toHaveBeenCalled();
  });

  it("asks for the arguments an action needs before calling the node", async () => {
    expect(await callTool(connectorCtx(), "collections", { action: "open" })).toEqual({ isError: true, text: "error: open requires `collection_id`" });
    expect(await callTool(connectorCtx(), "collections_edit", { action: "create" })).toEqual({ isError: true, text: "error: create requires `name`" });
    expect(await callTool(connectorCtx(), "collections_edit", { action: "rename", name: "x" })).toEqual({ isError: true, text: "error: rename requires `collection_id`" });
    expect(await callTool(connectorCtx(), "collections_edit", { action: "add_items", collection_id: "col_1" })).toEqual({
      isError: true,
      text: "error: add_items requires `doc_ids` or `folder_ids`",
    });
    expect(vi.mocked(db.getCollection)).not.toHaveBeenCalled();
    expectNothingChanged();
  });

  it("audits the change and then the answered tool call, both as the agent acting for its person", async () => {
    await callTool(connectorCtx(), "collections_edit", { action: "rename", collection_id: "col_1", name: "Renamed" });
    const rows = jobs.audits();
    expect(rows.map((r) => r.action)).toEqual(["collection.rename", "mcp.collections_edit.rename"]);
    for (const row of rows) {
      expect(row).toMatchObject({ actor: "agent-1", actorKind: "agent", onBehalfOf: "human-1", targetKind: "collection", targetId: "col_1" });
    }
  });
});

describe("a collection scope on /mcp", () => {
  it("searches exactly the collection's documents", async () => {
    await callTool(connectorCtx(), "search", { q: "launch", collection_id: "col_1" });
    expect(vi.mocked(db.expandCollectionScope)).toHaveBeenCalledWith({}, "col_1", { principals: ["agent:agent-1", "user:human-1"], workspaceId: "ws1", scopeFolderIds: null });
    expect(vi.mocked(db.searchDocs).mock.calls[0]![1]).toMatchObject({ scopeDocIds: ["d1", "d2"] });
  });

  it("retrieves exactly the collection's documents", async () => {
    await callTool(connectorCtx(), "retrieve", { q: "launch", collection_id: "col_1" });
    expect(vi.mocked(retrieveAndRerank).mock.calls[0]![0]).toMatchObject({ scopeDocIds: ["d1", "d2"] });
  });

  it("never falls back to every document for a collection it cannot use", async () => {
    vi.mocked(db.getCollection).mockResolvedValue(null);
    expect(await callTool(connectorCtx(), "search", { q: "launch", collection_id: "col_gone" })).toEqual({
      isError: true,
      text: "error: collection not found",
    });
    expect(await callTool(connectorCtx(), "retrieve", { q: "launch", collection_id: "col_gone" })).toEqual({
      isError: true,
      text: "error: collection not found",
    });
    expect(vi.mocked(db.searchDocs)).not.toHaveBeenCalled();
    expect(vi.mocked(retrieveAndRerank)).not.toHaveBeenCalled();
  });

  it.each(["search", "retrieve"])("refuses a collection on a %s over more than one workspace, before anything runs", async (tool) => {
    const r = await callTool(connectorCtx(), tool, { workspace_ids: ["ws1", "ws2"], q: "launch", collection_id: "col_1" });
    expect(r).toEqual({ isError: true, text: "error: `collection_id` narrows one workspace's search: pass exactly that workspace in `workspace_ids`" });
    expect(vi.mocked(workspaceContextFor)).not.toHaveBeenCalled();
    expect(vi.mocked(db.expandCollectionScope)).not.toHaveBeenCalled();
    expect(vi.mocked(db.searchDocs)).not.toHaveBeenCalled();
    expect(vi.mocked(retrieveAndRerank)).not.toHaveBeenCalled();
  });
});
