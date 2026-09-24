import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createClient, closeClients } from "./client.js";
import { initSchema } from "./schema/migrate.js";
import { insertAiUsage, purgeAiUsage, usageRollup } from "./agents.js";
import type { Sql } from "./client.js";

const URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!URL)("ai_usage telemetry", () => {
  let sql: Sql;
  const WS = "ws-test";

  beforeAll(async () => {
    sql = createClient(URL!);
    await initSchema(sql);
  });

  afterAll(async () => {
    await closeClients();
  });

  beforeEach(async () => {
    await sql`TRUNCATE ai_usage RESTART IDENTITY`;
  });

  it("inserts a coauthor row with all token fields", async () => {
    await insertAiUsage(sql, { workspaceId: WS,
      alias: "alice",
      docId: "doc-1",
      kind: "coauthor",
      model: "claude-sonnet-5",
      inputTokens: 1200,
      outputTokens: 300,
      cacheReadTokens: 800,
      cacheWriteTokens: 0,
    });
    const rows = await sql<
      { alias: string; kind: string; status: string; input_tokens: number; cache_read_tokens: number }[]
    >`SELECT alias, kind, status, input_tokens, cache_read_tokens FROM ai_usage`;
    expect(rows.length).toBe(1);
    expect(rows[0]?.alias).toBe("alice");
    expect(rows[0]?.kind).toBe("coauthor");
    expect(rows[0]?.status).toBe("ok");
    expect(rows[0]?.input_tokens).toBe(1200);
    expect(rows[0]?.cache_read_tokens).toBe(800);
  });

  it("defaults token counts to 0", async () => {
    await insertAiUsage(sql, { workspaceId: WS,
      alias: "bob",
      docId: null,
      kind: "coauthor",
      model: "sonnet",
      status: "error",
    });
    const [row] = await sql<{ status: string; input_tokens: number; output_tokens: number }[]>`
      SELECT status, input_tokens, output_tokens FROM ai_usage`;
    expect(row?.status).toBe("error");
    expect(row?.input_tokens).toBe(0);
    expect(row?.output_tokens).toBe(0);
  });

  it("rolls up tokens per user", async () => {
    await insertAiUsage(sql, { workspaceId: WS, alias: "alice", docId: "d1", kind: "coauthor", model: "opus", inputTokens: 1000, outputTokens: 500 });
    await insertAiUsage(sql, { workspaceId: WS, alias: "alice", docId: "d1", kind: "embedding", model: "embed-v2", inputTokens: 200 });
    await insertAiUsage(sql, { workspaceId: WS, alias: "bob", docId: "d2", kind: "coauthor", model: "sonnet", inputTokens: 100, outputTokens: 50 });
    await insertAiUsage(sql, { workspaceId: WS, alias: "bob", docId: "d2", kind: "coauthor", model: "sonnet", status: "error" });

    const rollup = await sql<
      { alias: string; calls: number; input_tokens: number; output_tokens: number }[]
    >`
      SELECT alias,
             count(*)::int            AS calls,
             sum(input_tokens)::int   AS input_tokens,
             sum(output_tokens)::int  AS output_tokens
      FROM ai_usage
      WHERE status = 'ok'
      GROUP BY alias
      ORDER BY alias`;

    expect(rollup.length).toBe(2);
    expect(rollup[0]).toMatchObject({ alias: "alice", calls: 2, input_tokens: 1200, output_tokens: 500 });
    expect(rollup[1]).toMatchObject({ alias: "bob", calls: 1, input_tokens: 100, output_tokens: 50 });
  });

  it("usageRollup groups by model/alias/day, tenant-scoped, ok-only", async () => {
    const since = new Date("2000-01-01T00:00:00Z");
    await insertAiUsage(sql, { workspaceId: WS, alias: "alice", docId: "d1", kind: "coauthor", model: "claude-opus-4-8", inputTokens: 1000, outputTokens: 400, cacheReadTokens: 200 });
    await insertAiUsage(sql, { workspaceId: WS, alias: "agent:bot", docId: "d1", kind: "coauthor", model: "claude-sonnet-5", inputTokens: 300, outputTokens: 100 });
    await insertAiUsage(sql, { workspaceId: WS, alias: "alice", docId: "d1", kind: "coauthor", model: "claude-sonnet-5", status: "error", inputTokens: 9999 });
    await insertAiUsage(sql, { workspaceId: "ws-other", alias: "mallory", docId: "d9", kind: "coauthor", model: "claude-opus-4-8", inputTokens: 5000 });

    const { byModel, byAlias, byDay } = await usageRollup(sql, WS, since);

    const opus = byModel.find((r) => r.model.includes("opus"));
    const sonnet = byModel.find((r) => r.model.includes("sonnet"));
    expect(opus).toMatchObject({ input_tokens: 1000, output_tokens: 400, cache_read_tokens: 200, calls: 1 });
    expect(sonnet).toMatchObject({ input_tokens: 300, output_tokens: 100, calls: 1 });
    expect(byModel.reduce((s, r) => s + r.input_tokens, 0)).toBe(1300);

    expect(byAlias.map((r) => r.alias).sort()).toEqual(["agent:bot", "alice"]);

    expect(byDay.length).toBe(1);
    expect(typeof byDay[0]!.input_tokens).toBe("number");
    expect(byDay[0]!.input_tokens).toBe(1300);
  });

  it("purges rows past the retention and counts them in SQL, leaving recent ones", async () => {
    const row = (alias: string) => ({ workspaceId: WS, alias, docId: null, kind: "ask" as const, model: "m", inputTokens: 1 });
    await insertAiUsage(sql, row("old-1"));
    await insertAiUsage(sql, row("old-2"));
    await insertAiUsage(sql, row("fresh"));
    await sql`UPDATE ai_usage SET created_at = now() - interval '400 days' WHERE alias LIKE 'old-%'`;

    expect(await purgeAiUsage(sql, 365)).toBe(2);
    expect(await purgeAiUsage(sql, 365)).toBe(0);
    const left = await sql<{ alias: string }[]>`SELECT alias FROM ai_usage`;
    expect(left.map((r) => r.alias)).toEqual(["fresh"]);
  });
});
