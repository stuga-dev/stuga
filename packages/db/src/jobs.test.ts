import { describe, expect, it } from "vitest";
import { LEASE_EXPIRED_ERROR, startJobWorkerOn, type JobBatch, type JobStore, type LeasedJob } from "./jobs.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The Postgres store's semantics in memory, driven by a controllable clock. */
function memoryJobStore<T>(clock: { now: number }): JobStore<T> & { rows: Map<string, MemRow<T>>; add(body: T): void } {
  const rows = new Map<string, MemRow<T>>();
  let seq = 0;
  return {
    rows,
    add(body) {
      seq += 1;
      rows.set(String(seq), { body, attempts: 0, availableAt: clock.now, lockedAt: null, deadAt: null, error: null });
    },
    async lease(limit, leaseMs, maxAttempts) {
      const out: LeasedJob<T>[] = [];
      for (const [id, row] of rows) {
        if (out.length >= limit) break;
        if (row.deadAt !== null || row.availableAt > clock.now || row.attempts >= maxAttempts) continue;
        if (row.lockedAt !== null && row.lockedAt >= clock.now - leaseMs) continue;
        row.lockedAt = clock.now;
        row.attempts += 1;
        out.push({ id, body: row.body, attempts: row.attempts });
      }
      return out;
    },
    async ack(ids) {
      for (const id of ids) rows.delete(id);
    },
    async retry(id, delayMs, error) {
      const row = rows.get(id)!;
      row.lockedAt = null;
      row.availableAt = clock.now + delayMs;
      row.error = error;
    },
    async bury(id, error) {
      const row = rows.get(id)!;
      row.lockedAt = null;
      row.deadAt = clock.now;
      row.error = error;
    },
    async buryExhausted(leaseMs, maxAttempts) {
      const out: LeasedJob<T>[] = [];
      for (const [id, row] of rows) {
        if (row.deadAt !== null || row.attempts < maxAttempts) continue;
        if (row.lockedAt !== null && row.lockedAt >= clock.now - leaseMs) continue;
        row.lockedAt = null;
        row.deadAt = clock.now;
        row.error = LEASE_EXPIRED_ERROR;
        out.push({ id, body: row.body, attempts: row.attempts });
      }
      return out;
    },
  };
}
interface MemRow<T> {
  body: T;
  attempts: number;
  availableAt: number;
  lockedAt: number | null;
  deadAt: number | null;
  error: string | null;
}

describe("job worker", () => {
  it("acks what the handler leaves alone, retries with backoff, buries after maxAttempts", async () => {
    const clock = { now: 0 };
    const store = memoryJobStore<{ n: number }>(clock);
    store.add({ n: 1 });
    store.add({ n: 2 });
    const dead: Array<{ body: { n: number }; attempts: number }> = [];
    const seen: number[] = [];
    const worker = startJobWorkerOn(
      store,
      async (batch: JobBatch<{ n: number }>) => {
        for (const m of batch.messages) {
          seen.push(m.body.n);
          if (m.body.n === 2) m.retry();
        }
      },
      { pollMs: 5, maxAttempts: 3, backoffMs: (attempts) => 100 * attempts, onDead: (job) => dead.push(job), onError: () => {} },
    );
    await worker.stop();

    await worker.runOnce();
    expect(seen).toEqual([1, 2]);
    expect(store.rows.has("1")).toBe(false); // acked
    expect(store.rows.get("2")).toMatchObject({ attempts: 1, availableAt: 100, lockedAt: null });

    await worker.runOnce(); // not due yet
    expect(seen).toEqual([1, 2]);

    clock.now = 100;
    await worker.runOnce();
    expect(store.rows.get("2")).toMatchObject({ attempts: 2, availableAt: 300 });

    clock.now = 300;
    await worker.runOnce();
    expect(store.rows.get("2")).toMatchObject({ attempts: 3, deadAt: 300 });
    expect(dead).toEqual([{ id: "2", body: { n: 2 }, attempts: 3 }]);

    clock.now = 10_000;
    await worker.runOnce(); // buried jobs are never leased again
    expect(seen).toEqual([1, 2, 2, 2]);
  });

  it("retries everything a throwing handler did not settle, and records the error", async () => {
    const clock = { now: 0 };
    const store = memoryJobStore<string>(clock);
    store.add("a");
    store.add("b");
    store.add("c");
    const errors: unknown[] = [];
    const worker = startJobWorkerOn(
      store,
      async (batch) => {
        batch.messages[0]!.ack();
        throw new Error("boom");
      },
      { pollMs: 5, maxAttempts: 5, backoffMs: () => 50, onError: (e) => errors.push(e) },
    );
    await worker.stop();
    await worker.runOnce();
    expect([...store.rows.keys()]).toEqual(["2", "3"]);
    expect(store.rows.get("2")).toMatchObject({ availableAt: 50, error: "boom" });
    expect(errors).toHaveLength(1);
  });

  it("reclaims an expired lease", async () => {
    const clock = { now: 0 };
    const store = memoryJobStore<string>(clock);
    store.add("a");
    expect(await store.lease(10, 1000, 5)).toHaveLength(1);
    expect(await store.lease(10, 1000, 5)).toHaveLength(0);
    clock.now = 2000;
    const again = await store.lease(10, 1000, 5);
    expect(again).toHaveLength(1);
    expect(again[0]!.attempts).toBe(2);
  });

  it("buries a job whose leases keep expiring once its attempts are used up", async () => {
    const clock = { now: 0 };
    const store = memoryJobStore<string>(clock);
    store.add("poison");
    const dead: Array<{ job: LeasedJob<string>; error: unknown }> = [];
    let handled = 0;
    const worker = startJobWorkerOn(
      store,
      // The process dies inside the handler: the job is neither acked nor retried.
      () => {
        handled += 1;
        return new Promise<void>(() => {});
      },
      { leaseMs: 1000, maxAttempts: 2, onDead: (job, error) => dead.push({ job, error }), onError: () => {} },
    );
    await worker.stop();

    for (let i = 0; i < 2; i++) {
      void worker.runOnce();
      await sleep(0);
      clock.now += 2000;
    }
    expect(handled).toBe(2);
    expect(store.rows.get("1")).toMatchObject({ attempts: 2, deadAt: null });

    await worker.runOnce();
    expect(handled).toBe(2);
    expect(store.rows.get("1")).toMatchObject({ attempts: 2, deadAt: 4000, error: LEASE_EXPIRED_ERROR });
    expect(dead).toHaveLength(1);
    expect(dead[0]!.job).toEqual({ id: "1", body: "poison", attempts: 2 });
    expect((dead[0]!.error as Error).message).toBe(LEASE_EXPIRED_ERROR);
  });

  it("polls on its own and stops cleanly", async () => {
    const clock = { now: 0 };
    const store = memoryJobStore<string>(clock);
    const seen: string[] = [];
    const worker = startJobWorkerOn(store, async (b) => void seen.push(...b.messages.map((m) => m.body)), { pollMs: 5 });
    store.add("x");
    await sleep(40);
    store.add("y");
    await sleep(40);
    await worker.stop();
    expect(seen).toEqual(["x", "y"]);
    store.add("z");
    await sleep(30);
    expect(seen).toEqual(["x", "y"]); // stopped
  });
});
