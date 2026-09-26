import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@stuga/db", async (orig) => ({
  ...(await orig<typeof import("@stuga/db")>()),
  resolveDocInstructions: vi.fn(),
  resolveFolderInstructions: vi.fn(),
  getDoc: vi.fn(),
  getCollection: vi.fn(),
  expandCollectionScope: vi.fn(),
  listEditableDocs: vi.fn(async () => []),
}));
vi.mock("../agents/edits.js", () => ({ proposeDocEdit: vi.fn() }));
vi.mock("../retrieval/retrieve.js", () => ({ retrieveAndRerank: vi.fn() }));

const { resolveDocInstructions, resolveFolderInstructions, getDoc, getCollection, expandCollectionScope, listEditableDocs } =
  await import("@stuga/db");
const { proposeDocEdit } = await import("../agents/edits.js");
const { retrieveAndRerank } = await import("../retrieval/retrieve.js");
const { handleInternalRequest } = await import("./routes.js");
const { createInternalApi } = await import("../platform/internal-api.js");
import type { InstructionLevel } from "@stuga/protocol/domain/instructions";
import type { NodeEnv } from "../env.js";

const mockGetDoc = getDoc as unknown as ReturnType<typeof vi.fn>;
const mockPropose = proposeDocEdit as unknown as ReturnType<typeof vi.fn>;
const mockRetrieve = retrieveAndRerank as unknown as ReturnType<typeof vi.fn>;

const actorFetch = vi.fn(async () => Response.json({ markdown: "# Other" }));
const env = {
  sql: {},
  embeddingDims: 4,
  searchLanguages: { current: () => [] },
  aiSettings: { current: () => ({ embed: { enabled: true } }) },
  docs: { get: () => ({ fetch: actorFetch }) },
} as unknown as NodeEnv;
const internal = createInternalApi((req) => handleInternalRequest(req, env));

async function post(path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const res = await internal.fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const WORKSPACE_LEVEL: InstructionLevel = { kind: "workspace", id: "ws1", title: "io", text: "always add 中文翻译在后面" };
const FOLDER_LEVEL: InstructionLevel = { kind: "folder", id: "f1", title: "Journal", text: "Newest entry first." };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveFolderInstructions).mockResolvedValue([WORKSPACE_LEVEL]);
  vi.mocked(resolveDocInstructions).mockResolvedValue([WORKSPACE_LEVEL, FOLDER_LEVEL]);
});

const call = (body: unknown) => post("/internal/agent-instructions", body);

describe("/internal/agent-instructions", () => {
  const DOC = { doc_id: "d1", workspace_id: "ws1", doc_type: "prose", title: "Notes", parent_id: "f1", page_of: null, agent_instructions: "" };

  it("resolves the document's stack for the principals the actor forwarded", async () => {
    mockGetDoc.mockResolvedValue(DOC);
    const out = await call({ workspaceId: "ws1", docId: "d1", principals: ["user:ada", "group:ops"] });
    expect(out).toEqual({ status: 200, body: { levels: [WORKSPACE_LEVEL, FOLDER_LEVEL] } });
    expect(mockGetDoc).toHaveBeenCalledWith(expect.anything(), "d1");
    expect(resolveDocInstructions).toHaveBeenCalledWith(expect.anything(), DOC, ["user:ada", "group:ops"]);
    expect(resolveFolderInstructions).not.toHaveBeenCalled();
  });

  it("gives a document in another workspace only the named workspace's level", async () => {
    mockGetDoc.mockResolvedValue({ ...DOC, workspace_id: "ws2" });
    const out = await call({ workspaceId: "ws1", docId: "d1", principals: ["user:ada"] });
    expect(out.body).toEqual({ levels: [WORKSPACE_LEVEL] });
    expect(resolveDocInstructions).not.toHaveBeenCalled();
    expect(resolveFolderInstructions).toHaveBeenCalledWith(expect.anything(), "ws1", null, ["user:ada"]);
  });

  it("gives an unknown or missing document only the workspace's level", async () => {
    mockGetDoc.mockResolvedValue(null);
    expect((await call({ workspaceId: "ws1", docId: "ghost", principals: ["user:ada"] })).body).toEqual({ levels: [WORKSPACE_LEVEL] });

    mockGetDoc.mockClear();
    expect((await call({ workspaceId: "ws1", principals: ["user:ada"] })).body).toEqual({ levels: [WORKSPACE_LEVEL] });
    expect(mockGetDoc).not.toHaveBeenCalled();
    expect(resolveDocInstructions).not.toHaveBeenCalled();
  });

  it("reads the stack as no principals when none usable were forwarded", async () => {
    mockGetDoc.mockResolvedValue(DOC);
    await call({ workspaceId: "ws1", docId: "d1", principals: "user:ada" });
    await call({ workspaceId: "ws1", docId: "d1", principals: ["user:ada", 7] });
    expect(vi.mocked(resolveDocInstructions).mock.calls.map((c) => c[2])).toEqual([[], ["user:ada"]]);
  });

  it("answers no levels for a missing tenant, before reading anything", async () => {
    expect(await call({ docId: "d1", principals: ["user:ada"] })).toEqual({ status: 200, body: { levels: [] } });
    expect(mockGetDoc).not.toHaveBeenCalled();
    expect(resolveDocInstructions).not.toHaveBeenCalled();
    expect(resolveFolderInstructions).not.toHaveBeenCalled();
  });
});

describe("a co-author turn with a collection selected", () => {
  const session = { principals: ["user:ada"], workspaceId: "ws1", alias: "ada", collection_id: "col_1" };
  const COLLECTION = { collection_id: "col_1", workspace_id: "ws1", owner: "ada", name: "Launch", created_at: "", updated_at: "" };
  const PROSE = { doc_id: "d_in", workspace_id: "ws1", doc_type: "prose", title: "Inside", trashed: false, locked: false, acl_writers: ["user:ada"] };

  beforeEach(() => {
    vi.mocked(getCollection).mockResolvedValue(COLLECTION);
    vi.mocked(expandCollectionScope).mockResolvedValue(["d_in"]);
    mockGetDoc.mockResolvedValue(PROSE);
    mockRetrieve.mockResolvedValue({ chunks: [], degraded: false });
  });

  it("lists only the collection's editable documents", async () => {
    await post("/internal/editable-docs", { ...session, exclude: "d_here" });
    expect(expandCollectionScope).toHaveBeenCalledWith({}, "col_1", { principals: ["user:ada"], workspaceId: "ws1", scopeFolderIds: null });
    expect(listEditableDocs).toHaveBeenCalledWith({}, ["user:ada"], "ws1", { exclude: "d_here", docIds: ["d_in"] });
  });

  it("lists every editable document for all documents", async () => {
    await post("/internal/editable-docs", { ...session, collection_id: "__all__" });
    expect(vi.mocked(listEditableDocs).mock.calls.map((c) => c[3]?.docIds)).toEqual([null]);
    expect(getCollection).not.toHaveBeenCalled();
  });

  it("expands the collection within a folder-scoped session's folders", async () => {
    await post("/internal/retrieve", { ...session, query: "launch", scopeFolderIds: ["f1"] });
    expect(expandCollectionScope).toHaveBeenCalledWith({}, "col_1", { principals: ["user:ada"], workspaceId: "ws1", scopeFolderIds: ["f1"] });
    expect(mockRetrieve).toHaveBeenCalledWith(expect.objectContaining({ scopeDocIds: ["d_in"], scopeFolderIds: ["f1"] }));
  });

  it("opens a document inside the collection, with its instructions for the session's principals", async () => {
    expect(await post("/internal/doc-markdown", { ...session, doc_id: "d_in" })).toEqual({
      status: 200,
      body: { markdown: "# Other", title: "Inside", instructions: [WORKSPACE_LEVEL, FOLDER_LEVEL] },
    });
    expect(resolveDocInstructions).toHaveBeenCalledWith(expect.anything(), PROSE, ["user:ada"]);
  });

  it("still opens the document, without instructions, when they cannot be read", async () => {
    // A failed lookup must not read to the model as "you cannot edit that document".
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(resolveDocInstructions).mockRejectedValueOnce(new Error("db down"));
    expect(await post("/internal/doc-markdown", { ...session, doc_id: "d_in" })).toEqual({
      status: 200,
      body: { markdown: "# Other", title: "Inside", instructions: [] },
    });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("refuses to open a document outside it, with words for the model, before reading the document", async () => {
    expect(await post("/internal/doc-markdown", { ...session, doc_id: "d_out" })).toEqual({
      status: 403,
      body: { error: "forbidden", message: "that document is not in the selected collection" },
    });
    expect(mockGetDoc).not.toHaveBeenCalled();
    expect(actorFetch).not.toHaveBeenCalled();
    expect(resolveDocInstructions).not.toHaveBeenCalled();
  });

  it("refuses a proposal into a document outside it", async () => {
    const out = await post("/internal/propose-doc-edit", { ...session, doc_id: "d_out", edits: [{ old_string: "a", new_string: "b" }] });
    expect(out).toEqual({ status: 403, body: { kind: "error", message: "that document is not in the selected collection" } });
    expect(mockPropose).not.toHaveBeenCalled();
  });

  it("proposes into a document inside it", async () => {
    mockPropose.mockResolvedValue({ kind: "proposed", pending: 1, run: { id: "run_1" } });
    const out = await post("/internal/propose-doc-edit", { ...session, doc_id: "d_in", edits: [{ old_string: "a", new_string: "b" }] });
    expect(out.status).toBe(200);
    expect(mockPropose).toHaveBeenCalledTimes(1);
  });

  it("searches exactly the collection's documents", async () => {
    await post("/internal/retrieve", { ...session, query: "launch" });
    expect(mockRetrieve).toHaveBeenCalledWith(expect.objectContaining({ scopeDocIds: ["d_in"] }));
  });

  it.each([
    ["someone else's", { owner: "grace" }],
    ["another workspace's", { workspace_id: "ws2" }],
  ])("treats %s collection as unavailable on every call, never as every document", async (_label, change) => {
    vi.mocked(getCollection).mockResolvedValue({ ...COLLECTION, ...change });
    expect(await post("/internal/editable-docs", session)).toEqual({ status: 404, body: { docs: [], message: "that collection is not available" } });
    expect((await post("/internal/doc-markdown", { ...session, doc_id: "d_in" })).status).toBe(404);
    expect((await post("/internal/propose-doc-edit", { ...session, doc_id: "d_in", edits: [{ old_string: "a", new_string: "b" }] })).body).toEqual({
      kind: "error",
      message: "that collection is not available",
    });
    expect((await post("/internal/retrieve", { ...session, query: "launch" })).body).toEqual({ chunks: [], message: "that collection is not available" });
    expect(listEditableDocs).not.toHaveBeenCalled();
    expect(expandCollectionScope).not.toHaveBeenCalled();
    expect(mockRetrieve).not.toHaveBeenCalled();
    expect(mockPropose).not.toHaveBeenCalled();
  });
});

describe("a co-author turn scoped to this document only", () => {
  const session = { principals: ["user:ada"], workspaceId: "ws1", alias: "ada", collection_id: null };
  const onlyThis = "this turn reaches only the open document; to work across documents, pick All documents or a collection as the search scope";

  it.each([null, undefined, ""])("lists no other document for a collection_id of %j", async (collectionId) => {
    expect(await post("/internal/editable-docs", { ...session, collection_id: collectionId, exclude: "d_here" })).toEqual({ status: 200, body: { docs: [] } });
    expect(listEditableDocs).not.toHaveBeenCalled();
  });

  it("refuses to open another document, with words for the model, before reading it", async () => {
    expect(await post("/internal/doc-markdown", { ...session, doc_id: "d_other" })).toEqual({ status: 403, body: { error: "forbidden", message: onlyThis } });
    expect(mockGetDoc).not.toHaveBeenCalled();
    expect(actorFetch).not.toHaveBeenCalled();
  });

  it("refuses a proposal into another document", async () => {
    const out = await post("/internal/propose-doc-edit", { ...session, doc_id: "d_other", edits: [{ old_string: "a", new_string: "b" }] });
    expect(out).toEqual({ status: 403, body: { kind: "error", message: onlyThis } });
    expect(mockPropose).not.toHaveBeenCalled();
  });

  it("searches nothing", async () => {
    expect((await post("/internal/retrieve", { ...session, query: "launch" })).body).toEqual({ chunks: [] });
    expect(mockRetrieve).not.toHaveBeenCalled();
    expect(getCollection).not.toHaveBeenCalled();
  });
});

describe("/internal/retrieve", () => {
  const body = { query: "q", collection_id: "__all__", principals: ["user:ada"], workspaceId: "ws1", alias: "ada" };

  it("retrieves as the alias the actor names", async () => {
    mockRetrieve.mockResolvedValue({ chunks: [], degraded: false });
    expect((await post("/internal/retrieve", body)).body).toEqual({ chunks: [] });
    expect(mockRetrieve).toHaveBeenCalledWith(expect.objectContaining({ alias: "ada", workspaceId: "ws1", scopeDocIds: null }));
  });

  it("retrieves nothing without an alias", async () => {
    const { alias: _alias, ...anonymous } = body;
    expect((await post("/internal/retrieve", anonymous)).body).toEqual({ chunks: [] });
    expect(mockRetrieve).not.toHaveBeenCalled();
  });
});

describe("/internal/media-ingest", () => {
  it("refuses a request that names no workspace before reading the document", async () => {
    const out = await post("/internal/media-ingest", { doc_id: "d1", principals: ["user:ada"], markdown: ["![x](https://e.test/x.png)"] });
    expect(out.status).toBe(400);
    expect(mockGetDoc).not.toHaveBeenCalled();
  });

  it("refuses a document in another workspace", async () => {
    mockGetDoc.mockResolvedValue({ doc_id: "d1", workspace_id: "ws2", trashed: false, locked: false, acl_writers: ["user:ada"] });
    const out = await post("/internal/media-ingest", {
      doc_id: "d1",
      principals: ["user:ada"],
      workspaceId: "ws1",
      markdown: ["![x](https://e.test/x.png)"],
    });
    expect(out.status).toBe(403);
  });
});

describe("/internal/propose-doc-edit", () => {
  const body = {
    doc_id: "d2",
    principals: ["user:ada"],
    workspaceId: "ws1",
    alias: "ada",
    agent: "Co-author",
    edits: [{ old_string: "a", new_string: "b" }],
    collection_id: "__all__",
  };

  it("proposes as the panel on behalf of its human, from the editor session", async () => {
    mockPropose.mockResolvedValue({ kind: "proposed", pending: 1, run: { id: "run_1" } });
    expect((await post("/internal/propose-doc-edit", body)).body).toEqual({ kind: "proposed", pending: 1, run_id: "run_1" });
    const [ctx, input] = mockPropose.mock.calls[0]!;
    expect(ctx).toMatchObject({ alias: "panel:ada", isAgent: true, onBehalfOf: "ada", surface: "ws", workspaceId: "ws1" });
    expect(input).toMatchObject({ docId: "d2", action: "cited_edits", source: "panel" });
  });

  it("reports a proposal that committed at once as applied", async () => {
    mockPropose.mockResolvedValue({ kind: "auto_applied", run: { id: "run_1" } });
    expect((await post("/internal/propose-doc-edit", body)).body).toEqual({ kind: "auto_applied", run_id: "run_1" });
  });
});
