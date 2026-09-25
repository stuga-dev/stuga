import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@stuga/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@stuga/db")>()),
  getDoc: vi.fn(),
  getFolder: vi.fn(),
  listDocs: vi.fn(async () => []),
  listFolders: vi.fn(async () => []),
  searchDocs: vi.fn(async () => []),
  insertApiKey: vi.fn(async () => {}),
  rotateApiKeySecret: vi.fn(async () => true),
  setDocAgentMode: vi.fn(),
  updateDoc: vi.fn(),
  folderEffectiveAcl: vi.fn(async () => null),
  getWorkspace: vi.fn(async () => ({ workspace_id: "ws1", name: "W", agent_instructions: "Be brief." })),
  listAgentRuns: vi.fn(async () => []),
  agentNames: vi.fn(async () => new Map()),
  agentRunStats: vi.fn(async () => []),
  getFolderAncestors: vi.fn(async () => []),
  resolveDocInstructions: vi.fn(async () => []),
  listWorkspaceEvents: vi.fn(async () => []),
  latestWorkspaceEventId: vi.fn(async () => 7),
}));

const {
  getDoc,
  getFolder,
  listDocs,
  listFolders,
  insertApiKey,
  rotateApiKeySecret,
  setDocAgentMode,
  updateDoc,
  listWorkspaceEvents,
} = await import("@stuga/db");
const { routeWorkspaceRequest } = await import("../http/dispatch.js");
const { READ_ONLY_MESSAGE } = await import("../authz/authz.js");
import type { Ctx } from "../auth/context.js";

const mockGetDoc = getDoc as unknown as ReturnType<typeof vi.fn>;
const mockGetFolder = getFolder as unknown as ReturnType<typeof vi.fn>;
const mockListDocs = listDocs as unknown as ReturnType<typeof vi.fn>;
const mockListFolders = listFolders as unknown as ReturnType<typeof vi.fn>;
const mockInsertKey = insertApiKey as unknown as ReturnType<typeof vi.fn>;
const mockRotate = rotateApiKeySecret as unknown as ReturnType<typeof vi.fn>;
const mockSetAgentMode = setDocAgentMode as unknown as ReturnType<typeof vi.fn>;
const mockUpdateDoc = updateDoc as unknown as ReturnType<typeof vi.fn>;
const mockListEvents = listWorkspaceEvents as unknown as ReturnType<typeof vi.fn>;

const FOLDER = { folder_id: "f1", workspace_id: "ws1", owner: "user:human-1", title: "Notes", acl_principals: ["user:human-1", "org:ws1"], acl_writers: ["user:human-1", "org:ws1"] };

function humanCtx(over: Partial<Ctx> = {}): Ctx {
  return {
    sql: {},
    alias: "human-1",
    displayName: "Ada",
    email: null,
    isAgent: false,
    principals: ["user:human-1", "org:ws1"],
    workspaceId: "ws1",
    role: "member",
    env: {
      publicOrigin: "https://stuga.test",
      jobs: { send: async () => {} },
      aiSettings: { current: () => ({ enabled: false, embed: { enabled: false }, chat: { enabled: false } }) },
      embeddingDims: 8,
      searchLanguages: [],
    },
    ...over,
  } as unknown as Ctx;
}

function agentCtx(over: Partial<Ctx> = {}): Ctx {
  return humanCtx({
    alias: "agent-1",
    displayName: "bot",
    isAgent: true,
    onBehalfOf: "human-1",
    principals: ["agent:agent-1", "user:human-1", "org:ws1"],
    ...over,
  } as Partial<Ctx>);
}

function req(method: string, path: string, body?: unknown): Request {
  return new Request(`https://stuga.test${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function call(ctx: Ctx, method: string, path: string, body?: unknown) {
  const r = req(method, path, body);
  const res = await routeWorkspaceRequest(ctx, r);
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetFolder.mockResolvedValue(FOLDER);
});

describe("a read-only key", () => {
  const ro = agentCtx({ scope: { folders: null, readOnly: true, credentialId: "k1" } });
  it("is refused any write before the route runs", async () => {
    for (const [m, p] of [
      ["POST", "/api/docs"],
      ["POST", "/api/docs/d1/propose"],
      ["POST", "/api/docs/d1/comments"],
      ["POST", "/api/docs/d1/media"],
      ["PATCH", "/api/docs/d1"],
    ] as const) {
      const out = await call(ro, m, p, { title: "x" });
      expect(out.status, `${m} ${p}`).toBe(403);
      expect(out.json.error).toBe(READ_ONLY_MESSAGE);
    }
  });
  it("still reads, including the three reads that travel as POST", async () => {
    const docs = await call(ro, "GET", "/api/docs");
    expect(docs.status).toBe(200);
    const search = await call(ro, "POST", "/api/search", { q: "hello" });
    expect(search.status).toBe(200);
    const retrieve = await call(ro, "POST", "/api/retrieve", { q: "hello" });
    expect(retrieve.status).toBe(200);
    // The row is mocked away, so a 404 shows the read got past the read-only gate.
    const query = await call(ro, "POST", "/api/databases/db1/query", { sql: "select 1" });
    expect(query.json.error).not.toBe(READ_ONLY_MESSAGE);
  });
  it("whoami reports the narrowing", async () => {
    const who = await call(ro, "GET", "/api/whoami");
    expect(who.json.scope).toEqual({ folders: null, read_only: true });
  });
});

describe("a folder-scoped key", () => {
  const scoped = agentCtx({ scope: { folders: ["f1", "f1a"], readOnly: false, credentialId: "k2" } });
  it("lists documents and folders inside its folders only", async () => {
    await call(scoped, "GET", "/api/docs");
    expect(mockListDocs).toHaveBeenCalledWith(expect.anything(), scoped.principals, "ws1", expect.objectContaining({ scopeFolderIds: ["f1", "f1a"] }));
    await call(scoped, "GET", "/api/folders");
    expect(mockListFolders).toHaveBeenCalledWith(expect.anything(), scoped.principals, "ws1", undefined, expect.objectContaining({ scopeFolderIds: ["f1", "f1a"] }));
  });
  it("may not create at the root", async () => {
    const out = await call(scoped, "POST", "/api/docs", { title: "loose" });
    expect(out.status).toBe(403);
    expect(String(out.json.error)).toMatch(/parent_id/);
  });
  it("sees only in-scope events", async () => {
    await call(scoped, "GET", "/api/events?after=0");
    expect(mockListEvents).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ scopeFolderIds: ["f1", "f1a"], after: 0 }));
  });
  it("an unscoped caller passes no folder filter", async () => {
    await call(humanCtx(), "GET", "/api/docs");
    expect(mockListDocs).toHaveBeenCalledWith(expect.anything(), expect.anything(), "ws1", expect.objectContaining({ scopeFolderIds: null }));
  });
});

describe("the pages of database rows in GET /api/docs", () => {
  const lastListOpts = () => mockListDocs.mock.calls.at(-1)![3] as Record<string, unknown>;
  it("are left out of the library by default, and out of the trash only when asked", async () => {
    await call(humanCtx(), "GET", "/api/docs");
    expect(lastListOpts()).toMatchObject({ pages: "exclude", pageOf: undefined });
    await call(humanCtx(), "GET", "/api/docs?trashed_only=true");
    expect(lastListOpts()).toMatchObject({ trashedOnly: true, pages: "include" });
    await call(humanCtx(), "GET", "/api/docs?trashed_only=true&pages=exclude");
    expect(lastListOpts()).toMatchObject({ trashedOnly: true, pages: "exclude" });
  });
  it("come along with ?pages=include, and alone for one database with ?page_of=", async () => {
    await call(humanCtx(), "GET", "/api/docs?pages=include");
    expect(lastListOpts()).toMatchObject({ pages: "include" });
    await call(humanCtx(), "GET", "/api/docs?page_of=db1");
    expect(lastListOpts()).toMatchObject({ pages: "only", pageOf: "db1" });
    // An unknown value falls back to the default rather than erroring.
    await call(humanCtx(), "GET", "/api/docs?pages=everything");
    expect(lastListOpts()).toMatchObject({ pages: "exclude" });
  });
});

describe("minting with a narrowing", () => {
  it("stores the folders, access and deadline it validated", async () => {
    const out = await call(humanCtx(), "POST", "/api/keys", { name: "scout", scope_folders: ["f1", "f1"], access: "read", expires_in_days: 30 });
    expect(out.status).toBe(201);
    expect(out.json).toMatchObject({ scope_folders: ["f1"], access: "read" });
    expect(typeof out.json.expires_at).toBe("string");
    expect(mockInsertKey).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ scopeFolders: ["f1"], access: "read", owner: "human-1", workspaceId: "ws1" }));
  });
  it("refuses a folder the minter cannot see, an empty scope, a bad access, a silly lifetime", async () => {
    mockGetFolder.mockResolvedValue({ ...FOLDER, acl_principals: ["user:someone-else"] });
    expect((await call(humanCtx(), "POST", "/api/keys", { name: "s", scope_folders: ["f1"] })).status).toBe(400);
    mockGetFolder.mockResolvedValue(FOLDER);
    expect((await call(humanCtx(), "POST", "/api/keys", { name: "s", scope_folders: [] })).status).toBe(400);
    expect((await call(humanCtx(), "POST", "/api/keys", { name: "s", access: "admin" })).status).toBe(400);
    expect((await call(humanCtx(), "POST", "/api/keys", { name: "s", expires_in_days: 100000 })).status).toBe(400);
    expect(mockInsertKey).not.toHaveBeenCalled();
  });
  it("rotation keeps the key id and returns a token that carries it", async () => {
    const out = await call(humanCtx(), "POST", "/api/keys/k1/rotate");
    expect(out.status).toBe(200);
    expect(out.json.key_id).toBe("k1");
    expect(String(out.json.token)).toMatch(/^vk_k1_[0-9a-f]{64}$/);
    expect(mockRotate).toHaveBeenCalledWith(expect.anything(), "k1", "human-1", expect.stringMatching(/^[0-9a-f]{64}$/));
  });
  it("rotating a key that is not yours is 404, not 403", async () => {
    mockRotate.mockResolvedValue(false);
    expect((await call(humanCtx(), "POST", "/api/keys/k9/rotate")).status).toBe(404);
  });
  it("agents may not mint, rotate or narrow keys", async () => {
    expect((await call(agentCtx(), "POST", "/api/keys", { name: "x" })).status).toBe(403);
    expect((await call(agentCtx(), "POST", "/api/keys/k1/rotate")).status).toBe(403);
  });
});

describe("the inbox and statistics", () => {
  it("refuse agents", async () => {
    expect((await call(agentCtx(), "GET", "/api/runs")).status).toBe(403);
    expect((await call(agentCtx(), "GET", "/api/agents/stats")).status).toBe(403);
  });
  it("answer members", async () => {
    const out = await call(humanCtx(), "GET", "/api/runs?filter=open");
    expect(out.status).toBe(200);
    expect(out.json).toMatchObject({ runs: [], filter: "open" });
    expect((await call(humanCtx(), "GET", "/api/agents/stats")).status).toBe(200);
  });
  it("pages below a cursor spelled as an ISO instant, and refuses a half or unparseable cursor", async () => {
    const { listAgentRuns } = await import("@stuga/db");
    const paged = await call(humanCtx(), "GET", "/api/runs?before_at=2026-09-01T10:00:00%2B02:00&before_id=run_9");
    expect(paged.status).toBe(200);
    expect(vi.mocked(listAgentRuns).mock.calls[0]![1].before).toEqual({ updatedAt: "2026-09-01T08:00:00.000Z", runId: "run_9" });

    expect((await call(humanCtx(), "GET", "/api/runs?before_at=2026-09-01T10:00:00Z")).status).toBe(400);
    expect((await call(humanCtx(), "GET", "/api/runs?before_id=run_9")).status).toBe(400);
    expect((await call(humanCtx(), "GET", "/api/runs?before_at=soon&before_id=run_9")).status).toBe(400);
  });
});

/** An agent reads what writing would do before it writes: the document's own `agent_mode`. */
describe("a document's review verdict, read before writing", () => {
  const DOC = {
    doc_id: "d1",
    workspace_id: "ws1",
    parent_id: "f1",
    title: "Notes",
    doc_type: "prose",
    owner: "user:human-1",
    created_by: "user:human-1",
    locked: false,
    search_hidden: false,
    agent_mode: "review",
    trashed: false,
    updated_at: "2026-01-01T00:00:00Z",
    acl_principals: ["user:human-1", "org:ws1"],
    acl_writers: ["user:human-1", "org:ws1"],
  };

  beforeEach(() => {
    mockGetDoc.mockResolvedValue(DOC);
  });

  it("parks on a `review` document, the default", async () => {
    const out = await call(agentCtx(), "GET", "/api/docs/d1");
    expect(out.status).toBe(200);
    expect(out.json.review).toMatchObject({ mode: "review" });
  });

  it("lands on an `auto` document", async () => {
    mockGetDoc.mockResolvedValue({ ...DOC, agent_mode: "auto" });
    const out = await call(agentCtx(), "GET", "/api/docs/d1");
    expect(out.json.review).toMatchObject({ mode: "auto" });
  });

  it("is absent for a human, whose shape the web client types as DocSummary", async () => {
    const out = await call(humanCtx(), "GET", "/api/docs/d1");
    expect(out.status).toBe(200);
    expect(out.json.doc_id).toBe("d1");
    expect(out.json).not.toHaveProperty("review");
  });
});

/** Who may change a document's agent mode, and the ledger row each change leaves. */
describe("PATCH /api/docs/:id/state — agent_mode", () => {
  const DOC = {
    doc_id: "d1",
    workspace_id: "ws1",
    parent_id: "f1",
    title: "Notes",
    doc_type: "prose",
    owner: "user:human-1",
    locked: false,
    search_hidden: false,
    agent_mode: "review",
    trashed: false,
    acl_principals: ["user:human-1", "org:ws1"],
    acl_writers: ["user:human-1", "org:ws1"],
  };
  // The ledger is written through the job queue, so that is where a row shows up.
  let sent: Array<Record<string, unknown>> = [];

  beforeEach(() => {
    sent = [];
    mockGetDoc.mockResolvedValue(DOC);
    mockSetAgentMode.mockImplementation(async (_sql: unknown, _id: string, mode: string) => ({ ...DOC, agent_mode: mode }));
  });

  const audit = () => sent.filter((m) => m.kind === "audit");
  const owner = () => {
    const ctx = humanCtx();
    (ctx.env as { jobs: unknown }).jobs = { send: async (m: Record<string, unknown>) => void sent.push(m) };
    return ctx;
  };

  it("refuses a word that is not review | auto", async () => {
    const out = await call(owner(), "PATCH", "/api/docs/d1/state", { agent_mode: "whenever" });
    expect(out.status).toBe(400);
    expect(mockSetAgentMode).not.toHaveBeenCalled();
  });

  it("refuses anyone but the owner or a workspace admin, and every agent", async () => {
    const member = humanCtx({ alias: "someone-else", principals: ["user:someone-else", "org:ws1"] });
    expect((await call(member, "PATCH", "/api/docs/d1/state", { agent_mode: "auto" })).status).toBe(403);
    expect((await call(agentCtx(), "PATCH", "/api/docs/d1/state", { agent_mode: "auto" })).status).toBe(403);
    expect(mockSetAgentMode).not.toHaveBeenCalled();
  });

  it("lets the owner flip it, and records who did", async () => {
    const out = await call(owner(), "PATCH", "/api/docs/d1/state", { agent_mode: "auto" });
    expect(out.status).toBe(200);
    expect(out.json).toMatchObject({ agent_mode: "auto" });
    expect(mockSetAgentMode).toHaveBeenCalledWith(expect.anything(), "d1", "auto");
    expect(audit()).toContainEqual(expect.objectContaining({ action: "doc.agent_mode", detail: { mode: "auto", from: "review" } }));
  });

  it("writes nothing when the mode already matches", async () => {
    const out = await call(owner(), "PATCH", "/api/docs/d1/state", { agent_mode: "review" });
    expect(out.status).toBe(200);
    expect(mockSetAgentMode).not.toHaveBeenCalled();
    expect(audit()).toHaveLength(0);
  });
});

describe("the ledger rows an item's life leaves", () => {
  const DOC = {
    doc_id: "d1",
    workspace_id: "ws1",
    parent_id: null,
    title: "Roadmap",
    doc_type: "prose",
    owner: "user:human-1",
    locked: false,
    search_hidden: false,
    agent_mode: "review",
    trashed: false,
    acl_principals: ["user:human-1", "org:ws1"],
    acl_writers: ["user:human-1", "org:ws1"],
  };
  let sent: Array<Record<string, unknown>> = [];

  function owner(): Ctx {
    const ctx = humanCtx();
    (ctx.env as { jobs: unknown }).jobs = { send: async (m: Record<string, unknown>) => void sent.push(m) };
    return ctx;
  }
  const audit = () => sent.filter((m) => m.kind === "audit");

  beforeEach(() => {
    sent = [];
    mockGetDoc.mockResolvedValue(DOC);
  });

  it("records a rename and a move separately from a trashing", async () => {
    mockUpdateDoc.mockResolvedValue({ ...DOC, title: "Plan", parent_id: "f2" });
    await call(owner(), "PATCH", "/api/docs/d1", { title: "Plan", parent_id: "f2" });
    expect(audit()[0]).toMatchObject({
      action: "doc.update",
      targetKind: "doc",
      targetLabel: "Plan",
      detail: { renamed: { from: "Roadmap", to: "Plan" }, moved: { from: null, to: "f2" } },
    });

    sent = [];
    mockUpdateDoc.mockResolvedValue({ ...DOC, trashed: true });
    await call(owner(), "PATCH", "/api/docs/d1", { trashed: true });
    expect(audit()[0]).toMatchObject({ action: "doc.trash" });
  });

  it("writes nothing for a PATCH that changed nothing", async () => {
    mockUpdateDoc.mockResolvedValue({ ...DOC });
    await call(owner(), "PATCH", "/api/docs/d1", { title: "Roadmap" });
    expect(audit()).toEqual([]);
  });

  it("calls a database a database, so one item's history stays under one target", async () => {
    const db = { ...DOC, doc_type: "database", title: "Bookings" };
    mockGetDoc.mockResolvedValue(db);
    mockUpdateDoc.mockResolvedValue({ ...db, title: "Bookings 2026" });
    await call(owner(), "PATCH", "/api/docs/d1", { title: "Bookings 2026" });
    expect(audit()[0]).toMatchObject({ action: "doc.update", targetKind: "database" });
  });
});

describe("instructions and events", () => {
  it("hand every caller the workspace's conventions", async () => {
    const out = await call(agentCtx(), "GET", "/api/instructions");
    expect(out.json).toEqual({ workspace_id: "ws1", name: "W", instructions: "Be brief." });
  });
  it("the feed reports its cursor and newest id", async () => {
    const out = await call(humanCtx(), "GET", "/api/events?after=3&types=run.decided");
    expect(out.json).toMatchObject({ events: [], cursor: 3, latest: 7 });
    expect((await call(humanCtx(), "GET", "/api/events?types=nope")).status).toBe(400);
  });
});
