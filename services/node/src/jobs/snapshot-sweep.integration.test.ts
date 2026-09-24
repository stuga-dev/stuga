/** The snapshot sweep of a deleted document through the real job queue. Needs TEST_DATABASE_URL; skips without it. */
import { closeClients, createClient, createDoc, deleteDoc, initSchema, startJobWorker, type Sql } from "@stuga/db";
import type { IndexMessage } from "@stuga/protocol/internal/jobs";
import type { BlobStore } from "@stuga/runtime";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sessionConnection, withDatabase, type LockSql } from "../writer-lock.js";
import { jobsDb } from "./db.js";
import type { JobsEnv } from "./deps.js";
import { SNAPSHOT_SWEEP_DELAY_SECONDS, queueSnapshotSweep } from "./snapshot-sweep.js";
import { handleJobBatch } from "./worker.js";

const URL = process.env.TEST_DATABASE_URL;
// Its own database: the suites in this folder run in parallel, and the notify suite truncates the shared jobs table.
const DB = `stuga_sweep_${process.pid}`;
const WS = "ws-snapshot-sweep";
const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

/** A snapshot store holding only keys. */
function keyStore(keys: string[]): BlobStore & { keys: Set<string> } {
  const held = new Set(keys);
  return {
    keys: held,
    get: async () => null,
    head: async () => null,
    put: async () => {},
    async delete(key) {
      for (const k of Array.isArray(key) ? key : [key]) held.delete(k);
    },
    async list(opts) {
      const objects = [...held].filter((k) => !opts?.prefix || k.startsWith(opts.prefix)).map((key) => ({ key, size: 1, uploaded: new Date() }));
      return { objects, truncated: false };
    },
  } as BlobStore & { keys: Set<string> };
}

describe.skipIf(!URL)("snapshot sweep on the job queue", () => {
  let maintenance: LockSql;
  let sql: Sql;

  beforeAll(async () => {
    maintenance = sessionConnection(URL!, "postgres");
    await maintenance`DROP DATABASE IF EXISTS ${maintenance(DB)} WITH (FORCE)`;
    await maintenance`CREATE DATABASE ${maintenance(DB)}`;
    sql = createClient(withDatabase(URL!, DB));
    await initSchema(sql);
    await sql`INSERT INTO workspaces (workspace_id, name) VALUES (${WS}, 'Sweep')`;
  });

  afterAll(async () => {
    await closeClients();
    if (maintenance) {
      await maintenance`DROP DATABASE IF EXISTS ${maintenance(DB)} WITH (FORCE)`;
      await maintenance.end({ timeout: 5 });
    }
  });

  beforeEach(async () => {
    await sql`TRUNCATE jobs`;
    await sql`DELETE FROM docs WHERE workspace_id = ${WS}`;
  });

  it("holds a sweep back for its delay, then clears a deleted document's snapshots and leaves a surviving one's", async () => {
    for (const docId of ["d-gone", "d-kept"]) {
      await createDoc(sql, { workspaceId: WS, docId, owner: "user:alice" });
      await queueSnapshotSweep(sql, docId);
    }
    await deleteDoc(sql, "d-gone");

    const snapshots = keyStore(["d-gone/1.bin", "d-gone/2.bin", "d-kept/1.bin"]);
    const env = { sql, snapshots } as unknown as JobsEnv;
    const worker = startJobWorker<IndexMessage>(sql, (batch) => handleJobBatch(env, batch, { db: jobsDb(sql), log: silentLog }), {
      pollMs: 10,
    });
    const queued = () => sql<{ secs: number; attempts: number }[]>`
      SELECT EXTRACT(EPOCH FROM available_at - now())::float AS secs, attempts FROM jobs`;
    try {
      await worker.runOnce();
      const held = await queued();
      expect(held).toHaveLength(2);
      for (const job of held) {
        expect(job.attempts).toBe(0);
        expect(job.secs).toBeGreaterThan(SNAPSHOT_SWEEP_DELAY_SECONDS - 60);
      }
      expect(snapshots.keys.size).toBe(3);

      await sql`UPDATE jobs SET available_at = now()`;
      await worker.runOnce();
    } finally {
      await worker.stop();
    }

    expect([...snapshots.keys]).toEqual(["d-kept/1.bin"]);
    expect(await queued()).toEqual([]);
  });
});
