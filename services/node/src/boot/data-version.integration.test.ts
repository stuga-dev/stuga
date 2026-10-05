/**
 * What a node reads of its database before it writes anything, against a real
 * Postgres. Needs TEST_DATABASE_URL (Postgres 18 preloading pg_search); skips
 * without it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { embeddingColumnDims, initSchema, recordNodeBoot, SCHEMA_VERSION } from "@stuga/db";
import { sessionConnection, withDatabase, type LockSql } from "../writer-lock.js";
import { readServedData } from "./data-version.js";

const URL = process.env.TEST_DATABASE_URL;
const DB = `stuga_dv_${process.pid}`;

let maintenance: LockSql;
let app: LockSql;

describe.skipIf(!URL)("what the node reads before it writes", () => {
  beforeAll(async () => {
    maintenance = sessionConnection(URL!, "postgres");
    await maintenance`DROP DATABASE IF EXISTS ${maintenance(DB)} WITH (FORCE)`;
    await maintenance`CREATE DATABASE ${maintenance(DB)}`;
    app = sessionConnection(withDatabase(URL!, DB));
  });

  afterAll(async () => {
    await app?.end({ timeout: 5 }).catch(() => {});
    if (maintenance) {
      await maintenance`DROP DATABASE IF EXISTS ${maintenance(DB)} WITH (FORCE)`;
      await maintenance.end({ timeout: 5 });
    }
  });

  it("reads a new database as schema 0, served by nobody, with no embedding width, and creates nothing in it", async () => {
    expect(await readServedData(app as never)).toEqual({ schema: 0, servedBy: null });
    expect(await embeddingColumnDims(app as never)).toBeNull();
    const [row] = await app<{ registry: string | null }[]>`SELECT to_regclass('public.schema_migrations')::text AS registry`;
    expect(row!.registry).toBeNull();
  });

  it("reads the schema and the newest build that wrote to it, and changes neither", async () => {
    await initSchema(app as never);
    await recordNodeBoot(app as never, "1.1.0");
    const before = await app<{ last_boot_at: Date }[]>`SELECT last_boot_at FROM node_state`;
    expect(await readServedData(app as never)).toEqual({ schema: SCHEMA_VERSION, servedBy: "1.1.0" });
    expect(await app<{ last_boot_at: Date }[]>`SELECT last_boot_at FROM node_state`).toEqual(before);
    expect(await embeddingColumnDims(app as never)).toBe(1024);
  });

  it("reads a schema a newer build added", async () => {
    await app`INSERT INTO schema_migrations (id, filename, checksum) VALUES (${SCHEMA_VERSION + 1}, 'future.sql', 'future')`;
    try {
      expect(await readServedData(app as never)).toEqual({ schema: SCHEMA_VERSION + 1, servedBy: "1.1.0" });
    } finally {
      await app`DELETE FROM schema_migrations WHERE id = ${SCHEMA_VERSION + 1}`;
    }
  });

  it("still reads a newer schema whose node_state it cannot, and nothing less", async () => {
    await app`ALTER TABLE node_state RENAME COLUMN app_version TO served_by`;
    try {
      await expect(readServedData(app as never)).rejects.toThrow(/app_version/);
      await app`INSERT INTO schema_migrations (id, filename, checksum) VALUES (${SCHEMA_VERSION + 1}, 'future.sql', 'future')`;
      expect(await readServedData(app as never)).toEqual({ schema: SCHEMA_VERSION + 1, servedBy: null });
    } finally {
      await app`DELETE FROM schema_migrations WHERE id = ${SCHEMA_VERSION + 1}`;
      await app`ALTER TABLE node_state RENAME COLUMN served_by TO app_version`;
    }
  });
});
