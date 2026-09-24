/**
 * The /mcp `databases` and `query` tools over the in-process backend: write
 * gates, table resolution against the caller's projected schema, the run
 * ledger's Proposed/Applied wording, and the SELECT-only guard.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@stuga/db", async (orig) => ({
  ...(await orig<typeof import("@stuga/db")>()),
  getDoc: vi.fn(),
  listDocs: vi.fn(),
  createDoc: vi.fn(),
  deleteDoc: vi.fn(async () => {}),
  touchDoc: vi.fn(async () => {}),
  getMemberRole: vi.fn(async () => "member"),
  getFolderAncestors: vi.fn(async () => []),
  getWorkspace: vi.fn(async () => null),
  resolveDocInstructions: vi.fn(async () => []),
}));

const { getDoc, listDocs, createDoc, resolveDocInstructions } = await import("@stuga/db");
const { handleMcpRequest } = await import("./handler.js");
import type { Ctx } from "../auth/context.js";

const mockGetDoc = getDoc as unknown as ReturnType<typeof vi.fn>;
const mockListDocs = listDocs as unknown as ReturnType<typeof vi.fn>;
const mockCreateDoc = createDoc as unknown as ReturnType<typeof vi.fn>;
const mockResolveInstructions = vi.mocked(resolveDocInstructions);
const jobsSend = vi.fn(async (_message: Record<string, unknown>) => {});

const DB_DOC = {
  doc_id: "db1",
  workspace_id: "ws1",
  owner: "user:human-1",
  title: "Projects",
  doc_type: "database",
  trashed: false,
  locked: false,
  acl_principals: ["user:human-1", "agent:agent-conn-abc"],
  acl_writers: ["user:human-1", "agent:agent-conn-abc"],
  own_grants: { p: [], w: [], c: [] },
};

const SCHEMA = {
  database_id: "db1",
  tables: [
    {
      table_id: "tbl_1",
      name: "projects",
      display: "Projects",
      position: 0,
      row_count: 2,
      columns: [
        { column_id: "col_1", name: "name", display: "Name", type: "text", position: 0, options: null },
      ],
      views: [
        { view_id: "view_1", table_id: "tbl_1", kind: "table", name: "Open", position: 0, filter: null, sorts: [], group_by: null, hidden_columns: [], config: {} },
      ],
    },
  ],
};

/** A run summary as the actor's propose endpoint answers with. */
const RUN = {
  id: "run_abc123def456",
  database_id: "db1",
  source: "connector",
  agent: "Connector",
  agent_alias: "agent-conn-abc",
  reviewer: "human-1",
  status: "open",
  ops: [{ id: "o1", kind: "rows.insert", table_id: "tbl_1", summary: 'Insert 2 rows into "Projects"', status: "pending" }],
  acknowledged: false,
  auto_applied: false,
  created_at: 1,
  updated_at: 1,
};

/** Route-aware database-actor fake: canned response per control path. */
const actorCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
/** Path-scoped, so a forced refusal leaves table resolution's /schema read alone. */
let actorOverride: { path: string; status: number; body: unknown } | null = null;
const actorFetch = vi.fn(async (url: string, init?: RequestInit) => {
  actorCalls.push({ url, body: init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {} });
  const path = new URL(url).pathname;
  if (actorOverride && path === actorOverride.path) {
    return new Response(JSON.stringify(actorOverride.body), { status: actorOverride.status });
  }
  const canned: Record<string, unknown> = {
    "/schema": SCHEMA,
    "/schema/init": { initialized: true, schema: SCHEMA },
    "/runs/propose": { mode: "proposed", run: RUN, pending: 1, minted: { row_ids: ["row_a", "row_b"] } },
    "/runs": { runs: [RUN] },
    "/query": { columns: ["n"], rows: [{ n: 1 }], truncated: false },
    "/rows/list": { rows: [{ _id: "row_a", col_1: "Alpha", _doc_id: null }], total: 1 },
    "/rows/link-doc": { linked: true, doc_id: "db-new", replaced: null },
    "/doc-links/take": { trash: [], restore: [] },
  };
  return new Response(JSON.stringify(canned[path] ?? {}), { status: 200 });
});

function connectorCtx(overrides: Partial<Ctx> = {}): Ctx {
  return {
    sql: {},
    alias: "agent-conn-abc",
    displayName: "Connector",
    isAgent: true,
    onBehalfOf: "human-1",
    principals: ["agent:agent-conn-abc"],
    workspaceId: "ws1",
    role: "member",
    env: {
      databases: { get: () => ({ fetch: actorFetch }) },
      docs: { get: () => ({ fetch: actorFetch }) },
      settings: { current: () => ({ databaseOpsKeep: 500, maxBodyBytes: 1024 * 1024, nodeLabel: "Studio" }) },
      jobs: { send: jobsSend },
      aiSettings: { current: () => ({ enabled: false }) },
      publicOrigin: "https://stuga.test",
    },
    ...overrides,
  } as unknown as Ctx;
}

/** Drive one JSON-RPC tools/call through the stateless transport. */
async function callTool(ctx: Ctx, name: string, args: Record<string, unknown> = {}) {
  const req = new Request("https://api.test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const res = await handleMcpRequest(ctx, req);
  const text = await res.text();
  const payload = text.startsWith("event:") || text.startsWith("data:")
    ? JSON.parse(/data: (.*)/.exec(text)![1]!)
    : JSON.parse(text);
  const result = payload.result ?? {};
  return { isError: result.isError === true, text: String(result.content?.[0]?.text ?? "") };
}

beforeEach(() => {
  vi.clearAllMocks();
  actorCalls.length = 0;
  actorOverride = null;
  mockGetDoc.mockResolvedValue({ ...DB_DOC });
  mockListDocs.mockResolvedValue([
    { doc_id: "d1", title: "Notes", doc_type: "prose", updated_at: "2026-08-01" },
    { ...DB_DOC, updated_at: "2026-08-02" },
  ]);
  mockCreateDoc.mockResolvedValue({ ...DB_DOC, doc_id: "db-new" });
});

describe("discovery", () => {
  it("docs list carries doc_type so agents pick the right pipeline", async () => {
    const r = await callTool(connectorCtx(), "docs", { action: "list" });
    const body = JSON.parse(r.text) as { docs: Array<{ doc_id: string; doc_type: string }> };
    expect(body.docs.find((d) => d.doc_id === "db1")!.doc_type).toBe("database");
    expect(body.docs.find((d) => d.doc_id === "d1")!.doc_type).toBe("prose");
  });

  it("databases action:list returns only databases", async () => {
    const r = await callTool(connectorCtx(), "databases", { action: "list" });
    const body = JSON.parse(r.text) as { databases: Array<{ database_id: string }> };
    expect(body.databases).toHaveLength(1);
    expect(body.databases[0]!.database_id).toBe("db1");
  });
});

describe("instructions for agents", () => {
  const LEVELS = [
    { kind: "workspace" as const, id: "ws1", title: "io", text: "Dates are ISO." },
    { kind: "database" as const, id: "db1", title: "Projects", text: "Never delete a project row." },
  ];

  it("schema carries the database's stack beside the caller's projection", async () => {
    mockResolveInstructions.mockResolvedValue(LEVELS);
    const ctx = connectorCtx();
    const r = await callTool(ctx, "databases", { action: "schema", database_id: "db1" });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.text)).toEqual({ ...SCHEMA, instructions: LEVELS });
    expect(mockResolveInstructions).toHaveBeenCalledWith(ctx.sql, expect.objectContaining({ doc_id: "db1" }), ctx.principals);
  });

  it("names the levels cut to fit", async () => {
    const long = "x".repeat(20_000);
    const deep = ["a", "b", "c", "d"].map((id) => ({ kind: "folder" as const, id, title: `F${id}`, text: long }));
    mockResolveInstructions.mockResolvedValue(deep);
    const body = JSON.parse((await callTool(connectorCtx(), "databases", { action: "schema", database_id: "db1" })).text);
    expect(body.instructions).toHaveLength(3);
    expect(body.instructions_cut).toEqual(['Folder "Fd"']);
  });

  it("a write names the levels below the workspace, so an insert made without a schema read learns of them", async () => {
    mockResolveInstructions.mockResolvedValue(LEVELS);
    const r = await callTool(connectorCtx(), "databases", {
      action: "insert_rows",
      database_id: "db1",
      table: "projects",
      rows: [{ name: "Alpha" }],
    });
    expect(r.isError).toBe(false);
    const body = JSON.parse(r.text);
    expect(body.result).toContain('apply here beyond the workspace\'s: Database "Projects".');
    expect(body.result).toContain("`databases` action:schema");
    expect(body.result).not.toContain('Workspace "io"');
    expect(body).not.toHaveProperty("instructions_labels");
  });

  it("an actor refusal stays a refusal", async () => {
    mockResolveInstructions.mockResolvedValue(LEVELS);
    actorOverride = { path: "/schema", status: 500, body: { message: "actor down" } };
    expect(await callTool(connectorCtx(), "databases", { action: "schema", database_id: "db1" })).toEqual({ isError: true, text: "error: actor down" });
  });

  it("create_database reports the stack the new database was placed under, resolving it once", async () => {
    mockResolveInstructions.mockResolvedValue(LEVELS.slice(0, 1));
    const r = await callTool(connectorCtx(), "databases", { action: "create_database", title: "Tracker" });
    expect(JSON.parse(r.text)).toMatchObject({ database_id: "db-new", table_id: "tbl_1", instructions: LEVELS.slice(0, 1) });
    // The read-back after the create needs only the tables.
    expect(mockResolveInstructions).toHaveBeenCalledTimes(1);
  });

  describe("when the stack cannot be read", () => {
    beforeEach(() => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      mockResolveInstructions.mockRejectedValue(new Error("statement timeout"));
    });
    afterEach(() => {
      vi.mocked(console.warn).mockRestore();
      mockResolveInstructions.mockReset();
    });

    it("create_database still reports the database it created, so the agent does not make another", async () => {
      const r = await callTool(connectorCtx(), "databases", { action: "create_database", title: "Tracker" });
      expect(r.isError).toBe(false);
      const body = JSON.parse(r.text);
      expect(body).toMatchObject({ database_id: "db-new", table_id: "tbl_1" });
      expect(body).not.toHaveProperty("instructions");
      expect(mockCreateDoc).toHaveBeenCalledTimes(1);
    });

    it("a write still lands, and its answer simply names nothing", async () => {
      const r = await callTool(connectorCtx(), "databases", {
        action: "insert_rows",
        database_id: "db1",
        table: "projects",
        rows: [{ name: "Alpha" }],
      });
      expect(r.isError).toBe(false);
      expect(r.text).toContain("Proposed — your change is waiting");
      expect(r.text).not.toContain("Standing instructions");
    });

    it("schema, which hands the stack over, still fails loudly", async () => {
      expect((await callTool(connectorCtx(), "databases", { action: "schema", database_id: "db1" })).isError).toBe(true);
    });
  });
});

describe("create_database", () => {
  it("refuses a guest-minted key before any row is created", async () => {
    const r = await callTool(connectorCtx({ role: "guest" }), "databases", { action: "create_database", title: "X" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/guests cannot create/);
    expect(mockCreateDoc).not.toHaveBeenCalled();
  });

  it("creates + eagerly initializes the actor with a starter table", async () => {
    const r = await callTool(connectorCtx(), "databases", { action: "create_database", title: "Tracker" });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.text).database_id).toBe("db-new");
    expect(actorCalls.some((c) => c.url.includes("/schema/init"))).toBe(true);
  });
});

describe("mutations", () => {
  it("resolves a table by display name and proposes with the agent actor + reviewer", async () => {
    const r = await callTool(connectorCtx(), "databases", {
      action: "insert_rows",
      database_id: "db1",
      table: "Projects",
      rows: [{ Name: "Alpha" }, { Name: "Beta" }],
    });
    expect(r.isError).toBe(false);
    const proposed = actorCalls.find((c) => c.url.includes("/runs/propose"))!;
    expect((proposed.body.op as { table: string }).table).toBe("tbl_1");
    expect(proposed.body.actor).toEqual({ alias: "agent-conn-abc", is_agent: true, on_behalf_of: "human-1" });
    expect(proposed.body.reviewer).toBe("human-1");
    expect(proposed.body.source).toBe("connector");
    const schemaRead = actorCalls.find((c) => c.url.includes("/schema"))!;
    expect(schemaRead.url).toContain("agent=agent-conn-abc");
  });

  it("says Proposed on a review database — with minted ids, and NO notification", async () => {
    const r = await callTool(connectorCtx(), "databases", {
      action: "insert_rows",
      database_id: "db1",
      table: "projects",
      rows: [{ name: "x" }, { name: "y" }],
    });
    expect(r.isError).toBe(false);
    const body = JSON.parse(r.text) as { result: string; row_ids: string[] };
    expect(body.result).toMatch(/Proposed —/);
    expect(body.result).toMatch(/Do NOT retry/);
    expect(body.row_ids).toEqual(["row_a", "row_b"]);
    expect(jobsSend).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "notify" }));
  });

  it("says Applied on an auto database, and notifies the human", async () => {
    actorOverride = {
      path: "/runs/propose",
      status: 200,
      body: {
        mode: "applied",
        run: { ...RUN, auto_applied: true, ops: [{ ...RUN.ops[0], status: "auto_applied" }] },
        result: { inserted: 1, row_ids: ["row_a"] },
        minted: { row_ids: ["row_a"] },
      },
    };
    const r = await callTool(connectorCtx(), "databases", {
      action: "insert_rows",
      database_id: "db1",
      table: "projects",
      rows: [{ name: "x" }],
    });
    const body = JSON.parse(r.text) as { result: string };
    expect(body.result).toMatch(/Applied —/);
    expect(body.result).not.toMatch(/Proposed/);
    expect(jobsSend).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "notify", eventType: "DATABASE_AGENT_EDIT", recipient: "human-1" }),
    );
  });

  it("answers an unknown table name with the real table list", async () => {
    const r = await callTool(connectorCtx(), "databases", {
      action: "insert_rows",
      database_id: "db1",
      table: "tasks",
      rows: [{ name: "x" }],
    });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/no table "tasks"/);
    expect(r.text).toMatch(/projects \(tbl_1\)/);
  });

  it("refuses a read-only connector's write in the handler", async () => {
    mockGetDoc.mockResolvedValue({ ...DB_DOC, acl_writers: ["user:human-1"] });
    const r = await callTool(connectorCtx(), "databases", {
      action: "insert_rows",
      database_id: "db1",
      table: "projects",
      rows: [{ name: "x" }],
    });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/no write access/);
    expect(actorCalls.filter((c) => c.url.includes("/rows/"))).toEqual([]);
  });

  it("refuses writes to a locked database", async () => {
    mockGetDoc.mockResolvedValue({ ...DB_DOC, locked: true });
    const r = await callTool(connectorCtx(), "databases", {
      action: "insert_rows",
      database_id: "db1",
      table: "projects",
      rows: [{ name: "x" }],
    });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/locked/);
  });

  it("passes an actor refusal's message through (caps, validation)", async () => {
    actorOverride = { path: "/runs/propose", status: 409, body: { error: "row_cap", message: "this table is at its 50,000-row cap" } };
    const r = await callTool(connectorCtx(), "databases", {
      action: "insert_rows",
      database_id: "db1",
      table: "tbl_1",
      rows: [{ name: "x" }],
    });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/50,000-row cap/);
  });

  it("add_column carries the column's description into the proposed op", async () => {
    const r = await callTool(connectorCtx(), "databases", {
      action: "add_column",
      database_id: "db1",
      table: "Projects",
      name: "Amount",
      type: "number",
      description: "USD, net of refunds",
    });
    expect(r.isError).toBe(false);
    const proposed = actorCalls.find((c) => c.url.includes("/runs/propose"))!;
    expect(proposed.body.op).toMatchObject({
      kind: "columns.add",
      table: "tbl_1",
      display: "Amount",
      type: "number",
      description: "USD, net of refunds",
    });
    // An agent that says nothing about the column sends no description at all.
    actorCalls.length = 0;
    await callTool(connectorCtx(), "databases", { action: "add_column", database_id: "db1", table: "Projects", name: "Plain", type: "text" });
    const plain = actorCalls.find((c) => c.url.includes("/runs/propose"))!.body.op as Record<string, unknown>;
    expect(plain.description).toBeUndefined();
  });

  it("action:status tallies the caller's own runs", async () => {
    const r = await callTool(connectorCtx(), "databases", { action: "status", database_id: "db1" });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/run_abc123def456: open — pending 1/);
  });
});

describe("views", () => {
  it("create_view proposes a views.create op with the filter tree as sent", async () => {
    const r = await callTool(connectorCtx(), "databases", {
      action: "create_view",
      database_id: "db1",
      table: "Projects",
      name: "Open",
      filter: { and: [{ column_id: "Name", op: "not_empty" }, { column_id: "name", op: "contains", value: "a" }] },
      sorts: [{ column_id: "Name", dir: "desc" }],
      hidden_columns: ["Name"],
    });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("Proposed");
    const proposed = actorCalls.find((c) => c.url.includes("/runs/propose"))!;
    expect(proposed.body.op).toEqual({
      kind: "views.create",
      table: "tbl_1",
      name: "Open",
      filter: { and: [{ column_id: "Name", op: "not_empty" }, { column_id: "name", op: "contains", value: "a" }] },
      sorts: [{ column_id: "Name", dir: "desc" }],
      hidden_columns: ["Name"],
    });
  });

  it("update_view resolves the view by name and sends only what changes; nothing to change is refused", async () => {
    const r = await callTool(connectorCtx(), "databases", { action: "update_view", database_id: "db1", table: "Projects", view: "Open", group_by: null });
    expect(r.isError).toBe(false);
    const proposed = actorCalls.find((c) => c.url.includes("/runs/propose"))!;
    expect(proposed.body.op).toEqual({ kind: "views.update", table: "tbl_1", view: "view_1", group_by: null });
    const empty = await callTool(connectorCtx(), "databases", { action: "update_view", database_id: "db1", table: "Projects", view: "Open" });
    expect(empty.isError).toBe(true);
    expect(empty.text).toContain("something to change");
  });
});

describe("row pages", () => {
  it("open_page makes the row's page through the documents path and hands back its doc_id for the markdown tool", async () => {
    const r = await callTool(connectorCtx(), "databases", { action: "open_page", database_id: "db1", table: "Projects", row_id: "row_a" });
    expect(r.isError).toBe(false);
    const body = JSON.parse(r.text) as { result: string; doc_id: string; created: boolean };
    expect(body).toMatchObject({ doc_id: "db-new", created: true });
    expect(body.result).toContain("`markdown`");
    const created = mockCreateDoc.mock.calls[0]![1] as Record<string, unknown>;
    expect(created).toMatchObject({ docType: "prose", title: "Alpha", owner: "user:human-1", createdBy: "agent:agent-conn-abc" });
    const link = actorCalls.find((c) => c.url.includes("/rows/link-doc"))!;
    expect(link.body).toMatchObject({
      table_id: "tbl_1",
      row_id: "row_a",
      doc_id: "db-new",
      actor: { alias: "agent-conn-abc", is_agent: true, on_behalf_of: "human-1" },
    });
    expect(jobsSend).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "index_doc" }));
  });

  it("open_page needs a row_id, and a connector that cannot write is refused before anything is made", async () => {
    const missing = await callTool(connectorCtx(), "databases", { action: "open_page", database_id: "db1", table: "Projects" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("row_id");
    mockGetDoc.mockResolvedValue({ ...DB_DOC, acl_writers: ["user:human-1"] });
    const viewOnly = await callTool(connectorCtx(), "databases", { action: "open_page", database_id: "db1", table: "Projects", row_id: "row_a" });
    expect(viewOnly).toEqual({ isError: true, text: "error: view-only access" });
    expect(mockCreateDoc).not.toHaveBeenCalled();
    expect(actorCalls.some((c) => c.url.includes("/rows/link-doc"))).toBe(false);
  });
});

describe("query", () => {
  it("rejects non-SELECT SQL with the guard's wording, before the actor", async () => {
    const r = await callTool(connectorCtx(), "query", { database_id: "db1", sql: "DELETE FROM projects" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/only SELECT|disallowed keyword/);
    expect(actorCalls).toEqual([]);
  });

  it("blocks WITH ... INSERT smuggling", async () => {
    const r = await callTool(connectorCtx(), "query", {
      database_id: "db1",
      sql: "WITH x AS (SELECT 1) INSERT INTO projects (name) SELECT 'x' FROM x",
    });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/INSERT/);
    expect(actorCalls).toEqual([]);
  });

  it("forwards a clean SELECT and normalizes boolean params to 0/1", async () => {
    const r = await callTool(connectorCtx(), "query", {
      database_id: "db1",
      sql: "SELECT * FROM projects WHERE done = ?",
      params: [true],
    });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.text).rows).toEqual([{ n: 1 }]);
    expect(actorCalls[0]!.body.params).toEqual([1]);
  });

  it("hides a database the connector cannot read", async () => {
    mockGetDoc.mockResolvedValue({ ...DB_DOC, acl_principals: ["user:human-1"] });
    const r = await callTool(connectorCtx(), "query", { database_id: "db1", sql: "SELECT 1" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/not found or no access/);
  });
});

describe("bulk data and declarative schema", () => {
  /** An in-memory snapshots store, enough for the import keys. */
  function memoryBlobs() {
    const store = new Map<string, Uint8Array>();
    const head = (key: string) => ({ key, size: store.get(key)!.byteLength, uploaded: new Date() });
    return {
      store,
      async get(key: string) {
        const v = store.get(key);
        return v ? { ...head(key), body: null, arrayBuffer: async () => v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength), text: async () => new TextDecoder().decode(v) } : null;
      },
      async head(key: string) {
        return store.has(key) ? head(key) : null;
      },
      async put(key: string, value: string | Uint8Array | ArrayBuffer) {
        store.set(key, typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value as ArrayBuffer));
      },
      async delete(key: string | string[]) {
        for (const k of Array.isArray(key) ? key : [key]) store.delete(k);
      },
      async list(opts?: { prefix?: string }) {
        return { objects: [...store.keys()].filter((k) => !opts?.prefix || k.startsWith(opts.prefix)).map(head), truncated: false };
      },
    };
  }

  const importCtx = (blobs = memoryBlobs()) =>
    connectorCtx({
      env: {
        databases: { get: () => ({ fetch: actorFetch }) },
        docs: { get: () => ({ fetch: actorFetch }) },
        settings: { current: () => ({ databaseOpsKeep: 500, maxBodyBytes: 1024 * 1024, nodeLabel: "Studio" }) },
        jobs: { send: vi.fn(async () => {}) },
        aiSettings: { current: () => ({ enabled: false }) },
        publicOrigin: "https://stuga.test",
        snapshots: blobs,
        internalSecret: "top-secret",
      } as never,
    });

  it("import with `content` stages, validates and proposes ONE flagged insert", async () => {
    const ctx = importCtx();
    const r = await callTool(ctx, "databases", { action: "import", database_id: "db1", table: "Projects", content: "Name\nAlpha\nBeta\n" });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("Proposed — the import of 2 rows is ONE change");
    expect(r.text).toContain("do NOT retry");
    const propose = actorCalls.find((c) => c.url.includes("/runs/propose"))!;
    expect(propose.body.source).toBe("connector");
    expect(propose.body.op).toEqual({ kind: "rows.insert", table: "tbl_1", rows: [{ col_1: "Alpha" }, { col_1: "Beta" }], import: true });
  });

  it("hands back the row-level report and retries by import_id without re-sending the data", async () => {
    const ctx = importCtx();
    const r = await callTool(ctx, "databases", { action: "import", database_id: "db1", table: "Projects", content: "Nmae\nAlpha\n" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("headers do not match");
    expect(r.text).toContain("call import again with import_id");
    expect(r.text).toContain('"hint":"did you mean \\"Name\\"?"');
    expect(actorCalls.some((c) => c.url.includes("/runs/propose"))).toBe(false);
    const importId = (JSON.parse(r.text.slice(r.text.indexOf("{"))) as { import_id: string }).import_id;
    const fixed = await callTool(ctx, "databases", {
      action: "import",
      database_id: "db1",
      import_id: importId,
      column_map: { Nmae: "Name" },
    });
    expect(fixed.isError).toBe(false);
    expect(JSON.parse(fixed.text)).toMatchObject({ rows_ingested: 1 });
  });

  it("hands an oversized file to the user with the link, instead of trying another way", async () => {
    const ctx = importCtx();
    const huge = `Name\n${"x".repeat(1_000_001)}\n`;
    const r = await callTool(ctx, "databases", { action: "import", database_id: "db1", table: "Projects", content: huge });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("https://stuga.test/doc/db1?table=tbl_1&import");
    expect(r.text).toContain("do NOT fall back to insert_rows");
    expect(r.text).toContain("Then stop");
    expect(actorCalls.some((c) => c.url.includes("/runs/propose"))).toBe(false);
  });

  it("steers a full insert_rows batch to import, where the next batch would be written", async () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ Name: `r${i}` }));
    const big = await callTool(connectorCtx(), "databases", { action: "insert_rows", database_id: "db1", table: "Projects", rows: many });
    expect(big.isError).toBe(false);
    expect(big.text).toContain("do NOT send another insert_rows batch");
    expect(big.text).toContain("action:import");
    const small = await callTool(connectorCtx(), "databases", { action: "insert_rows", database_id: "db1", table: "Projects", rows: [{ Name: "a" }] });
    expect(small.text).not.toContain("do NOT send another insert_rows batch");
  });

  it("create_table with columns fans out to one run of table + columns", async () => {
    actorOverride = {
      path: "/runs/propose",
      status: 200,
      body: { mode: "proposed", run: RUN, pending: 3, minted: { table_id: "tbl_new", column_id: "col_new" } },
    };
    const r = await callTool(connectorCtx(), "databases", {
      action: "create_table",
      database_id: "db1",
      name: "Guests",
      columns: [
        { name: "Guest", type: "text", description: "Who the booking is for" },
        { name: "Tier", type: "single_select", choices: ["Gold"] },
      ],
    });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.text)).toMatchObject({ table_id: "tbl_new", column_ids: ["col_new", "col_new"] });
    const ops = actorCalls.filter((c) => c.url.includes("/runs/propose")).map((c) => c.body.op as Record<string, unknown>);
    expect(ops.map((o) => o.kind)).toEqual(["tables.create", "columns.add", "columns.add"]);
    expect(ops[1]).toMatchObject({ table: "tbl_new", display: "Guest", type: "text", description: "Who the booking is for" });
    actorCalls.length = 0;
    const bad = await callTool(connectorCtx(), "databases", { action: "create_table", database_id: "db1", name: "X", columns: [{ name: "T", type: "single_select" }] });
    expect(bad.isError).toBe(true);
    expect(actorCalls).toHaveLength(0);
  });

  it("create_database is born with the named table and columns, and reports them", async () => {
    const r = await callTool(connectorCtx(), "databases", {
      action: "create_database",
      title: "Hotel",
      table: "Bookings",
      columns: [{ name: "Ref", type: "text" }],
    });
    expect(r.isError).toBe(false);
    const init = actorCalls.find((c) => c.url.includes("/schema/init"))!;
    expect(init.body).toMatchObject({ display: "Bookings", columns: [{ display: "Ref", type: "text" }] });
    expect(JSON.parse(r.text)).toMatchObject({ database_id: "db-new", table_id: "tbl_1", table: "projects" });
  });
});
