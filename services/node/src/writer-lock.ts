/**
 * The locks that keep a running node apart from a backup or restore: Postgres
 * session-level advisory locks, released however the session ends and visible
 * to every process that reaches the cluster.
 *
 *   writer lock  held by the node on its own database for as long as it runs.
 *   ops lock     held by a backup or restore on the `postgres` database (a
 *                restore renames the node's database, which refuses while any
 *                session is connected to it), keyed by the node's database name.
 *
 * Exclusion comes from the order: the node takes the writer lock and then checks
 * the ops lock; a backup or restore takes the ops lock and then checks the
 * writer lock. Whichever comes second sees the first.
 */
import postgres from "postgres";
import { pgConnection } from "@stuga/db";
import { ConfigError } from "./config/env.js";

/** First half of every Stuga advisory lock key; the second half says which. */
export const LOCK_CLASS = 0x5354_5547; // "STUG"
const WRITER = 1;

/** A 32-bit key for a database name (FNV-1a), as a signed int4. */
export function nameKey(name: string): number {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(name, "utf8")) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash | 0;
}

/** The database a connection string names. */
export function databaseName(databaseUrl: string): string {
  const name = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ""));
  if (!name) throw new Error("DATABASE_URL names no database (postgres://…/<database>)");
  return name;
}

/** The same connection string, naming another database on the same server. */
export function withDatabase(databaseUrl: string, database: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${encodeURIComponent(database)}`;
  return url.toString();
}

export type LockSql = postgres.Sql;

/**
 * A single unpooled connection, since advisory locks belong to a session.
 * postgres.js would otherwise close it when idle or at a random age and silently
 * reconnect on a session holding nothing. A session can still end on its own,
 * so a holder asks Postgres whether it still holds its lock.
 */
export const LOCK_SESSION_OPTIONS = {
  max: 1,
  idle_timeout: 0,
  max_lifetime: null,
  connect_timeout: 10,
  onnotice: () => {},
} as const;

export function sessionConnection(databaseUrl: string, database?: string): LockSql {
  const { url, options } = pgConnection(database ? withDatabase(databaseUrl, database) : databaseUrl);
  return postgres(url, { ...options, ...LOCK_SESSION_OPTIONS });
}

/** Take the node's writer lock on `sql`'s session; false when something holds it. */
async function tryWriterLock(sql: LockSql): Promise<boolean> {
  const [row] = await sql<{ ok: boolean }[]>`SELECT pg_try_advisory_lock(${LOCK_CLASS}, ${WRITER}) AS ok`;
  return row?.ok === true;
}

/** Whether a node runs against this database: the writer lock is tried and let go at once, never blocking a node's start. */
export async function nodeIsRunning(appSql: LockSql): Promise<boolean> {
  if (!(await tryWriterLock(appSql))) return true;
  await appSql`SELECT pg_advisory_unlock(${LOCK_CLASS}, ${WRITER})`;
  return false;
}

/** Take the ops lock for `database` on `maintenanceSql`'s session. */
export async function tryOpsLock(maintenanceSql: LockSql, database: string): Promise<boolean> {
  const [row] = await maintenanceSql<{ ok: boolean }[]>`
    SELECT pg_try_advisory_lock(${LOCK_CLASS}, ${nameKey(database)}) AS ok`;
  return row?.ok === true;
}

/** Whether a backup or restore of `database` is running, asked the same non-blocking way. */
async function opsInProgress(maintenanceSql: LockSql, database: string): Promise<boolean> {
  const [row] = await maintenanceSql<{ ok: boolean }[]>`
    SELECT pg_try_advisory_lock_shared(${LOCK_CLASS}, ${nameKey(database)}) AS ok`;
  if (row?.ok !== true) return true;
  await maintenanceSql`SELECT pg_advisory_unlock_shared(${LOCK_CLASS}, ${nameKey(database)})`;
  return false;
}

/**
 * Whether `sql`'s current session holds the advisory lock (LOCK_CLASS, key).
 * pg_locks stores the two keys as oids, so a negative key compares unsigned;
 * objsubid 2 marks the two-key form.
 */
async function holdsLock(sql: LockSql, key: number): Promise<boolean> {
  const [row] = await sql<{ held: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM pg_locks
      WHERE locktype = 'advisory' AND pid = pg_backend_pid()
        AND classid = ${String(LOCK_CLASS >>> 0)}::oid AND objid = ${String(key >>> 0)}::oid
        AND objsubid = 2 AND granted
    ) AS held`;
  return row?.held === true;
}

function holdsWriterLock(sql: LockSql): Promise<boolean> {
  return holdsLock(sql, WRITER);
}

/** Whether `maintenanceSql`'s current session still holds the ops lock it took for `database`. */
export function holdsOpsLock(maintenanceSql: LockSql, database: string): Promise<boolean> {
  return holdsLock(maintenanceSql, nameKey(database));
}

/** The node's hold on its database, for as long as it runs. */
export interface WriterLock {
  held: true;
  release: () => Promise<void>;
  /** Whether the session still holds the lock, asked of Postgres now. */
  stillHeld: () => Promise<boolean>;
}

export type WriterLockOutcome = WriterLock | { held: false; reason: "another-node" | "ops-in-progress" };

/** How often the node confirms it still holds its writer lock. */
const WRITER_HEARTBEAT_MS = 15_000;

/**
 * The node's side: take the writer lock on a session of its own, then check that
 * no backup or restore holds the ops lock. A heartbeat asks whether this session
 * still holds the lock and calls `onLost` once when it does not, since a node
 * writing without it could run beside a restore.
 */
export async function holdWriterLock(
  databaseUrl: string,
  onLost: (reason: string) => void,
  opts: { heartbeatMs?: number } = {},
): Promise<WriterLockOutcome> {
  let database: string;
  try {
    database = databaseName(databaseUrl);
  } catch (err) {
    throw new ConfigError(`DATABASE_URL must name its database (postgres://…/<database>): ${err instanceof Error ? err.message : String(err)}`);
  }
  const session = sessionConnection(databaseUrl);
  const endSession = () => session.end({ timeout: 5 }).catch(() => {});
  try {
    if (!(await tryWriterLock(session))) {
      await endSession();
      return { held: false, reason: "another-node" };
    }
    const maintenance = sessionConnection(databaseUrl, "postgres");
    let busy: boolean;
    try {
      busy = await opsInProgress(maintenance, database);
    } catch (err) {
      throw new ConfigError(
        `the node looks for a backup or restore of "${database}" in the same server's "postgres" database, ` +
          `and could not ask it: ${err instanceof Error ? err.message : String(err)}. ` +
          `The role in DATABASE_URL needs to be able to connect to the "postgres" database.`,
      );
    } finally {
      await maintenance.end({ timeout: 5 }).catch(() => {});
    }
    if (busy) {
      await endSession();
      return { held: false, reason: "ops-in-progress" };
    }
  } catch (err) {
    await endSession();
    throw err;
  }
  let released = false;
  let lost = false;
  const lose = (why: string) => {
    if (released || lost) return;
    lost = true;
    onLost(`this node lost its writer lock: ${why}`);
  };
  const heartbeat = setInterval(() => {
    holdsWriterLock(session)
      .then((held) => {
        if (!held) lose("the database session holding it ended");
      })
      .catch((err: unknown) => {
        lose(`the heartbeat could not reach the database (${err instanceof Error ? err.message : String(err)})`);
      });
  }, opts.heartbeatMs ?? WRITER_HEARTBEAT_MS);
  heartbeat.unref();
  return {
    held: true,
    release: async () => {
      released = true;
      clearInterval(heartbeat);
      await session.end({ timeout: 5 }).catch(() => {});
    },
    stillHeld: () => (released || lost ? Promise.resolve(false) : holdsWriterLock(session).catch(() => false)),
  };
}
