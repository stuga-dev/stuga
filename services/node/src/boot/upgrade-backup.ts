/**
 * The backup a node takes before it changes a database that another version
 * served. Migrations, extension updates and search index rebuilds all run at
 * boot and none of them has a way back but a restore, so the node takes the
 * backup itself: every way a new version arrives (an upgrade command, a package,
 * a NAS app store, an image pulled by hand) passes through here, and only some
 * of them would run a backup of their own.
 *
 * Taken before any actor opens, while the node holds its writer lock, so the
 * two halves describe one instant as a stopped node's would. The manifest's
 * `stuga_version` is the version that served the data, which is the one to go
 * back to; `runtime_version` is this build.
 *
 * Once per upgrade: a backup this build already took of this data, after the
 * last successful boot, is still the data as the old version left it, so a new
 * version that fails to start and is restarted does not take another one and
 * push older backups out of retention.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { lastNodeBoot, type Sql } from "@stuga/db";
import { runBackup, PARTIAL_SUFFIX } from "../ops/backup.js";
import type { BackupEnv } from "../ops/env.js";
import { readManifest } from "../ops/manifest.js";
import { databaseName, type WriterLock } from "../writer-lock.js";

export type UpgradeBackup =
  | { taken: true; path: string; from: string }
  | { taken: false; reason: "new-database" | "same-version" }
  | { taken: false; reason: "already-taken"; path: string; from: string };

/** `env.version` is this build's: the version the data is about to be upgraded to. */
export async function backupBeforeUpgrade(opts: {
  sql: Sql;
  env: BackupEnv;
  writer: Pick<WriterLock, "stillHeld">;
  signal?: AbortSignal;
  /** Called with the version being upgraded from, just before the backup starts. */
  onStart?: (from: string) => void;
}): Promise<UpgradeBackup> {
  const last = await lastNodeBoot(opts.sql);
  if (!last) return { taken: false, reason: "new-database" };
  if (last.version === opts.env.version) return { taken: false, reason: "same-version" };

  const earlier = await findUpgradeBackup(opts.env, last.version, last.at);
  if (earlier) return { taken: false, reason: "already-taken", path: earlier, from: last.version };

  opts.onStart?.(last.version);
  const { path } = await runBackup(opts.env, { writer: opts.writer, signal: opts.signal });
  return { taken: true, path, from: last.version };
}

/** A whole backup of this database this build took of `from`'s data since that version last booted. */
async function findUpgradeBackup(env: BackupEnv, from: string, lastBootAt: Date): Promise<string | null> {
  const database = databaseName(env.databaseUrl);
  const entries = await readdir(env.backupDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.endsWith(PARTIAL_SUFFIX)) continue;
    const path = join(env.backupDir, entry.name);
    const m = await readManifest(path).catch(() => null);
    if (
      m &&
      m.database === database &&
      m.stuga_version === from &&
      m.runtime_version === env.version &&
      Date.parse(m.created_at) > lastBootAt.getTime()
    ) {
      return path;
    }
  }
  return null;
}
