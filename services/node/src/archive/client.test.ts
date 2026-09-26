/** The import client: writes go through the web app's routes as the person importing, and wait out the database actor's budget. */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@stuga/db", async (orig) => ({
  ...(await orig<typeof import("@stuga/db")>()),
  getDoc: vi.fn(),
  touchDoc: vi.fn(async () => {}),
  getMemberRole: vi.fn(),
  getWorkspace: vi.fn(async () => ({ workspace_id: "ws1", name: "Acme", agent_instructions: "" })),
  updateWorkspaceSettings: vi.fn(async () => ({ workspace_id: "ws1", name: "Acme", agent_instructions: "Cite." })),
  importComments: vi.fn(async () => {}),
}));
vi.mock("../documents/create.js", async (orig) => ({
  ...(await orig<typeof import("../documents/create.js")>()),
  seedBody: vi.fn(async () => true),
}));

const { getDoc, getMemberRole, importComments, updateWorkspaceSettings } = await import("@stuga/db");
const { seedBody } = await import("../documents/create.js");
const { ImportWriteError, workspaceImportClient } = await import("./client.js");
import type { ImportedComment } from "@stuga/db";
import type { Ctx } from "../auth/context.js";

const mockGetDoc = getDoc as unknown as ReturnType<typeof vi.fn>;
const mockRole = getMemberRole as unknown as ReturnType<typeof vi.fn>;
const mockUpdate = updateWorkspaceSettings as unknown as ReturnType<typeof vi.fn>;
const mockSeed = seedBody as unknown as ReturnType<typeof vi.fn>;
const mockImportComments = importComments as unknown as ReturnType<typeof vi.fn>;

const DB = {
  doc_id: "db1",
  workspace_id: "ws1",
  owner: "user:u_liv",
  title: "Obligations",
  doc_type: "database",
  trashed: false,
  locked: false,
  parent_id: null,
  acl_principals: ["user:u_liv"],
  acl_writers: ["user:u_liv"],
  acl_commenters: [],
};

const PLAN = { ...DB, doc_id: "d1", title: "Plan", doc_type: "prose" };

/** The actor's answers to rows/insert, one per call, and the bodies it received. */
let answers: Array<{ status: number; body: unknown }>;
let inserts: Array<Record<string, unknown>>;

function ctxOf(): Ctx {
  const actor = {
    fetch: async (_url: string, init?: RequestInit) => {
      inserts.push(JSON.parse(init!.body as string) as Record<string, unknown>);
      const next = answers.length > 1 ? answers.shift()! : answers[0]!;
      return new Response(JSON.stringify(next.body), { status: next.status });
    },
  };
  return {
    sql: {},
    surface: "web",
    alias: "u_liv",
    displayName: "Liv",
    isAgent: false,
    principals: ["user:u_liv"],
    workspaceId: "ws1",
    role: "owner",
    env: {
      databases: { get: () => actor },
      settings: { current: () => ({ databaseOpsKeep: 500 }) },
      jobs: { send: vi.fn(async () => {}) },
    },
  } as unknown as Ctx;
}

const RATE_LIMITED = { status: 429, body: { error: "rate_limited", message: "too many mutations (max 120/min per actor)" } };
const INSERTED = { status: 200, body: { inserted: 2, row_ids: ["row_a", "row_b"] } };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetDoc.mockResolvedValue({ ...DB });
  mockRole.mockResolvedValue("owner");
  answers = [INSERTED];
  inserts = [];
});

describe("the import client", () => {
  it("writes through the web app's routes as the person, and a refusal names the route and its reason", async () => {
    const client = workspaceImportClient(ctxOf());
    await client.setWorkspaceInstructions("Cite.");
    expect(mockUpdate.mock.calls[0]![1]).toBe("ws1");
    expect(mockUpdate.mock.calls[0]![2]).toEqual({ agentInstructions: "Cite." });

    mockRole.mockResolvedValue("member");
    const err = await client.setWorkspaceInstructions("Cite.").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImportWriteError);
    expect(err).toMatchObject({ status: 403, message: "PATCH /api/workspaces/ws1: only a workspace owner or admin can change settings" });
  });

  it("lands rows as one import write and hands back their ids in order", async () => {
    const client = workspaceImportClient(ctxOf());
    const ids = await client.insertRows("db1", { table_id: "t1", display: "Main" }, [{ c1: "a" }, { c1: "b" }]);
    expect(ids).toEqual(["row_a", "row_b"]);
    expect(inserts).toEqual([expect.objectContaining({ table_id: "t1", rows: [{ c1: "a" }, { c1: "b" }], import: true, actor: { alias: "u_liv", is_agent: false } })]);
  });

  it("waits out the database actor's per-minute budget and tries the write again", async () => {
    answers = [RATE_LIMITED, INSERTED];
    const waits: number[] = [];
    const client = workspaceImportClient(ctxOf(), { sleep: async (ms) => void waits.push(ms) });
    expect(await client.insertRows("db1", { table_id: "t1", display: "Main" }, [{ c1: "a" }, { c1: "b" }])).toEqual(["row_a", "row_b"]);
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThan(60_000);
    expect(inserts).toHaveLength(2);
  });

  it("gives up when the write is refused again after a whole window", async () => {
    answers = [RATE_LIMITED];
    const waits: number[] = [];
    const client = workspaceImportClient(ctxOf(), { sleep: async (ms) => void waits.push(ms) });
    const err = await client.insertRows("db1", { table_id: "t1", display: "Main" }, [{ c1: "a" }]).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 429 });
    expect(waits).toHaveLength(1);
    expect(inserts).toHaveLength(2);
  });

  it("sends nothing once the import is stopped, and a wait for the budget ends at once", async () => {
    answers = [RATE_LIMITED, INSERTED];
    const stop = new AbortController();
    const client = workspaceImportClient(ctxOf(), { signal: stop.signal });
    const waiting = client.insertRows("db1", { table_id: "t1", display: "Main" }, [{ c1: "a" }]);
    await vi.waitFor(() => expect(inserts).toHaveLength(1));
    stop.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    await expect(client.setWorkspaceInstructions("Cite.")).rejects.toMatchObject({ name: "AbortError" });
    expect(inserts).toHaveLength(1);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("seeds a body, saved before it returns, only into a document the person may write, unlocked and not a database, and says when the seed fails", async () => {
    const client = workspaceImportClient(ctxOf());
    mockGetDoc.mockResolvedValue({ ...PLAN });
    await client.seedBody("d1", "# Plan");
    expect(mockSeed).toHaveBeenCalledWith(expect.anything(), "d1", "# Plan", { flush: true });
    mockSeed.mockClear();

    const refused: Array<[object, number]> = [
      [{ ...PLAN, locked: true }, 403],
      [{ ...PLAN, acl_writers: [] }, 403],
      [{ ...PLAN, acl_principals: ["user:u_other"] }, 404],
      [{ ...DB }, 404],
    ];
    for (const [doc, status] of refused) {
      mockGetDoc.mockResolvedValue(doc);
      await expect(client.seedBody("d1", "# Plan"), JSON.stringify(doc)).rejects.toMatchObject({ status });
    }
    expect(mockSeed).not.toHaveBeenCalled();

    mockGetDoc.mockResolvedValue({ ...PLAN });
    mockSeed.mockResolvedValueOnce(false);
    await expect(client.seedBody("d1", "# Plan")).rejects.toMatchObject({ status: 502, message: "document d1: could not write the body" });
  });

  it("adds comments only where the person may comment", async () => {
    const client = workspaceImportClient(ctxOf());
    const comments: ImportedComment[] = [
      { num: 1, parentNum: null, authorName: "Ada", body: "Is this final?", anchorQuote: null, resolved: false, createdAt: "2026-09-21T10:00:00Z" },
    ];
    const refused: Array<[object, number]> = [
      [{ ...PLAN, acl_writers: [], acl_commenters: [] }, 403],
      [{ ...PLAN, acl_principals: ["user:u_other"] }, 404],
    ];
    for (const [doc, status] of refused) {
      mockGetDoc.mockResolvedValue(doc);
      await expect(client.importComments("d1", comments), JSON.stringify(doc)).rejects.toMatchObject({ status });
    }
    expect(mockImportComments).not.toHaveBeenCalled();

    mockGetDoc.mockResolvedValue({ ...PLAN, acl_writers: [], acl_commenters: ["user:u_liv"] });
    await client.importComments("d1", comments);
    expect(mockImportComments).toHaveBeenCalledWith(expect.anything(), "d1", comments);
  });

  it("refuses a database the person may not write, or that is locked, without reaching the actor", async () => {
    const client = workspaceImportClient(ctxOf());
    mockGetDoc.mockResolvedValue({ ...DB, locked: true });
    await expect(client.insertRows("db1", { table_id: "t1", display: "Main" }, [{ c1: "a" }])).rejects.toMatchObject({ status: 403 });
    mockGetDoc.mockResolvedValue({ ...DB, acl_writers: [] });
    await expect(client.openRowPages("db1", "t1", [{ rowId: "row_a", title: "A" }])).rejects.toMatchObject({ status: 403 });
    expect(inserts).toEqual([]);
  });
});
