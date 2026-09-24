/**
 * A read-only key on /mcp, over every tool and action: each read answers, and
 * each change is the read-only refusal as an ordinary tool error, audited as
 * denied, with nothing read or written on its way.
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

const { TOOL_ACTIONS, TOOL_NAMES } = await import("@stuga/agent-surface/catalog");
const { handleMcpRequest } = await import("./handler.js");
const { READ_ONLY_MESSAGE } = await import("../authz/authz.js");
import type { Ctx } from "../auth/context.js";

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

function readOnlyKey(): Ctx {
  return {
    sql: {},
    alias: "agent-1",
    displayName: "Scout",
    surface: "mcp",
    isAgent: true,
    onBehalfOf: "human-1",
    principals: ["agent:agent-1", "user:human-1", "org:ws1"],
    workspaceId: "ws1",
    role: "member",
    scope: { folders: null, readOnly: true, keyId: "k1" },
    env: {
      databases: { get: () => ({ fetch: actorFetch }) },
      docs: { get: () => ({ fetch: actorFetch }) },
      settings: { current: () => ({ databaseOpsKeep: 500, maxBodyBytes: 1024 * 1024, nodeLabel: "Studio" }) },
      jobs: { send: jobsSend },
      media: { head: async () => null, put: mediaPut },
      aiSettings: { current: () => ({ chat: { enabled: true }, embed: { enabled: true } }) },
      publicOrigin: "https://stuga.test",
    },
  } as unknown as Ctx;
}

async function callTool(name: string, args: Record<string, unknown>) {
  const req = new Request("https://stuga.test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await (await handleMcpRequest(readOnlyKey(), req)).text();
  const payload = text.startsWith("event:") || text.startsWith("data:") ? JSON.parse(/data: (.*)/.exec(text)![1]!) : JSON.parse(text);
  const result = payload.result ?? {};
  return { isError: result.isError === true, text: String(result.content?.[0]?.text ?? "") };
}

const PNG = btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3));

/** Every tool and action on /mcp with arguments that would otherwise succeed, and what a read-only key gets. */
const CALLS: Array<[tool: string, args: Record<string, unknown>, verdict: "reads" | "refused"]> = [
  ["workspaces", { action: "list" }, "reads"],
  ["workspaces", { action: "instructions" }, "reads"],
  ["docs", { action: "list" }, "reads"],
  ["docs", { action: "search", q: "launch" }, "reads"],
  ["docs", { action: "metadata", doc_id: "d1" }, "reads"],
  ["docs", { action: "create", title: "New" }, "refused"],
  ["markdown", { action: "read", doc_id: "d1" }, "reads"],
  ["markdown", { action: "write", doc_id: "d1", text: "x" }, "refused"],
  ["markdown", { action: "str_replace", doc_id: "d1", find: "a", replace: "b" }, "refused"],
  ["markdown", { action: "append", doc_id: "d1", text: "x" }, "refused"],
  ["markdown", { action: "cited_edits", doc_id: "d1", edits: [{ old_string: "a", new_string: "b" }] }, "refused"],
  ["markdown", { action: "status", doc_id: "d1" }, "reads"],
  ["markdown", { action: "provenance", doc_id: "d1" }, "reads"],
  ["media", { action: "upload", doc_id: "d1", data: PNG }, "refused"],
  ["media", { action: "upload_from_url", doc_id: "d1", url: "https://example.com/a.png" }, "refused"],
  ["comments", { action: "list", doc_id: "d1" }, "reads"],
  ["comments", { action: "add", doc_id: "d1", body: "Looks good" }, "refused"],
  ["folders", {}, "reads"],
  ["events", {}, "reads"],
  ["collections", { action: "list" }, "reads"],
  ["collections", { action: "open", collection_id: "col_1" }, "reads"],
  ["collections", { action: "create", name: "x" }, "refused"],
  ["collections", { action: "rename", collection_id: "col_1", name: "x" }, "refused"],
  ["collections", { action: "delete", collection_id: "col_1" }, "refused"],
  ["collections", { action: "add_items", collection_id: "col_1", doc_ids: ["d1"] }, "refused"],
  ["collections", { action: "remove_items", collection_id: "col_1", doc_ids: ["d1"] }, "refused"],
  ["retrieve", { q: "launch" }, "reads"],
  ["databases", { action: "list" }, "reads"],
  ["databases", { action: "schema", database_id: "db1" }, "reads"],
  ["databases", { action: "status", database_id: "db1" }, "reads"],
  ["databases", { action: "create_database", title: "New" }, "refused"],
  ["databases", { action: "create_table", database_id: "db1", name: "Projects" }, "refused"],
  ["databases", { action: "add_column", database_id: "db1", table: "tasks", name: "Due", type: "date" }, "refused"],
  ["databases", { action: "insert_rows", database_id: "db1", table: "tasks", rows: [{ name: "x" }] }, "refused"],
  ["databases", { action: "update_rows", database_id: "db1", table: "tasks", updates: [{ _id: "r1", values: { name: "y" } }] }, "refused"],
  ["databases", { action: "delete_rows", database_id: "db1", table: "tasks", row_ids: ["r1"] }, "refused"],
  ["databases", { action: "import", database_id: "db1", table: "tasks", content: "name\nx\n" }, "refused"],
  ["databases", { action: "create_view", database_id: "db1", table: "tasks", name: "Mine" }, "refused"],
  ["databases", { action: "update_view", database_id: "db1", table: "tasks", view: "Open", name: "Closed" }, "refused"],
  ["databases", { action: "open_page", database_id: "db1", table: "tasks", row_id: "r1" }, "reads"],
  ["query", { database_id: "db1", sql: "SELECT 1" }, "reads"],
];

const audits = () => jobsSend.mock.calls.map(([m]) => m).filter((m) => m.kind === "audit");

beforeEach(() => {
  vi.clearAllMocks();
  actorCalls.length = 0;
  pageOfRow = "page1";
  db.getWorkspace.mockResolvedValue({ workspace_id: "ws1", name: "io", agent_instructions: "" });
  db.listWorkspacesForUser.mockResolvedValue([{ workspace_id: "ws1", name: "io", role: "member" }]);
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

  it.each(CALLS.filter(([, , verdict]) => verdict === "reads"))("answers %s %o", async (tool, args) => {
    const out = await callTool(tool, args);
    expect(out.isError, out.text).toBe(false);
    expect(audits()).toEqual([expect.objectContaining({ action: expect.stringMatching(new RegExp(`^mcp\\.${tool}\\.`)), status: "ok" })]);
  });

  it.each(CALLS.filter(([, , verdict]) => verdict === "refused"))("refuses %s %o before anything runs", async (tool, args) => {
    expect(await callTool(tool, args)).toEqual({ isError: true, text: `error: ${READ_ONLY_MESSAGE}` });
    expect(audits()).toEqual([expect.objectContaining({ action: `mcp.${tool}.${String(args.action)}`, status: "denied" })]);
    for (const [name, fn] of Object.entries({ ...db, ...edits, ...search })) {
      // The handshake reads the workspace's conventions.
      if (name !== "getWorkspace") expect(fn, name).not.toHaveBeenCalled();
    }
    expect(actorFetch).not.toHaveBeenCalled();
    expect(mediaPut).not.toHaveBeenCalled();
  });

  it("reads the instructions that apply with metadata, read and schema", async () => {
    const levels = [{ kind: "workspace", id: "ws1", title: "io", text: "Answer in Swedish." }];
    db.resolveDocInstructions.mockResolvedValue(levels);
    expect(JSON.parse((await callTool("docs", { action: "metadata", doc_id: "d1" })).text).instructions).toEqual(levels);
    expect((await callTool("markdown", { action: "read", doc_id: "d1" })).text).toContain('--- Workspace "io" ---\nAnswer in Swedish.');
    expect(JSON.parse((await callTool("databases", { action: "schema", database_id: "db1" })).text).instructions).toEqual(levels);
  });

  it("opens a row's live page, and is refused a page that would have to be made", async () => {
    expect(JSON.parse((await callTool("databases", { action: "open_page", database_id: "db1", table: "tasks", row_id: "r1" })).text)).toMatchObject({
      doc_id: "page1",
      created: false,
    });
    expect(audits()).toEqual([expect.objectContaining({ action: "mcp.databases.open_page", targetId: "db1", status: "ok" })]);
    jobsSend.mockClear();
    pageOfRow = null;
    expect(await callTool("databases", { action: "open_page", database_id: "db1", table: "tasks", row_id: "r1" })).toEqual({
      isError: true,
      text: `error: ${READ_ONLY_MESSAGE}`,
    });
    expect(audits()).toEqual([expect.objectContaining({ action: "mcp.databases.open_page", targetId: "db1", status: "denied" })]);
    expect(db.createDoc).not.toHaveBeenCalled();
    expect(actorCalls).not.toContain("/rows/link-doc");
  });
});
