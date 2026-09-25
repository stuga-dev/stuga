/**
 * A read-only key on /mcp, over every tool and action: it is offered the
 * reading tools only, each read answers, and a write is refused with nothing
 * read or written on its way — as a tool it was never offered, and at the
 * node's own gate as the read-only refusal, audited as denied.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const DOC = {
  doc_id: "d1",
  workspace_id: "ws1",
  owner: "user:human-1",
  title: "Notes",
  doc_type: "prose",
  parent_id: null,
  trashed: false,
  locked: false,
  agent_mode: "review",
  acl_principals: ["user:human-1", "org:ws1"],
  acl_writers: ["user:human-1", "org:ws1"],
  acl_commenters: [],
};
const DATABASE = { ...DOC, doc_id: "db1", title: "Tasks", doc_type: "database" };
const PAGE = { ...DOC, doc_id: "page1", title: "Task 1", page_of: "db1", page_row: "t1.r1" };
const COLLECTION = { collection_id: "col_1", workspace_id: "ws1", owner: "human-1", name: "Research", created_at: "", updated_at: "" };
const WORKSPACES = [
  { workspace_id: "ws1", name: "io", role: "member" },
  { workspace_id: "ws2", name: "Shared", role: "member" },
];

const db = vi.hoisted(() => ({
  getWorkspace: vi.fn(),
  listWorkspacesForUser: vi.fn(),
  listDocs: vi.fn(),
  getDoc: vi.fn(),
  listComments: vi.fn(),
  listFolders: vi.fn(),
  latestWorkspaceEventId: vi.fn(),
  listWorkspaceEvents: vi.fn(),
  listCollections: vi.fn(),
  getCollection: vi.fn(),
  listCollectionItems: vi.fn(),
  getMemberRole: vi.fn(),
  createDoc: vi.fn(),
  updateDoc: vi.fn(),
  addComment: vi.fn(),
  createCollection: vi.fn(),
  renameCollection: vi.fn(),
  deleteCollection: vi.fn(),
  addCollectionItems: vi.fn(),
  removeCollectionItems: vi.fn(),
  resolveDocInstructions: vi.fn(),
}));
const edits = vi.hoisted(() => ({
  readDocMarkdownWithProjection: vi.fn(),
  readDocRuns: vi.fn(),
  readDocProvenance: vi.fn(),
  proposeDocEdit: vi.fn(),
}));
const search = vi.hoisted(() => ({ searchDocuments: vi.fn(), retrievePassages: vi.fn() }));

vi.mock("@stuga/db", async (orig) => ({ ...(await orig<typeof import("@stuga/db")>()), ...db }));
vi.mock("../agents/edits.js", async (orig) => ({ ...(await orig<typeof import("../agents/edits.js")>()), ...edits }));
vi.mock("../api/search.js", async (orig) => ({ ...(await orig<typeof import("../api/search.js")>()), ...search }));
vi.mock("../auth/context.js", async (orig) => ({ ...(await orig<typeof import("../auth/context.js")>()), workspaceContextFor: vi.fn() }));

const { TOOL_ACTIONS, TOOL_NAMES } = await import("@stuga/agent-surface/catalog");
const { workspaceContextFor } = await import("../auth/context.js");
const { callerFor, resolvingTo, inWorkspace, callToolAs, mcpRequest } = await import("./testing/call.js");
const { READ_ONLY_MESSAGE } = await import("../authz/authz.js");
import type { Ctx, McpCaller } from "../auth/context.js";

const SCHEMA = {
  database_id: "db1",
  tables: [
    {
      table_id: "t1",
      name: "tasks",
      display: "Tasks",
      position: 0,
      row_count: 1,
      columns: [{ column_id: "c1", name: "name", display: "Name", type: "text", position: 0, options: null }],
      views: [{ view_id: "v1", table_id: "t1", kind: "table", name: "Open", position: 0, filter: null, sorts: [], group_by: null, hidden_columns: [], config: {} }],
    },
  ],
};

const actorCalls: string[] = [];
let pageOfRow: string | null = "page1";
const actorFetch = vi.fn(async (url: string) => {
  const path = new URL(url).pathname;
  actorCalls.push(path);
  const answers: Record<string, unknown> = {
    "/schema": SCHEMA,
    "/runs": { runs: [] },
    "/query": { columns: ["n"], rows: [{ n: 1 }], truncated: false },
    "/rows/list": { rows: [{ _id: "r1", c1: "Task 1", _doc_id: pageOfRow }], total: 1 },
  };
  return new Response(JSON.stringify(answers[path] ?? {}), { status: path in answers ? 200 : 500 });
});
const jobsSend = vi.fn(async (_message: Record<string, unknown>) => {});
const mediaPut = vi.fn(async () => {});

function readOnlyKey(workspaceId = "ws1"): Ctx {
  return {
    sql: {},
    alias: "agent-1",
    displayName: "Scout",
    surface: "mcp",
    isAgent: true,
    onBehalfOf: "human-1",
    principals: ["agent:agent-1", "user:human-1", `org:${workspaceId}`],
    workspaceId,
    role: "member",
    scope: { folders: null, readOnly: true, credentialId: "k1" },
    env: {
      databases: { get: () => ({ fetch: actorFetch }) },
      docs: { get: () => ({ fetch: actorFetch }) },
      settings: { current: () => ({ databaseOpsKeep: 500, maxBodyBytes: 1024 * 1024, nodeLabel: "Studio" }) },
      jobs: { send: jobsSend },
      media: { head: async () => null, put: mediaPut },
      aiSettings: { current: () => ({ chat: { enabled: true }, embed: { enabled: true } }) },
      publicOrigin: "https://stuga.test",
      nodeId: "node-1",
    },
  } as unknown as Ctx;
}

async function callTool(name: string, args: Record<string, unknown>, over: Partial<McpCaller> = {}) {
  const ctx = readOnlyKey();
  vi.mocked(workspaceContextFor).mockImplementation(resolvingTo(ctx));
  return callToolAs(callerFor(ctx, over), name, inWorkspace(ctx.workspaceId, name, args));
}

const PNG = btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3));

/** Every tool and action on /mcp with arguments that would otherwise succeed, and what a read-only key gets. */
const CALLS: Array<[tool: string, args: Record<string, unknown>, verdict: "reads" | "refused"]> = [
  ["workspaces", { action: "list" }, "reads"],
  ["workspaces", { action: "instructions" }, "reads"],
  ["docs", { action: "list" }, "reads"],
  ["docs", { action: "metadata", doc_id: "d1" }, "reads"],
  ["search", { q: "launch" }, "reads"],
  ["markdown", { action: "read", doc_id: "d1" }, "reads"],
  ["markdown", { action: "status", doc_id: "d1" }, "reads"],
  ["markdown", { action: "provenance", doc_id: "d1" }, "reads"],
  ["comments", { doc_id: "d1" }, "reads"],
  ["folders", {}, "reads"],
  ["events", {}, "reads"],
  ["collections", { action: "list" }, "reads"],
  ["collections", { action: "open", collection_id: "col_1" }, "reads"],
  ["retrieve", { q: "launch" }, "reads"],
  ["databases", { action: "list" }, "reads"],
  ["databases", { action: "schema", database_id: "db1" }, "reads"],
  ["databases", { action: "status", database_id: "db1" }, "reads"],
  ["databases", { action: "page", database_id: "db1", table: "tasks", row_id: "r1" }, "reads"],
  ["query", { database_id: "db1", sql: "SELECT 1" }, "reads"],
  ["docs_create", { title: "New" }, "refused"],
  ["markdown_append", { doc_id: "d1", text: "x" }, "refused"],
  ["markdown_edit", { action: "write", doc_id: "d1", text: "x" }, "refused"],
  ["markdown_edit", { action: "str_replace", doc_id: "d1", find: "a", replace: "b" }, "refused"],
  ["markdown_edit", { action: "cited_edits", doc_id: "d1", edits: [{ old_string: "a", new_string: "b" }] }, "refused"],
  ["comments_add", { doc_id: "d1", body: "Looks good" }, "refused"],
  ["media_upload", { action: "upload", doc_id: "d1", data: PNG }, "refused"],
  ["media_upload", { action: "upload_from_url", doc_id: "d1", url: "https://example.com/a.png" }, "refused"],
  ["collections_edit", { action: "create", name: "x" }, "refused"],
  ["collections_edit", { action: "rename", collection_id: "col_1", name: "x" }, "refused"],
  ["collections_edit", { action: "delete", collection_id: "col_1" }, "refused"],
  ["collections_edit", { action: "add_items", collection_id: "col_1", doc_ids: ["d1"] }, "refused"],
  ["collections_edit", { action: "remove_items", collection_id: "col_1", doc_ids: ["d1"] }, "refused"],
  ["databases_add", { action: "create_database", title: "New" }, "refused"],
  ["databases_add", { action: "create_table", database_id: "db1", name: "Projects" }, "refused"],
  ["databases_add", { action: "add_column", database_id: "db1", table: "tasks", name: "Due", type: "date" }, "refused"],
  ["databases_add", { action: "insert_rows", database_id: "db1", table: "tasks", rows: [{ name: "x" }] }, "refused"],
  ["databases_add", { action: "import", database_id: "db1", table: "tasks", content: "name\nx\n" }, "refused"],
  ["databases_add", { action: "start_import", database_id: "db1", table: "tasks" }, "refused"],
  ["databases_add", { action: "create_view", database_id: "db1", table: "tasks", name: "Mine" }, "refused"],
  ["databases_add", { action: "open_page", database_id: "db1", table: "tasks", row_id: "r1" }, "refused"],
  ["databases_change", { action: "update_rows", database_id: "db1", table: "tasks", updates: [{ _id: "r1", values: { name: "y" } }] }, "refused"],
  ["databases_change", { action: "delete_rows", database_id: "db1", table: "tasks", row_ids: ["r1"] }, "refused"],
  ["databases_change", { action: "update_view", database_id: "db1", table: "tasks", view: "Open", name: "Closed" }, "refused"],
];
const READS = CALLS.filter(([, , verdict]) => verdict === "reads");
const REFUSED = CALLS.filter(([, , verdict]) => verdict === "refused");

/** The audit verb of a tool that takes no `action`. */
const VERB: Record<string, string> = {
  search: "search",
  comments: "list",
  folders: "list",
  events: "poll",
  retrieve: "retrieve",
  query: "select",
  docs_create: "create",
  markdown_append: "append",
  comments_add: "add",
};
const auditAction = (tool: string, args: Record<string, unknown>) => `mcp.${tool}.${String(args.action ?? VERB[tool])}`;

const audits = () => jobsSend.mock.calls.map(([m]) => m).filter((m) => m.kind === "audit");

/** Nothing ran past the handshake, which reads the routing table and the only workspace's conventions. */
function expectNothingRan() {
  for (const [name, fn] of Object.entries({ ...db, ...edits, ...search })) {
    if (name !== "getWorkspace" && name !== "listWorkspacesForUser") expect(fn, name).not.toHaveBeenCalled();
  }
  expect(actorFetch).not.toHaveBeenCalled();
  expect(mediaPut).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  actorCalls.length = 0;
  pageOfRow = "page1";
  db.getWorkspace.mockResolvedValue({ workspace_id: "ws1", name: "io", agent_instructions: "" });
  db.listWorkspacesForUser.mockResolvedValue([WORKSPACES[0]]);
  db.listDocs.mockResolvedValue([DOC, DATABASE]);
  db.getDoc.mockImplementation(async (_sql: unknown, id: string) => ({ d1: DOC, db1: DATABASE, page1: PAGE })[id] ?? null);
  db.listComments.mockResolvedValue([]);
  db.listFolders.mockResolvedValue([]);
  db.latestWorkspaceEventId.mockResolvedValue(3);
  db.listWorkspaceEvents.mockResolvedValue([]);
  db.listCollections.mockResolvedValue([{ ...COLLECTION, item_count: 0 }]);
  db.getCollection.mockResolvedValue(COLLECTION);
  db.listCollectionItems.mockResolvedValue([]);
  db.resolveDocInstructions.mockResolvedValue([]);
  edits.readDocMarkdownWithProjection.mockResolvedValue({ markdown: "body", doc: DOC });
  edits.readDocRuns.mockResolvedValue([]);
  edits.readDocProvenance.mockResolvedValue({ passages: [], pending_runs: 0 });
  search.searchDocuments.mockResolvedValue({ query: "launch", results: [], degraded: false, semantic: true });
  search.retrievePassages.mockResolvedValue({ chunks: [], degraded: false });
});

describe("a read-only key on /mcp", () => {
  it("has a verdict for every tool and action the catalog registers", () => {
    const listed = CALLS.map(([tool, args]) => `${tool}.${String(args.action ?? "")}`);
    const registered = TOOL_NAMES.flatMap((tool) => (TOOL_ACTIONS[tool].length ? TOOL_ACTIONS[tool].map((a) => `${tool}.${a}`) : [`${tool}.`]));
    expect(listed).toEqual(registered);
  });

  it("is offered exactly the tools it may call, each marked read-only, and told it may only read", async () => {
    const caller = callerFor(readOnlyKey());
    const { tools } = (await mcpRequest(caller, "tools/list")).result as { tools: Array<{ name: string; annotations?: { readOnlyHint?: boolean } }> };
    expect(tools.map((t) => t.name)).toEqual([...new Set(READS.map(([tool]) => tool))]);
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
    const init = await mcpRequest(caller, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    expect((init.result as { instructions: string }).instructions).toContain("READ-ONLY: this connection may read and search");
  });

  it.each(READS.filter(([tool, args]) => !(tool === "workspaces" && args.action === "list")))("answers %s %o", async (tool, args) => {
    const out = await callTool(tool, args);
    expect(out.isError, out.text).toBe(false);
    expect(audits()).toEqual([expect.objectContaining({ action: auditAction(tool, args), workspaceId: "ws1", status: "ok" })]);
  });

  it("lists the workspaces it reaches as read access", async () => {
    db.listWorkspacesForUser.mockResolvedValue(WORKSPACES);
    const out = await callTool("workspaces", { action: "list" });
    expect(JSON.parse(out.text).workspaces.map((w: { workspace_id: string; access: string }) => [w.workspace_id, w.access])).toEqual([
      ["ws1", "read"],
      ["ws2", "read"],
    ]);
  });

  it.each(REFUSED)("is refused %s %o, a tool it was never offered, before anything runs", async (tool, args) => {
    expect((await callTool(tool, args)).isError).toBe(true);
    expect(workspaceContextFor).not.toHaveBeenCalled();
    expectNothingRan();
  });

  // The node's own gate, behind the tool list: a workspace that resolves read-only refuses every write.
  it.each(REFUSED)("is refused %s %o where its workspace resolves read-only, audited as denied", async (tool, args) => {
    expect(await callTool(tool, args, { readOnly: false })).toEqual({ isError: true, text: `error: ${READ_ONLY_MESSAGE}` });
    expect(audits()).toEqual([expect.objectContaining({ action: auditAction(tool, args), workspaceId: "ws1", status: "denied" })]);
    expectNothingRan();
  });

  it.each([[["ws1", "ws2"]], [["*"]]])("searches and retrieves across %j, each workspace read-only", async (workspaceIds) => {
    db.listWorkspacesForUser.mockResolvedValue(WORKSPACES);
    vi.mocked(workspaceContextFor).mockImplementation(async (_caller, id) => (id === "ws1" || id === "ws2" ? readOnlyKey(id) : null));
    search.searchDocuments.mockImplementation(async (ctx: Ctx) => ({
      query: "launch",
      results: [{ doc_id: `${ctx.workspaceId}-d`, title: "Launch", score: 1 }],
      degraded: false,
      semantic: true,
    }));
    search.retrievePassages.mockImplementation(async (ctx: Ctx) => ({
      chunks: [{ doc_id: `${ctx.workspaceId}-d`, title: "Launch", chunk_index: 0, content: "Ship it.", heading_path: null }],
      degraded: false,
    }));
    const caller = callerFor(readOnlyKey());

    const found = await callToolAs(caller, "search", { workspace_ids: workspaceIds, q: "launch" });
    expect(found.isError, found.text).toBe(false);
    expect(JSON.parse(found.text)).toMatchObject({
      results: [
        { workspace_id: "ws1", doc_id: "ws1-d", url: "https://stuga.test/doc/ws1-d" },
        { workspace_id: "ws2", doc_id: "ws2-d", url: "https://stuga.test/doc/ws2-d" },
      ],
      unavailable: [],
    });
    const passages = await callToolAs(caller, "retrieve", { workspace_ids: workspaceIds, q: "launch" });
    expect(JSON.parse(passages.text)).toMatchObject({
      passages: [
        { workspace_id: "ws1", doc_id: "ws1-d", content: "Ship it." },
        { workspace_id: "ws2", doc_id: "ws2-d", content: "Ship it." },
      ],
      unavailable: [],
    });

    for (const fn of [search.searchDocuments, search.retrievePassages]) {
      expect(fn.mock.calls.map(([ctx]) => [(ctx as Ctx).workspaceId, (ctx as Ctx).scope?.readOnly])).toEqual([
        ["ws1", true],
        ["ws2", true],
      ]);
    }
    expect(audits().map((a) => [a.action, a.workspaceId, a.status])).toEqual([
      ["mcp.search.search", "ws1", "ok"],
      ["mcp.search.search", "ws2", "ok"],
      ["mcp.retrieve.retrieve", "ws1", "ok"],
      ["mcp.retrieve.retrieve", "ws2", "ok"],
    ]);
  });

  it("reads the instructions that apply with metadata, read and schema", async () => {
    const levels = [{ kind: "workspace", id: "ws1", title: "io", text: "Answer in Swedish." }];
    db.resolveDocInstructions.mockResolvedValue(levels);
    expect(JSON.parse((await callTool("docs", { action: "metadata", doc_id: "d1" })).text).instructions).toEqual(levels);
    expect((await callTool("markdown", { action: "read", doc_id: "d1" })).text).toContain('--- Workspace "io" ---\nAnswer in Swedish.');
    expect(JSON.parse((await callTool("databases", { action: "schema", database_id: "db1" })).text).instructions).toEqual(levels);
  });

  it("finds a row's live page, and makes none for a row without one", async () => {
    const page = { action: "page", database_id: "db1", table: "tasks", row_id: "r1" };
    expect(JSON.parse((await callTool("databases", page)).text)).toMatchObject({ doc_id: "page1" });
    pageOfRow = null;
    const none = await callTool("databases", page);
    expect(none.isError).toBe(false);
    expect(JSON.parse(none.text)).toMatchObject({ doc_id: null });
    expect(audits()).toEqual([
      expect.objectContaining({ action: "mcp.databases.page", targetId: "db1", status: "ok" }),
      expect.objectContaining({ action: "mcp.databases.page", targetId: "db1", status: "ok" }),
    ]);
    expect(db.createDoc).not.toHaveBeenCalled();
    expect(db.updateDoc).not.toHaveBeenCalled();
    expect(actorCalls).not.toContain("/rows/link-doc");
  });
});
