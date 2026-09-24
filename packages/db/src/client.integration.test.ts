import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { closeClients, createClient, type Sql } from "./client.js";
import { agentRunStats } from "./governance.js";
import { initSearchSchema } from "./testing/search-schema.js";

const URL = process.env.TEST_DATABASE_URL;
const SOCKET_DIR = process.env.PGHOST?.startsWith("/") ? process.env.PGHOST : undefined;

describe.skipIf(!URL || !SOCKET_DIR)("a socket directory in DATABASE_URL", () => {
  afterAll(async () => {
    await closeClients();
  });

  it("connects with no PGHOST in the environment", async () => {
    const saved = process.env.PGHOST;
    delete process.env.PGHOST;
    try {
      const url = `${URL}${URL!.includes("?") ? "&" : "?"}host=${encodeURIComponent(SOCKET_DIR!)}`;
      const sql = createClient(url);
      const [row] = await sql<{ ok: number }[]>`SELECT 1 AS ok`;
      expect(row?.ok).toBe(1);
    } finally {
      process.env.PGHOST = saved;
    }
  });
});

describe.skipIf(!URL)("server notices on the pooled client", () => {
  let sql: Sql;
  beforeAll(async () => {
    sql = createClient(URL!);
    await initSearchSchema(sql);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await closeClients();
  });

  it("logs a notice as one line", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await sql`DO $$ BEGIN RAISE NOTICE 'hello from a test'; END $$`;
    expect(warn.mock.calls).toEqual([["[postgres] NOTICE: hello from a test"]]);
  });

  it("stays quiet about pg_search's planner warning on the agent statistics query", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await agentRunStats(sql, "ws-test", ["user:alice"]);
    expect(warn).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
});
