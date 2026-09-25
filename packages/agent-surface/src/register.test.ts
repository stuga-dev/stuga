import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { DatabaseSchema } from "@stuga/protocol/databases/types";
import type { AgentBackend } from "./backend.js";
import { MCP_CONTRACT_VERSION, READ_TOOLS, TOOL_NAMES } from "./catalog.js";
import { registerAgentTools, type AgentSurface, type Reach, type ToolCall, type WorkspaceRoute } from "./register.js";
import { EMPTY_SCOPE_NOTE, RETRIEVE_AI_DISABLED_MESSAGE } from "./render/search.js";

const SCHEMA: DatabaseSchema = {
  database_id: "db1",
  tables: [
    {
      table_id: "t1",
      name: "tasks",
      display: "Tasks",
      position: 0,
      row_count: 0,
      columns: [],
      views: [
        { view_id: "view_1", table_id: "t1", kind: "table", name: "Open", position: 0, filter: null, sorts: [], group_by: null, hidden_columns: [], config: {} },
      ],
    },
  ],
};

const METHODS = [
  "workspaceInstructions",
  "listDocs",
  "searchDocs",
  "docMetadata",
  "createDoc",
  "readMarkdown",
  "docRuns",
  "provenance",
  "propose",
  "uploadImage",
  "listComments",
  "addComment",
  "listFolders",
  "pollEvents",
  "listCollections",
  "openCollection",
  "createCollection",
  "renameCollection",
  "deleteCollection",
  "changeCollectionItems",
  "retrieve",
  "databaseSchema",
  "databaseRuns",
  "mutateDatabase",
  "openRowPage",
  "findRowPage",
  "startImport",
  "importRows",
  "query",
] as const;

/** A backend whose every method fails the test unless the case replaces it. */
function backend(over: Partial<AgentBackend> = {}, origin = "https://stuga.test"): AgentBackend {
  const b = { origin } as Record<string, unknown>;
  for (const m of METHODS) {
    b[m] = vi.fn(async () => {
      throw new Error(`unexpected backend call: ${m}`);
    });
  }
  return { ...(b as unknown as AgentBackend), ...over };
}

const routeOf = (id: string): WorkspaceRoute => ({
  workspace_id: id,
  name: id,
  role: "editor",
  access: "propose",
  node: { id: "n1", name: "Studio", origin: "https://stuga.test" },
});

/** A surface over fixed per-workspace backends; any other workspace is refused, as a node refuses one. */
function surface(backends: Record<string, AgentBackend>, over: Partial<Reach> = {}) {
  const settled = vi.fn();
  const calls: ToolCall[] = [];
  const s: AgentSurface = {
    reach: vi.fn(async () => ({ workspaces: Object.keys(backends).map(routeOf), unavailable: [], ...over })),
    backendFor: vi.fn(async (call: ToolCall) => {
      calls.push(call);
      const b = backends[call.workspaceId];
      return b ? { backend: b, settled } : { error: "workspace is not available to this connector" };
    }),
  };
  return { s, settled, calls };
}

async function connect(s: AgentSurface, readOnly = false) {
  const server = new McpServer({ name: "stuga", version: "0" });
  registerAgentTools(server, s, { readOnly });
  const client = new Client({ name: "test", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as { content?: Array<{ text?: string }>; isError?: boolean };
    return { text: res.content?.[0]?.text ?? "", isError: res.isError === true };
  };
  return { client, call };
}

/** One workspace, `ws1`, over the given backend. */
async function single(over: Partial<AgentBackend> = {}) {
  const b = backend(over);
  const { s, settled, calls } = surface({ ws1: b });
  return { ...(await connect(s)), b, settled, calls };
}

const W = { workspace_id: "ws1" };

describe("registerAgentTools", () => {
  it("offers every tool with its annotations, and a read-only credential only the reading ones", async () => {
    const { client } = await connect(surface({}).s);
    const tools = (await client.listTools()).tools;
    expect(tools.map((t) => t.name)).toEqual([...TOOL_NAMES]);
    const edit = tools.find((t) => t.name === "markdown_edit")!;
    expect(edit.annotations).toMatchObject({ title: "Edit a document", readOnlyHint: false, destructiveHint: true, openWorldHint: true });
    expect(tools.find((t) => t.name === "search")!.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });

    const readOnly = await connect(surface({}).s, true);
    expect((await readOnly.client.listTools()).tools.map((t) => t.name)).toEqual([...READ_TOOLS]);
  });

  it("lists the routing table with the contract version, without asking any workspace", async () => {
    const { s } = surface({ ws1: backend(), ws2: backend() }, { unavailable: [{ workspace_id: "ws9", reason: "node is asleep" }] });
    const { call } = await connect(s);
    const listed = JSON.parse((await call("workspaces", { action: "list" })).text);
    expect(listed).toEqual({
      contract: MCP_CONTRACT_VERSION,
      workspaces: [routeOf("ws1"), routeOf("ws2")],
      unavailable: [{ workspace_id: "ws9", reason: "node is asleep" }],
    });
    expect(s.backendFor).not.toHaveBeenCalled();
  });

  it("runs a call in the workspace it names, and refuses one that names none", async () => {
    const one = backend({ listFolders: vi.fn(async () => ({ folders: ["one"] })) });
    const two = backend({ listFolders: vi.fn(async () => ({ folders: ["two"] })) });
    const { s, calls } = surface({ ws1: one, ws2: two });
    const { call } = await connect(s);
    expect(JSON.parse((await call("folders", { workspace_id: "ws2" })).text)).toEqual({ folders: ["two"] });
    expect(calls.at(-1)).toMatchObject({ tool: "folders", workspaceId: "ws2" });
    expect((await call("folders", { workspace_id: "  " })).text).toContain("needs a `workspace_id`");
    expect((await call("workspaces", { action: "instructions" })).text).toContain("needs a `workspace_id`");
    expect(await call("folders", { workspace_id: "ws9" })).toEqual({ text: "error: workspace is not available to this connector", isError: true });
    expect(one.listFolders).not.toHaveBeenCalled();
  });

  it("tells the surface how each call ended once the tool has answered", async () => {
    const { call, settled } = await single({
      listFolders: vi.fn(async () => ({ folders: [] })),
      openRowPage: vi.fn(async () => ({ error: "this key is read-only" })),
      databaseSchema: vi.fn(async () => SCHEMA),
    });
    await call("folders", W);
    expect(settled).toHaveBeenLastCalledWith(null);
    await call("databases_add", { ...W, action: "open_page", database_id: "db1", table: "tasks", row_id: "r1" });
    expect(settled).toHaveBeenLastCalledWith("this key is read-only");
    await call("docs", { ...W, action: "metadata" });
    expect(settled).toHaveBeenLastCalledWith("metadata requires `doc_id`");
    expect(settled).toHaveBeenCalledTimes(3);
  });

  it("hands every answer that carries instructions to the model with them", async () => {
    const instructions = [{ kind: "workspace" as const, id: "ws1", title: "Acme", text: "Write in British English." }];
    const cut = { instructions, instructions_cut: ['Folder "Contracts"'] };
    const { call } = await single({
      docMetadata: vi.fn(async () => ({ doc_id: "d1", review: { mode: "review" }, ...cut })),
      createDoc: vi.fn(async () => ({ doc_id: "d2", title: "Notes", owner: "user:human-1", instructions })),
      readMarkdown: vi.fn(async () => ({ markdown: "body", run_id: null, pending: 0, ...cut })),
      databaseSchema: vi.fn(async () => ({ ...SCHEMA, instructions })),
    });
    expect(JSON.parse((await call("docs", { ...W, action: "metadata", doc_id: "d1" })).text)).toEqual({ doc_id: "d1", review: { mode: "review" }, ...cut });
    expect(JSON.parse((await call("docs_create", { ...W, title: "Notes" })).text)).toEqual({ doc_id: "d2", title: "Notes", instructions });
    const read = (await call("markdown", { ...W, doc_id: "d1", action: "read" })).text;
    expect(read).toMatch(/^=== INSTRUCTIONS FOR THIS DOCUMENT/);
    expect(read).toContain('--- Workspace "Acme" ---\nWrite in British English.\nCut short or left out to fit: Folder "Contracts".');
    expect(read.endsWith("===\n\nbody")).toBe(true);
    expect(JSON.parse((await call("databases", { ...W, action: "schema", database_id: "db1" })).text)).toEqual({ ...SCHEMA, instructions });
  });

  it("sends each edit tool's action to the one propose call", async () => {
    const propose = vi.fn(async () => ({ mode: "noop" as const, message: "Nothing to change." }));
    const { call } = await single({ propose });
    await call("markdown_append", { ...W, doc_id: "d1", text: "note", heading: "Log" });
    expect(propose).toHaveBeenLastCalledWith("d1", { action: "append", text: "note", heading: "Log" });
    await call("markdown_edit", { ...W, doc_id: "d1", action: "str_replace", find: "a", replace: "b" });
    expect(propose).toHaveBeenLastCalledWith("d1", expect.objectContaining({ action: "str_replace", find: "a", replace: "b" }));
  });

  it("asks for the stack only where the answer hands it to the model", async () => {
    const databaseSchema = vi.fn(async () => SCHEMA);
    const { call } = await single({
      databaseSchema,
      mutateDatabase: vi.fn(async () => ({})),
      createDoc: vi.fn(async () => ({ doc_id: "db2", title: "Tracker", instructions: [] })),
    });
    await call("databases_add", { ...W, action: "insert_rows", database_id: "db1", table: "tasks", rows: [{ name: "a" }] });
    expect(databaseSchema).toHaveBeenLastCalledWith("db1", { instructions: false });
    await call("databases_add", { ...W, action: "create_database", title: "Tracker" });
    expect(databaseSchema).toHaveBeenLastCalledWith("db2", { instructions: false });
    await call("databases", { ...W, action: "schema", database_id: "db1" });
    expect(databaseSchema).toHaveBeenLastCalledWith("db1");
  });

  it("hands add_column's description to the backend, and sends none when the agent wrote none", async () => {
    const mutateDatabase = vi.fn(async () => ({}));
    const { call } = await single({ databaseSchema: vi.fn(async () => SCHEMA), mutateDatabase });
    await call("databases_add", { ...W, action: "add_column", database_id: "db1", table: "tasks", name: "Amount", type: "number", description: "USD, net of refunds" });
    expect(mutateDatabase).toHaveBeenLastCalledWith("db1", { action: "add_column", table_id: "t1", display: "Amount", type: "number", description: "USD, net of refunds" });
    await call("databases_add", { ...W, action: "add_column", database_id: "db1", table: "tasks", name: "Plain", type: "text" });
    expect(mutateDatabase).toHaveBeenLastCalledWith("db1", { action: "add_column", table_id: "t1", display: "Plain", type: "text" });
  });

  it("refuses incomplete arguments before reaching the backend", async () => {
    const { call } = await single();
    expect((await call("docs", { ...W, action: "metadata" })).text).toBe("error: metadata requires `doc_id`");
    expect((await call("markdown_edit", { ...W, doc_id: "d1", action: "write" })).text).toBe("error: write requires `text`");
    expect((await call("markdown_edit", { ...W, doc_id: "d1", action: "str_replace" })).isError).toBe(true);
    expect((await call("markdown_edit", { ...W, doc_id: "d1", action: "cited_edits" })).isError).toBe(true);
    expect((await call("media_upload", { ...W, doc_id: "d1", action: "upload_from_url" })).text).toContain("`url`");
    expect((await call("comments_add", { ...W, doc_id: "d1", body: "  " })).text).toBe("error: comments_add requires `body`");
    expect((await call("events", { ...W, types: ["doc.exploded"] })).text).toBe("error: unknown event type doc.exploded");
    expect((await call("databases", { ...W, action: "schema" })).text).toBe("error: schema requires `database_id`");
    expect((await call("databases", { ...W, action: "page", database_id: "db1", table: "tasks" })).text).toContain("page requires `row_id`");
    expect((await call("query", { ...W, database_id: "db1", sql: "DELETE FROM tasks" })).isError).toBe(true);
    expect((await call("collections_edit", { ...W, action: "create", name: " " })).text).toBe("error: create requires `name`");
    expect((await call("collections", { ...W, action: "open" })).text).toBe("error: open requires `collection_id`");
    expect((await call("collections_edit", { ...W, action: "rename", collection_id: "c1" })).text).toBe("error: rename requires `name`");
    expect((await call("collections_edit", { ...W, action: "remove_items", collection_id: "c1", doc_ids: [] })).text).toBe(
      "error: remove_items requires `doc_ids` or `folder_ids`",
    );
    expect((await call("search", { workspace_ids: ["ws1"], q: "   " })).text).toBe("error: search requires `q`");
  });

  it("routes each collections action to its backend call", async () => {
    const { call, b } = await single({
      listCollections: vi.fn(async () => [{ collection_id: "c1", name: "Research", item_count: 3, owner: "liv" }]),
      openCollection: vi.fn(async () => ({ collection: { collection_id: "c1", name: "Research" }, items: [{ doc_id: "d1", folder_id: null, title: "Doc" }] })),
      createCollection: vi.fn(async (name: string) => ({ collection_id: "c2", name })),
      renameCollection: vi.fn(async (id: string, name: string) => ({ collection_id: id, name })),
      deleteCollection: vi.fn(async () => ({ deleted: true })),
      changeCollectionItems: vi.fn(async (_id: string, change: "add" | "remove") => (change === "add" ? { added: 2, skipped: 0 } : { removed: 1 })),
    });
    expect(JSON.parse((await call("collections", { ...W, action: "list" })).text)).toEqual({ collections: [{ collection_id: "c1", name: "Research", item_count: 3 }] });
    expect(JSON.parse((await call("collections", { ...W, action: "open", collection_id: "c1" })).text)).toEqual({
      collection_id: "c1",
      name: "Research",
      items: [{ doc_id: "d1", title: "Doc" }],
    });
    expect(JSON.parse((await call("collections_edit", { ...W, action: "create", name: " Launch " })).text)).toEqual({ collection_id: "c2", name: "Launch" });
    expect(JSON.parse((await call("collections_edit", { ...W, action: "rename", collection_id: "c1", name: "Renamed" })).text)).toEqual({ collection_id: "c1", name: "Renamed" });
    expect(JSON.parse((await call("collections_edit", { ...W, action: "delete", collection_id: "c1" })).text)).toEqual({ deleted: true });
    expect(JSON.parse((await call("collections_edit", { ...W, action: "add_items", collection_id: "c1", doc_ids: ["d1"], folder_ids: ["f1"] })).text)).toEqual({
      added: 2,
      skipped: 0,
    });
    expect(b.changeCollectionItems).toHaveBeenCalledWith("c1", "add", { doc_ids: ["d1"], folder_ids: ["f1"] });
    await call("collections_edit", { ...W, action: "remove_items", collection_id: "c1", folder_ids: ["f1"] });
    expect(b.changeCollectionItems).toHaveBeenLastCalledWith("c1", "remove", { doc_ids: [], folder_ids: ["f1"] });
  });

  it("lists databases from the document listing", async () => {
    const { call } = await single({
      listDocs: vi.fn(async () => [
        { doc_id: "d1", title: "Notes", doc_type: "prose", parent_id: null, updated_at: "a" },
        { doc_id: "db1", title: "Tracker", doc_type: "database", parent_id: null, updated_at: "b" },
      ]),
    });
    expect(JSON.parse((await call("databases", { ...W, action: "list" })).text)).toEqual({ databases: [{ database_id: "db1", title: "Tracker", updated_at: "b" }] });
  });

  it("finds a row's page as a read, and opens or creates one as a write", async () => {
    const findRowPage = vi.fn(async () => ({ doc_id: null }));
    const openRowPage = vi.fn(async () => ({ doc_id: "p1", created: true, restored: false }));
    const { call } = await single({ databaseSchema: vi.fn(async () => SCHEMA), findRowPage, openRowPage });
    expect(JSON.parse((await call("databases", { ...W, action: "page", database_id: "db1", table: "Tasks", row_id: "r1" })).text)).toMatchObject({ doc_id: null });
    expect(findRowPage).toHaveBeenCalledWith("db1", "t1", "r1");
    expect(openRowPage).not.toHaveBeenCalled();
    expect(JSON.parse((await call("databases_add", { ...W, action: "open_page", database_id: "db1", table: "Tasks", row_id: "r1" })).text)).toMatchObject({
      doc_id: "p1",
      created: true,
    });
  });

  it("resolves the table and the view before proposing a view change", async () => {
    const mutateDatabase = vi.fn(async () => ({ mode: "proposed" as const, run: { id: "run_1" } as never, pending: 1 }));
    const { call } = await single({ databaseSchema: vi.fn(async () => SCHEMA), mutateDatabase });
    const res = await call("databases_change", { ...W, action: "update_view", database_id: "db1", table: "Tasks", view: "Open", group_by: null, kind: "table" });
    expect(res.isError).toBe(false);
    expect(mutateDatabase).toHaveBeenCalledWith("db1", { action: "update_view", table_id: "t1", view_id: "view_1", changes: { kind: "table", group_by: null } });
    const empty = await call("databases_change", { ...W, action: "update_view", database_id: "db1", table: "Tasks", view: "Open" });
    expect(empty.text).toContain("something to change");
  });

  it("takes `title` as the table name for create_table", async () => {
    const mutateDatabase = vi.fn(async () => ({ mode: "proposed" as const, run: { id: "run_1" } as never, pending: 1 }));
    const { call } = await single({ mutateDatabase });
    await call("databases_add", { ...W, action: "create_table", database_id: "db1", title: "Guests" });
    expect(mutateDatabase).toHaveBeenCalledWith("db1", { action: "create_table", display: "Guests" });
  });

  it("commits an upload by id without reading the schema, and asks for one import source", async () => {
    const importRows = vi.fn(async () => ({ status: 200, body: { mode: "applied", rows_ingested: 2, rows_skipped: 0 } }));
    const { call } = await single({ importRows });
    const res = await call("databases_add", { ...W, action: "import", database_id: "db1", import_id: "imp_1", on_error: "skip_bad_rows" });
    expect(res.text).toContain("Applied — imported 2 rows.");
    expect(importRows).toHaveBeenCalledWith("db1", null, { kind: "import_id", import_id: "imp_1" }, expect.objectContaining({ on_error: "skip_bad_rows" }));
    expect((await call("databases_add", { ...W, action: "import", database_id: "db1", table: "Tasks" })).text).toBe(
      "error: import requires `content` (the file's text) or `import_id` to commit an upload the node holds",
    );
    expect((await call("databases_add", { ...W, action: "import", database_id: "db1", content: "a", import_id: "imp_1" })).text).toBe(
      "error: import takes `content` or `import_id`, not both",
    );
  });

  it("hands a caller that can send a file an upload URL, and the next step", async () => {
    const startImport = vi.fn(async () => ({
      import_id: "imp_2",
      upload_url: "https://stuga.test/api/databases/db1/imports/imp_2/upload?sig=x",
      upload_path: "/api/databases/db1/imports/imp_2/upload?sig=x",
      max_bytes: 1000,
      expires_at: "2026-09-26T00:00:00.000Z",
      import_page_url: "https://stuga.test/doc/db1?table=t1&import",
    }));
    const { call } = await single({ databaseSchema: vi.fn(async () => SCHEMA), startImport });
    const out = JSON.parse((await call("databases_add", { ...W, action: "start_import", database_id: "db1", table: "Tasks", format: "jsonl" })).text);
    expect(startImport).toHaveBeenCalledWith("db1", "t1", "jsonl");
    expect(out).toMatchObject({ import_id: "imp_2", max_bytes: 1000 });
    expect(out.next).toContain('import_id: "imp_2"');
  });

  it("returns a hand-off as an error carrying the link", async () => {
    const importRows = vi.fn(async () => ({ hand_off: { page_url: "https://stuga.test/doc/db1?table=t1&import", why: "Too big." } }));
    const { call } = await single({ databaseSchema: vi.fn(async () => SCHEMA), importRows });
    const res = await call("databases_add", { ...W, action: "import", database_id: "db1", table: "tasks", content: "a,b" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("Too big.");
    expect(res.text).toContain("https://stuga.test/doc/db1?table=t1&import");
  });
});

describe("search and retrieval across workspaces", () => {
  const hit = (id: string) => ({ doc_id: id, title: id, snippet: "", page_of: null, page_row: null, score: 0.5, sem_score: 0.4 });
  const found = (...ids: string[]) => vi.fn(async () => ({ query: "q", results: ids.map(hit), degraded: false, semantic: true }));

  it("merges several workspaces in rank order, names each hit's workspace, and drops the scores", async () => {
    const { s, settled } = surface({ ws1: backend({ searchDocs: found("a1", "a2") }), ws2: backend({ searchDocs: found("b1") }, "https://other.test") });
    const { call } = await connect(s);
    const out = JSON.parse((await call("search", { workspace_ids: ["ws1", "ws2"], q: "q" })).text);
    expect(out.results.map((r: { workspace_id: string; doc_id: string }) => `${r.workspace_id}/${r.doc_id}`)).toEqual(["ws1/a1", "ws2/b1", "ws1/a2"]);
    expect(out.results[1]).toEqual({ workspace_id: "ws2", doc_id: "b1", title: "b1", snippet: "", page_of: null, page_row: null, url: "https://other.test/doc/b1" });
    expect(out).toMatchObject({ query: "q", degraded: false, semantic: true, unavailable: [] });
    expect(settled).toHaveBeenCalledTimes(2);
  });

  it("covers every workspace for [\"*\"], and reports the ones it could not reach", async () => {
    const { s } = surface({ ws1: backend({ searchDocs: found("a1") }) }, { unavailable: [{ workspace_id: "ws9", reason: "node is asleep" }] });
    const { call } = await connect(s);
    const out = JSON.parse((await call("search", { workspace_ids: ["*"], q: "q" })).text);
    expect(out.results.map((r: { doc_id: string }) => r.doc_id)).toEqual(["a1"]);
    expect(out.unavailable).toEqual([{ workspace_id: "ws9", reason: "node is asleep" }]);
  });

  it("covers at most fifty workspaces for [\"*\"] too, and names the rest as not searched", async () => {
    const many = Object.fromEntries(Array.from({ length: 53 }, (_, i) => [`ws${i}`, backend({ searchDocs: found(`d${i}`) })]));
    const { s } = surface(many);
    const { call } = await connect(s);
    const out = JSON.parse((await call("search", { workspace_ids: ["*"], q: "q", limit: 50 })).text);
    expect(out.results).toHaveLength(50);
    expect(out.unavailable.map((u: { workspace_id: string }) => u.workspace_id)).toEqual(["ws50", "ws51", "ws52"]);
    expect(out.unavailable[0].reason).toContain("at most 50 workspaces");
    expect(many.ws51!.searchDocs).not.toHaveBeenCalled();
  });

  it("answers with the refusal when the only workspace named is refused, and lists it among several", async () => {
    const { s } = surface({ ws1: backend({ searchDocs: found("a1") }) });
    const { call } = await connect(s);
    expect(await call("search", { workspace_ids: ["ws9"], q: "q" })).toEqual({ text: "error: workspace is not available to this connector", isError: true });
    const out = JSON.parse((await call("search", { workspace_ids: ["ws1", "ws9"], q: "q" })).text);
    expect(out.unavailable).toEqual([{ workspace_id: "ws9", reason: "workspace is not available to this connector" }]);
  });

  it("narrows one workspace to a collection, and refuses a collection across several", async () => {
    const searchDocs = vi.fn(async () => ({ query: "q", results: [], degraded: false, semantic: false, empty_scope: true }));
    const { s } = surface({ ws1: backend({ searchDocs }), ws2: backend() });
    const { call } = await connect(s);
    const out = JSON.parse((await call("search", { workspace_ids: ["ws1"], q: "q", collection_id: "c1" })).text);
    expect(searchDocs).toHaveBeenCalledWith({ q: "q", collection_id: "c1", limit: undefined });
    expect(out.note).toBe(EMPTY_SCOPE_NOTE);
    expect((await call("search", { workspace_ids: ["ws1", "ws2"], q: "q", collection_id: "c1" })).text).toContain("exactly that workspace");
  });

  it("merges passages with their workspace and link, and says retrieval is off instead of reporting no match", async () => {
    const chunk = (id: string) => ({ doc_id: id, title: id, content: `about ${id}`, heading_path: null });
    const { s } = surface({
      ws1: backend({ retrieve: vi.fn(async () => ({ chunks: [chunk("a1")] })) }),
      ws2: backend({ retrieve: vi.fn(async () => ({ chunks: [chunk("b1")], degraded: true })) }),
    });
    const { call } = await connect(s);
    const out = JSON.parse((await call("retrieve", { workspace_ids: ["ws1", "ws2"], q: "q" })).text);
    expect(out.passages).toEqual([
      { workspace_id: "ws1", doc_id: "a1", title: "a1", heading_path: null, content: "about a1", url: "https://stuga.test/doc/a1" },
      { workspace_id: "ws2", doc_id: "b1", title: "b1", heading_path: null, content: "about b1", url: "https://stuga.test/doc/b1" },
    ]);
    expect(out.degraded).toBe(true);

    const off = surface({ ws1: backend({ retrieve: vi.fn(async () => ({ chunks: [], ai_disabled: true })) }) });
    const offCall = (await connect(off.s)).call;
    expect(await offCall("retrieve", { workspace_ids: ["ws1"], q: "x" })).toEqual({ text: `error: ${RETRIEVE_AI_DISABLED_MESSAGE}`, isError: true });
    // Agent skills fall back to keyword search on this exact sentence.
    expect(RETRIEVE_AI_DISABLED_MESSAGE).toMatch(/^AI chat is disabled on this node\b/);
  });
});
