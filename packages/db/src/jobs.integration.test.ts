import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeClients, createClient, type Sql } from "./client.js";
import { initSchema } from "./schema/migrate.js";
import { LEASE_EXPIRED_ERROR, pgJobQueue, pgJobStore, startJobWorker } from "./jobs.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!URL)("pg job queue", () => {
  let sql: Sql;

  beforeAll(async () => {
    sql = createClient(URL!);
    await initSchema(sql);
  });
  beforeEach(async () => {
    await sql`TRUNCATE jobs RESTART IDENTITY`;
  });
  afterAll(async () => {
    await closeClients();
  });

  it("delivers, retries, buries, and leases with SKIP LOCKED", async () => {
    const queue = pgJobQueue<{ kind: string; i: number }>(sql);
    for (let i = 0; i < 5; i++) await queue.send({ kind: "index", i });

    const seen: number[] = [];
    const dead: number[] = [];
    const worker = startJobWorker<{ kind: string; i: number }>(
      sql,
      async (batch) => {
        for (const m of batch.messages) {
          seen.push(m.body.i);
          expect(m.body.kind).toBe("index");
          if (m.body.i === 3) m.retry();
        }
      },
      { batchSize: 2, pollMs: 10, maxAttempts: 2, backoffMs: () => 0, onDead: (job) => dead.push(job.body.i) },
    );
    await sleep(600);
    await worker.stop();
    expect(seen.filter((i) => i !== 3).sort()).toEqual([0, 1, 2, 4]);
    expect(seen.filter((i) => i === 3)).toHaveLength(2);
    expect(dead).toEqual([3]);

    const rows = await sql<{ attempts: number; dead: boolean; body: { i: number } }[]>`
      SELECT attempts, dead_at IS NOT NULL AS dead, body FROM jobs`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ attempts: 2, dead: true, body: { kind: "index", i: 3 } });

    // A leased row is invisible to a second worker until the lease expires.
    await queue.send({ kind: "index", i: 9 });
    const store = pgJobStore<{ i: number }>(sql);
    const first = await store.lease(10, 60_000, 5);
    expect(first.map((j) => j.body.i)).toEqual([9]);
    expect(await store.lease(10, 60_000, 5)).toEqual([]);
    expect((await store.lease(10, 0, 5)).map((j) => j.body.i)).toEqual([9]);
    await store.ack(first.map((j) => j.id));
    expect(await store.lease(10, 0, 5)).toEqual([]);
  });

  it("buries a job whose leases are abandoned, instead of leasing it forever", async () => {
    await pgJobQueue<{ i: number }>(sql).send({ i: 1 });
    const store = pgJobStore<{ i: number }>(sql);

    // Two workers take the job and die before settling it.
    expect((await store.lease(10, 0, 2)).map((j) => j.attempts)).toEqual([1]);
    expect((await store.lease(10, 0, 2)).map((j) => j.attempts)).toEqual([2]);
    expect(await store.lease(10, 0, 2)).toEqual([]);

    const handled: number[] = [];
    const dead: Array<{ attempts: number; error: unknown }> = [];
    const worker = startJobWorker<{ i: number }>(sql, async (batch) => void handled.push(batch.messages.length), {
      maxAttempts: 2,
      leaseMs: 0,
      onDead: (job, error) => dead.push({ attempts: job.attempts, error }),
    });
    await worker.stop();
    await worker.runOnce();

    expect(handled).toEqual([]);
    expect(dead).toHaveLength(1);
    expect(dead[0]!.attempts).toBe(2);
    expect((dead[0]!.error as Error).message).toBe(LEASE_EXPIRED_ERROR);
    const rows = await sql<{ attempts: number; dead: boolean; locked: boolean; last_error: string }[]>`
      SELECT attempts, dead_at IS NOT NULL AS dead, locked_at IS NOT NULL AS locked, last_error FROM jobs`;
    expect(rows).toEqual([{ attempts: 2, dead: true, locked: false, last_error: LEASE_EXPIRED_ERROR }]);

    await worker.runOnce();
    expect(dead).toHaveLength(1);
  });

  it("does not bury an exhausted job while its last lease is still live", async () => {
    await pgJobQueue<{ i: number }>(sql).send({ i: 1 });
    const store = pgJobStore<{ i: number }>(sql);
    await store.lease(10, 0, 1);
    expect(await store.buryExhausted(60_000, 1)).toEqual([]);
    expect((await store.buryExhausted(0, 1)).map((j) => j.body)).toEqual([{ i: 1 }]);
  });
});
