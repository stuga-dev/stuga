import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createClient, closeClients } from "./client.js";
import { initSchema } from "./schema/migrate.js";
import {
  createAskThread,
  listAskThreads,
  getAskThread,
  listAskTurns,
  appendAskTurn,
  renameAskThread,
  deleteAskThread,
  purgeAskThreads,
  setAskThreadTitleIfEmpty,
} from "./ask-threads.js";
import type { Sql } from "./client.js";

const URL = process.env.TEST_DATABASE_URL;

const WS_A = "ws-ask-a";
const WS_B = "ws-ask-b";

function turn(threadId: string, question: string, answer = "an answer") {
  return {
    threadId,
    question,
    answer,
    citations: [{ n: 1, doc_id: "d1", title: "Plan" }],
    steps: [{ kind: "search", query: question, hits: 3 }],
    model: "claude-sonnet-5",
    rounds: 2,
    stopReason: "complete",
    inputTokens: 900,
    outputTokens: 120,
  };
}

describe.skipIf(!URL)("ask threads", () => {
  let sql: Sql;

  beforeAll(async () => {
    sql = createClient(URL!);
    await initSchema(sql);
  });
  afterAll(async () => {
    await closeClients();
  });
  beforeEach(async () => {
    await sql`TRUNCATE workspaces CASCADE`;
    await sql`TRUNCATE collections CASCADE`;
    await sql`INSERT INTO workspaces (workspace_id, name) VALUES (${WS_A}, 'A'), (${WS_B}, 'B')`;
  });

  it("round-trips a thread and its turns", async () => {
    const t = await createAskThread(sql, { threadId: "ask_1", workspaceId: WS_A, owner: "alice" });
    expect(t.title).toBe("");
    expect(t.collection_id).toBeNull();

    await appendAskTurn(sql, turn("ask_1", "what was the target?"));
    await appendAskTurn(sql, turn("ask_1", "and the actuals?"));

    const turns = await listAskTurns(sql, "ask_1");
    expect(turns.map((x) => x.seq)).toEqual([1, 2]);
    expect(turns[0]!.question).toBe("what was the target?");
    expect(turns[0]!.citations).toEqual([{ n: 1, doc_id: "d1", title: "Plan" }]);
    expect(turns[0]!.steps).toEqual([{ kind: "search", query: "what was the target?", hits: 3 }]);
    expect(turns[0]!.input_tokens).toBe(900);
  });

  it("purges a thread idle past the retention with its turns, and keeps one still being asked in", async () => {
    await createAskThread(sql, { threadId: "ask_idle", workspaceId: WS_A, owner: "alice" });
    await appendAskTurn(sql, turn("ask_idle", "old question"));
    await createAskThread(sql, { threadId: "ask_live", workspaceId: WS_A, owner: "alice" });
    await appendAskTurn(sql, turn("ask_live", "first, long ago"));
    await sql`UPDATE ask_threads SET created_at = now() - interval '400 days', updated_at = now() - interval '400 days'`;
    await appendAskTurn(sql, turn("ask_live", "asked again today"));

    expect(await purgeAskThreads(sql, 365)).toBe(1);
    expect(await getAskThread(sql, "ask_idle")).toBeNull();
    expect(await listAskTurns(sql, "ask_idle")).toEqual([]);
    expect((await listAskTurns(sql, "ask_live")).map((t) => t.question)).toEqual(["first, long ago", "asked again today"]);
    expect(await purgeAskThreads(sql, 365)).toBe(0);
  });

  it("mints seq without collisions under concurrent appends", async () => {
    await createAskThread(sql, { threadId: "ask_race", workspaceId: WS_A, owner: "alice" });
    await Promise.all([
      appendAskTurn(sql, turn("ask_race", "q1")),
      appendAskTurn(sql, turn("ask_race", "q2")),
      appendAskTurn(sql, turn("ask_race", "q3")),
    ]);
    const seqs = (await listAskTurns(sql, "ask_race")).map((t) => t.seq);
    expect(seqs).toEqual([1, 2, 3]);
  });

  it("lists only this owner's threads in this workspace, newest first", async () => {
    await createAskThread(sql, { threadId: "a1", workspaceId: WS_A, owner: "alice" });
    await createAskThread(sql, { threadId: "a2", workspaceId: WS_A, owner: "alice" });
    await createAskThread(sql, { threadId: "b1", workspaceId: WS_B, owner: "alice" });
    await createAskThread(sql, { threadId: "o1", workspaceId: WS_A, owner: "bob" });

    await appendAskTurn(sql, turn("a1", "older"));
    const listed = await listAskThreads(sql, WS_A, "alice");

    expect(listed.map((t) => t.thread_id)).toEqual(["a1", "a2"]);
    expect(listed[0]!.turn_count).toBe(1);
    expect(listed[0]!.last_question).toBe("older");
    expect(listed[1]!.turn_count).toBe(0);
    expect(listed[1]!.last_question).toBeNull();
  });

  it("auto-titles once and never overwrites a chosen title", async () => {
    await createAskThread(sql, { threadId: "t1", workspaceId: WS_A, owner: "alice" });
    await setAskThreadTitleIfEmpty(sql, "t1", "what was the target?");
    expect((await getAskThread(sql, "t1"))!.title).toBe("what was the target?");

    await renameAskThread(sql, "t1", "Q3 investigation");
    await setAskThreadTitleIfEmpty(sql, "t1", "a later question");
    expect((await getAskThread(sql, "t1"))!.title).toBe("Q3 investigation");
  });

  it("deletes a thread and its turns together", async () => {
    await createAskThread(sql, { threadId: "gone", workspaceId: WS_A, owner: "alice" });
    await appendAskTurn(sql, turn("gone", "q"));
    await deleteAskThread(sql, "gone");
    expect(await getAskThread(sql, "gone")).toBeNull();
    expect(await listAskTurns(sql, "gone")).toEqual([]);
  });

  it("keeps the research when its collection is deleted", async () => {
    await sql`INSERT INTO collections (collection_id, workspace_id, owner, name) VALUES ('col1', ${WS_A}, 'alice', 'KB')`;
    await createAskThread(sql, { threadId: "scoped", workspaceId: WS_A, owner: "alice", collectionId: "col1" });
    await appendAskTurn(sql, turn("scoped", "q"));

    await sql`DELETE FROM collections WHERE collection_id = 'col1'`;

    const t = await getAskThread(sql, "scoped");
    expect(t).not.toBeNull();
    expect(t!.collection_id).toBeNull();
    expect(await listAskTurns(sql, "scoped")).toHaveLength(1);
  });

  it("goes with its workspace", async () => {
    await createAskThread(sql, { threadId: "ws", workspaceId: WS_A, owner: "alice" });
    await appendAskTurn(sql, turn("ws", "q"));

    await sql`DELETE FROM workspaces WHERE workspace_id = ${WS_A}`;

    expect(await getAskThread(sql, "ws")).toBeNull();
    expect(await listAskTurns(sql, "ws")).toEqual([]);
  });
});
