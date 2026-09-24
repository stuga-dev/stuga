/**
 * The backup a node takes of a database another version served, against a real
 * Postgres, pg_dump and tar. Needs TEST_DATABASE_URL (Postgres 18 preloading
 * pg_search) and client tools of major 18+ from PG_BIN or PATH; skips without the URL.
 */
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { initSchema, recordNodeBoot, runBootRepairs } from "@stuga/db";
import { parseBackupEnv, type BackupEnv } from "../ops/env.js";
import { readManifest } from "../ops/manifest.js";
import { OpsError } from "../ops/outcome.js";
import { holdWriterLock, sessionConnection, withDatabase, type LockSql, type WriterLock } from "../writer-lock.js";
import { backupBeforeUpgrade } from "./upgrade-backup.js";

const URL = process.env.TEST_DATABASE_URL;
const DB = `stuga_ub_${process.pid}`;

let root: string;
let dbUrl: string;
let maintenance: LockSql;
let app: LockSql;
let writer: WriterLock;

function envAt(version: string): BackupEnv {
  return {
    ...parseBackupEnv({
      DATABASE_URL: dbUrl,
      DATA_DIR: join(root, "node"),
      BACKUP_DIR: join(root, "backups"),
      BACKUP_KEEP: "5",
      ...(process.env.PG_BIN ? { PG_BIN: process.env.PG_BIN } : {}),
    }),
    version,
  };
}

const backups = async () => (await readdir(join(root, "backups")).catch(() => [])).sort();

describe.skipIf(!URL)("the backup before an upgrade", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    dbUrl = withDatabase(URL!, DB);
    maintenance = sessionConnection(URL!, "postgres");
    await maintenance`DROP DATABASE IF EXISTS ${maintenance(DB)} WITH (FORCE)`;
    await maintenance`CREATE DATABASE ${maintenance(DB)}`;
    app = sessionConnection(dbUrl);
  });

  afterAll(async () => {
    await writer?.release();
    await app?.end({ timeout: 5 }).catch(() => {});
    if (root) await rm(root, { recursive: true, force: true });
    if (maintenance) {
      await maintenance`DROP DATABASE IF EXISTS ${maintenance(DB)} WITH (FORCE)`;
      await maintenance.end({ timeout: 5 });
    }
  });

  beforeEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = await mkdtemp(join(tmpdir(), "stuga-upgrade-backup-"));
    await mkdir(join(root, "node/actors/docs"), { recursive: true });
    await writeFile(join(root, "node/actors/docs/d1.sqlite"), "sqlite bytes");
    await writer?.release();
    const held = await holdWriterLock(dbUrl, () => {});
    if (!held.held) throw new Error(`could not take the writer lock: ${held.reason}`);
    writer = held;
  });

  it("takes nothing of a database no node has booted on", async () => {
    expect(await backupBeforeUpgrade({ sql: app as never, env: envAt("1.1.0"), writer })).toEqual({
      taken: false,
      reason: "new-database",
    });
    expect(await backups()).toEqual([]);
  });

  it("takes nothing when the same version served the database last", async () => {
    await initSchema(app as never);
    await runBootRepairs(app as never);
    await recordNodeBoot(app as never, "1.0.0");
    expect(await backupBeforeUpgrade({ sql: app as never, env: envAt("1.0.0"), writer })).toEqual({
      taken: false,
      reason: "same-version",
    });
    expect(await backups()).toEqual([]);
  });

  it("backs up another version's data once, while holding the writer lock, and names that version in the manifest", async () => {
    const started: string[] = [];
    const first = await backupBeforeUpgrade({
      sql: app as never,
      env: envAt("1.1.0"),
      writer,
      onStart: (from) => started.push(from),
    });
    expect(first).toMatchObject({ taken: true, from: "1.0.0" });
    expect(started).toEqual(["1.0.0"]);
    const path = (first as { path: string }).path;
    const m = await readManifest(path);
    expect(m).toMatchObject({ database: DB, stuga_version: "1.0.0", runtime_version: "1.1.0" });

    // The new version failed to start and is started again: the data is still the old version's.
    const again = await backupBeforeUpgrade({ sql: app as never, env: envAt("1.1.0"), writer, onStart: (from) => started.push(from) });
    expect(again).toEqual({ taken: false, reason: "already-taken", path, from: "1.0.0" });
    expect(started).toEqual(["1.0.0"]);
    expect(await backups()).toHaveLength(1);

    // The old version served the database again, so that backup no longer describes it. A backup's
    // name is its second, so the next one waits for another.
    await new Promise((r) => setTimeout(r, 1100));
    await recordNodeBoot(app as never, "1.0.0");
    const later = await backupBeforeUpgrade({ sql: app as never, env: envAt("1.1.0"), writer });
    expect(later).toMatchObject({ taken: true, from: "1.0.0" });
    expect((later as { path: string }).path).not.toBe(path);
  });

  it("refuses when the node no longer holds its database", async () => {
    await writer.release();
    const err = await backupBeforeUpgrade({ sql: app as never, env: envAt("1.2.0"), writer }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpsError);
    expect((err as OpsError).exitCode).toBe(2);
    expect((err as OpsError).message).toMatch(/no longer holds/);
  });
});
