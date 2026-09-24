/**
 * stuga-node restore: put a backup back so that a wrong or failed restore can be
 * undone. Everything slow happens beside the current data, which is only renamed.
 *
 *   1. refuse unless no other backup or restore runs, the node is stopped, the
 *      backup verifies, the server can load pg_search, the person confirmed, and
 *      there is room for a second copy of both halves;
 *   2. extract the archive into `<DATA_DIR>.restore-<stamp>`;
 *   3. restore the dump into `<db>_restore_<stamp>`, stopping at the first error;
 *   4. confirm the ops lock is still held, then swap by four renames, keeping the
 *      current halves as `<db>_replaced_<stamp>` and `<DATA_DIR>.replaced-<stamp>`.
 *
 * A failure in 1-3 leaves the current data untouched (exit 3) and removes what it
 * made. A failed swap reverses the renames that happened; only if the original
 * names cannot be restored does it exit 4, saying where each half is. The next
 * restore removes what a killed one left.
 */
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { preloadsPgSearch } from "@stuga/db";
import { TRASH_RETENTION_DAYS } from "@stuga/protocol/domain/limits";
import { pgSearchProblem } from "../boot/preflight.js";
import { mib, nodeRunningRefusal } from "./backup.js";
import type { BackupEnv } from "./env.js";
import {
  databaseName,
  holdsOpsLock,
  nodeIsRunning,
  sessionConnection,
  tryOpsLock,
  withDatabase,
  type LockSql,
} from "../writer-lock.js";
import { ARCHIVE_NAME, DUMP_NAME, syncDirectory, type Manifest } from "./manifest.js";
import { failedChanged, failedUnchanged, messageOf, OpsError, refused, throwIfInterrupted } from "./outcome.js";
import { extractArchive, freeBytes, pgTool, run } from "./tools.js";
import { checkCompatibility, verifyIntegrity } from "./verify.js";

export interface RestoreResult {
  path: string;
  /** The database the restore replaced, kept under this name; null if there was none. */
  replacedDatabase: string | null;
  /** The data directory the restore replaced, kept at this path; null if there was none. */
  replacedDataDir: string | null;
  notes: string[];
}

export interface RestoreDeps {
  now?: () => Date;
  freeBytes?: (path: string) => Promise<number>;
  /** The dump-into-the-side-database step; a test replaces it to fail midway. */
  restoreDump?: (env: BackupEnv, dump: string, sideUrl: string, signal?: AbortSignal) => Promise<void>;
  /** The swap's two kinds of rename; a test replaces them to fail one. */
  renameDatabase?: (sql: LockSql, from: string, to: string) => Promise<void>;
  renameDirectory?: (from: string, to: string) => Promise<void>;
  /** Aborted on SIGINT or SIGTERM: before the swap the restore stops and cleans up. */
  signal?: AbortSignal;
}

const HEADROOM = 1.2;
const MAX_IDENTIFIER = 63;
/** The stamp in every name a restore makes beside the data. */
export const STAMP = /^\d{8}t\d{6}z$/;

function stampOf(at: Date): string {
  return at.toISOString().replace(/\.\d{3}Z$/, "z").replace(/[-:]/g, "").toLowerCase();
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function databasesNamed(sql: LockSql, names: string[]): Promise<Set<string>> {
  const rows = await sql<{ datname: string }[]>`SELECT datname FROM pg_database WHERE datname IN ${sql(names)}`;
  return new Set(rows.map((r) => r.datname));
}

/** LIKE pattern matching `prefix` literally, followed by anything. */
function likePrefix(prefix: string): string {
  return `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Disconnect every other session from `name`, and wait until they are gone. */
async function emptyDatabase(sql: LockSql, name: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const rows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = ${name} AND pid <> pg_backend_pid()`;
    if (rows[0]!.n === 0) return;
    await sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${name} AND pid <> pg_backend_pid()`;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`sessions on database "${name}" did not disconnect`);
}

export async function defaultRestoreDump(env: BackupEnv, dump: string, sideUrl: string, signal?: AbortSignal): Promise<void> {
  await run(pgTool(env, "pg_restore"), ["--no-owner", "--no-acl", "--exit-on-error", `--dbname=${sideUrl}`, dump], { signal });
}

async function defaultRenameDatabase(sql: LockSql, from: string, to: string): Promise<void> {
  await sql`ALTER DATABASE ${sql(from)} RENAME TO ${sql(to)}`;
}

/**
 * The room a restore needs before it writes anything: the extracted data
 * directory beside the current one, and the side database on the server's disk.
 * When the server's data directory is not visible from here, the returned note
 * says that half was not checked.
 */
async function checkRoom(
  env: BackupEnv,
  maintenance: LockSql,
  manifest: Manifest,
  measure: (path: string) => Promise<number>,
): Promise<string | null> {
  const parent = dirname(env.dataDir);
  const dirNeed = Math.ceil(manifest.data_dir_bytes * HEADROOM);
  const dbNeed = Math.ceil(manifest.database_bytes * HEADROOM);

  const serverDir = await maintenance<{ data_directory?: string }[]>`SHOW data_directory`
    .then((r) => r[0]?.data_directory ?? null)
    .catch(() => null);
  const serverStat = serverDir ? await stat(serverDir).catch(() => null) : null;
  const parentStat = await stat(parent);

  const short = (where: string, need: number, free: number, what: string) =>
    refused(`not enough disk at ${where} for ${what}: about ${mib(need)} needed, ${mib(free)} free. Nothing was changed.`);

  if (serverDir && serverStat && serverStat.dev === parentStat.dev) {
    const free = await measure(parent);
    if (free < dirNeed + dbNeed) throw short(parent, dirNeed + dbNeed, free, "a second copy of the database and the data directory");
    return null;
  }
  const free = await measure(parent);
  if (free < dirNeed) throw short(parent, dirNeed, free, "extracting the backup beside the current data");
  if (serverDir && serverStat) {
    const serverFree = await measure(serverDir);
    if (serverFree < dbNeed) throw short(serverDir, dbNeed, serverFree, "a second copy of the database");
    return null;
  }
  return (
    `the restored database is built beside the current one and needs about ${mib(dbNeed)} on the Postgres server's disk, ` +
    `which is not visible from here and was not checked`
  );
}

/** Remove what killed restores of this database left beside the data; under the ops lock none of it is live. */
async function removeLeftovers(env: BackupEnv, maintenance: LockSql, database: string): Promise<string[]> {
  const removed: string[] = [];
  const parent = dirname(env.dataDir);
  const dirPrefix = `${basename(env.dataDir)}.restore-`;
  for (const entry of await readdir(parent, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory() && entry.name.startsWith(dirPrefix) && STAMP.test(entry.name.slice(dirPrefix.length))) {
      await rm(join(parent, entry.name), { recursive: true, force: true });
      removed.push(join(parent, entry.name));
    }
  }
  const dbPrefix = `${database}_restore_`;
  const rows = await maintenance<{ datname: string }[]>`
    SELECT datname FROM pg_database WHERE datname LIKE ${likePrefix(dbPrefix)}`;
  for (const { datname } of rows) {
    if (!STAMP.test(datname.slice(dbPrefix.length))) continue;
    await maintenance`DROP DATABASE IF EXISTS ${maintenance(datname)} WITH (FORCE)`;
    removed.push(`database "${datname}"`);
  }
  return removed;
}

export async function runRestore(
  env: BackupEnv,
  dir: string,
  opts: { confirmed: boolean },
  deps: RestoreDeps = {},
): Promise<RestoreResult> {
  const database = databaseName(env.databaseUrl);
  const signal = deps.signal;
  const renameDatabase = deps.renameDatabase ?? defaultRenameDatabase;
  const renameDirectory = deps.renameDirectory ?? rename;
  const maintenance = sessionConnection(env.databaseUrl, "postgres");
  /** What removing an interrupted restore's leftovers did, for any message after it. */
  let removedNote: string | null = null;
  try {
    // 1. Checks; nothing changes before step 2.
    if (!(await tryOpsLock(maintenance, database))) {
      throw refused(`another backup or restore of database "${database}" is running; nothing was changed`);
    }
    const hasDatabase = (await databasesNamed(maintenance, [database])).has(database);
    if (hasDatabase) {
      const app = sessionConnection(env.databaseUrl);
      try {
        if (await nodeIsRunning(app)) {
          throw refused(nodeRunningRefusal(database));
        }
      } finally {
        await app.end({ timeout: 5 }).catch(() => {});
      }
    }

    const manifest = await verifyIntegrity(env, dir, signal);
    throwIfInterrupted(signal, "nothing was changed");
    const [server] = await maintenance<{ v: string }[]>`SELECT current_setting('server_version_num') AS v`;
    const notes = checkCompatibility(env, manifest, Number(server!.v));

    // A dump with BM25 indexes fails mid-restore on a server that cannot load pg_search.
    const [ext] = await maintenance<{ available: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_search') AS available`;
    const preloaded = await maintenance<{ shared_preload_libraries?: string }[]>`SHOW shared_preload_libraries`
      .then((r) => (typeof r[0]?.shared_preload_libraries === "string" ? preloadsPgSearch(r[0].shared_preload_libraries) : null))
      .catch(() => null);
    const pgSearch = pgSearchProblem({ available: ext?.available === true, preloaded });
    if (pgSearch) throw refused(`${pgSearch} Nothing was changed.`);

    if (!opts.confirmed) {
      throw refused(`restoring replaces the current database and data directory; confirm it (--yes). Nothing was changed.`);
    }

    const parent = dirname(env.dataDir);
    await mkdir(parent, { recursive: true });
    const leftovers = await removeLeftovers(env, maintenance, database);
    if (leftovers.length > 0) {
      removedNote = `removed what an interrupted restore left behind: ${leftovers.join(", ")}`;
      notes.push(removedNote);
    }
    const roomNote = await checkRoom(env, maintenance, manifest, deps.freeBytes ?? freeBytes);
    if (roomNote) notes.push(roomNote);

    const stamp = stampOf((deps.now ?? (() => new Date()))());
    const side = `${database}_restore_${stamp}`;
    const replacedDatabase = `${database}_replaced_${stamp}`;
    if (replacedDatabase.length > MAX_IDENTIFIER) {
      throw refused(`database name "${database}" is too long to keep a replaced copy beside it; nothing was changed`);
    }
    const extracted = `${env.dataDir}.restore-${stamp}`;
    const replacedDataDir = `${env.dataDir}.replaced-${stamp}`;
    if ((await exists(extracted)) || (await exists(replacedDataDir))) {
      throw refused(`${extracted} or ${replacedDataDir} already exists; nothing was changed`);
    }
    if ((await databasesNamed(maintenance, [side, replacedDatabase])).size > 0) {
      throw refused(`database "${side}" or "${replacedDatabase}" already exists; nothing was changed`);
    }
    const hasDataDir = await exists(env.dataDir);

    /** Remove what steps 2–3 made; returns what could not be removed. */
    const discard = async (): Promise<string[]> => {
      const left: string[] = [];
      await rm(extracted, { recursive: true, force: true }).catch((err: unknown) => left.push(`${extracted} (${messageOf(err)})`));
      await maintenance`DROP DATABASE IF EXISTS ${maintenance(side)} WITH (FORCE)`.catch((err: unknown) =>
        left.push(`database "${side}" (${messageOf(err)})`),
      );
      return left;
    };
    const unchanged = async (what: string): Promise<OpsError> => {
      const left = await discard();
      const tail = left.length
        ? `The current database and data directory were not touched; these could not be removed and can be deleted: ${left.join("; ")}.`
        : "Nothing was changed.";
      return failedUnchanged(`${what}. ${tail}`);
    };

    // 2. Extract beside the current data directory.
    try {
      await mkdir(extracted, { mode: 0o700 });
      await extractArchive(join(dir, ARCHIVE_NAME), extracted, signal);
      throwIfInterrupted(signal, "");
    } catch (err) {
      throw await unchanged(signal?.aborted ? "interrupted while extracting the backup" : `extracting the backup failed (${messageOf(err)})`);
    }

    // 3. Restore into a side database.
    try {
      // Explicit, not the server's default: the node refuses a database with any other collation.
      await maintenance`CREATE DATABASE ${maintenance(side)} TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER builtin BUILTIN_LOCALE 'C.UTF-8'`;
      await (deps.restoreDump ?? defaultRestoreDump)(env, join(dir, DUMP_NAME), withDatabase(env.databaseUrl, side), signal);
      throwIfInterrupted(signal, "");
    } catch (err) {
      throw await unchanged(signal?.aborted ? "interrupted while restoring the database" : `restoring the database failed (${messageOf(err)})`);
    }

    // 4. Swap. Only this session's unbroken ops lock proves no node started meanwhile.
    if (!(await holdsOpsLock(maintenance, database).catch(() => false))) {
      throw await unchanged(
        `this restore's hold on database "${database}" ended while it ran (Postgres restarted, or the connection dropped), ` +
          `so nothing proves the node stayed stopped`,
      );
    }
    // An interrupt waits from here: stopping between two renames would leave mismatched halves.
    try {
      if (hasDatabase) {
        await emptyDatabase(maintenance, database);
        await renameDatabase(maintenance, database, replacedDatabase);
      }
      await renameDatabase(maintenance, side, database);
      if (hasDataDir) await renameDirectory(env.dataDir, replacedDataDir);
      await renameDirectory(extracted, env.dataDir);
      await syncDirectory(parent);
    } catch (err) {
      const reason = messageOf(err);
      try {
        await putBack();
      } catch (undoErr) {
        throw failedChanged(
          `the restore failed while swapping (${reason}), and putting everything back failed too (${messageOf(undoErr)}). ` +
            (await whereThingsAre()) +
            ` Before starting the node, put the original database back under the name "${database}" and the original data directory back at ${env.dataDir}.`,
        );
      }
      throw await unchanged(`the restore failed while swapping (${reason}); everything was put back`);
    }

    notes.push(
      "within minutes of starting, the node's maintenance runs against today's date: " +
        `trash older than ${TRASH_RETENTION_DAYS} days and audit rows past their retention are removed for good`,
    );
    return {
      path: dir,
      replacedDatabase: hasDatabase ? replacedDatabase : null,
      replacedDataDir: hasDataDir ? replacedDataDir : null,
      notes,
    };

    /**
     * Reverse the renames that happened, judged by the names that exist now: a
     * rename can commit on the server and still reject on the client. Every step
     * is attempted; throws unless the original names are back.
     */
    async function putBack(): Promise<void> {
      const errors: string[] = [];
      const attempt = async (step: () => Promise<void>) => {
        try {
          await step();
        } catch (err) {
          errors.push(messageOf(err));
        }
      };
      await attempt(async () => {
        if (!(await exists(extracted)) && (await exists(env.dataDir))) await renameDirectory(env.dataDir, extracted);
      });
      await attempt(async () => {
        if (hasDataDir && (await exists(replacedDataDir)) && !(await exists(env.dataDir))) {
          await renameDirectory(replacedDataDir, env.dataDir);
        }
      });
      await attempt(async () => {
        const dbs = await databasesNamed(maintenance, [database, side, replacedDatabase]);
        if (!dbs.has(side) && dbs.has(database) && (!hasDatabase || dbs.has(replacedDatabase))) {
          await emptyDatabase(maintenance, database);
          await renameDatabase(maintenance, database, side);
        }
      });
      await attempt(async () => {
        const dbs = await databasesNamed(maintenance, [database, side, replacedDatabase]);
        if (hasDatabase && dbs.has(replacedDatabase) && !dbs.has(database)) {
          await renameDatabase(maintenance, replacedDatabase, database);
        }
      });
      await syncDirectory(parent).catch(() => {});

      const dbs = await databasesNamed(maintenance, [database, side, replacedDatabase]);
      const original =
        dbs.has(side) &&
        !dbs.has(replacedDatabase) &&
        dbs.has(database) === hasDatabase &&
        (await exists(extracted)) &&
        !(await exists(replacedDataDir)) &&
        (await exists(env.dataDir)) === hasDataDir;
      if (!original) {
        throw new Error(`the names did not all return to how they were${errors.length ? ` (${errors.join("; ")})` : ""}`);
      }
    }

    /** One sentence per half: where the original and the restored copy are now. */
    async function whereThingsAre(): Promise<string> {
      try {
        const dbs = await databasesNamed(maintenance, [database, side, replacedDatabase]);
        const dirs = {
          dataDir: await exists(env.dataDir),
          extracted: await exists(extracted),
          replaced: await exists(replacedDataDir),
        };
        const originalDb = !hasDatabase ? "none" : dbs.has(replacedDatabase) ? `"${replacedDatabase}"` : dbs.has(database) && dbs.has(side) ? `"${database}"` : "unknown";
        const restoredDb = dbs.has(side) ? `"${side}"` : dbs.has(database) ? `"${database}"` : "unknown";
        const originalDir = !hasDataDir ? "none" : dirs.replaced ? replacedDataDir : dirs.dataDir && dirs.extracted ? env.dataDir : "unknown";
        const restoredDir = dirs.extracted ? extracted : dirs.dataDir ? env.dataDir : "unknown";
        return (
          `Now: the original database is ${originalDb}, the restored one ${restoredDb}; ` +
          `the original data directory is ${originalDir}, the restored one ${restoredDir}.`
        );
      } catch (err) {
        return `Where each half is now could not be read (${messageOf(err)}); the renames attempted were ${database} → ${replacedDatabase}, ${side} → ${database}, ${env.dataDir} → ${replacedDataDir}, ${extracted} → ${env.dataDir}.`;
      }
    }
  } catch (err) {
    const error =
      err instanceof OpsError ? err : failedUnchanged(`the restore of ${basename(dir)} failed before changing anything: ${messageOf(err)}`);
    // "Nothing was changed" is about the node's data; say what else was removed.
    if (removedNote && error.exitCode !== 4) throw new OpsError(error.exitCode, `${error.message} Before that, it ${removedNote}.`);
    throw error;
  } finally {
    await maintenance.end({ timeout: 5 }).catch(() => {});
  }
}
