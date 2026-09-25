/**
 * /mcp document creation and retrieval go through the same functions as REST:
 * documents/create for new rows, and the /api/search and /api/retrieve handlers
 * for ranking, collection scope and the embeddings gate, once per workspace a
 * call names.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@stuga/db", async (orig) => ({
  ...(await orig<typeof import("@stuga/db")>()),
  createDoc: vi.fn(),
  getDoc: vi.fn(async () => null),
  getFolder: vi.fn(async () => null),
  listFolders: vi.fn(async () => []),
  getWorkspace: vi.fn(async () => ({ workspace_id: "ws1", name: "io", agent_instructions: "", default_doc_access: "workspace_view" })),
  getMemberRole: vi.fn(async () => "member"),
  getCollection: vi.fn(async () => null),
  expandCollectionScope: vi.fn(async () => []),
  searchDocs: vi.fn(async () => []),
  insertAiUsage: vi.fn(async () => {}),
  resolveDocInstructions: vi.fn(async () => []),
  listWorkspacesForUser: vi.fn(async () => []),
}));

vi.mock("../auth/context.js", async (orig) => ({
  ...(await orig<typeof import("../auth/context.js")>()),
  workspaceContextFor: vi.fn(),
}));

vi.mock("../retrieval/retrieve.js", () => ({ retrieveAndRerank: vi.fn() }));
vi.mock("../agents/edits.js", async (orig) => ({
  ...(await orig<typeof import("../agents/edits.js")>()),
  proposeDocEdit: vi.fn(),
}));

vi.mock("@stuga/ai", async (orig) => ({
  ...(await orig<typeof import("@stuga/ai")>()),
  embed: vi.fn(async () => ({ embeddings: [[0.1, 0.2]], inputTokens: 1 })),
}));

const { createDoc, getDoc, getFolder, getCollection, expandCollectionScope, listFolders, listWorkspacesForUser, resolveDocInstructions, searchDocs } =
  await import("@stuga/db");
const { retrieveAndRerank } = await import("../retrieval/retrieve.js");
const { proposeDocEdit } = await import("../agents/edits.js");
const { workspaceContextFor } = await import("../auth/context.js");
const { WORKSPACE_UNAVAILABLE_MESSAGE } = await import("./handler.js");
const { callerFor, resolvingTo, inWorkspace, callToolAs } = await import("./testing/call.js");
const { retrieve: restRetrieve, search: restSearch } = await import("../api/search.js");
import { EMPTY_SCOPE_NOTE, RETRIEVE_AI_DISABLED_MESSAGE } from "@stuga/agent-surface/render/search";
import { NO_INSTRUCTIONS } from "@stuga/agent-surface/render/docs";
import type { Ctx } from "../auth/context.js";

const mockCreateDoc = vi.mocked(createDoc);
const mockGetDoc = vi.mocked(getDoc);
const mockResolveInstructions = vi.mocked(resolveDocInstructions);
const mockGetFolder = vi.mocked(getFolder);
const mockGetCollection = vi.mocked(getCollection);
const mockExpandScope = vi.mocked(expandCollectionScope);
const mockRetrieve = vi.mocked(retrieveAndRerank);
const jobsSend = vi.fn(async (_message: Record<string, unknown>) => {});

const FOLDER = {
  folder_id: "f1",
  workspace_id: "ws1",
  owner: "user:carol",
  acl_principals: ["user:carol", "user:human-1", "group:ws1:design", "agent:agent-1"],
  acl_writers: ["user:carol", "user:human-1", "agent:agent-1"],
};

let ai = { chat: { enabled: true }, embed: { enabled: true, model: "embed-1" } };

function ctxOf(overrides: Record<string, unknown> = {}): Ctx {
  return {
    sql: {},
    alias: "agent-1",
    displayName: "Connector",
    surface: "mcp",
    isAgent: true,
    onBehalfOf: "human-1",
    principals: ["agent:agent-1", "user:human-1", "org:ws1"],
    workspaceId: "ws1",
    role: "member",
    env: {
      jobs: { send: jobsSend },
      aiSettings: { current: () => ai },
      publicOrigin: "https://stuga.test",
      embeddingDims: 2,
      searchLanguages: [],
      settings: { current: () => ({ databaseOpsKeep: 500, nodeLabel: "Studio", maxBodyBytes: 1_000_000 }) },
    },
    ...overrides,
  } as unknown as Ctx;
}

const human = () => ctxOf({ alias: "human-1", isAgent: false, onBehalfOf: undefined, principals: ["user:human-1", "org:ws1"] });

/** One call run in `ctx`'s workspace, which is the only one the gate resolves. */
async function callTool(ctx: Ctx, name: string, args: Record<string, unknown> = {}) {
  vi.mocked(workspaceContextFor).mockImplementation(resolvingTo(ctx));
  return callToolAs(callerFor(ctx), name, inWorkspace(ctx.workspaceId, name, args));
}

/** REST's answer to the same request in the same workspace, to hold the tool's against. */
async function restBody(handler: typeof restRetrieve, path: string, ctx: Ctx, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const url = new URL(`https://api.test${path}`);
  const req = new Request(url, { method: "POST", body: JSON.stringify(body) });
  return (await (await handler({ ctx, req, url, match: [url.pathname] })).json()) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  ai = { chat: { enabled: true }, embed: { enabled: true, model: "embed-1" } };
  mockCreateDoc.mockImplementation(async (_sql, input) => ({
    doc_id: input.docId,
    workspace_id: input.workspaceId,
    title: input.title,
    doc_type: input.docType ?? "prose",
    parent_id: input.parentId ?? null,
    owner: input.owner,
  }) as never);
  mockGetFolder.mockResolvedValue(null);
  vi.mocked(searchDocs).mockResolvedValue([]);
  vi.mocked(listWorkspacesForUser).mockResolvedValue([]);
  mockRetrieve.mockResolvedValue({
    chunks: [{ doc_id: "d1", title: "Handbook", chunk_index: 0, content: "Expenses are filed monthly.", heading_path: "Policies" }],
    degraded: true,
  } as never);
});

describe("docs_create", () => {
  it("inherits the parent folder's sharing", async () => {
    mockGetFolder.mockResolvedValue(FOLDER as never);
    const r = await callTool(ctxOf(), "docs_create", { title: "Notes", parent_id: "f1" });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.text)).toMatchObject({ title: "Notes" });
    const row = mockCreateDoc.mock.calls[0]![1];
    expect(row.parentId).toBe("f1");
    expect(row.owner).toBe("user:human-1");
    expect(row.aclPrincipals).toEqual(expect.arrayContaining(["group:ws1:design", "user:carol", "agent:agent-1"]));
  });

  it("applies the workspace's default visibility to a person's document", async () => {
    await callTool(human(), "docs_create", { title: "Plan" });
    expect(mockCreateDoc.mock.calls[0]![1].ownGrants).toEqual({ p: ["org:ws1"], w: [], c: [] });
  });

  it("announces the document once, in the ledger's own vocabulary", async () => {
    await callTool(ctxOf(), "docs_create", { title: "Notes" });
    const audit = jobsSend.mock.calls.map(([m]) => m).filter((m) => m.kind === "audit");
    expect(audit.map((m) => m.action)).toEqual(["doc.create", "mcp.docs_create.create"]);
    expect(jobsSend).toHaveBeenCalledWith(expect.objectContaining({ kind: "event", type: "doc.created" }));
  });

  it("refuses a folder the caller cannot write before inserting", async () => {
    mockGetFolder.mockResolvedValue({ ...FOLDER, acl_writers: ["user:carol"] } as never);
    const r = await callTool(ctxOf(), "docs_create", { title: "x", parent_id: "f1" });
    expect(r).toEqual({ isError: true, text: "error: view-only access to the parent folder" });
    expect(mockCreateDoc).not.toHaveBeenCalled();
  });

  it("creates a database through the same path", async () => {
    mockGetFolder.mockResolvedValue(FOLDER as never);
    const fetch = vi.fn(async (url: string) =>
      new Response(JSON.stringify(url.includes("/schema/init") ? { initialized: true } : { database_id: "x", tables: [] }), { status: 200 }),
    );
    const ctx = ctxOf();
    (ctx.env as unknown as Record<string, unknown>).databases = { get: () => ({ fetch }) };
    const r = await callTool(ctx, "databases_add", { action: "create_database", title: "Tracker", table: "Backlog" });
    expect(r.isError).toBe(false);
    expect(mockCreateDoc.mock.calls[0]![1]).toMatchObject({ docType: "database", owner: "user:human-1" });
    expect(fetch.mock.calls[0]![0]).toContain("/schema/init");
  });
});

describe("retrieve", () => {
  it("gates on embeddings, not chat", async () => {
    ai = { chat: { enabled: false }, embed: { enabled: true, model: "embed-1" } };
    const on = await callTool(ctxOf(), "retrieve", { q: "expenses" });
    expect(on.isError).toBe(false);
    expect(JSON.parse(on.text).passages[0]).toMatchObject({ workspace_id: "ws1", doc_id: "d1", url: "https://stuga.test/doc/d1" });

    ai = { chat: { enabled: true }, embed: { enabled: false, model: "embed-1" } };
    const off = await callTool(ctxOf(), "retrieve", { q: "expenses" });
    expect(off).toEqual({ isError: true, text: `error: ${RETRIEVE_AI_DISABLED_MESSAGE}` });
    expect(mockRetrieve).toHaveBeenCalledTimes(1);
  });

  it("reports the same degraded and empty-scope facts as REST", async () => {
    mockGetCollection.mockResolvedValue({ collection_id: "c1", workspace_id: "ws1", owner: "human-1" } as never);
    mockExpandScope.mockResolvedValue([]);
    mockRetrieve.mockResolvedValue({ chunks: [], degraded: true } as never);
    const rest = await restBody(restRetrieve, "/api/retrieve", ctxOf(), { q: "expenses", collection_id: "c1" });
    const mcp = JSON.parse((await callTool(ctxOf(), "retrieve", { q: "expenses", collection_id: "c1" })).text);
    expect(rest).toMatchObject({ chunks: [], degraded: true, empty_scope: true });
    expect(mcp).toEqual({ passages: [], degraded: rest.degraded, unavailable: [], note: EMPTY_SCOPE_NOTE });
    expect(mockRetrieve.mock.calls[0]![0]).toEqual(mockRetrieve.mock.calls[1]![0]);
  });

  it("refuses a collection the caller cannot read", async () => {
    mockGetCollection.mockResolvedValue(null);
    const r = await callTool(ctxOf(), "retrieve", { q: "expenses", collection_id: "c-other" });
    expect(r).toEqual({ isError: true, text: "error: collection not found" });
    expect(mockRetrieve).not.toHaveBeenCalled();
  });

  it("lists a named workspace the call cannot reach, and still answers from the rest", async () => {
    const r = await callTool(ctxOf(), "retrieve", { workspace_ids: ["ws1", "ws2"], q: "expenses" });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.text)).toEqual({
      passages: [
        {
          workspace_id: "ws1",
          doc_id: "d1",
          title: "Handbook",
          heading_path: "Policies",
          content: "Expenses are filed monthly.",
          url: "https://stuga.test/doc/d1",
        },
      ],
      degraded: true,
      unavailable: [{ workspace_id: "ws2", reason: WORKSPACE_UNAVAILABLE_MESSAGE }],
    });
    expect(mockRetrieve).toHaveBeenCalledTimes(1);
  });

  it("answers with the refusal when the only workspace named is out of reach", async () => {
    const r = await callTool(ctxOf(), "retrieve", { workspace_ids: ["ws2"], q: "expenses" });
    expect(r).toEqual({ isError: true, text: `error: ${WORKSPACE_UNAVAILABLE_MESSAGE}` });
    expect(mockRetrieve).not.toHaveBeenCalled();
  });
});

describe("search", () => {
  const HIT = { doc_id: "d1", title: "Handbook", page_of: null, page_row: null, snippet: "Expenses are filed", kw_rank: 3.2, sem_score: 0.8, score: 0.03 };

  it("answers with REST's hits, each naming its workspace and link, without the per-workspace scores", async () => {
    vi.mocked(searchDocs).mockResolvedValue([HIT]);
    const rest = await restBody(restSearch, "/api/search", ctxOf(), { q: "expenses" });
    const mcp = JSON.parse((await callTool(ctxOf(), "search", { q: "expenses" })).text);
    const hits = rest.results as Array<Record<string, unknown>>;
    expect(hits).toHaveLength(1);
    expect(mcp).toEqual({
      query: "expenses",
      results: hits.map(({ score: _score, sem_score: _sem, ...hit }) => ({ workspace_id: "ws1", ...hit, url: "https://stuga.test/doc/d1" })),
      degraded: false,
      semantic: true,
      unavailable: [],
    });
  });

  it("covers every workspace the connection reaches for [\"*\"], and none past its grant", async () => {
    vi.mocked(listWorkspacesForUser).mockResolvedValue([
      { workspace_id: "ws1", name: "io", role: "member" },
      { workspace_id: "ws2", name: "Other", role: "member" },
    ] as never);
    vi.mocked(searchDocs).mockResolvedValue([HIT]);
    vi.mocked(workspaceContextFor).mockImplementation(resolvingTo(ctxOf()));
    const r = await callToolAs(callerFor(ctxOf(), { workspaces: ["ws1"] }), "search", { workspace_ids: ["*"], q: "expenses" });
    expect(r.isError).toBe(false);
    expect(vi.mocked(workspaceContextFor).mock.calls.map(([, workspaceId]) => workspaceId)).toEqual(["ws1"]);
    expect(JSON.parse(r.text)).toMatchObject({ results: [{ workspace_id: "ws1", doc_id: "d1" }], unavailable: [] });
  });
});

describe("instructions for agents", () => {
  const DOC = {
    doc_id: "d1",
    workspace_id: "ws1",
    title: "Q3 plan",
    doc_type: "prose",
    parent_id: "f2",
    page_of: null,
    trashed: false,
    locked: false,
    search_hidden: false,
    agent_mode: "review",
    agent_instructions: "Keep the risks table.",
    updated_at: "2026-09-01",
    acl_principals: ["user:human-1"],
    acl_writers: ["user:human-1"],
  };
  const LEVELS = [
    { kind: "workspace" as const, id: "ws1", title: "io", text: "Write in British English." },
    { kind: "folder" as const, id: "f1", title: "Planning", text: "Cite the source of every figure." },
    { kind: "document" as const, id: "d1", title: "Q3 plan", text: "Keep the risks table." },
  ];

  beforeEach(() => {
    mockGetDoc.mockResolvedValue(DOC as never);
    mockResolveInstructions.mockResolvedValue(LEVELS);
  });

  it("docs metadata carries the stack, resolved with the person's principals rather than the key's folder scope", async () => {
    const ctx = ctxOf({ scope: { folders: ["f2"], readOnly: false, credentialId: "k1" } });
    const r = await callTool(ctx, "docs", { action: "metadata", doc_id: "d1" });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.text)).toMatchObject({ doc_id: "d1", review: { mode: "review" }, instructions: LEVELS });
    expect(JSON.parse(r.text)).not.toHaveProperty("instructions_cut");
    expect(mockResolveInstructions).toHaveBeenCalledWith(ctx.sql, DOC, ctx.principals);
  });

  it("markdown read puts the stack before the text, fenced level by level", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ markdown: "# Q3 plan\n\nbody" })));
    const ctx = ctxOf();
    (ctx.env as unknown as Record<string, unknown>).docs = { get: () => ({ fetch }) };
    const r = await callTool(ctx, "markdown", { action: "read", doc_id: "d1" });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/^=== INSTRUCTIONS FOR THIS DOCUMENT \(not part of its text\) ===\n/);
    expect(r.text).toContain('--- Workspace "io" ---\nWrite in British English.\n--- Folder "Planning" ---');
    expect(r.text.endsWith("===\n\n# Q3 plan\n\nbody")).toBe(true);
  });

  it("markdown read of a document nothing applies to says so before the text", async () => {
    mockResolveInstructions.mockResolvedValue([]);
    const fetch = vi.fn(async () => new Response(JSON.stringify({ markdown: "body" })));
    const ctx = ctxOf();
    (ctx.env as unknown as Record<string, unknown>).docs = { get: () => ({ fetch }) };
    expect(await callTool(ctx, "markdown", { action: "read", doc_id: "d1" })).toEqual({ isError: false, text: `${NO_INSTRUCTIONS}\n\nbody` });
  });

  it("docs_create answers with the stack the new document was placed under", async () => {
    mockGetFolder.mockResolvedValue(FOLDER as never);
    mockResolveInstructions.mockResolvedValue(LEVELS.slice(0, 2));
    const r = await callTool(ctxOf(), "docs_create", { title: "Notes", parent_id: "f1" });
    const body = JSON.parse(r.text);
    expect(body).toEqual({ doc_id: body.doc_id, title: "Notes", instructions: LEVELS.slice(0, 2) });
    expect(mockResolveInstructions.mock.calls[0]![1]).toMatchObject({ doc_id: body.doc_id, parent_id: "f1" });
  });

  it("a write's answer names the levels below the workspace, so an append that never read learns of them", async () => {
    vi.mocked(proposeDocEdit).mockResolvedValue({
      kind: "proposed",
      run: { id: "run_1", hunks: [] },
      pending: 1,
      review: "review",
      reason: "this document waits for review",
      doc: DOC,
    } as never);
    const r = await callTool(ctxOf(), "markdown_append", { doc_id: "d1", text: "- a note" });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/^Proposed — /);
    expect(r.text).toContain('beyond the workspace\'s: Folder "Planning", Document "Q3 plan".');
    expect(r.text).not.toContain('Workspace "io"');
    expect(mockResolveInstructions).toHaveBeenCalledWith(expect.anything(), DOC, expect.any(Array));
  });

  it("docs_create still answers with the new document when its stack cannot be read", async () => {
    // Created already: an error here would read as a failed create, and the agent would make a second one.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockGetFolder.mockResolvedValue(FOLDER as never);
    mockResolveInstructions.mockRejectedValue(new Error("connection reset"));
    const r = await callTool(ctxOf(), "docs_create", { title: "Notes", parent_id: "f1" });
    expect(r.isError).toBe(false);
    const body = JSON.parse(r.text);
    expect(body).toEqual({ doc_id: body.doc_id, title: "Notes" });
    expect(mockCreateDoc).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    mockResolveInstructions.mockReset();
  });
});

describe("folders", () => {
  it("lists summaries: neither grants nor a folder's instructions ride along", async () => {
    vi.mocked(listFolders).mockResolvedValue([
      { ...FOLDER, parent_id: null, title: "Legal", inherits_perms: true, own_grants: { p: [], w: [], c: [] }, agent_instructions: "Never promise dates.", created_at: "t0", updated_at: "t1" },
    ] as never);
    const r = await callTool(ctxOf(), "folders", {});
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.text)).toEqual({
      folders: [{ folder_id: "f1", parent_id: null, title: "Legal", owner: "user:carol", created_at: "t0", updated_at: "t1" }],
    });
  });
});
