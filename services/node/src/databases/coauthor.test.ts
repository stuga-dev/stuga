import { describe, expect, it, vi } from "vitest";

vi.mock("@stuga/ai", async (orig) => ({
  ...(await orig<typeof import("@stuga/ai")>()),
  runTableAgentTurn: vi.fn(),
}));
vi.mock("@stuga/db", async (orig) => ({
  ...(await orig<typeof import("@stuga/db")>()),
  getCollection: vi.fn(),
  expandCollectionScope: vi.fn(),
  resolveDocInstructions: vi.fn(),
  touchDoc: vi.fn(async () => {}),
  insertAiUsage: vi.fn(async () => {}),
}));
vi.mock("../retrieval/retrieve.js", () => ({ retrieveAndRerank: vi.fn(async () => ({ chunks: [], degraded: false })) }));

const { runTableAgentTurn } = await import("@stuga/ai");
const { getCollection, expandCollectionScope, resolveDocInstructions } = await import("@stuga/db");
const { retrieveAndRerank } = await import("../retrieval/retrieve.js");
const { databaseCoauthor, tableToolRunner } = await import("./coauthor.js");
import type { DocRow } from "@stuga/db";
import type { InstructionLevel } from "@stuga/protocol/domain/instructions";
import type { Ctx } from "../auth/context.js";
import type { DatabaseCall } from "./routes.js";

function ctxWithActor(answer: () => Response): Ctx {
  return {
    sql: {},
    alias: "bob",
    isAgent: false,
    principals: ["user:bob"],
    workspaceId: "ws1",
    env: {
      databases: { get: () => ({ fetch: vi.fn(async () => answer()) }) },
      settings: { current: () => ({ databaseOpsKeep: 500 }) },
    },
  } as unknown as Ctx;
}

const DOC = { doc_id: "db1", title: "Projects" } as DocRow;
const AI = {} as never;

describe("the table co-author's query tool", () => {
  it("returns the actor's rows as they came", async () => {
    const { runner } = tableToolRunner(ctxWithActor(() => new Response('{"rows":[[1]]}')), DOC, AI, null);
    expect(await runner.query({ sql: "SELECT 1" })).toBe('{"rows":[[1]]}');
  });

  it("hands a refusal back as text the model can act on", async () => {
    const refusal = () => new Response(JSON.stringify({ message: "no such column: nme" }), { status: 400 });
    const { runner } = tableToolRunner(ctxWithActor(refusal), DOC, AI, null);
    expect(await runner.query({ sql: "SELECT nme FROM t" })).toBe("error: no such column: nme");
  });

  it("does not throw on an error body that is not JSON", async () => {
    const { runner } = tableToolRunner(ctxWithActor(() => new Response("upstream exploded", { status: 502 })), DOC, AI, null);
    await expect(runner.query({ sql: "SELECT 1" })).resolves.toBe("error: query failed (502)");
  });

  it("refuses a write before reaching the actor", async () => {
    const answer = vi.fn(() => new Response("{}"));
    const { runner } = tableToolRunner(ctxWithActor(answer), DOC, AI, null);
    expect(await runner.query({ sql: "DELETE FROM t" })).toMatch(/^error: /);
    expect(answer).not.toHaveBeenCalled();
  });

  it("offers collection search only when a collection is selected", () => {
    expect(tableToolRunner(ctxWithActor(() => new Response("{}")), DOC, AI, null).runner.searchCollection).toBeUndefined();
    expect(tableToolRunner(ctxWithActor(() => new Response("{}")), DOC, AI, "col1").runner.searchCollection).toBeTypeOf("function");
  });
});

describe("the table co-author's collection search", () => {
  const ctx = () => ({ ...ctxWithActor(() => new Response("{}")), env: { embeddingDims: 2, searchLanguages: [] } }) as unknown as Ctx;
  const COLLECTION = { collection_id: "col1", workspace_id: "ws1", owner: "bob", name: "Specs", created_at: "", updated_at: "" };

  it("searches exactly the selected collection's documents", async () => {
    vi.mocked(getCollection).mockResolvedValue(COLLECTION);
    vi.mocked(expandCollectionScope).mockResolvedValue(["d1"]);
    await tableToolRunner(ctx(), DOC, AI, "col1").runner.searchCollection!({ query: "pricing" });
    expect(expandCollectionScope).toHaveBeenCalledWith({}, "col1", { principals: ["user:bob"], workspaceId: "ws1", scopeFolderIds: null });
    expect(retrieveAndRerank).toHaveBeenCalledWith(expect.objectContaining({ scopeDocIds: ["d1"] }));
  });

  it("refuses a collection the person does not own instead of searching everything", async () => {
    vi.mocked(retrieveAndRerank).mockClear();
    vi.mocked(getCollection).mockResolvedValue({ ...COLLECTION, owner: "grace" });
    const out = await tableToolRunner(ctx(), DOC, AI, "col1").runner.searchCollection!({ query: "pricing" });
    expect(out).toEqual({ text: "That collection is not available.", citations: [] });
    expect(retrieveAndRerank).not.toHaveBeenCalled();
  });
});

describe("a table co-author turn", () => {
  const LEVELS: InstructionLevel[] = [
    { kind: "workspace", id: "ws1", title: "Acme", text: "Dates are ISO 8601." },
    { kind: "database", id: "db1", title: "Projects", text: "One project per row." },
  ];
  const turnResult = {
    prose: "",
    staged: 0,
    citations: [],
    usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 },
    modelId: "",
    rounds: 1,
    stopReason: "complete" as const,
  };

  function start(ctx: Ctx): Promise<string> {
    const call = { ctx, doc: DOC, docId: "db1", writeRefusal: () => null, body: async () => ({ prompt: "add a project" }) };
    return databaseCoauthor(call as unknown as DatabaseCall).then((res) => res.text());
  }

  function turnCtx(): Ctx {
    const base = ctxWithActor(() => new Response('{"tables":[]}'));
    return { ...base, env: { ...base.env, aiSettings: { current: () => ({ chat: { enabled: true } }) } } } as unknown as Ctx;
  }

  it("hands the model the database's instructions, resolved for this person every turn", async () => {
    vi.mocked(runTableAgentTurn).mockResolvedValue(turnResult);
    vi.mocked(resolveDocInstructions).mockResolvedValue(LEVELS);
    const ctx = turnCtx();
    await start(ctx);
    expect(resolveDocInstructions).toHaveBeenCalledWith(ctx.sql, DOC, ["user:bob"]);
    expect(vi.mocked(runTableAgentTurn).mock.calls.at(-1)![1]).toMatchObject({ instructions: LEVELS });
  });

  it("runs the turn without them when they cannot be read", async () => {
    vi.mocked(runTableAgentTurn).mockClear().mockResolvedValue(turnResult);
    vi.mocked(resolveDocInstructions).mockRejectedValue(new Error("db down"));
    await start(turnCtx());
    expect(runTableAgentTurn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runTableAgentTurn).mock.calls[0]![1]).toMatchObject({ instructions: [] });
  });
});
