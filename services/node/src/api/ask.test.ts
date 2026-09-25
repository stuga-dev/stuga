/** POST /api/ask hands its tools the selected collection as a strict scope, and a read-only key asks and keeps its threads. */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@stuga/ai", async (orig) => ({
  ...(await orig<typeof import("@stuga/ai")>()),
  runAskAgentTurn: vi.fn(),
}));
vi.mock("@stuga/db", async (orig) => ({
  ...(await orig<typeof import("@stuga/db")>()),
  getCollection: vi.fn(),
  expandCollectionScope: vi.fn(),
  getWorkspace: vi.fn(),
  insertAiUsage: vi.fn(async () => {}),
  createAskThread: vi.fn(),
  getAskThread: vi.fn(),
  listAskTurns: vi.fn(async () => []),
  appendAskTurn: vi.fn(async () => {}),
  setAskThreadTitleIfEmpty: vi.fn(async () => {}),
  renameAskThread: vi.fn(),
  deleteAskThread: vi.fn(async () => {}),
}));
vi.mock("../agents/edits.js", () => ({
  readDocMarkdownWithProjection: vi.fn(async () => ({ markdown: "body", doc: { title: "Doc" } })),
  databaseDocMessage: (id: string) => `${id} is a database`,
}));

const { runAskAgentTurn } = await import("@stuga/ai");
const { getCollection, expandCollectionScope, getWorkspace, createAskThread, getAskThread, appendAskTurn, renameAskThread, deleteAskThread } =
  await import("@stuga/db");
const { routeWorkspaceRequest } = await import("../http/dispatch.js");
import type { AskToolRunner } from "@stuga/ai";
import type { Ctx } from "../auth/context.js";

const ctx = {
  sql: {},
  alias: "ada",
  displayName: "Ada",
  surface: "web",
  isAgent: false,
  principals: ["user:ada"],
  workspaceId: "ws1",
  role: "member",
  env: { jobs: { send: vi.fn(async () => {}) }, aiSettings: { current: () => ({ chat: { enabled: true }, embed: { enabled: true } }) } },
} as unknown as Ctx;

const reads: unknown[] = [];

async function send(caller: Ctx, method: string, path: string, body?: Record<string, unknown>): Promise<{ status: number; text: string }> {
  const init = body ? { method, body: JSON.stringify(body), headers: { "content-type": "application/json" } } : { method };
  const res = await routeWorkspaceRequest(caller, new Request(`https://node.test${path}`, init));
  return { status: res.status, text: await res.text() };
}

const ask = (body: Record<string, unknown>) => send(ctx, "POST", "/api/ask", body);

beforeEach(() => {
  vi.clearAllMocks();
  reads.length = 0;
  vi.mocked(getCollection).mockResolvedValue({ collection_id: "col_1", workspace_id: "ws1", owner: "ada", name: "Launch", created_at: "", updated_at: "" });
  vi.mocked(expandCollectionScope).mockResolvedValue(["d_in"]);
  vi.mocked(getWorkspace).mockResolvedValue({ workspace_id: "ws1", name: "Acme", agent_instructions: "" } as never);
  vi.mocked(runAskAgentTurn).mockImplementation(async (_cfg, input, runner: AskToolRunner) => {
    reads.push(input.scopeLabel, await runner.readDocument({ doc_id: "d_in" }), await runner.readDocument({ doc_id: "d_out" }));
    return { prose: "", citations: [], steps: [], usage: { inputTokens: 0, outputTokens: 0 }, modelId: "m", rounds: 1, stopReason: "complete" } as never;
  });
});

describe("POST /api/ask", () => {
  it("reads inside the selected collection and refuses outside it", async () => {
    const res = await ask({ question: "what launched?", collection_id: "col_1" });
    expect(res.status).toBe(200);
    expect(reads).toEqual([
      "the selected collection, and nothing outside it",
      { title: "Doc", text: "body", total: 4 },
      { error: "that document is not in the selected collection" },
    ]);
  });

  it("reads anything the asker can read without a collection", async () => {
    await ask({ question: "what launched?" });
    expect(reads[2]).toEqual({ title: "Doc", text: "body", total: 4 });
    expect(expandCollectionScope).not.toHaveBeenCalled();
  });

  it("hands the turn the asker's workspace's instructions, read per request", async () => {
    vi.mocked(getWorkspace).mockResolvedValue({ workspace_id: "ws1", name: "Acme", agent_instructions: "Answer in bullet points." } as never);
    await ask({ question: "what launched?" });
    expect(getWorkspace).toHaveBeenCalledWith(expect.anything(), "ws1");
    expect(vi.mocked(runAskAgentTurn).mock.calls[0]![1]).toMatchObject({ workspaceInstructions: "Answer in bullet points." });

    vi.mocked(getWorkspace).mockResolvedValue({ workspace_id: "ws1", name: "Acme", agent_instructions: "Answer in one line." } as never);
    await ask({ question: "and after?" });
    expect(vi.mocked(runAskAgentTurn).mock.calls[1]![1]).toMatchObject({ workspaceInstructions: "Answer in one line." });
  });

  it("still answers, without instructions, when the workspace cannot be read", async () => {
    vi.mocked(getWorkspace).mockRejectedValue(new Error("db down"));
    expect((await ask({ question: "what launched?" })).status).toBe(200);
    expect(vi.mocked(runAskAgentTurn).mock.calls[0]![1]).toMatchObject({ workspaceInstructions: "" });
  });

  it("answers 404 for a collection the asker does not own, before streaming", async () => {
    vi.mocked(getCollection).mockResolvedValue({ collection_id: "col_1", workspace_id: "ws1", owner: "grace", name: "x", created_at: "", updated_at: "" });
    expect((await ask({ question: "what launched?", collection_id: "col_1" })).status).toBe(404);
    expect(runAskAgentTurn).not.toHaveBeenCalled();
  });
});

describe("a read-only key", () => {
  const readOnlyKey = {
    ...ctx,
    alias: "agent-1",
    displayName: "Scout",
    surface: "api-key",
    isAgent: true,
    onBehalfOf: "ada",
    principals: ["agent:agent-1", "user:ada"],
    scope: { folders: null, readOnly: true, credentialId: "k1" },
  } as unknown as Ctx;
  const THREAD = { thread_id: "ask_1", workspace_id: "ws1", owner: "agent-1", title: "", collection_id: null, created_at: "", updated_at: "" };

  beforeEach(() => {
    vi.mocked(createAskThread).mockImplementation(async (_sql, input) => ({ ...THREAD, thread_id: input.threadId, owner: input.owner }));
    vi.mocked(getAskThread).mockResolvedValue(THREAD);
    vi.mocked(renameAskThread).mockImplementation(async (_sql, _id, title) => ({ ...THREAD, title }));
  });

  it("asks, and the turn is kept in a thread of its own", async () => {
    const created = await send(readOnlyKey, "POST", "/api/ask/threads", { title: "Research" });
    expect(created.status).toBe(201);
    expect(vi.mocked(createAskThread).mock.calls[0]![1]).toMatchObject({ owner: "agent-1", workspaceId: "ws1" });

    const asked = await send(readOnlyKey, "POST", "/api/ask", { question: "what launched?", thread_id: "ask_1" });
    expect(asked.status).toBe(200);
    expect(vi.mocked(appendAskTurn).mock.calls[0]![1]).toMatchObject({ threadId: "ask_1", question: "what launched?" });
  });

  it("renames and deletes its own threads, and cannot reach anyone else's", async () => {
    expect((await send(readOnlyKey, "PATCH", "/api/ask/threads/ask_1", { title: "Renamed" })).status).toBe(200);
    expect((await send(readOnlyKey, "DELETE", "/api/ask/threads/ask_1")).status).toBe(200);
    expect(deleteAskThread).toHaveBeenCalledWith(expect.anything(), "ask_1");

    vi.mocked(getAskThread).mockResolvedValue({ ...THREAD, owner: "ada" });
    expect((await send(readOnlyKey, "DELETE", "/api/ask/threads/ask_1")).status).toBe(404);
    expect(deleteAskThread).toHaveBeenCalledTimes(1);
  });
});
