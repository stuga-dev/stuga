/**
 * The /mcp surface external clients are written against: tool and argument
 * names, which arguments are required, action enums, annotations, event types,
 * and the result wording and shapes they branch on. A change here breaks those
 * clients; make it deliberately, raise MCP_CONTRACT_VERSION if it does, and
 * update them too.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@stuga/db", async (orig) => ({
  ...(await orig<typeof import("@stuga/db")>()),
  getWorkspace: vi.fn(async () => null),
  getDoc: vi.fn(),
  listWorkspacesForUser: vi.fn(async () => [{ workspace_id: "ws1", name: "io", role: "member" }]),
  resolveDocInstructions: vi.fn(async () => []),
  searchDocs: vi.fn(async () => []),
}));
vi.mock("../agents/edits.js", async (orig) => ({
  ...(await orig<typeof import("../agents/edits.js")>()),
  proposeDocEdit: vi.fn(),
}));
vi.mock("../retrieval/retrieve.js", async (orig) => ({
  ...(await orig<typeof import("../retrieval/retrieve.js")>()),
  retrieveAndRerank: vi.fn(),
}));
vi.mock("../auth/context.js", async (orig) => ({
  ...(await orig<typeof import("../auth/context.js")>()),
  workspaceContextFor: vi.fn(),
}));

const { getDoc, searchDocs } = await import("@stuga/db");
const { proposeDocEdit } = await import("../agents/edits.js");
const { retrieveAndRerank } = await import("../retrieval/retrieve.js");
const { workspaceContextFor } = await import("../auth/context.js");
const { callerFor, resolvingTo, inWorkspace, callToolAs, mcpRequest } = await import("./testing/call.js");
import { renderImportCommit } from "@stuga/agent-surface/render/databases";
import type { Ctx, McpCaller } from "../auth/context.js";

const RUN = { id: "run_1", hunks: [], status: "open" };
const DB_RUN = { id: "run_2", ops: [], status: "open" };
let actorReply: unknown = {};
let embeddings = false;

function fixture(): Ctx {
  const actor = { fetch: vi.fn(async (url: string) => new Response(JSON.stringify(url.includes("/schema") ? SCHEMA : actorReply))) };
  return {
    sql: {},
    alias: "agent-1",
    displayName: "Connector",
    surface: "mcp",
    isAgent: true,
    onBehalfOf: "human-1",
    principals: ["agent:agent-1", "user:human-1"],
    workspaceId: "ws1",
    role: "member",
    env: {
      jobs: { send: vi.fn(async () => {}) },
      aiSettings: { current: () => ({ chat: { enabled: true }, embed: { enabled: embeddings } }) },
      publicOrigin: "https://stuga.test",
      nodeId: "ktbbpahhzxoldakw",
      databases: { get: () => actor },
      docs: { get: () => actor },
      settings: { current: () => ({ databaseOpsKeep: 500, nodeLabel: "Studio", maxBodyBytes: 1_000_000 }) },
    },
  } as unknown as Ctx;
}

const SCHEMA = { database_id: "db1", tables: [{ table_id: "t1", name: "tasks", display: "Tasks", position: 0, row_count: 0, columns: [], views: [] }] };

/** One call in ws1, the workspace the fixture resolves to. */
async function callTool(name: string, args: Record<string, unknown>, over: Partial<McpCaller> = {}) {
  const ctx = fixture();
  vi.mocked(workspaceContextFor).mockImplementation(resolvingTo(ctx));
  return callToolAs(callerFor(ctx, over), name, inWorkspace(ctx.workspaceId, name, args));
}

async function callText(name: string, args: Record<string, unknown>): Promise<string> {
  return (await callTool(name, args)).text;
}

interface ListedTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: { properties?: Record<string, { enum?: string[] }>; required?: string[] };
  annotations?: Record<string, unknown>;
}

async function listTools(over: Partial<McpCaller> = {}): Promise<ListedTool[]> {
  return ((await mcpRequest(callerFor(fixture(), over), "tools/list")).result as { tools: ListedTool[] }).tools;
}

const READ_TOOLS = ["workspaces", "docs", "search", "markdown", "comments", "folders", "events", "collections", "retrieve", "databases", "query"];

beforeEach(() => {
  vi.clearAllMocks();
  actorReply = {};
  embeddings = false;
  vi.mocked(getDoc).mockResolvedValue({
    doc_id: "db1",
    workspace_id: "ws1",
    doc_type: "database",
    trashed: false,
    locked: false,
    acl_principals: ["agent:agent-1"],
    acl_writers: ["agent:agent-1"],
  } as never);
});

describe("the /mcp contract", () => {
  it("lists the same tools, arguments and actions", async () => {
    const tools = await listTools();
    const surface = Object.fromEntries(
      tools.map((t) => [
        t.name,
        {
          arguments: Object.keys(t.inputSchema.properties ?? {}).sort(),
          actions: t.inputSchema.properties?.action?.enum ?? null,
        },
      ]),
    );
    expect(surface).toEqual({
      workspaces: { arguments: ["action", "workspace_id"], actions: ["list", "instructions"] },
      docs: { arguments: ["action", "doc_id", "parent_id", "workspace_id"], actions: ["list", "metadata"] },
      search: { arguments: ["collection_id", "limit", "q", "workspace_ids"], actions: null },
      markdown: { arguments: ["action", "doc_id", "workspace_id"], actions: ["read", "status", "provenance"] },
      comments: { arguments: ["doc_id", "workspace_id"], actions: null },
      folders: { arguments: ["workspace_id"], actions: null },
      events: { arguments: ["after", "limit", "types", "workspace_id"], actions: null },
      collections: { arguments: ["action", "collection_id", "workspace_id"], actions: ["list", "open"] },
      retrieve: { arguments: ["collection_id", "limit", "q", "workspace_ids"], actions: null },
      databases: { arguments: ["action", "database_id", "row_id", "table", "workspace_id"], actions: ["list", "schema", "status", "page"] },
      query: { arguments: ["database_id", "params", "sql", "workspace_id"], actions: null },
      docs_create: { arguments: ["parent_id", "title", "workspace_id"], actions: null },
      markdown_append: { arguments: ["doc_id", "heading", "text", "workspace_id"], actions: null },
      markdown_edit: {
        arguments: ["action", "citations", "doc_id", "edits", "find", "replace", "replace_all", "text", "workspace_id"],
        actions: ["write", "str_replace", "cited_edits"],
      },
      comments_add: { arguments: ["body", "doc_id", "workspace_id"], actions: null },
      media_upload: {
        arguments: ["action", "alt", "caption", "data", "doc_id", "url", "workspace_id"],
        actions: ["upload", "upload_from_url"],
      },
      collections_edit: {
        arguments: ["action", "collection_id", "doc_ids", "folder_ids", "name", "workspace_id"],
        actions: ["create", "rename", "delete", "add_items", "remove_items"],
      },
      databases_add: {
        arguments: [
          "action",
          "choices",
          "column_map",
          "columns",
          "content",
          "database_id",
          "date_order",
          "description",
          "dry_run",
          "filter",
          "format",
          "group_by",
          "hidden_columns",
          "import_id",
          "kind",
          "max_bad_rows",
          "name",
          "on_error",
          "row_id",
          "rows",
          "sorts",
          "table",
          "title",
          "type",
          "workspace_id",
        ],
        actions: ["create_database", "create_table", "add_column", "insert_rows", "import", "start_import", "create_view", "open_page"],
      },
      databases_change: {
        arguments: [
          "action",
          "database_id",
          "filter",
          "group_by",
          "hidden_columns",
          "kind",
          "name",
          "row_ids",
          "sorts",
          "table",
          "updates",
          "view",
          "workspace_id",
        ],
        actions: ["update_rows", "delete_rows", "update_view"],
      },
    });
  });

  it("requires a workspace on every tool but the routing table and the reads that span workspaces", async () => {
    const tools = await listTools();
    const required = Object.fromEntries(tools.map((t) => [t.name, [...(t.inputSchema.required ?? [])].sort()]));
    expect(required).toEqual({
      workspaces: ["action"],
      docs: ["action", "workspace_id"],
      search: ["q", "workspace_ids"],
      markdown: ["action", "doc_id", "workspace_id"],
      comments: ["doc_id", "workspace_id"],
      folders: ["workspace_id"],
      events: ["workspace_id"],
      collections: ["action", "workspace_id"],
      retrieve: ["q", "workspace_ids"],
      databases: ["action", "workspace_id"],
      query: ["database_id", "sql", "workspace_id"],
      docs_create: ["title", "workspace_id"],
      markdown_append: ["doc_id", "text", "workspace_id"],
      markdown_edit: ["action", "doc_id", "workspace_id"],
      comments_add: ["body", "doc_id", "workspace_id"],
      media_upload: ["action", "doc_id", "workspace_id"],
      collections_edit: ["action", "workspace_id"],
      databases_add: ["action", "workspace_id"],
      databases_change: ["action", "database_id", "table", "workspace_id"],
    });
  });

  it("marks every tool with the hints a client acts on, true of every call to it", async () => {
    const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
    const ADDS = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
    const CHANGES = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
    // An image URL in the text is downloaded by the node.
    const FETCHES = { openWorldHint: true };
    const tools = await listTools();
    const hints = Object.fromEntries(
      tools.map((t) => {
        const { readOnlyHint, destructiveHint, idempotentHint, openWorldHint } = t.annotations ?? {};
        return [t.name, { readOnlyHint, destructiveHint, idempotentHint, openWorldHint }];
      }),
    );
    expect(hints).toEqual({
      ...Object.fromEntries(READ_TOOLS.map((name) => [name, READ])),
      docs_create: ADDS,
      markdown_append: { ...ADDS, ...FETCHES },
      markdown_edit: { ...CHANGES, ...FETCHES },
      comments_add: ADDS,
      media_upload: { ...ADDS, ...FETCHES },
      collections_edit: CHANGES,
      databases_add: ADDS,
      databases_change: CHANGES,
    });
    for (const t of tools) expect(t.annotations?.title, t.name).toBe(t.title);
  });

  it("offers a read-only caller the reading tools only", async () => {
    const tools = await listTools({ readOnly: true });
    expect(tools.map((t) => t.name).sort()).toEqual([...READ_TOOLS].sort());
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
  });

  it("refuses a write tool a read-only caller calls anyway, before anything is proposed", async () => {
    const r = await callTool("markdown_append", { doc_id: "d1", text: "x" }, { readOnly: true });
    expect(r.isError).toBe(true);
    expect(proposeDocEdit).not.toHaveBeenCalled();
  });

  it("refuses a call that names no workspace before resolving one", async () => {
    const ctx = fixture();
    for (const [name, args] of [
      ["docs", { action: "list" }],
      ["markdown_append", { doc_id: "d1", text: "x" }],
    ] as const) {
      const r = await callToolAs(callerFor(ctx), name, args);
      expect(r.isError, name).toBe(true);
      expect(r.text, name).toContain("workspace_id");
    }
    expect(workspaceContextFor).not.toHaveBeenCalled();
    expect(proposeDocEdit).not.toHaveBeenCalled();
  });

  it("answers the routing table with the contract version and each workspace's node", async () => {
    const reply = JSON.parse(await callText("workspaces", { action: "list" }));
    expect(reply).toEqual({
      contract: 2,
      workspaces: [
        {
          workspace_id: "ws1",
          name: "io",
          role: "member",
          access: "propose",
          node: { id: "ktbbpahhzxoldakw", name: "Studio", origin: "https://stuga.test" },
        },
      ],
      unavailable: [],
    });
  });

  it("names the event types the feed emits", async () => {
    const events = (await listTools()).find((t) => t.name === "events")!.description;
    expect(/Types: (.+?)\. Pass/.exec(events)![1]!.split(", ")).toEqual([
      "doc.created",
      "doc.updated",
      "doc.trashed",
      "run.proposed",
      "run.applied",
      "run.decided",
      "run.reverted",
      "comment.added",
      "database.changed",
    ]);
  });

  it("starts a document write's result with Proposed or Applied", async () => {
    const writes = [
      ["markdown_append", { doc_id: "d1", text: "x" }],
      ["markdown_edit", { doc_id: "d1", action: "str_replace", find: "a", replace: "b" }],
    ] as const;
    for (const [name, args] of writes) {
      vi.mocked(proposeDocEdit).mockResolvedValueOnce({ kind: "proposed", run: RUN, pending: 1, review: "review", reason: "this document waits for review" } as never);
      expect(await callText(name, args), name).toMatch(/^Proposed — .*do NOT retry/);
      vi.mocked(proposeDocEdit).mockResolvedValueOnce({ kind: "auto_applied", run: RUN, seq: 7, review: "auto", reason: "this document applies agent changes at once" } as never);
      expect(await callText(name, args), name).toMatch(/^Applied \(server seq 7\) — /);
    }
  });

  it("starts a database write's result with Proposed or Applied", async () => {
    actorReply = { mode: "proposed", run: DB_RUN, pending: 1, minted: { row_ids: ["r1"] } };
    const proposed = JSON.parse(await callText("databases_add", { action: "insert_rows", database_id: "db1", table: "tasks", rows: [{ a: 1 }] }));
    expect(proposed.result).toMatch(/^Proposed — .*Do NOT retry/);
    actorReply = { mode: "applied", run: DB_RUN, minted: { row_ids: ["r1"] }, result: { inserted: 1 } };
    const applied = JSON.parse(await callText("databases_add", { action: "insert_rows", database_id: "db1", table: "tasks", rows: [{ a: 1 }] }));
    expect(applied.result).toMatch(/^Applied — /);
    actorReply = { mode: "proposed", run: DB_RUN, pending: 1 };
    const changed = JSON.parse(await callText("databases_change", { action: "delete_rows", database_id: "db1", table: "tasks", row_ids: ["r1"] }));
    expect(changed.result).toMatch(/^Proposed — .*Do NOT retry/);
  });

  it("starts an import's result with Proposed or Applied", () => {
    expect(JSON.parse(renderImportCommit(200, { mode: "proposed", rows_ingested: 2 }, "content").text).result).toMatch(/^Proposed — the import of 2 rows/);
    expect(JSON.parse(renderImportCommit(200, { mode: "applied", rows_ingested: 2 }, "content").text).result).toMatch(/^Applied — imported 2 rows/);
  });

  it("answers a search with documents that name their workspace and link, without per-workspace scores", async () => {
    vi.mocked(searchDocs).mockResolvedValueOnce([
      { doc_id: "d1", title: "Plan", page_of: null, page_row: null, snippet: "the plan", kw_rank: 3, sem_score: 0.4, score: 0.9 },
    ]);
    expect(JSON.parse(await callText("search", { q: "plan" }))).toEqual({
      query: "plan",
      results: [{ workspace_id: "ws1", doc_id: "d1", title: "Plan", page_of: null, page_row: null, snippet: "the plan", url: "https://stuga.test/doc/d1" }],
      degraded: false,
      semantic: false,
      unavailable: [],
    });
  });

  it("answers retrieval with citable passages that name their workspace and link", async () => {
    embeddings = true;
    vi.mocked(retrieveAndRerank).mockResolvedValueOnce({
      chunks: [{ doc_id: "d1", title: "Plan", chunk_index: 0, content: "Ship in May.", heading_path: "Plan > Dates", score: 0.8 }],
      degraded: false,
    } as never);
    expect(JSON.parse(await callText("retrieve", { q: "when do we ship?" }))).toEqual({
      passages: [
        { workspace_id: "ws1", doc_id: "d1", title: "Plan", heading_path: "Plan > Dates", content: "Ship in May.", url: "https://stuga.test/doc/d1" },
      ],
      degraded: false,
      unavailable: [],
    });
  });

  it("refuses retrieval with fixed wording when embeddings are off, for one workspace or all", async () => {
    const wording =
      "error: AI chat is disabled on this node for retrieval (embeddings are off) — use `search` for keyword search instead";
    expect(await callText("retrieve", { q: "anything" })).toBe(wording);
    expect(await callText("retrieve", { q: "anything", workspace_ids: ["*"] })).toBe(wording);
  });
});
