/**
 * stuga-node backup, verify, restore and list against a real Postgres, pg_dump,
 * pg_restore and tar. Needs TEST_DATABASE_URL (Postgres 18 preloading pg_search)
 * and client tools of major 18+ from PG_BIN or PATH; skips without the URL. Each
 * run works in a database of its own and drops it, and everything a restore kept
 * beside it, at the end. Every refusal and failure must leave the database, the
 * data directory and the backup directory as they were.
 */
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readdir, readFile, rename, rm, stat, truncate, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDoc, initSchema, runBootRepairs, SCHEMA_VERSION } from "@stuga/db";
import { ConfigError } from "../config/env.js";
import { PARTIAL_OWNER, runBackup } from "./backup.js";
import { parseBackupEnv, type BackupEnv } from "./env.js";
import { runList } from "./list.js";
import {
  holdWriterLock,
  LOCK_CLASS,
  LOCK_SESSION_OPTIONS,
  nameKey,
  sessionConnection,
  tryOpsLock,
  withDatabase,
  type LockSql,
} from "../writer-lock.js";
import { ARCHIVE_NAME, DUMP_NAME, MANIFEST_NAME, readManifest, writeManifest, type Manifest } from "./manifest.js";
import { OpsError } from "./outcome.js";
import { defaultRestoreDump, runRestore } from "./restore.js";
import { sha256File } from "./tools.js";
import { runVerify } from "./verify.js";

const URL = process.env.TEST_DATABASE_URL;
const DB = `stuga_bk_${process.pid}`;
const WS = "ws-backup";
/** This run's databases beside DB (`<DB>_…`), and no other run's: `_` is a LIKE wildcard. */
const BESIDE_DB = `${DB.replace(/[\\%_]/g, (c) => `\\${c}`)}\\_%`;

let root: string;
/** Every temporary directory this run made, removed when it ends. */
const temporary: string[] = [];
let dbUrl: string;
let maintenance: LockSql;
let app: LockSql;

function envFor(overrides: Record<string, string> = {}): BackupEnv {
  return parseBackupEnv({
    DATABASE_URL: dbUrl,
    DATA_DIR: join(root, "node"),
    BACKUP_DIR: join(root, "backups"),
    BACKUP_KEEP: "5",
    ...(process.env.PG_BIN ? { PG_BIN: process.env.PG_BIN } : {}),
    ...overrides,
  });
}

async function expectExit(promise: Promise<unknown>, code: 2 | 3 | 4, message?: RegExp): Promise<OpsError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, "expected the operation to fail").toBeInstanceOf(OpsError);
  expect((err as OpsError).exitCode, (err as OpsError).message).toBe(code);
  if (message) expect((err as OpsError).message).toMatch(message);
  return err as OpsError;
}

const docIds = async (): Promise<string[]> =>
  (await app<{ doc_id: string }[]>`SELECT doc_id FROM docs ORDER BY doc_id`).map((r) => r.doc_id);

async function ourDatabases(): Promise<string[]> {
  return (
    await maintenance<{ datname: string }[]>`
      SELECT datname FROM pg_database WHERE datname = ${DB} OR datname LIKE ${BESIDE_DB} ORDER BY datname`
  ).map((r) => r.datname);
}

/** Everything a refusal must leave alone, in one comparable value. */
async function snapshot(): Promise<unknown> {
  const beside = await readdir(root);
  const backups = await readdir(join(root, "backups")).catch(() => []);
  const node = await readdir(join(root, "node"), { recursive: true }).catch(() => []);
  const secret = await readFile(join(root, "node/secrets/internal"), "utf8").catch(() => null);
  return { beside: beside.sort(), backups: backups.sort(), node: node.sort(), secret, databases: await ourDatabases(), docs: await docIds() };
}

/** A realistic data directory: a blob with its sidecar, an actor store, a secret. */
async function seedDataDir(): Promise<void> {
  const node = join(root, "node");
  await mkdir(join(node, "blobs/media/media/ws"), { recursive: true });
  await mkdir(join(node, "actors/docs"), { recursive: true });
  await mkdir(join(node, "secrets"), { recursive: true, mode: 0o700 });
  await mkdir(join(root, "backups"));
  await writeFile(join(node, "blobs/media/media/ws/abc.blob"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(join(node, "blobs/media/media/ws/abc.blob.meta.json"), JSON.stringify({ contentType: "image/png" }));
  await writeFile(join(node, "actors/docs/d1.sqlite"), "sqlite bytes");
  await writeFile(join(node, "secrets/internal"), "s3cret", { mode: 0o600 });
  // The upload time media-scan reads is the file's mtime, so a restore must keep it.
  const uploaded = new Date("2026-01-02T03:04:05Z");
  await utimes(join(node, "blobs/media/media/ws/abc.blob"), uploaded, uploaded);
}

/** Rewrite a manifest after tampering with a file, so only a deeper check can catch it. */
async function rehash(dir: string, edit: (m: Manifest) => void = () => {}): Promise<void> {
  const m = await readManifest(dir);
  m.files[DUMP_NAME] = await sha256File(join(dir, DUMP_NAME));
  m.files[ARCHIVE_NAME] = await sha256File(join(dir, ARCHIVE_NAME));
  edit(m);
  await rm(join(dir, MANIFEST_NAME));
  await writeManifest(dir, m);
}

/** The directory holding the real pg_dump and pg_restore. */
function realPgBin(): string {
  if (process.env.PG_BIN) return process.env.PG_BIN;
  return dirname(spawnSync("sh", ["-c", "command -v pg_dump"], { encoding: "utf8" }).stdout.trim());
}

/**
 * A PG_BIN whose pg_restore is the real one and whose pg_dump runs `script`
 * (sh), with the real pg_dump as $REAL and the file it writes as $FILE.
 */
async function pgBinWith(script: string): Promise<string> {
  const bin = await mkdtemp(join(tmpdir(), "stuga-pgbin-"));
  temporary.push(bin);
  const real = realPgBin();
  await writeFile(
    join(bin, "pg_dump"),
    `#!/bin/sh\nREAL="${real}/pg_dump"\nFILE=""\nfor a in "$@"; do case "$a" in --file=*) FILE="\${a#--file=}" ;; esac; done\n${script}\n`,
    { mode: 0o755 },
  );
  await writeFile(join(bin, "pg_restore"), `#!/bin/sh\nexec "${real}/pg_restore" "$@"\n`, { mode: 0o755 });
  return bin;
}

/** Terminate the session holding `database`'s ops lock, once one does. */
async function terminateOpsLockHolder(database: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const rows = await maintenance<{ pid: number }[]>`
      SELECT pid FROM pg_locks
      WHERE locktype = 'advisory' AND classid = ${String(LOCK_CLASS >>> 0)}::oid
        AND objid = ${String(nameKey(database) >>> 0)}::oid AND objsubid = 2 AND granted
        AND pid <> pg_backend_pid()`;
    if (rows.length > 0) {
      await maintenance`SELECT pg_terminate_backend(${rows[0]!.pid})`;
      return;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`no session ever held the ops lock for ${database}`);
}

// Real pg_restore and tar several times per case run well past vitest's default timeout.
describe.skipIf(!URL)("stuga-node backup, verify and restore", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    const pgDump = join(realPgBin(), "pg_dump");
    const version = spawnSync(pgDump, ["--version"], { encoding: "utf8" });
    const major = Number(/\(PostgreSQL\) (\d+)/.exec(version.stdout ?? "")?.[1]);
    expect(major, `pg_dump of major 18 or newer is required (set PG_BIN); ${pgDump} said ${JSON.stringify(version.stdout ?? version.error?.message)}`).toBeGreaterThanOrEqual(18);

    dbUrl = withDatabase(URL!, DB);
    maintenance = sessionConnection(URL!, "postgres");
    await maintenance`DROP DATABASE IF EXISTS ${maintenance(DB)} WITH (FORCE)`;
    await maintenance`CREATE DATABASE ${maintenance(DB)}`;
    app = sessionConnection(dbUrl);
    await initSchema(app as never);
    await runBootRepairs(app as never);
    await app`INSERT INTO workspaces (workspace_id, name) VALUES (${WS}, 'Backup')`;
  });

  afterAll(async () => {
    for (const dir of temporary) await rm(dir, { recursive: true, force: true });
    await app?.end({ timeout: 5 }).catch(() => {});
    if (maintenance) {
      for (const datname of await ourDatabases()) await maintenance`DROP DATABASE IF EXISTS ${maintenance(datname)} WITH (FORCE)`;
      await maintenance.end({ timeout: 5 });
    }
  });

  beforeEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = await mkdtemp(join(tmpdir(), "stuga-backup-"));
    temporary.push(root);
    await seedDataDir();
    await app`TRUNCATE docs CASCADE`;
    await createDoc(app as never, { docId: "d1", workspaceId: WS, owner: "user:alice", title: "Kept" });
    for (const datname of await ourDatabases()) {
      if (datname !== DB) await maintenance`DROP DATABASE IF EXISTS ${maintenance(datname)} WITH (FORCE)`;
    }
  });

  describe("backup", () => {
    it("writes both halves and a manifest that describes them, owner-only", async () => {
      const result = await runBackup(envFor());
      const m = result.manifest;
      expect(m.format).toBe(1);
      expect(m.database).toBe(DB);
      expect(m.schema_version).toBe(SCHEMA_VERSION);
      expect(Math.floor(m.postgres_version_num / 10000)).toBe(18);
      expect(m.embedding_dims).toBe(1024);
      expect(Object.keys(m.extensions)).toEqual(expect.arrayContaining(["pg_search", "vector"]));
      expect(m.files[DUMP_NAME]).toEqual(await sha256File(join(result.path, DUMP_NAME)));
      expect(m.files[ARCHIVE_NAME]).toEqual(await sha256File(join(result.path, ARCHIVE_NAME)));
      expect((await stat(result.path)).mode & 0o777).toBe(0o700);
      expect((await stat(join(result.path, DUMP_NAME))).mode & 0o777).toBe(0o600);
      expect((await stat(join(result.path, ARCHIVE_NAME))).mode & 0o777).toBe(0o600);
      expect((await readdir(result.path)).sort()).toEqual([ARCHIVE_NAME, MANIFEST_NAME, DUMP_NAME].sort());
      expect(await readdir(join(root, "backups"))).toEqual([result.path.split("/").pop()]);
      await expect(runVerify(envFor(), result.path)).resolves.toMatchObject({ path: result.path });
    });

    it("refuses while a node holds its writer lock, and changes nothing", async () => {
      const node = await holdWriterLock(dbUrl, () => {});
      expect(node.held).toBe(true);
      try {
        const before = await snapshot();
        await expectExit(runBackup(envFor()), 2, /node is running/);
        expect(await snapshot()).toEqual(before);
      } finally {
        if (node.held) await node.release();
      }
    });

    it("refuses while another backup or restore holds the ops lock", async () => {
      const other = sessionConnection(URL!, "postgres");
      try {
        expect(await tryOpsLock(other, DB)).toBe(true);
        const before = await snapshot();
        await expectExit(runBackup(envFor()), 2, /another backup or restore/);
        expect(await snapshot()).toEqual(before);
      } finally {
        await other.end({ timeout: 5 });
      }
    });

    it("refuses when the disk cannot hold both halves, and leaves no partial directory", async () => {
      const before = await snapshot();
      await expectExit(runBackup(envFor(), { freeBytes: async () => 0 }), 2, /not enough disk/);
      expect(await snapshot()).toEqual(before);
    });

    it("refuses a BACKUP_KEEP that would delete the backup it just took", () => {
      for (const keep of ["0", "-1", "five", "2.5"]) {
        expect(() => envFor({ BACKUP_KEEP: keep }), keep).toThrow(ConfigError);
      }
    });

    it("keeps the newest BACKUP_KEEP complete backups of its own database, and leaves everything else alone", async () => {
      const backups = join(root, "backups");
      const env = envFor({ BACKUP_KEEP: "2" });
      const at = (s: string) => () => new Date(s);
      // Only this database's partial is abandoned; another database's partial, an
      // ownerless one, another database's backup and a foreign directory stay.
      await mkdir(join(backups, "2020-01-01T000000Z.partial"), { recursive: true });
      await writeFile(join(backups, "2020-01-01T000000Z.partial", PARTIAL_OWNER), DB);
      await mkdir(join(backups, "2020-01-02T000000Z.partial"), { recursive: true });
      await writeFile(join(backups, "2020-01-02T000000Z.partial", PARTIAL_OWNER), "other_node");
      await mkdir(join(backups, "2020-01-03T000000Z.partial"), { recursive: true });
      await mkdir(join(backups, "not-a-backup"), { recursive: true });
      const foreign = await runBackup(env, { now: at("2025-01-01T00:00:00Z") });
      await rehash(foreign.path, (m) => void (m.database = "other_node"));

      const first = await runBackup(env, { now: at("2026-01-01T00:00:00Z") });
      // Crashed between manifest and rename: recognised by the manifest.
      await mkdir(join(backups, "2020-01-04T000000Z.partial"));
      await writeFile(join(backups, "2020-01-04T000000Z.partial", MANIFEST_NAME), await readFile(join(first.path, MANIFEST_NAME)));
      await mkdir(join(backups, "2020-01-05T000000Z.partial"));
      await writeFile(join(backups, "2020-01-05T000000Z.partial", MANIFEST_NAME), await readFile(join(foreign.path, MANIFEST_NAME)));
      await runBackup(env, { now: at("2026-01-02T00:00:00Z") });
      const third = await runBackup(env, { now: at("2026-01-03T00:00:00Z") });
      expect(third.pruned).toEqual(["2026-01-01T000000Z"]);
      expect((await readdir(backups)).sort()).toEqual([
        "2020-01-02T000000Z.partial",
        "2020-01-03T000000Z.partial",
        "2020-01-05T000000Z.partial",
        "2025-01-01T000000Z",
        "2026-01-02T000000Z",
        "2026-01-03T000000Z",
        "not-a-backup",
      ]);
    });

    it("fails, keeps nothing and changes nothing when pg_dump fails", async () => {
      const bin = await pgBinWith(`echo "simulated failure" >&2\nexit 1`);
      const before = await snapshot();
      await expectExit(runBackup(envFor({ PG_BIN: bin })), 3, /writing the backup failed.*simulated failure/);
      expect(await snapshot()).toEqual(before);
    });

    it("reads the dump back before keeping it: a pg_dump that exits 0 with a short file keeps nothing", async () => {
      const bin = await pgBinWith(
        `"$REAL" "$@" || exit $?\nsize=$(wc -c < "$FILE")\nhead -c $((size - 64)) "$FILE" > "$FILE.short" && mv "$FILE.short" "$FILE"`,
      );
      const before = await snapshot();
      await expectExit(runBackup(envFor({ PG_BIN: bin })), 3, /did not read back/);
      expect(await snapshot()).toEqual(before);
    });

    it("keeps nothing if its session's ops lock ended while it ran, since a node could have started", async () => {
      const bin = await pgBinWith(`sleep 1\nexec "$REAL" "$@"`);
      const before = await snapshot();
      const backup = runBackup(envFor({ PG_BIN: bin }));
      await terminateOpsLockHolder(DB);
      await expectExit(backup, 3, /hold on database .* ended/);
      expect(await snapshot()).toEqual(before);
    });

    it("stops and keeps nothing when interrupted", async () => {
      const bin = await pgBinWith(`sleep 5\nexec "$REAL" "$@"`);
      const controller = new AbortController();
      const before = await snapshot();
      const backup = runBackup(envFor({ PG_BIN: bin }), { signal: controller.signal });
      setTimeout(() => controller.abort(), 300);
      await expectExit(backup, 3, /interrupted/);
      expect(await snapshot()).toEqual(before);
    });
  });

  describe("verify", () => {
    let backup: string;
    beforeEach(async () => {
      backup = (await runBackup(envFor())).path;
    });

    it("refuses a half that no longer matches its checksum", async () => {
      const bytes = await readFile(join(backup, ARCHIVE_NAME));
      const at = bytes.length - 20;
      bytes[at] = bytes[at]! ^ 0xff;
      await writeFile(join(backup, ARCHIVE_NAME), bytes);
      await expectExit(runVerify(envFor(), backup), 2, /does not match its checksum/);
    });

    it("refuses a dump truncated in its data — one whose table of contents still lists — even with a manifest rewritten to match", async () => {
      const dump = join(backup, DUMP_NAME);
      const size = (await stat(dump)).size;
      await truncate(dump, size - 64);
      // The cut is past the table of contents: a listing still succeeds.
      const listing = spawnSync(join(realPgBin(), "pg_restore"), ["--list", dump], { encoding: "utf8" });
      expect(listing.status, listing.stderr).toBe(0);
      await rehash(backup);
      await expectExit(runVerify(envFor(), backup), 2, /does not read back/);
    });

    it("refuses an archive that does not read back, even with a manifest rewritten to match", async () => {
      const size = (await stat(join(backup, ARCHIVE_NAME))).size;
      await truncate(join(backup, ARCHIVE_NAME), Math.floor(size / 2));
      await rehash(backup);
      await expectExit(runVerify(envFor(), backup), 2, /does not read back/);
    });

    it("refuses a backup this runtime cannot restore", async () => {
      const cases: [string, (m: Manifest) => void, RegExp][] = [
        ["newer schema", (m) => void (m.schema_version = SCHEMA_VERSION + 1), /only knows schema/],
        ["another Postgres major", (m) => void (m.postgres_version_num = 170004), /Postgres 17/],
        ["another embedding width", (m) => void (m.embedding_dims = 768), /width 768/],
      ];
      for (const [label, edit, message] of cases) {
        const original = await readFile(join(backup, MANIFEST_NAME), "utf8");
        await rehash(backup, edit);
        await expectExit(runVerify(envFor(), backup), 2, message).catch((err: unknown) => {
          throw new Error(`${label}: ${String(err)}`);
        });
        await rm(join(backup, MANIFEST_NAME));
        await writeFile(join(backup, MANIFEST_NAME), original);
      }
    });

    it("refuses a directory with no manifest, or one it cannot read", async () => {
      await writeFile(join(backup, MANIFEST_NAME), '{"format": 2}');
      await expectExit(runVerify(envFor(), backup), 2, /format 2/);
      await rm(join(backup, MANIFEST_NAME));
      await expectExit(runVerify(envFor(), backup), 2, /no MANIFEST/);
    });

    it("says an older schema will migrate forward rather than refusing it", async () => {
      await rehash(backup, (m) => void (m.schema_version = SCHEMA_VERSION - 1));
      const result = await runVerify(envFor(), backup);
      expect(result.notes.join(" ")).toMatch(new RegExp(`migrates it to schema ${SCHEMA_VERSION}`));
    });
  });

  describe("restore", () => {
    let backup: string;
    beforeEach(async () => {
      backup = (await runBackup(envFor())).path;
      // Life after the backup: a document added, a secret rotated.
      await createDoc(app as never, { docId: "d2", workspaceId: WS, owner: "user:alice", title: "After" });
      await writeFile(join(root, "node/secrets/internal"), "rotated", { mode: 0o600 });
      // A restore disconnects every session on the database it replaces.
      await app.end({ timeout: 5 });
      app = sessionConnection(dbUrl);
    });

    it("puts both halves back and keeps what it replaced, both halves, under names it reports", async () => {
      const result = await runRestore(envFor(), backup, { confirmed: true });

      expect(await docIds()).toEqual(["d1"]);
      const node = join(root, "node");
      expect(await readFile(join(node, "secrets/internal"), "utf8")).toBe("s3cret");
      expect((await stat(join(node, "secrets/internal"))).mode & 0o777).toBe(0o600);
      expect(await readFile(join(node, "blobs/media/media/ws/abc.blob.meta.json"), "utf8")).toContain("image/png");
      expect((await stat(join(node, "blobs/media/media/ws/abc.blob"))).mtime.toISOString()).toBe("2026-01-02T03:04:05.000Z");

      expect(result.replacedDatabase).toMatch(new RegExp(`^${DB}_replaced_`));
      const replaced = sessionConnection(URL!, result.replacedDatabase!);
      try {
        expect((await replaced<{ doc_id: string }[]>`SELECT doc_id FROM docs ORDER BY doc_id`).map((r) => r.doc_id)).toEqual(["d1", "d2"]);
      } finally {
        await replaced.end({ timeout: 5 });
      }
      expect(await readFile(join(result.replacedDataDir!, "secrets/internal"), "utf8")).toBe("rotated");

      const list = await runList(envFor());
      expect(list.replacedDatabases).toEqual([result.replacedDatabase]);
      expect(list.replacedDataDirs).toEqual([result.replacedDataDir]);
      expect(list.unfinishedRestoreDirs).toEqual([]);
      expect(list.unfinishedRestoreDatabases).toEqual([]);
      expect(list.backups.map((b) => b.path)).toEqual([backup]);
    });

    it("refuses without confirmation, and changes nothing", async () => {
      const before = await snapshot();
      await expectExit(runRestore(envFor(), backup, { confirmed: false }), 2, /confirm/);
      expect(await snapshot()).toEqual(before);
    });

    it("refuses while a node holds its writer lock", async () => {
      const node = await holdWriterLock(dbUrl, () => {});
      try {
        const before = await snapshot();
        await expectExit(runRestore(envFor(), backup, { confirmed: true }), 2, /node is running/);
        expect(await snapshot()).toEqual(before);
      } finally {
        if (node.held) await node.release();
      }
    });

    it("refuses a damaged backup before touching anything", async () => {
      await truncate(join(backup, DUMP_NAME), 100);
      const before = await snapshot();
      await expectExit(runRestore(envFor(), backup, { confirmed: true }), 2);
      expect(await snapshot()).toEqual(before);
    });

    it("refuses when there is no room for a second copy, before writing anything", async () => {
      const before = await snapshot();
      await expectExit(runRestore(envFor(), backup, { confirmed: true }, { freeBytes: async () => 0 }), 2, /not enough disk/);
      expect(await snapshot()).toEqual(before);
    });

    it("counts the side database when the server's disk is visible, and says so when it is not", async () => {
      const m = await readManifest(backup);
      const before = await snapshot();
      // Room for the extracted data directory, not for a second database too.
      const justTheDirectory = Math.ceil(m.data_dir_bytes * 1.2) + 1;
      const outcome = await runRestore(envFor(), backup, { confirmed: true }, { freeBytes: async () => justTheDirectory }).then(
        (r) => r,
        (e: unknown) => e,
      );
      if (outcome instanceof OpsError) {
        expect(outcome.exitCode).toBe(2);
        expect(outcome.message).toMatch(/second copy of the database/);
        expect(await snapshot()).toEqual(before);
      } else {
        expect((outcome as { notes: string[] }).notes.join(" ")).toMatch(/not visible from here and was not checked/);
      }
    });

    it("leaves the current database and data directory untouched when the database restore fails midway", async () => {
      const before = await snapshot();
      await expectExit(
        runRestore(envFor(), backup, { confirmed: true }, {
          restoreDump: async () => {
            throw new Error("pg_restore exited 1: simulated");
          },
        }),
        3,
        /Nothing was changed/,
      );
      expect(await snapshot()).toEqual(before);
    });

    it("stops before the swap, and changes nothing, if its session's ops lock ended while it ran", async () => {
      const before = await snapshot();
      await expectExit(
        runRestore(envFor(), backup, { confirmed: true }, {
          restoreDump: async (env, dump, sideUrl, signal) => {
            await terminateOpsLockHolder(DB);
            await defaultRestoreDump(env, dump, sideUrl, signal);
          },
        }),
        3,
        /hold on database .* ended/,
      );
      expect(await snapshot()).toEqual(before);
    });

    it("stops and cleans up when interrupted before the swap", async () => {
      const controller = new AbortController();
      const before = await snapshot();
      await expectExit(
        runRestore(envFor(), backup, { confirmed: true }, {
          signal: controller.signal,
          restoreDump: async () => {
            controller.abort();
          },
        }),
        3,
        /interrupted while restoring the database/,
      );
      expect(await snapshot()).toEqual(before);
    });

    it("puts every rename back, newest first, when the last one fails", async () => {
      const before = await snapshot();
      const calls: string[] = [];
      await expectExit(
        runRestore(envFor(), backup, { confirmed: true }, {
          renameDirectory: async (from, to) => {
            calls.push(`${from.slice(root.length)} -> ${to.slice(root.length)}`);
            if (from.includes(".restore-")) throw new Error("simulated rename failure");
            await rename(from, to);
          },
        }),
        3,
        /failed while swapping \(simulated rename failure\); everything was put back/,
      );
      expect(calls.map((c) => c.replace(/\d{8}t\d{6}z/g, "S"))).toEqual([
        "/node -> /node.replaced-S",
        "/node.restore-S -> /node",
        "/node.replaced-S -> /node",
      ]);
      expect(await snapshot()).toEqual(before);
    });

    it("judges what to put back by what exists: a rename that happened but reported failure is undone too", async () => {
      const before = await snapshot();
      await expectExit(
        runRestore(envFor(), backup, { confirmed: true }, {
          renameDatabase: async (sql, from, to) => {
            await sql`ALTER DATABASE ${sql(from)} RENAME TO ${sql(to)}`;
            if (from.includes("_restore_")) throw new Error("connection lost after commit (simulated)");
          },
        }),
        3,
        /everything was put back/,
      );
      expect(await snapshot()).toEqual(before);
    });

    it("judges the put-back by what exists too: an undo that happened but reported failure still ends in exit 3", async () => {
      const before = await snapshot();
      await expectExit(
        runRestore(envFor(), backup, { confirmed: true }, {
          renameDatabase: async (sql, from, to) => {
            await sql`ALTER DATABASE ${sql(from)} RENAME TO ${sql(to)}`;
            // Both the swap's first rename and the rename undoing it commit, then fail.
            if (from.includes("_replaced_") || to.includes("_replaced_")) throw new Error("connection lost after commit (simulated)");
          },
        }),
        3,
        /everything was put back/,
      );
      expect(await snapshot()).toEqual(before);
    });

    it("says where each half is when putting it back fails too (exit 4)", async () => {
      const err = await expectExit(
        runRestore(envFor(), backup, { confirmed: true }, {
          renameDirectory: async (from, to) => {
            if (from.includes(".restore-")) throw new Error("simulated rename failure");
            if (from.includes(".replaced-")) throw new Error("simulated undo failure");
            await rename(from, to);
          },
        }),
        4,
        /simulated undo failure/,
      );
      expect(err.message).toMatch(new RegExp(`original data directory is ${root}/node\\.replaced-`));
      // The database undo is still attempted after the directory undo failed.
      expect(err.message).toMatch(new RegExp(`original database is "${DB}", the restored one "${DB}_restore_`));
      // Put the directory back by hand, as the message tells an operator to.
      const [replacedDir] = (await readdir(root)).filter((n) => n.startsWith("node.replaced-"));
      await rename(join(root, replacedDir!), join(root, "node"));
      expect(await docIds()).toEqual(["d1", "d2"]);
    });

    it("removes what a restore killed outright left behind, before it starts, and lists it until then", async () => {
      const stamp = "20200101t000000z";
      await mkdir(join(root, `node.restore-${stamp}`));
      await maintenance`CREATE DATABASE ${maintenance(`${DB}_restore_${stamp}`)}`;
      const listed = await runList(envFor());
      expect(listed.unfinishedRestoreDirs).toEqual([join(root, `node.restore-${stamp}`)]);
      expect(listed.unfinishedRestoreDatabases).toEqual([`${DB}_restore_${stamp}`]);

      // A refusal after the leftovers are gone says they are gone.
      await expectExit(
        runRestore(envFor(), backup, { confirmed: true }, { freeBytes: async () => 0 }),
        2,
        /Nothing was changed\. Before that, it removed what an interrupted restore left behind: .*node\.restore-20200101t000000z/,
      );
      await mkdir(join(root, `node.restore-${stamp}`));
      const result = await runRestore(envFor(), backup, { confirmed: true });
      expect(result.notes.join(" ")).toMatch(/removed what an interrupted restore left behind/);
      const after = await runList(envFor());
      expect(after.unfinishedRestoreDirs).toEqual([]);
      expect(after.unfinishedRestoreDatabases).toEqual([]);
    });

    it("restores onto a server that has lost the database altogether", async () => {
      await app.end({ timeout: 5 });
      await maintenance`DROP DATABASE ${maintenance(DB)} WITH (FORCE)`;
      await rm(join(root, "node"), { recursive: true, force: true });
      const result = await runRestore(envFor(), backup, { confirmed: true });
      app = sessionConnection(dbUrl);
      expect(result.replacedDatabase).toBeNull();
      expect(result.replacedDataDir).toBeNull();
      expect(await docIds()).toEqual(["d1"]);
      await chmod(join(root, "node"), 0o700);
    });
  });

  describe("the locks", () => {
    it("will not start a node beside another node, or while a backup or restore holds the ops lock", async () => {
      const first = await holdWriterLock(dbUrl, () => {});
      expect(first.held).toBe(true);
      expect(await holdWriterLock(dbUrl, () => {})).toEqual({ held: false, reason: "another-node" });
      if (first.held) await first.release();

      const ops = sessionConnection(URL!, "postgres");
      try {
        expect(await tryOpsLock(ops, DB)).toBe(true);
        expect(await holdWriterLock(dbUrl, () => {})).toEqual({ held: false, reason: "ops-in-progress" });
      } finally {
        await ops.end({ timeout: 5 });
      }
      const after = await holdWriterLock(dbUrl, () => {});
      expect(after.held).toBe(true);
      if (after.held) await after.release();
    });

    it("never lets the client recycle a session that holds a lock", async () => {
      expect(LOCK_SESSION_OPTIONS.max_lifetime).toBeNull();
      expect(LOCK_SESSION_OPTIONS.idle_timeout).toBe(0);
      const sql = sessionConnection(dbUrl);
      const options = (sql as unknown as { options: { max_lifetime: unknown; idle_timeout: unknown } }).options;
      expect(options.max_lifetime).toBeNull();
      expect(options.idle_timeout).toBe(0);
      await sql.end({ timeout: 1 });
    });

    it("tells a running node, once, when the session holding its writer lock ends — and not while it holds", async () => {
      const lost: string[] = [];
      const node = await holdWriterLock(dbUrl, (reason) => lost.push(reason), { heartbeatMs: 50 });
      expect(node.held).toBe(true);
      try {
        await new Promise((r) => setTimeout(r, 300));
        expect(lost).toEqual([]);
        const [holder] = await maintenance<{ pid: number }[]>`
          SELECT l.pid FROM pg_locks l JOIN pg_database d ON d.oid = l.database
          WHERE l.locktype = 'advisory' AND d.datname = ${DB}
            AND l.classid = ${String(LOCK_CLASS >>> 0)}::oid AND l.objid = 1 AND l.objsubid = 2 AND l.granted`;
        await maintenance`SELECT pg_terminate_backend(${holder!.pid})`;
        for (let i = 0; i < 100 && lost.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
        await new Promise((r) => setTimeout(r, 300));
        expect(lost).toHaveLength(1);
        expect(lost[0]).toMatch(/^this node lost its writer lock: /);
      } finally {
        if (node.held) await node.release();
      }
    });

    it("refuses a DATABASE_URL that names no database as a configuration error", async () => {
      const url = new globalThis.URL(dbUrl);
      url.pathname = "";
      await expect(holdWriterLock(url.toString(), () => {})).rejects.toBeInstanceOf(ConfigError);
    });
  });
});
