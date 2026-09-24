/**
 * The /mcp surface external clients are written against: tool and argument
 * names, action enums, event types, and the result wording they branch on.
 * A change here breaks those clients; make it deliberately and update them too.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@stuga/db", async (orig) => ({
  ...(await orig<typeof import("@stuga/db")>()),
  getWorkspace: vi.fn(async () => null),
  getDoc: vi.fn(),
  getMemberRole: vi.fn(async () => "member"),
  resolveDocInstructions: vi.fn(async () => []),
}));
vi.mock("../agents/edits.js", async (orig) => ({
  ...(await orig<typeof import("../agents/edits.js")>()),
  proposeDocEdit: vi.fn(),
}));

const { getDoc } = await import("@stuga/db");
const { proposeDocEdit } = await import("../agents/edits.js");
const { handleMcpRequest } = await import("./handler.js");
import { renderImportCommit } from "@stuga/agent-surface/render/databases";
import type { Ctx } from "../auth/context.js";

const RUN = { id: "run_1", hunks: [], status: "open" };
const DB_RUN = { id: "run_2", ops: [], status: "open" };
let actorReply: unknown = {};

function ctx(): Ctx {
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
      aiSettings: { current: () => ({ chat: { enabled: true }, embed: { enabled: false } }) },
      publicOrigin: "https://stuga.test",
      databases: { get: () => actor },
      docs: { get: () => actor },
      settings: { current: () => ({ databaseOpsKeep: 500, nodeLabel: "Studio" }) },
    },
  } as unknown as Ctx;
}

const SCHEMA = { database_id: "db1", tables: [{ table_id: "t1", name: "tasks", display: "Tasks", position: 0, row_count: 0, columns: [], views: [] }] };

async function rpc(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const req = new Request("https://stuga.test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await (await handleMcpRequest(ctx(), req)).text();
  const payload = text.startsWith("event:") || text.startsWith("data:") ? JSON.parse(/data: (.*)/.exec(text)![1]!) : JSON.parse(text);
  return payload.result as Record<string, unknown>;
}

async function callText(name: string, args: Record<string, unknown>): Promise<string> {
  const result = (await rpc("tools/call", { name, arguments: args })) as { content: Array<{ text: string }> };
  return result.content[0]!.text;
}

interface ListedTool {
  name: string;
  description: string;
  inputSchema: { properties?: Record<string, { enum?: string[] }> };
}

beforeEach(() => {
  vi.clearAllMocks();
  actorReply = {};
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
    const { tools } = (await rpc("tools/list", {})) as { tools: ListedTool[] };
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
      docs: {
        arguments: ["action", "collection_id", "doc_id", "limit", "parent_id", "q", "title", "workspace_id"],
        actions: ["list", "search", "metadata", "create"],
      },
      markdown: {
        arguments: ["action", "citations", "doc_id", "edits", "find", "heading", "replace", "replace_all", "text", "workspace_id"],
        actions: ["read", "write", "str_replace", "append", "cited_edits", "status", "provenance"],
      },
      media: {
        arguments: ["action", "alt", "caption", "data", "doc_id", "url", "workspace_id"],
        actions: ["upload", "upload_from_url"],
      },
      comments: { arguments: ["action", "body", "doc_id", "workspace_id"], actions: ["list", "add"] },
      folders: { arguments: ["workspace_id"], actions: null },
      events: { arguments: ["after", "limit", "types", "workspace_id"], actions: null },
      collections: {
        arguments: ["action", "collection_id", "doc_ids", "folder_ids", "name", "workspace_id"],
        actions: ["list", "open", "create", "rename", "delete", "add_items", "remove_items"],
      },
      retrieve: { arguments: ["collection_id", "limit", "q", "workspace_id"], actions: null },
      databases: {
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
          "row_ids",
          "rows",
          "sorts",
          "table",
          "title",
          "type",
          "updates",
          "view",
          "workspace_id",
        ],
        actions: [
          "list",
          "schema",
          "status",
          "create_database",
          "create_table",
          "add_column",
          "insert_rows",
          "update_rows",
          "delete_rows",
          "import",
          "create_view",
          "update_view",
          "open_page",
        ],
      },
      query: { arguments: ["database_id", "params", "sql", "workspace_id"], actions: null },
    });
  });

  it("names the event types the feed emits", async () => {
    const { tools } = (await rpc("tools/list", {})) as { tools: ListedTool[] };
    const events = tools.find((t) => t.name === "events")!.description;
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
    vi.mocked(proposeDocEdit).mockResolvedValueOnce({ kind: "proposed", run: RUN, pending: 1, review: "review", reason: "this document waits for review" } as never);
    expect(await callText("markdown", { doc_id: "d1", action: "append", text: "x" })).toMatch(/^Proposed — .*do NOT retry/);
    vi.mocked(proposeDocEdit).mockResolvedValueOnce({ kind: "auto_applied", run: RUN, seq: 7, review: "auto", reason: "this document applies agent changes at once" } as never);
    expect(await callText("markdown", { doc_id: "d1", action: "append", text: "x" })).toMatch(/^Applied \(server seq 7\) — /);
  });

  it("starts a database write's result with Proposed or Applied", async () => {
    actorReply = { mode: "proposed", run: DB_RUN, pending: 1, minted: { row_ids: ["r1"] } };
    const proposed = JSON.parse(await callText("databases", { action: "insert_rows", database_id: "db1", table: "tasks", rows: [{ a: 1 }] }));
    expect(proposed.result).toMatch(/^Proposed — .*Do NOT retry/);
    actorReply = { mode: "applied", run: DB_RUN, minted: { row_ids: ["r1"] }, result: { inserted: 1 } };
    const applied = JSON.parse(await callText("databases", { action: "insert_rows", database_id: "db1", table: "tasks", rows: [{ a: 1 }] }));
    expect(applied.result).toMatch(/^Applied — /);
  });

  it("starts an import's result with Proposed or Applied", () => {
    expect(JSON.parse(renderImportCommit(200, { mode: "proposed", rows_ingested: 2 }, "content").text).result).toMatch(/^Proposed — the import of 2 rows/);
    expect(JSON.parse(renderImportCommit(200, { mode: "applied", rows_ingested: 2 }, "content").text).result).toMatch(/^Applied — imported 2 rows/);
  });

  it("refuses retrieval with fixed wording when embeddings are off", async () => {
    expect(await callText("retrieve", { q: "anything" })).toBe(
      "error: AI chat is disabled on this node for retrieval (embeddings are off) — use `docs` action:search for keyword search instead",
    );
  });
});
