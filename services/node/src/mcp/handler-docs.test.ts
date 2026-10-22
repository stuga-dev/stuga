/**
 * /mcp document creation and retrieval go through the same functions as REST:
 * documents/create for new rows, and the /api/search and /api/retrieve handlers
 * for ranking, collection scope and the embeddings gate, once per workspace a
 * call names.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@stuga/db", async (orig) => ({
  ...(await orig<typeof import("@stuga/db")>()),
  createDoc: vi.fn(),
  addComment: vi.fn(),
  getComment: vi.fn(async () => null),
  listComments: vi.fn(async () => []),
  getMembersByUsername: vi.fn(async () => []),
  getUserDisplayName: vi.fn(async () => "Ada"),
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
  waitingRuns: vi.fn(async () => new Map()),
  docAuthorship: vi.fn(async () => new Map()),
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

const {
  addComment,
  createDoc,
  getComment,
  getDoc,
  getFolder,
  getCollection,
  expandCollectionScope,
  getMembersByUsername,
  listComments,
  listFolders,
  listWorkspacesForUser,
  resolveDocInstructions,
  searchDocs,
  waitingRuns,
  docAuthorship,
} = await import("@stuga/db");
const { agentBudgetKey, agentNoticeBudget } = await import("../comments/budget.js");
const { DOCUMENT_BUSY, QUOTE_ANCHOR_WAIT_MS, QUOTE_NOT_ONCE } = await import("../comments/post.js");
const { retrieveAndRerank } = await import("../retrieval/retrieve.js");
const { proposeDocEdit } = await import("../agents/edits.js");
const { workspaceContextFor } = await import("../auth/context.js");
const { WORKSPACE_UNAVAILABLE_MESSAGE } = await import("./handler.js");
const { callerFor, resolvingTo, inWorkspace, callToolAs } = await import("./testing/call.js");
const { retrieve: restRetrieve, search: restSearch } = await import("../api/search.js");
import { EMPTY_SCOPE_NOTE, RETRIEVE_SEMANTIC_OFF_MESSAGE } from "@stuga/agent-surface/render/search";
import { NO_INSTRUCTIONS } from "@stuga/agent-surface/render/docs";
import type { Ctx } from "../auth/context.js";
import { actorsAnswering, agentCtx, fixed, nodeSettings, personCtx, recordingJobs, type CtxOverrides } from "../testing/ctx.js";

const mockCreateDoc = vi.mocked(createDoc);
const mockGetDoc = vi.mocked(getDoc);
const mockResolveInstructions = vi.mocked(resolveDocInstructions);
const mockGetFolder = vi.mocked(getFolder);
const mockGetCollection = vi.mocked(getCollection);
const mockExpandScope = vi.mocked(expandCollectionScope);
const mockRetrieve = vi.mocked(retrieveAndRerank);
const jobs = recordingJobs();

const FOLDER = {
  folder_id: "f1",
  workspace_id: "ws1",
  owner: "user:carol",
  acl_principals: ["user:carol", "user:human-1", "group:ws1:design", "agent:agent-1"],
  acl_writers: ["user:carol", "user:human-1", "agent:agent-1"],
};

let ai = { chat: { enabled: true }, embed: { enabled: true, model: "embed-1" } };

/** What the node asked a document's actor, by path. */
const actorFetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 204 }));

const env = () => ({
  jobs,
  docs: actorsAnswering(actorFetch),
  aiSettings: { current: () => ai },
  embeddingDims: 2,
  searchLanguages: fixed([]),
  settings: nodeSettings({ maxBodyBytes: 1_000_000 }),
});

const ctxOf = (overrides: CtxOverrides = {}): Ctx => agentCtx({ surface: "mcp", env: env(), ...overrides });
const human = () => personCtx({ surface: "mcp", displayName: "Connector", env: env() });

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
    const audit = jobs.audits();
    expect(audit.map((m) => m.action)).toEqual(["doc.create", "mcp.docs_create.create"]);
    expect(jobs.send).toHaveBeenCalledWith(expect.objectContaining({ kind: "event", type: "doc.created" }));
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

    // Off, an agent gets passages found by the question's words; a person's REST call is refused as before.
    ai = { chat: { enabled: true }, embed: { enabled: false, model: "embed-1" } };
    const off = await callTool(ctxOf(), "retrieve", { q: "expenses" });
    expect(off.isError).toBe(false);
    expect(JSON.parse(off.text)).toMatchObject({ passages: [{ doc_id: "d1" }], semantic: false, keyword_note: expect.any(String) });
    expect(mockRetrieve).toHaveBeenCalledTimes(2);
    expect(mockRetrieve.mock.calls[1]![0]).toMatchObject({ keywordOnly: true });
    expect(await restBody(restRetrieve, "/api/retrieve", ctxOf(), { q: "expenses" })).toEqual({ chunks: [], ai_disabled: true });
    expect(mockRetrieve).toHaveBeenCalledTimes(2);
    expect(RETRIEVE_SEMANTIC_OFF_MESSAGE).toMatch(/^Semantic search is off on this node\b/);
  });

  it("reports the same degraded and empty-scope facts as REST", async () => {
    mockGetCollection.mockResolvedValue({ collection_id: "c1", workspace_id: "ws1", owner: "human-1" } as never);
    mockExpandScope.mockResolvedValue([]);
    mockRetrieve.mockResolvedValue({ chunks: [], degraded: true } as never);
    const rest = await restBody(restRetrieve, "/api/retrieve", ctxOf(), { q: "expenses", collection_id: "c1" });
    const mcp = JSON.parse((await callTool(ctxOf(), "retrieve", { q: "expenses", collection_id: "c1" })).text);
    expect(rest).toMatchObject({ chunks: [], degraded: true, empty_scope: true });
    expect(mcp).toEqual({ passages: [], degraded: rest.degraded, unavailable: [], note: EMPTY_SCOPE_NOTE });
    // The languages are a getter each call makes its own, read as the query is built.
    const [restArgs, mcpArgs] = [mockRetrieve.mock.calls[0]![0], mockRetrieve.mock.calls[1]![0]];
    expect(restArgs).toEqual({ ...mcpArgs, searchLanguages: expect.any(Function) });
    expect(restArgs.searchLanguages()).toEqual(mcpArgs.searchLanguages());
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

  it("lists the user's own waiting changes on the passage holding what they replace, and counts others', for an agent only", async () => {
    ai = { chat: { enabled: true }, embed: { enabled: false, model: "embed-1" } };
    mockRetrieve.mockResolvedValue({
      chunks: [
        { doc_id: "d1", title: "Acme", chunk_index: 0, content: "## Contacts\n\n* Jonas Weber is the main contact.", heading_path: "Acme > Contacts" },
        { doc_id: "d1", title: "Acme", chunk_index: 1, content: "## Contract\n\n* The refund window is 14 days from delivery.", heading_path: "Acme > Contract" },
      ],
      degraded: false,
      whole: false,
    } as never);
    const run = (over: Record<string, unknown>) => ({ review_mode: "colleague", pending: 1, created_at: "2026-10-22T08:00:00.000Z", ...over });
    vi.mocked(docAuthorship).mockResolvedValue(
      new Map([
        [
          "d1",
          {
            doc_id: "d1",
            updated_at: "2026-10-22T07:00:00.000Z",
            last_edited_by: [{ kind: "person", name: "Liv" }],
            ai_changes: 0,
            ai_unreviewed: 0,
            // This agent's earlier change and another person's agent's, which is never read.
            waiting: [run({ run_id: "run_mine", agent_alias: "agent-1", reviewer: "human-1" }), run({ run_id: "run_sam", agent_alias: "agent-9", reviewer: "sam", pending: 2 })],
            level: { agent_mode: "colleague", folder_agent_mode: null, database_agent_mode: null, notes_shared: false },
          },
        ],
      ]) as never,
    );
    const actor = vi.fn(async (url: string) =>
      url.includes("/runs/detail")
        ? Response.json({
            hunks: [
              {
                id: "h1",
                old_string: "* The refund window is 14 days from delivery.",
                new_string: "* The refund window is 30 days from delivery.",
                status: "pending",
                review: "colleague",
              },
            ],
          })
        : Response.json({ markdown: "# Acme\n\n## Contacts\n\n* Jonas Weber is the main contact.\n\n## Contract\n\n* The refund window is 14 days from delivery." }),
    );
    const ctx = ctxOf();
    (ctx.env as unknown as Record<string, unknown>).docs = actorsAnswering(actor);
    const out = JSON.parse((await callTool(ctx, "retrieve", { q: "Acme refund window" })).text);
    const others = { asked_by: "others", waits_for: "colleague", changes: 2, since: "2026-10-22T08:00:00.000Z" };
    const mine = { asked_by: "user", waits_for: "colleague", changes: 1, since: "2026-10-22T08:00:00.000Z" };
    // On the passage holding the approved text it changes, as it would land; the other passage says it lists none of it.
    expect(out.passages[1].pending_changes).toEqual([
      { ...mine, proposed: [{ approved_now: "* The refund window is 14 days from delivery.", after_approval: "* The refund window is 30 days from delivery." }] },
      others,
    ]);
    expect(out.passages[0].pending_changes).toEqual([{ ...mine, note: "0 of 1 listed here; read the page for the rest." }, others]);
    expect(out).toMatchObject({ partial: true, partial_note: expect.stringContaining("another language") });
    // The approved text once, and only the user's own run: another person's is never read.
    const asked = actor.mock.calls.map(([url]) => url);
    expect(asked).toEqual(expect.arrayContaining([expect.stringContaining("runId=run_mine"), expect.not.stringContaining("runs/detail")]));
    expect(asked.filter((url) => url.includes("run_sam"))).toEqual([]);
    // A person's REST answer is as it was: no authorship, nothing waiting, no partial.
    const person = await restBody(restRetrieve, "/api/retrieve", human(), { q: "Acme refund window" });
    expect(person).toEqual({ chunks: [], ai_disabled: true });
    vi.mocked(docAuthorship).mockResolvedValue(new Map());
  });

  describe("the user's own waiting changes, as they would land", () => {
    // Globex in eval run 3: one run of four waiting changes, the refund window's last (#3, #11 twice, #12).
    const GLOBEX =
      "# Globex\n\nGlobex is a manufacturing group in Lyon and a customer since 2025.\n\n## Contacts\n\n" +
      "* Priya Shah, procurement lead, is the main contact.\n\n## Contract\n\n* Monthly contract, cancelled with 30 days' notice.\n\n" +
      "* The refund window is 7 days from delivery.\n\n## Facts\n\n* Globex prefers email to phone calls.";
    const hunk = (id: string, old_string: string, new_string: string) => ({ id, old_string, new_string, status: "pending", review: "colleague" });
    const GLOBEX_RUN = [
      hunk("h1", "* Globex prefers email to phone calls.", "* Globex prefers email to phone calls.\n\n* Globex wants invoices sent to ap@globex.example."),
      hunk("h2", "* Priya Shah, procurement lead, is the main contact.", "* Tom Becker is the main contact.\n\n* Priya Shah, procurement lead, is the main contact."),
      hunk("h3", "* Priya Shah, procurement lead, is the main contact.", "* Priya Shah, the previous main contact (procurement lead), has moved to the finance department."),
      hunk("h4", "* The refund window is 7 days from delivery.", "* The refund window is 14 days from delivery (customer sync, 2026-10-20)."),
    ];
    const passage = (heading_path: string, content: string, chunk_index: number) => ({ doc_id: "d1", title: "Globex", chunk_index, content, heading_path });
    const CONTRACT = passage("Globex > Contract", "## Contract\n\n* Monthly contract, cancelled with 30 days' notice.\n\n* The refund window is 7 days from delivery.", 2);
    const OPENING = passage("Globex", "# Globex\n\nGlobex is a manufacturing group in Lyon and a customer since 2025.", 0);
    const FACTS = passage("Globex > Facts", "## Facts\n\n* Globex prefers email to phone calls.", 3);
    const CONTACTS = passage("Globex > Contacts", "## Contacts\n\n* Priya Shah, procurement lead, is the main contact.", 1);
    const since = "2026-10-22T09:51:34.601Z";

    /** An agent whose user has one waiting run on d1, of `hunks` over `approved`, and the actor answering for it. */
    function waitingOn(approved: string, hunks: unknown[], pending = hunks.length): Ctx {
      vi.mocked(docAuthorship).mockResolvedValue(
        new Map([
          [
            "d1",
            {
              doc_id: "d1",
              updated_at: "2026-10-22T09:50:54.085Z",
              last_edited_by: [{ kind: "person", name: "Liv" }],
              ai_changes: 0,
              ai_unreviewed: 0,
              waiting: [{ run_id: "run_mine", agent_alias: "agent-1", reviewer: "human-1", review_mode: "colleague", pending, created_at: since }],
              level: { agent_mode: "colleague", folder_agent_mode: null, database_agent_mode: null, notes_shared: false },
            },
          ],
        ]) as never,
      );
      const ctx = ctxOf();
      (ctx.env as unknown as Record<string, unknown>).docs = actorsAnswering(
        vi.fn(async (url: string) => (url.includes("/runs/detail") ? Response.json({ hunks }) : Response.json({ markdown: approved }))),
      );
      return ctx;
    }

    afterEach(() => {
      vi.mocked(docAuthorship).mockResolvedValue(new Map());
    });

    it("lists every one of four, each on the passage it lands in, and says where some are not listed (eval run 3, #17)", async () => {
      ai = { chat: { enabled: true }, embed: { enabled: false, model: "embed-1" } };
      mockRetrieve.mockResolvedValue({ chunks: [CONTRACT, OPENING, FACTS, CONTACTS], degraded: false, whole: false } as never);
      const ctx = waitingOn(GLOBEX, GLOBEX_RUN);
      const out = JSON.parse((await callTool(ctx, "retrieve", { q: "Globex refund window" })).text);
      const mine = { asked_by: "user", waits_for: "colleague", changes: 4, since };
      const shown = (out.passages as Array<{ heading_path: string; pending_changes: unknown }>).map((p) => [p.heading_path, p.pending_changes]);
      expect(shown).toEqual([
        // The refund window's change, on the very passage that says 7 days.
        [
          "Globex > Contract",
          [
            {
              ...mine,
              proposed: [
                { approved_now: "* The refund window is 7 days from delivery.", after_approval: "* The refund window is 14 days from delivery (customer sync, 2026-10-20)." },
              ],
              note: "1 of 4 listed here; read the page for the rest.",
            },
          ],
        ],
        ["Globex", [{ ...mine, note: "0 of 4 listed here; read the page for the rest." }]],
        // An addition on the passage it is added to, never on the document's first.
        [
          "Globex > Facts",
          [{ ...mine, proposed: [{ approved_now: "", after_approval: "* Globex wants invoices sent to ap@globex.example." }], note: "1 of 4 listed here; read the page for the rest." }],
        ],
        [
          "Globex > Contacts",
          [
            {
              ...mine,
              proposed: [
                { approved_now: "", after_approval: "* Tom Becker is the main contact." },
                {
                  approved_now: "* Priya Shah, procurement lead, is the main contact.",
                  after_approval: "* Priya Shah, the previous main contact (procurement lead), has moved to the finance department.",
                },
              ],
              note: "2 of 4 listed here; read the page for the rest.",
            },
          ],
        ],
      ]);
    });

    it("lists a change about the question that lands in no passage found on the document's first, naming its section", async () => {
      ai = { chat: { enabled: true }, embed: { enabled: false, model: "embed-1" } };
      mockRetrieve.mockResolvedValue({ chunks: [CONTRACT], degraded: false, whole: false } as never);
      const out = JSON.parse((await callTool(waitingOn(GLOBEX, GLOBEX_RUN), "retrieve", { q: "Globex invoices and refunds" })).text);
      expect(out.passages[0].pending_changes).toEqual([
        {
          asked_by: "user",
          waits_for: "colleague",
          changes: 4,
          since,
          proposed: [
            { approved_now: "* The refund window is 7 days from delivery.", after_approval: "* The refund window is 14 days from delivery (customer sync, 2026-10-20)." },
            { approved_now: "", after_approval: "* Globex wants invoices sent to ap@globex.example.", section: "Globex > Facts" },
          ],
          note: "2 of 4 listed here; read the page for the rest.",
        },
      ]);
    });

    it("lists those about the question first when more wait than a document lists, and says how many are left out", async () => {
      // Eight lines, each changed; the refund window's last.
      const lines = [...Array.from({ length: 7 }, (_, i) => `* Rule ${i + 1} applies on day ${i + 1}.`), "* The refund window is 7 days from delivery."];
      const approved = `# Policy\n\n## Rules\n\n${lines.join("\n\n")}`;
      const hunks = lines.map((line, i) => hunk(`h${i + 1}`, line, line.replace(/(\d+) (days|applies)/, (_m, n: string, w: string) => `${Number(n) * 2} ${w}`)));
      vi.mocked(searchDocs).mockResolvedValue([
        { doc_id: "d1", title: "Policy", doc_type: "prose", page_of: null, page_row: null, updated_at: since, snippet: "", kw_rank: 1, kw_whole: true, sem_score: 0, score: 0.03 },
      ] as never);
      const out = JSON.parse((await callTool(waitingOn(approved, hunks), "search", { q: "refund window" })).text);
      const [group] = out.results[0].pending_changes;
      expect(group.changes).toBe(8);
      expect(group.proposed).toHaveLength(6);
      expect(group.proposed[0]).toEqual({ approved_now: "* The refund window is 7 days from delivery.", after_approval: "* The refund window is 14 days from delivery." });
      expect(group.note).toBe("6 of 8 listed; read the page for the rest.");
    });

    it("tells a change to the run's own waiting text as one change on a page with no approved text (eval run 3, #19)", async () => {
      // The agent appended a sentence twice, then removed the first copy: an edit of its own waiting text.
      const run = [
        hunk("h1", "", "Initech is a new customer.\n\n## Contacts\n\n* Ana Ruiz is the contact person at Initech.\n\n## Facts\n\n* Initech is a new customer."),
        hunk("h2", "Initech is a new customer.\n\n", ""),
      ];
      vi.mocked(searchDocs).mockResolvedValue([
        { doc_id: "d1", title: "Initech", doc_type: "prose", page_of: null, page_row: null, updated_at: since, snippet: "", kw_rank: 1, kw_whole: true, sem_score: 0, score: 0.03 },
      ] as never);
      const out = JSON.parse((await callTool(waitingOn("", run), "search", { q: "Initech" })).text);
      expect(out.results[0].pending_changes).toEqual([
        {
          asked_by: "user",
          waits_for: "colleague",
          changes: 1,
          since,
          proposed: [
            { approved_now: "", after_approval: "## Contacts\n\n* Ana Ruiz is the contact person at Initech.\n\n## Facts\n\n* Initech is a new customer." },
          ],
        },
      ]);
      expect(JSON.stringify(out)).not.toContain('"approved_now":"Initech is a new customer.');
    });
  });

  it("answers with the refusal when the only workspace named is out of reach", async () => {
    const r = await callTool(ctxOf(), "retrieve", { workspace_ids: ["ws2"], q: "expenses" });
    expect(r).toEqual({ isError: true, text: `error: ${WORKSPACE_UNAVAILABLE_MESSAGE}` });
    expect(mockRetrieve).not.toHaveBeenCalled();
  });
});

describe("search", () => {
  const HIT = { doc_id: "d1", title: "Handbook", doc_type: "prose" as const, page_of: null, page_row: null, updated_at: "2026-10-01T09:00:00.000Z", snippet: "Expenses are filed", kw_rank: 3.2, kw_whole: true, sem_score: 0.8, score: 0.03 };

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

  it("falls back for an agent to the documents holding some of the words, and says so; a person's search keeps every word", async () => {
    const some = { ...HIT, doc_id: "d2", kw_whole: false, kw_rank: 1.4 };
    vi.mocked(searchDocs).mockImplementation(async (_sql, input) => (input.anyWord ? [some] : []));
    const mcp = JSON.parse((await callTool(ctxOf(), "search", { q: "travel expense reimbursement" })).text);
    expect(mcp).toMatchObject({ results: [{ doc_id: "d2" }], partial: true, partial_note: expect.stringContaining("No document holds every word") });
    expect(vi.mocked(searchDocs).mock.calls.map(([, input]) => input.anyWord === true)).toEqual([false, true]);

    vi.mocked(searchDocs).mockClear();
    const rest = await restBody(restSearch, "/api/search", ctxOf(), { q: "travel expense reimbursement" });
    expect(rest).toEqual({ query: "travel expense reimbursement", results: [], degraded: false, semantic: true });
    expect(vi.mocked(searchDocs)).toHaveBeenCalledTimes(1);

    // A document holding every word answers as it is; one holding none of them is no fallback either.
    vi.mocked(searchDocs).mockReset();
    vi.mocked(searchDocs).mockResolvedValue([HIT]);
    expect(JSON.parse((await callTool(ctxOf(), "search", { q: "expenses" })).text)).not.toHaveProperty("partial");
    expect(vi.mocked(searchDocs)).toHaveBeenCalledTimes(1);
    vi.mocked(searchDocs).mockReset();
    vi.mocked(searchDocs).mockResolvedValue([]);
    expect(JSON.parse((await callTool(ctxOf(), "search", { q: "zebra" })).text)).not.toHaveProperty("partial");
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

  it("markdown read tells the agent's own waiting changes from the approved text, lists the user's other agents' and counts others'", async () => {
    // The item is at `colleague` now, so a change proposed at `review` waits for a colleague too.
    mockGetDoc.mockResolvedValue({ ...DOC, agent_mode: "colleague" } as never);
    vi.mocked(waitingRuns).mockResolvedValueOnce(
      new Map([
        [
          "d1",
          [
            { run_id: "run_1", agent_alias: "agent-1", reviewer: "human-1", review_mode: "review", pending: 1, created_at: "2026-10-21T08:00:00.000Z" },
            { run_id: "run_2", agent_alias: "agent-2", reviewer: "sam", review_mode: "review", pending: 2, created_at: "2026-10-20T09:00:00.000Z" },
            // The same person's in-app co-author: theirs, listed, and not laid over this agent's read.
            { run_id: "run_3", agent_alias: "panel:human-1", reviewer: "human-1", review_mode: "review", pending: 1, created_at: "2026-10-19T09:00:00.000Z" },
          ],
        ],
      ]),
    );
    const markdown = "# Q3 plan\n\nThe refund window is 30 days.";
    const approved = "# Q3 plan\n\nThe refund window is 14 days.";
    const fetch = vi.fn(async (url: string) =>
      url.includes("/runs/detail")
        ? new Response(
            JSON.stringify({
              run: { id: "run_3" },
              hunks: [
                { id: "h1", old_string: "# Q3 plan", new_string: "# Q3 plan\n\nOwner: finance.", status: "pending", review: "review" },
                { id: "h2", old_string: "gone", new_string: "", status: "rejected", review: "review" },
              ],
            }),
          )
        : new Response(
            JSON.stringify({
              markdown,
              run_id: "run_1",
              pending: 1,
              pending_hunks: [{ id: "h1", old_string: "The refund window is 14 days.", new_string: "The refund window is 30 days.", review: "review" }],
              approved_markdown: approved,
              run_created_at: Date.parse("2026-10-21T08:00:00.000Z"),
              run_review_mode: "review",
            }),
          ),
    );
    const ctx = ctxOf();
    (ctx.env as unknown as Record<string, unknown>).docs = { get: () => ({ fetch }) };
    const r = await callTool(ctx, "markdown", { action: "read", doc_id: "d1" });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/^=== CHANGES NOT APPROVED YET \(from Stuga, not part of the document\) ===\n/);
    expect(r.text).toContain("(run run_1, since 2026-10-21): the user's own changes, not someone else's");
    expect(r.text).toContain(
      '1. Waits for a colleague\'s approval (someone other than the user). Approved now: "The refund window is 14 days." → after approval: "The refund window is 30 days."',
    );
    // The co-author's change, told against the approved text the read's own changes are laid over.
    expect(r.text).toContain(
      "Also waiting, and NOT in the text below: 1 change(s) the user asked for through another of their agents or their AI co-author, " +
        'for a colleague\'s approval (someone other than the user), since 2026-10-19:\n- Approved now: nothing (it adds) → after approval: "Owner: finance."',
    );
    expect(r.text).toContain("Also waiting, and NOT in the text below: 2 change(s) proposed by others, for a colleague's approval, since 2026-10-20.");
    expect(r.text.indexOf("=== END OF CHANGES NOT APPROVED YET")).toBeLessThan(r.text.indexOf("=== INSTRUCTIONS"));
    // The laid-over text stays exactly as read, so an edit's `find` still lines up with it.
    expect(r.text.endsWith(`===\n\n${markdown}`)).toBe(true);
    expect(fetch.mock.calls[0]![0]).toContain("agent=agent-1");
    // Only the user's own other run is read; another person's never is.
    const details = fetch.mock.calls.map(([url]) => url).filter((url) => url.includes("/runs/detail"));
    expect(details).toEqual([expect.stringContaining("runId=run_3")]);
  });

  it("markdown read tells a change to the agent's own waiting text as one with it, on a page with no approved text (eval run 3, #19)", async () => {
    mockGetDoc.mockResolvedValue({ ...DOC, agent_mode: "colleague" } as never);
    const markdown = "## Contacts\n\n* Ana Ruiz is the contact person at Initech.\n\n## Facts\n\n* Initech is a new customer.";
    const fetch = vi.fn(async (url: string) =>
      url.includes("agent=")
        ? Response.json({
            markdown,
            run_id: "run_1",
            pending: 2,
            pending_hunks: [
              { id: "h1", old_string: "", new_string: `Initech is a new customer.\n\n${markdown}`, review: "colleague" },
              { id: "h2", old_string: "Initech is a new customer.\n\n", new_string: "", review: "colleague" },
            ],
            approved_markdown: "",
            run_created_at: Date.parse("2026-10-22T09:51:56.007Z"),
            run_review_mode: "colleague",
          })
        : Response.json({ markdown: "" }),
    );
    const ctx = ctxOf();
    (ctx.env as unknown as Record<string, unknown>).docs = { get: () => ({ fetch }) };
    const r = await callTool(ctx, "markdown", { action: "read", doc_id: "d1" });
    expect(r.text).toContain("The text below is NOT the approved text: it reads as it will once 1 change(s) the user asked for are approved.");
    expect(r.text).toContain(
      `1. Waits for a colleague's approval (someone other than the user). Approved now: nothing (the page has no approved text yet) → after approval: ${JSON.stringify(markdown)}`,
    );
    // Its own first sentence, which it removed again, is never told as approved text.
    expect(r.text).not.toContain("Removes");
    expect(r.text).not.toContain('Approved now: "Initech is a new customer.');
    expect(r.text.endsWith(`===\n\n${markdown}`)).toBe(true);
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
      {
        ...FOLDER,
        parent_id: null,
        title: "Legal",
        inherits_perms: true,
        own_grants: { p: [], w: [], c: [] },
        agent_instructions: "Never promise dates.",
        agent_mode: null,
        approver_group: null,
        parent_agent_mode: null,
        created_at: "t0",
        updated_at: "t1",
      },
    ] as never);
    const r = await callTool(ctxOf(), "folders", {});
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.text)).toEqual({
      folders: [
        {
          folder_id: "f1",
          parent_id: null,
          title: "Legal",
          owner: "user:carol",
          created_at: "t0",
          updated_at: "t1",
          // How AI edits beneath it are reviewed, which an agent may read like anyone who can see the folder.
          agent_mode: "review",
          agent_mode_floor: null,
          approver_group: null,
        },
      ],
    });
  });
});

describe("comments_add", () => {
  const DOC = {
    doc_id: "d1",
    workspace_id: "ws1",
    owner: "user:human-1",
    title: "Renovation",
    doc_type: "prose",
    trashed: false,
    acl_principals: ["user:human-1", "agent:agent-1", "org:ws1"],
    acl_writers: ["user:human-1", "agent:agent-1"],
    acl_commenters: [],
  };
  const ROOT = { doc_id: "d1", num: 3, parent_num: null, author: "u_bob", resolved: false, created_at: "2026-10-03T10:00:00Z" };
  /** What the node asked the document's actor to anchor, by quote. */
  const quotesAsked = () =>
    actorFetch.mock.calls.filter(([url]) => new URL(url).pathname === "/quote-anchor").map(([, init]) => JSON.parse(String(init!.body)).quote);

  beforeEach(() => {
    mockGetDoc.mockResolvedValue(DOC as never);
    vi.mocked(addComment).mockImplementation(async (_sql, input) => ({ num: 4, parent_num: input.parentNum ?? null, author: input.author, body: input.body }) as never);
    vi.mocked(getComment).mockImplementation(async (_sql, _doc, num) => (num === 3 ? (ROOT as never) : null));
    vi.mocked(listComments).mockResolvedValue([ROOT] as never);
  });

  afterEach(() => {
    actorFetch.mockReset().mockImplementation(async () => new Response(null, { status: 204 }));
  });

  it("tells the document's open pages, as a person's comment does", async () => {
    const r = await callTool(ctxOf(), "comments_add", { doc_id: "d1", body: "Looks good" });
    expect(r.isError).toBe(false);
    expect(actorFetch.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(["/comments-changed"]);
  });

  it("replies in a thread, telling the thread's first commenter, and the owner it works for, as the person's agent", async () => {
    const r = await callTool(ctxOf(), "comments_add", { doc_id: "d1", body: "Done.", parent_num: 3 });
    expect(JSON.parse(r.text)).toEqual({ num: 4, parent_num: 3, author: "agent-1", body: "Done." });
    expect(jobs.sent().filter((m) => m.kind === "notify")).toEqual([
      expect.objectContaining({ recipient: "u_bob", eventType: "COMMENT_REPLY", params: expect.objectContaining({ actor: { agent_of: "Ada" }, relation: "comment" }) }),
      expect.objectContaining({ recipient: "human-1", eventType: "COMMENT_ON_OWNED_DOC", params: expect.objectContaining({ actor: { agent_of: "Ada" }, kind: "reply" }) }),
    ]);
  });

  it("starts a thread on a passage the document has exactly once, as written", async () => {
    actorFetch.mockImplementation(async (url: string) =>
      new URL(url).pathname === "/quote-anchor" ? Response.json({ anchor: { start: "s1", end: "e1", quote: "bathtub" } }) : new Response(null, { status: 204 }),
    );
    const r = await callTool(ctxOf(), "comments_add", { doc_id: "d1", body: "Built-in or freestanding?", quote: "bathtub" });
    expect(r.isError).toBe(false);
    expect(quotesAsked()).toEqual(["bathtub"]);
    expect(vi.mocked(addComment).mock.calls[0]![1]).toMatchObject({ parentNum: null, anchorStart: "s1", anchorEnd: "e1", anchorQuote: "bathtub" });
  });

  it("refuses a quote the document has not exactly as written, and saves nothing", async () => {
    actorFetch.mockImplementation(async () => Response.json({ anchor: { start: "s1", end: "e1", quote: "it’s built in" } }));
    const r = await callTool(ctxOf(), "comments_add", { doc_id: "d1", body: "Sure?", quote: "it's built in" });
    expect(r).toEqual({ isError: true, text: `error: ${QUOTE_NOT_ONCE}` });
    expect(addComment).not.toHaveBeenCalled();
  });

  it("refuses a quote on a reply before asking the document", async () => {
    const r = await callTool(ctxOf(), "comments_add", { doc_id: "d1", body: "Yes.", parent_num: 3, quote: "bathtub" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("not both");
    expect(quotesAsked()).toEqual([]);
    expect(addComment).not.toHaveBeenCalled();
  });

  it("says the document is busy when its actor does not answer in time", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      actorFetch.mockImplementation(() => new Promise<Response>(() => {}));
      const pending = callTool(ctxOf(), "comments_add", { doc_id: "d1", body: "Sure?", quote: "bathtub" });
      await vi.advanceTimersByTimeAsync(QUOTE_ANCHOR_WAIT_MS);
      expect(await pending).toEqual({ isError: true, text: `error: ${DOCUMENT_BUSY}` });
      expect(addComment).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a sixth mention", async () => {
    vi.mocked(getMembersByUsername).mockImplementationOnce(async (_sql, usernames) => usernames.map((u) => ({ alias: `u_${u}`, username: u })));
    const r = await callTool(ctxOf(), "comments_add", { doc_id: "d1", body: "@ann @ben @cat @dan @eli @fox" });
    expect(r).toEqual({ isError: true, text: "error: an agent's comment may mention at most 5 people" });
    expect(addComment).not.toHaveBeenCalled();
  });

  it("says how many notices it held once its person's agents used the hour's allowance", async () => {
    agentNoticeBudget.reserve(agentBudgetKey("ws1", "human-9"), 60);
    const r = await callTool(ctxOf({ onBehalfOf: "human-9", principals: ["agent:agent-1", "user:human-9", "org:ws1"] }), "comments_add", {
      doc_id: "d1",
      body: "Done.",
      parent_num: 3,
    });
    expect(JSON.parse(r.text)).toMatchObject({ num: 4, notifications_held: 2 });
    expect(jobs.sent().filter((m) => m.kind === "notify")).toEqual([]);
  });
});

describe("comments", () => {
  it("marks the comments the agent wrote", async () => {
    mockGetDoc.mockResolvedValue({ doc_id: "d1", workspace_id: "ws1", doc_type: "prose", acl_principals: ["agent:agent-1"] } as never);
    vi.mocked(listComments).mockResolvedValue([
      { num: 1, parent_num: null, author: "u_bob", body: "Tiles?" },
      { num: 2, parent_num: 1, author: "agent-1", body: "White." },
    ] as never);
    const r = await callTool(ctxOf(), "comments", { doc_id: "d1" });
    expect(JSON.parse(r.text)).toEqual({
      comments: [
        { num: 1, parent_num: null, author: "u_bob", body: "Tiles?" },
        { num: 2, parent_num: 1, author: "agent-1", body: "White.", you: true },
      ],
    });
  });
});
