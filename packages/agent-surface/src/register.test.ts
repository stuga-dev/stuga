import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { DatabaseSchema } from "@stuga/protocol/databases/types";
import type { AgentBackend } from "./backend.js";
import { TOOL_NAMES, type Variant } from "./catalog.js";
import { registerAgentTools, type BackendFor } from "./register.js";
import { RETRIEVE_AI_DISABLED_MESSAGE } from "./render/search.js";

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

/** A backend whose every method fails the test unless the case replaces it. */
function backend(over: Partial<AgentBackend> = {}): AgentBackend {
  const unexpected = (name: string) => vi.fn(async () => {
    throw new Error(`unexpected backend call: ${name}`);
  });
  const methods = [
    "listWorkspaces",
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
    "importRows",
    "query",
  ] as const;
  const b = { origin: "https://stuga.test" } as Record<string, unknown>;
  for (const m of methods) b[m] = unexpected(m);
  return { ...(b as unknown as AgentBackend), ...over };
}

async function connect(b: AgentBackend | BackendFor, variant: Variant = "http") {
  const server = new McpServer({ name: "stuga", version: "0" });
  registerAgentTools(server, b, variant);
  const client = new Client({ name: "test", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as { content?: Array<{ text?: string }>; isError?: boolean };
    return { text: res.content?.[0]?.text ?? "", isError: res.isError === true };
  };
  return { client, call };
}

describe("registerAgentTools", () => {
  it.each(["http", "stdio"] as const)("registers the same tool set on %s", async (variant) => {
    const { client } = await connect(backend(), variant);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual([...TOOL_NAMES]);
  });

  it("answers a per-call refusal without running the tool", async () => {
    const b = backend();
    const settled = vi.fn();
    const { call } = await connect(async ({ tool, action }) =>
      tool === "docs" && action === "list" ? { error: "workspace is not available" } : { backend: b, settled },
    );
    expect(await call("docs", { action: "list" })).toEqual({ text: "error: workspace is not available", isError: true });
    expect(b.listDocs).not.toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
  });

  it("tells a per-call backend how the call ended once the tool has answered", async () => {
    const b = backend({
      listFolders: vi.fn(async () => ({ folders: [] })),
      openRowPage: vi.fn(async () => ({ error: "this key is read-only" })),
      databaseSchema: vi.fn(async () => SCHEMA),
    });
    const settled = vi.fn();
    const { call } = await connect(async () => ({ backend: b, settled }));

    await call("folders");
    expect(settled).toHaveBeenLastCalledWith(null);
    await call("databases", { action: "open_page", database_id: "db1", table: "tasks", row_id: "r1" });
    expect(settled).toHaveBeenLastCalledWith("this key is read-only");
    await call("docs", { action: "metadata" });
    expect(settled).toHaveBeenLastCalledWith("metadata requires `doc_id`");
    expect(settled).toHaveBeenCalledTimes(3);
  });

  it("hands every answer that carries instructions to the model with them", async () => {
    const instructions = [{ kind: "workspace" as const, id: "ws1", title: "Acme", text: "Write in British English." }];
    const cut = { instructions, instructions_cut: ['Folder "Contracts"'] };
    const { call } = await connect(
      backend({
        docMetadata: vi.fn(async () => ({ doc_id: "d1", review: { mode: "review" }, ...cut })),
        createDoc: vi.fn(async () => ({ doc_id: "d2", title: "Notes", owner: "user:human-1", instructions })),
        readMarkdown: vi.fn(async () => ({ markdown: "body", run_id: null, pending: 0, ...cut })),
        databaseSchema: vi.fn(async () => ({ ...SCHEMA, instructions })),
      }),
    );
    expect(JSON.parse((await call("docs", { action: "metadata", doc_id: "d1" })).text)).toEqual({ doc_id: "d1", review: { mode: "review" }, ...cut });
    expect(JSON.parse((await call("docs", { action: "create", title: "Notes" })).text)).toEqual({ doc_id: "d2", title: "Notes", instructions });
    const read = (await call("markdown", { doc_id: "d1", action: "read" })).text;
    expect(read).toMatch(/^=== INSTRUCTIONS FOR THIS DOCUMENT/);
    expect(read).toContain('--- Workspace "Acme" ---\nWrite in British English.\nCut short or left out to fit: Folder "Contracts".');
    expect(read.endsWith("===\n\nbody")).toBe(true);
    expect(JSON.parse((await call("databases", { action: "schema", database_id: "db1" })).text)).toEqual({ ...SCHEMA, instructions });
  });

  it("asks for the stack only where the answer hands it to the model", async () => {
    const databaseSchema = vi.fn(async () => SCHEMA);
    const { call } = await connect(
      backend({
        databaseSchema,
        mutateDatabase: vi.fn(async () => ({})),
        createDoc: vi.fn(async () => ({ doc_id: "db2", title: "Tracker", instructions: [] })),
      }),
    );
    await call("databases", { action: "insert_rows", database_id: "db1", table: "tasks", rows: [{ name: "a" }] });
    expect(databaseSchema).toHaveBeenLastCalledWith("db1", { instructions: false });
    await call("databases", { action: "create_database", title: "Tracker" });
    expect(databaseSchema).toHaveBeenLastCalledWith("db2", { instructions: false });
    await call("databases", { action: "schema", database_id: "db1" });
    expect(databaseSchema).toHaveBeenLastCalledWith("db1");
  });

  it("hands add_column's description to the backend, and sends none when the agent wrote none", async () => {
    const mutateDatabase = vi.fn(async () => ({}));
    const { call } = await connect(backend({ databaseSchema: vi.fn(async () => SCHEMA), mutateDatabase }));
    await call("databases", {
      action: "add_column",
      database_id: "db1",
      table: "tasks",
      name: "Amount",
      type: "number",
      description: "USD, net of refunds",
    });
    expect(mutateDatabase).toHaveBeenLastCalledWith("db1", {
      action: "add_column",
      table_id: "t1",
      display: "Amount",
      type: "number",
      description: "USD, net of refunds",
    });
    await call("databases", { action: "add_column", database_id: "db1", table: "tasks", name: "Plain", type: "text" });
    expect(mutateDatabase).toHaveBeenLastCalledWith("db1", { action: "add_column", table_id: "t1", display: "Plain", type: "text" });
  });

  it("refuses incomplete arguments before reaching the backend", async () => {
    const { call } = await connect(backend());
    expect((await call("docs", { action: "search", q: "   " })).text).toBe("error: search requires `q`");
    expect((await call("docs", { action: "metadata" })).text).toBe("error: metadata requires `doc_id`");
    expect((await call("markdown", { doc_id: "d1", action: "append" })).text).toBe("error: append requires `text`");
    expect((await call("markdown", { doc_id: "d1", action: "str_replace" })).isError).toBe(true);
    expect((await call("markdown", { doc_id: "d1", action: "cited_edits" })).isError).toBe(true);
    expect((await call("media", { doc_id: "d1", action: "upload_from_url" })).text).toContain("`url`");
    expect((await call("comments", { doc_id: "d1", action: "add", body: "  " })).text).toBe("error: add requires `body`");
    expect((await call("events", { types: ["doc.exploded"] })).text).toBe("error: unknown event type doc.exploded");
    expect((await call("databases", { action: "schema" })).text).toBe("error: schema requires `database_id`");
    expect((await call("query", { database_id: "db1", sql: "DELETE FROM tasks" })).isError).toBe(true);
    expect((await call("collections", { action: "create", name: " " })).text).toBe("error: create requires `name`");
    expect((await call("collections", { action: "open" })).text).toBe("error: open requires `collection_id`");
    expect((await call("collections", { action: "rename", collection_id: "c1" })).text).toBe("error: rename requires `name`");
    expect((await call("collections", { action: "remove_items", collection_id: "c1", doc_ids: [] })).text).toBe(
      "error: remove_items requires `doc_ids` or `folder_ids`",
    );
  });

  it("routes each collections action to its backend call", async () => {
    const b = backend({
      listCollections: vi.fn(async () => [{ collection_id: "c1", name: "Research", item_count: 3, owner: "liv" }]),
      openCollection: vi.fn(async () => ({
        collection: { collection_id: "c1", name: "Research" },
        items: [{ doc_id: "d1", folder_id: null, title: "Doc" }],
      })),
      createCollection: vi.fn(async (name: string) => ({ collection_id: "c2", name })),
      renameCollection: vi.fn(async (id: string, name: string) => ({ collection_id: id, name })),
      deleteCollection: vi.fn(async () => ({ deleted: true })),
      changeCollectionItems: vi.fn(async (_id: string, change: "add" | "remove") => (change === "add" ? { added: 2, skipped: 0 } : { removed: 1 })),
    });
    const { call } = await connect(b);
    expect(JSON.parse((await call("collections", { action: "list" })).text)).toEqual({ collections: [{ collection_id: "c1", name: "Research", item_count: 3 }] });
    expect(JSON.parse((await call("collections", { action: "open", collection_id: "c1" })).text)).toEqual({
      collection_id: "c1",
      name: "Research",
      items: [{ doc_id: "d1", title: "Doc" }],
    });
    expect(JSON.parse((await call("collections", { action: "create", name: " Launch " })).text)).toEqual({ collection_id: "c2", name: "Launch" });
    expect(JSON.parse((await call("collections", { action: "rename", collection_id: "c1", name: "Renamed" })).text)).toEqual({ collection_id: "c1", name: "Renamed" });
    expect(JSON.parse((await call("collections", { action: "delete", collection_id: "c1" })).text)).toEqual({ deleted: true });
    expect(JSON.parse((await call("collections", { action: "add_items", collection_id: "c1", doc_ids: ["d1"], folder_ids: ["f1"] })).text)).toEqual({
      added: 2,
      skipped: 0,
    });
    expect(b.changeCollectionItems).toHaveBeenCalledWith("c1", "add", { doc_ids: ["d1"], folder_ids: ["f1"] });
    await call("collections", { action: "remove_items", collection_id: "c1", folder_ids: ["f1"] });
    expect(b.changeCollectionItems).toHaveBeenLastCalledWith("c1", "remove", { doc_ids: [], folder_ids: ["f1"] });
  });

  it("says retrieval is off instead of reporting an empty result as no match", async () => {
    const { call } = await connect(backend({ retrieve: vi.fn(async () => ({ chunks: [], ai_disabled: true })) }));
    expect(await call("retrieve", { q: "x" })).toEqual({ text: `error: ${RETRIEVE_AI_DISABLED_MESSAGE}`, isError: true });
    // Agent skills fall back to keyword search on this exact sentence.
    expect(RETRIEVE_AI_DISABLED_MESSAGE).toMatch(/^AI chat is disabled on this node\b/);
  });

  it("lists databases from the document listing", async () => {
    const listDocs = vi.fn(async () => [
      { doc_id: "d1", title: "Notes", doc_type: "prose", parent_id: null, updated_at: "a" },
      { doc_id: "db1", title: "Tracker", doc_type: "database", parent_id: null, updated_at: "b" },
    ]);
    const { call } = await connect(backend({ listDocs }));
    expect(JSON.parse((await call("databases", { action: "list" })).text)).toEqual({ databases: [{ database_id: "db1", title: "Tracker", updated_at: "b" }] });
  });

  it("resolves the table and the view before proposing a view change", async () => {
    const mutateDatabase = vi.fn(async () => ({ mode: "proposed" as const, run: { id: "run_1" } as never, pending: 1 }));
    const { call } = await connect(backend({ databaseSchema: vi.fn(async () => SCHEMA), mutateDatabase }));
    const res = await call("databases", { action: "update_view", database_id: "db1", table: "Tasks", view: "Open", group_by: null, kind: "table" });
    expect(res.isError).toBe(false);
    expect(mutateDatabase).toHaveBeenCalledWith("db1", { action: "update_view", table_id: "t1", view_id: "view_1", changes: { kind: "table", group_by: null } });
    const empty = await call("databases", { action: "update_view", database_id: "db1", table: "Tasks", view: "Open" });
    expect(empty.text).toContain("something to change");
  });

  it("takes `title` as the table name for create_table", async () => {
    const mutateDatabase = vi.fn(async () => ({ mode: "proposed" as const, run: { id: "run_1" } as never, pending: 1 }));
    const { call } = await connect(backend({ mutateDatabase }));
    await call("databases", { action: "create_table", database_id: "db1", title: "Guests" });
    expect(mutateDatabase).toHaveBeenCalledWith("db1", { action: "create_table", display: "Guests" });
  });

  it("retries an import by id without reading the schema", async () => {
    const importRows = vi.fn(async () => ({ status: 200, body: { mode: "applied", rows_ingested: 2, rows_skipped: 0 } }));
    const { call } = await connect(backend({ importRows }));
    const res = await call("databases", { action: "import", database_id: "db1", import_id: "imp_1", on_error: "skip_bad_rows" });
    expect(res.text).toContain("Applied — imported 2 rows.");
    expect(importRows).toHaveBeenCalledWith("db1", null, { kind: "import_id", import_id: "imp_1" }, expect.objectContaining({ on_error: "skip_bad_rows" }));
  });

  it("asks each server for the import sources it has", async () => {
    const http = await connect(backend(), "http");
    expect((await http.call("databases", { action: "import", database_id: "db1", table: "Tasks" })).text).toBe(
      "error: import requires `content` (the file's text) or `import_id` to retry an upload the node holds",
    );
    expect((await http.call("databases", { action: "import", database_id: "db1", content: "a", import_id: "imp_1" })).text).toBe(
      "error: import takes `content` or `import_id`, not both",
    );
    const stdio = await connect(backend(), "stdio");
    expect((await stdio.call("databases", { action: "import", database_id: "db1", table: "Tasks" })).text).toContain("requires `file`");
  });

  it("returns a hand-off as an error carrying the link", async () => {
    const importRows = vi.fn(async () => ({ hand_off: { page_url: "https://stuga.test/doc/db1?table=t1&import", why: "Too big." } }));
    const { call } = await connect(backend({ databaseSchema: vi.fn(async () => SCHEMA), importRows }));
    const res = await call("databases", { action: "import", database_id: "db1", table: "tasks", content: "a,b" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("Too big.");
    expect(res.text).toContain("https://stuga.test/doc/db1?table=t1&import");
  });
});
