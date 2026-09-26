/**
 * stuga-node backup: the Postgres database and the data directory, which only
 * mean something together, taken while the node is proven stopped so both
 * describe one instant. The node takes the same backup itself (`writer`): it
 * holds its writer lock throughout, so nothing else can write, and it has proven
 * itself quiet first, before any actor opened at boot or in maintenance.
 *
 *   1. refuse unless no other backup or restore of this database runs and the node is stopped, or is the caller;
 *   2. refuse unless the backup filesystem has room, with margin;
 *   3. write both halves into `<name>.partial`, owner-only (the archive holds keys and secrets);
 *   4. read both back end to end;
 *   5. confirm this session still holds the ops lock;
 *   6. write the manifest, rename into place, prune to BACKUP_KEEP.
 *
 * Any failure before the rename removes the partial directory; the data was only read.
 */
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { embeddingColumnDims, getSearchLanguages, readSchemaVersion } from "@stuga/db";
import type { BackupEnv } from "./env.js";
import {
  databaseName,
  holdsOpsLock,
  nodeIsRunning,
  sessionConnection,
  tryOpsLock,
  type LockSql,
  type WriterLock,
} from "../writer-lock.js";
import {
  ARCHIVE_NAME,
  DUMP_NAME,
  MANIFEST_FORMAT,
  readManifest,
  syncDirectory,
  writeManifest,
  type Manifest,
} from "./manifest.js";
import { failedUnchanged, messageOf, OpsError, refused, throwIfInterrupted } from "./outcome.js";
import { createArchive, directoryBytes, freeBytes, listArchive, pgTool, run, sha256File } from "./tools.js";

export interface BackupResult {
  path: string;
  manifest: Manifest;
  /** Complete backups retention removed. */
  pruned: string[];
}

export interface BackupDeps {
  now?: () => Date;
  freeBytes?: (path: string) => Promise<number>;
  /** Aborted on SIGINT or SIGTERM: the backup stops and removes what it wrote. */
  signal?: AbortSignal;
  /**
   * The node itself is the caller: it holds its writer lock and has stopped writing, so the
   * backup does not ask for it to be stopped, and checks instead that the lock is still held.
   */
  writer?: Pick<WriterLock, "stillHeld">;
}

/** How much room a backup asks for beyond the measured size of what it copies. */
const HEADROOM = 1.5;

export const PARTIAL_SUFFIX = ".partial";

/**
 * Inside a `.partial` directory, the database it backs up, written first. Nodes
 * can share a backup directory, so only a backup of the same database treats a
 * partial one as abandoned.
 */
export const PARTIAL_OWNER = ".database";

/** A backup's directory name: its UTC creation time, second resolution, sortable. */
function backupName(at: Date): string {
  return at.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "");
}

/** The refusal while a node holds its writer lock. */
export function nodeRunningRefusal(database: string): string {
  return `the node is running against database "${database}"; stop it first. Nothing was changed.`;
}

/** What the database says about itself, for the manifest; a never-booted database has no node tables yet. */
async function describeDatabase(sql: LockSql): Promise<{
  stugaVersion: string | null;
  schemaVersion: number;
  postgresVersionNum: number;
  extensions: Record<string, string>;
  embeddingDims: number | null;
  searchLanguages: string[];
  databaseBytes: number;
}> {
  const [facts] = await sql<
    { has_state: boolean; has_chunks: boolean; has_settings: boolean; version_num: string; bytes: string }[]
  >`
    SELECT to_regclass('public.node_state') IS NOT NULL        AS has_state,
           to_regclass('public.doc_chunks') IS NOT NULL        AS has_chunks,
           to_regclass('public.node_settings') IS NOT NULL     AS has_settings,
           current_setting('server_version_num')               AS version_num,
           pg_database_size(current_database())::text          AS bytes`;
  const stugaVersion = facts!.has_state
    ? ((await sql<{ app_version: string }[]>`SELECT app_version FROM node_state WHERE id = TRUE`)[0]?.app_version ?? null)
    : null;
  const dbSql = sql as unknown as Parameters<typeof embeddingColumnDims>[0];
  const schemaVersion = await readSchemaVersion(dbSql);
  const extensions: Record<string, string> = {};
  for (const e of await sql<{ extname: string; extversion: string }[]>`
    SELECT extname, extversion FROM pg_extension ORDER BY extname`) {
    extensions[e.extname] = e.extversion;
  }
  return {
    stugaVersion,
    schemaVersion,
    postgresVersionNum: Number(facts!.version_num),
    extensions,
    embeddingDims: facts!.has_chunks ? await embeddingColumnDims(dbSql) : null,
    searchLanguages: (facts!.has_settings ? await getSearchLanguages(dbSql) : null) ?? [],
    databaseBytes: Number(facts!.bytes),
  };
}

export async function runBackup(env: BackupEnv, deps: BackupDeps = {}): Promise<BackupResult> {
  const now = deps.now ?? (() => new Date());
  const signal = deps.signal;
  const untouched = "no backup was kept. Your data is untouched.";
  const database = databaseName(env.databaseUrl);
  await mkdir(env.backupDir, { recursive: true, mode: 0o700 });

  const maintenance = sessionConnection(env.databaseUrl, "postgres");
  const app = sessionConnection(env.databaseUrl);
  let partial: string | null = null;
  try {
    if (!(await tryOpsLock(maintenance, database))) {
      throw refused(`another backup or restore of database "${database}" is running; nothing was changed`);
    }
    if (deps.writer) {
      if (!(await deps.writer.stillHeld())) throw refused(`this node no longer holds database "${database}"; nothing was changed`);
    } else if (await nodeIsRunning(app)) {
      throw refused(nodeRunningRefusal(database));
    }

    // The node was proven stopped just now, or is the caller and quiet, so both halves describe this instant.
    const createdAt = now();
    const db = await describeDatabase(app);
    const dataDirBytes = await directoryBytes(env.dataDir);
    const need = Math.ceil((db.databaseBytes + dataDirBytes) * HEADROOM);
    const free = await (deps.freeBytes ?? freeBytes)(env.backupDir);
    if (free < need) {
      throw refused(
        `not enough disk at ${env.backupDir}: about ${mib(need)} needed, ${mib(free)} free. ` +
          `A dump that runs out of space can look complete and not restore. Nothing was changed.`,
      );
    }

    const name = backupName(createdAt);
    const final = join(env.backupDir, name);
    if (await exists(final)) throw refused(`${final} already exists; nothing was changed`);
    partial = `${final}${PARTIAL_SUFFIX}`;
    await rm(partial, { recursive: true, force: true });
    await mkdir(partial, { mode: 0o700 });
    const owner = join(partial, PARTIAL_OWNER);
    await writeFile(owner, database, { mode: 0o600 });

    const dump = join(partial, DUMP_NAME);
    const archive = join(partial, ARCHIVE_NAME);
    try {
      throwIfInterrupted(signal, untouched);
      await run(pgTool(env, "pg_dump"), ["--format=custom", `--file=${dump}`, `--dbname=${env.databaseUrl}`], { signal });
      await createArchive(env.dataDir, archive, signal);
    } catch (err) {
      throwIfInterrupted(signal, untouched);
      throw failedUnchanged(`writing the backup failed: ${messageOf(err)}. Your data is untouched.`);
    }
    await chmod(dump, 0o600);
    await chmod(archive, 0o600);

    // Restoring to /dev/null reads every data block, not only the table of contents.
    try {
      await run(pgTool(env, "pg_restore"), ["--file=/dev/null", dump], { signal });
    } catch (err) {
      throwIfInterrupted(signal, untouched);
      throw failedUnchanged(`the dump did not read back (${messageOf(err)}); ${untouched}`);
    }
    try {
      const listing = await listArchive(archive, signal);
      if (listing.first !== "./") throw new Error(`unexpected first member ${JSON.stringify(listing.first)}`);
    } catch (err) {
      throwIfInterrupted(signal, untouched);
      throw failedUnchanged(`the archive did not read back (${messageOf(err)}); ${untouched}`);
    }
    throwIfInterrupted(signal, untouched);

    // Only this session's unbroken lock proves no node started and wrote while the halves were copied;
    // for the node itself, that it never let go of its own.
    if (deps.writer && !(await deps.writer.stillHeld())) {
      throw failedUnchanged(
        `this node lost its hold on database "${database}" while the backup ran, so nothing proves it was the only writer; ${untouched}`,
      );
    }
    if (!(await holdsOpsLock(maintenance, database).catch(() => false))) {
      throw failedUnchanged(
        `this backup's hold on database "${database}" ended while it ran (Postgres restarted, or the connection dropped), ` +
          `so nothing proves the node stayed stopped throughout; ${untouched}`,
      );
    }

    const manifest: Manifest = {
      format: MANIFEST_FORMAT,
      created_at: createdAt.toISOString(),
      database,
      stuga_version: db.stugaVersion,
      runtime_version: env.version,
      schema_version: db.schemaVersion,
      postgres_version_num: db.postgresVersionNum,
      extensions: db.extensions,
      embedding_dims: db.embeddingDims,
      search_languages: db.searchLanguages,
      public_origin: env.publicOrigin,
      database_bytes: db.databaseBytes,
      data_dir_bytes: dataDirBytes,
      files: { [DUMP_NAME]: await sha256File(dump), [ARCHIVE_NAME]: await sha256File(archive) },
    };
    await writeManifest(partial, manifest);
    await rename(partial, final);
    partial = null;
    await syncDirectory(env.backupDir);
    // Only after the rename: a crashed partial directory must stay recognisable to a later backup.
    await rm(join(final, PARTIAL_OWNER), { force: true }).catch(() => {});

    // Retention never fails a backup that is already whole.
    const pruned = await prune(env, database, name).catch((err: unknown) => {
      console.warn(`[backup] retention skipped: ${messageOf(err)}`);
      return [] as string[];
    });
    return { path: final, manifest, pruned };
  } catch (err) {
    if (partial) await rm(partial, { recursive: true, force: true }).catch(() => {});
    if (err instanceof OpsError) throw err;
    throw failedUnchanged(`the backup failed: ${messageOf(err)}. Your data is untouched.`);
  } finally {
    await app.end({ timeout: 5 }).catch(() => {});
    await maintenance.end({ timeout: 5 }).catch(() => {});
  }
}

/**
 * Keep the newest BACKUP_KEEP complete backups of `database`. Under its ops
 * lock, a `.partial` directory of the same database is abandoned and goes too.
 * Only directories whose manifest or owner file names this database are removed.
 */
async function prune(env: BackupEnv, database: string, justMade: string): Promise<string[]> {
  const entries = await readdir(env.backupDir, { withFileTypes: true });
  const complete: { name: string; createdAt: number }[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(env.backupDir, entry.name);
    if (entry.name.endsWith(PARTIAL_SUFFIX)) {
      const owner = await readFile(join(path, PARTIAL_OWNER), "utf8").catch(() => null);
      const manifestOf = owner === null ? ((await readManifest(path).catch(() => null))?.database ?? null) : null;
      if (owner === database || manifestOf === database) await rm(path, { recursive: true, force: true });
      continue;
    }
    const manifest = await readManifest(path).catch(() => null);
    if (manifest?.database === database) complete.push({ name: entry.name, createdAt: Date.parse(manifest.created_at) });
  }
  complete.sort((a, b) => b.createdAt - a.createdAt || (a.name < b.name ? 1 : -1));
  const removed: string[] = [];
  for (const old of complete.slice(env.keep)) {
    if (old.name === justMade) continue;
    await rm(join(env.backupDir, old.name), { recursive: true, force: true });
    removed.push(old.name);
  }
  return removed;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

export function mib(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1048576))} MiB`;
}
