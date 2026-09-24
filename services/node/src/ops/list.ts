/**
 * stuga-node list: complete backups newest first, `.partial` backups the next
 * backup removes, what restores replaced (kept until a person removes them), and
 * what an interrupted restore left (the next restore removes it).
 */
import { readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { PARTIAL_SUFFIX } from "./backup.js";
import type { BackupEnv } from "./env.js";
import { databaseName, sessionConnection } from "../writer-lock.js";
import { readManifest } from "./manifest.js";
import { STAMP } from "./restore.js";

export interface ListResult {
  backups: { name: string; path: string; database: string; created_at: string; stuga_version: string | null; schema_version: number; bytes: number }[];
  partial: string[];
  replacedDataDirs: string[];
  /** Null when the server did not answer. */
  replacedDatabases: string[] | null;
  unfinishedRestoreDirs: string[];
  /** Null when the server did not answer. */
  unfinishedRestoreDatabases: string[] | null;
}

async function entries(dir: string) {
  return readdir(dir, { withFileTypes: true }).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return [];
    throw err;
  });
}

export async function runList(env: BackupEnv): Promise<ListResult> {
  const backups: ListResult["backups"] = [];
  const partial: string[] = [];
  for (const entry of await entries(env.backupDir)) {
    if (!entry.isDirectory()) continue;
    const path = join(env.backupDir, entry.name);
    if (entry.name.endsWith(PARTIAL_SUFFIX)) {
      partial.push(path);
      continue;
    }
    const m = await readManifest(path).catch(() => null);
    if (!m) continue;
    backups.push({
      name: entry.name,
      path,
      database: m.database,
      created_at: m.created_at,
      stuga_version: m.stuga_version,
      schema_version: m.schema_version,
      bytes: m.files["postgres.dump"].bytes + m.files["data.tar.gz"].bytes,
    });
  }
  backups.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));

  const dataName = basename(env.dataDir);
  const siblings = (await entries(dirname(env.dataDir))).filter((e) => e.isDirectory());
  const siblingsNamed = (infix: string) =>
    siblings
      .filter((e) => e.name.startsWith(`${dataName}${infix}`) && STAMP.test(e.name.slice(dataName.length + infix.length)))
      .map((e) => join(dirname(env.dataDir), e.name))
      .sort();

  const database = databaseName(env.databaseUrl);
  const sql = sessionConnection(env.databaseUrl, "postgres");
  const databasesNamed = (infix: string) =>
    sql<{ datname: string }[]>`
      SELECT datname FROM pg_database WHERE starts_with(datname, ${`${database}${infix}`}) ORDER BY datname`.then((rows) =>
      rows.map((r) => r.datname).filter((n) => STAMP.test(n.slice(database.length + infix.length))),
    );
  const [replacedDatabases, unfinishedRestoreDatabases] = await Promise.all([
    databasesNamed("_replaced_").catch(() => null),
    databasesNamed("_restore_").catch(() => null),
  ]).finally(() => sql.end({ timeout: 5 }).catch(() => {}));

  return {
    backups,
    partial,
    replacedDataDirs: siblingsNamed(".replaced-"),
    replacedDatabases,
    unfinishedRestoreDirs: siblingsNamed(".restore-"),
    unfinishedRestoreDatabases,
  };
}
