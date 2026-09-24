/**
 * Durable background jobs over the `jobs` table. Delivery is at-least-once:
 * a handler must tolerate seeing the same job twice.
 *
 * A lease counts as an attempt. A job is leased only while it has attempts
 * left; a lease that expires (its process died mid-handler) makes the job
 * available again, or buries it once its attempts are used up.
 */
import type { Sql } from "./client.js";
import type { Queryable } from "./sql.js";

export interface JobMessage<T = unknown> {
  readonly id: string;
  readonly body: T;
  readonly attempts: number;
  ack(): void;
  retry(): void;
}

export interface JobBatch<T = unknown> {
  readonly messages: JobMessage<T>[];
}

export type JobHandler<T = unknown> = (batch: JobBatch<T>) => Promise<void>;

export interface LeasedJob<T> {
  readonly id: string;
  readonly body: T;
  /** Leases so far, this one included. */
  readonly attempts: number;
}

/** What the worker loop needs from the table; `pgJobStore` is the real one. */
export interface JobStore<T> {
  /** Ready jobs with fewer than `maxAttempts` leases whose previous lease, if any, has expired. */
  lease(limit: number, leaseMs: number, maxAttempts: number): Promise<LeasedJob<T>[]>;
  ack(ids: string[]): Promise<void>;
  retry(id: string, delayMs: number, error: string | null): Promise<void>;
  bury(id: string, error: string | null): Promise<void>;
  /** Bury the jobs with no attempts left that nothing holds a live lease on, and return them. */
  buryExhausted(leaseMs: number, maxAttempts: number): Promise<LeasedJob<T>[]>;
}

export const LEASE_EXPIRED_ERROR = "lease expired after max attempts";

export function pgJobQueue<T>(sql: Queryable): { send(message: T): Promise<void> } {
  return {
    async send(message: T): Promise<void> {
      await sql`INSERT INTO jobs (body) VALUES (${sql.json(message as never)})`;
    },
  };
}

export function pgJobStore<T>(sql: Sql): JobStore<T> {
  const expired = (leaseMs: number) => sql`(locked_at IS NULL OR locked_at < now() - make_interval(secs => ${leaseMs / 1000}))`;
  return {
    async lease(limit, leaseMs, maxAttempts) {
      const rows = await sql<{ id: number; body: T; attempts: number }[]>`
        UPDATE jobs SET locked_at = now(), attempts = attempts + 1
        WHERE id IN (
          SELECT id FROM jobs
          WHERE dead_at IS NULL
            AND available_at <= now()
            AND attempts < ${maxAttempts}
            AND ${expired(leaseMs)}
          ORDER BY available_at, id
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id, body, attempts`;
      return rows.map((r) => ({ id: String(r.id), body: r.body, attempts: r.attempts }));
    },
    async ack(ids) {
      if (ids.length === 0) return;
      await sql`DELETE FROM jobs WHERE id = ANY(${ids}::bigint[])`;
    },
    async retry(id, delayMs, error) {
      await sql`
        UPDATE jobs
        SET locked_at = NULL,
            available_at = now() + make_interval(secs => ${delayMs / 1000}),
            last_error = ${error}
        WHERE id = ${id}::bigint`;
    },
    async bury(id, error) {
      await sql`UPDATE jobs SET locked_at = NULL, dead_at = now(), last_error = ${error} WHERE id = ${id}::bigint`;
    },
    async buryExhausted(leaseMs, maxAttempts) {
      const rows = await sql<{ id: number; body: T; attempts: number }[]>`
        UPDATE jobs SET locked_at = NULL, dead_at = now(), last_error = ${LEASE_EXPIRED_ERROR}
        WHERE dead_at IS NULL
          AND attempts >= ${maxAttempts}
          AND ${expired(leaseMs)}
        RETURNING id, body, attempts`;
      return rows.map((r) => ({ id: String(r.id), body: r.body, attempts: r.attempts }));
    },
  };
}

export interface JobWorkerOptions<T> {
  /** Jobs handed to one handler call. Default 10. */
  batchSize?: number;
  /** How long to wait after an empty poll. Default 1000. */
  pollMs?: number;
  /** Leases after which a job is buried instead of retried. Default 5. */
  maxAttempts?: number;
  /** A lease older than this is considered abandoned. Default 5 minutes. */
  leaseMs?: number;
  /** Delay before the n-th retry. Default: 1s · 2^(n-1), capped at 1 hour. */
  backoffMs?: (attempts: number) => number;
  /** Called once when a job is buried. */
  onDead?: (job: LeasedJob<T>, error: unknown) => void;
  /** Called when a handler call throws or a poll fails. Default: console.error. */
  onError?: (error: unknown) => void;
}

export interface JobWorker {
  /** Stop polling; resolves once the batch in flight (if any) has finished. */
  stop(): Promise<void>;
  /** Drain everything that is ready right now. */
  runOnce(): Promise<void>;
}

const defaultBackoff = (attempts: number): number => Math.min(60 * 60_000, 1000 * 2 ** Math.max(0, attempts - 1));

export function startJobWorker<T>(sql: Sql, handler: JobHandler<T>, options: JobWorkerOptions<T> = {}): JobWorker {
  return startJobWorkerOn(pgJobStore<T>(sql), handler, options);
}

export function startJobWorkerOn<T>(store: JobStore<T>, handler: JobHandler<T>, options: JobWorkerOptions<T> = {}): JobWorker {
  const batchSize = options.batchSize ?? 10;
  const pollMs = options.pollMs ?? 1000;
  const maxAttempts = options.maxAttempts ?? 5;
  const leaseMs = options.leaseMs ?? 5 * 60_000;
  const backoffMs = options.backoffMs ?? defaultBackoff;
  const onError = options.onError ?? ((e: unknown) => console.error("[jobs] worker error", e));

  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> | null = null;

  const settle = async (job: LeasedJob<T>, error: unknown): Promise<void> => {
    const message = error instanceof Error ? error.message : error === undefined ? null : String(error);
    if (job.attempts >= maxAttempts) {
      await store.bury(job.id, message);
      options.onDead?.(job, error);
    } else {
      await store.retry(job.id, backoffMs(job.attempts), message);
    }
  };

  const processBatch = async (jobs: LeasedJob<T>[]): Promise<void> => {
    const outcome = new Map<string, "ack" | "retry">();
    const messages: JobMessage<T>[] = jobs.map((job) => ({
      id: job.id,
      body: job.body,
      attempts: job.attempts,
      ack: () => void (outcome.has(job.id) || outcome.set(job.id, "ack")),
      retry: () => void (outcome.has(job.id) || outcome.set(job.id, "retry")),
    }));
    let failure: unknown = undefined;
    let threw = false;
    try {
      await handler({ messages });
    } catch (e) {
      threw = true;
      failure = e;
      onError(e);
    }
    // Returning acknowledges what the handler did not retry; throwing retries what it did not settle.
    const acked: string[] = [];
    for (const job of jobs) {
      const decision = outcome.get(job.id) ?? (threw ? "retry" : "ack");
      if (decision === "ack") acked.push(job.id);
      else await settle(job, failure);
    }
    await store.ack(acked);
  };

  const runOnce = async (): Promise<void> => {
    for (const job of await store.buryExhausted(leaseMs, maxAttempts)) {
      options.onDead?.(job, new Error(LEASE_EXPIRED_ERROR));
    }
    for (;;) {
      const jobs = await store.lease(batchSize, leaseMs, maxAttempts);
      if (jobs.length === 0) return;
      await processBatch(jobs);
      if (jobs.length < batchSize || stopped) return;
    }
  };

  const tick = (): void => {
    if (stopped) return;
    inFlight = runOnce()
      .catch(onError)
      .finally(() => {
        inFlight = null;
        if (!stopped) timer = setTimeout(tick, pollMs);
      });
  };
  timer = setTimeout(tick, 0);

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      if (inFlight) await inFlight;
    },
    runOnce,
  };
}
