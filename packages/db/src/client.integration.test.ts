import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { closeClients, createClient, type Sql } from "./client.js";

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
  beforeAll(() => {
    sql = createClient(URL!);
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
});
