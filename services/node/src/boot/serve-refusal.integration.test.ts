/**
 * `stuga-node serve` on data it must not touch, as a process against a real
 * Postgres: it parks rather than exits, writes and backs up nothing, holds its
 * writer lock until it is stopped, and exits 0 on SIGTERM. The operator
 * commands that write refuse the same data. Needs TEST_DATABASE_URL (Postgres
 * 18 preloading pg_search); skips without it.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { initSchema, recordNodeBoot, runBootRepairs, SCHEMA_VERSION } from "@stuga/db";
import { runBackup } from "../ops/backup.js";
import { parseBackupEnv } from "../ops/env.js";
import { OpsError } from "../ops/outcome.js";
import { sessionConnection, withDatabase, type LockSql } from "../writer-lock.js";

const URL = process.env.TEST_DATABASE_URL;
const DB = `stuga_sr_${process.pid}`;
const BIN = join(import.meta.dirname, "..", "..", "bin", "stuga-node.js");
/** libpq's own variables (PGHOST for a socket-only cluster, PG_BIN), which a spawned node needs too. */
const PG_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("PG"))) as Record<string, string>;

let root: string;
let dbUrl: string;
let maintenance: LockSql;
let app: LockSql;
let node: ChildProcess | null = null;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** Start the node; resolves once `line` is in its output, or with its exit code when it exits first. */
async function serve(extra: Record<string, string>, line: string): Promise<{ output: () => string; exited: Promise<number | null> }> {
  let output = "";
  node = spawn(process.execPath, [BIN, "serve"], {
    cwd: "/",
    env: {
      PATH: process.env.PATH ?? "",
      DATABASE_URL: dbUrl,
      DATA_DIR: join(root, "node"),
      BACKUP_DIR: join(root, "backups"),
      ...PG_ENV,
      ...extra,
    },
  });
  node.stdout!.on("data", (d: Buffer) => (output += d.toString()));
  node.stderr!.on("data", (d: Buffer) => (output += d.toString()));
  const child = node;
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  let done = false;
  void exited.then(() => (done = true));
  for (let i = 0; i < 600 && !done && !output.includes(line); i++) await new Promise((r) => setTimeout(r, 100));
  return { output: () => output, exited };
}

/** What a refusal must leave as it was. */
async function snapshot(): Promise<unknown> {
  return {
    migrations: await app`SELECT id, filename, checksum, applied_at FROM schema_migrations ORDER BY id`,
    state: await app`SELECT node_id, app_version, first_boot_at, last_boot_at FROM node_state`,
    backups: await readdir(join(root, "backups")).catch(() => []),
  };
}

describe.skipIf(!URL)("a node on data it must not touch", { timeout: 120_000 }, () => {
  beforeAll(async () => {
    dbUrl = withDatabase(URL!, DB);
    maintenance = sessionConnection(URL!, "postgres");
    await maintenance`DROP DATABASE IF EXISTS ${maintenance(DB)} WITH (FORCE)`;
    await maintenance`CREATE DATABASE ${maintenance(DB)}`;
    app = sessionConnection(dbUrl);
    await initSchema(app as never);
    await runBootRepairs(app as never);
    await recordNodeBoot(app as never, "1.0.0");
  });

  afterAll(async () => {
    await app?.end({ timeout: 5 }).catch(() => {});
    if (maintenance) {
      await maintenance`DROP DATABASE IF EXISTS ${maintenance(DB)} WITH (FORCE)`;
      await maintenance.end({ timeout: 5 });
    }
  });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "stuga-serve-refusal-"));
  });

  afterEach(async () => {
    if (node && node.exitCode === null && node.signalCode === null) node.kill("SIGKILL");
    node = null;
    await rm(root, { recursive: true, force: true });
  });

  it("parks on a newer schema: refused readiness and a page, nothing written or backed up, the lock held until SIGTERM", async () => {
    await app`INSERT INTO schema_migrations (id, filename, checksum) VALUES (${SCHEMA_VERSION + 1}, 'future.sql', 'future')`;
    try {
      const before = await snapshot();
      const port = await freePort();
      const run = await serve({ PORT: String(port) }, "[node] refusing this database: ");
      expect(run.output()).toContain(`[node] refusing this database: it is at schema ${SCHEMA_VERSION + 1}, and this build knows schema ${SCHEMA_VERSION}`);

      const ready = await fetch(`http://127.0.0.1:${port}/ready`);
      expect(ready.status).toBe(503);
      expect(ready.headers.get("retry-after")).toBeNull();
      expect(await ready.json()).toEqual({ ok: false, status: "refused" });
      const page = await fetch(`http://127.0.0.1:${port}/`, { headers: { accept: "text/html" } });
      expect(page.status).toBe(503);
      // 1.0.0 stamped it, and a build from source cannot tell whether that is the newer one.
      expect(await page.text()).toContain("<strong>Stuga 1.0.0 last served this data</strong>");

      await new Promise((r) => setTimeout(r, 5000));
      expect(node!.exitCode).toBeNull();
      expect(await snapshot()).toEqual(before);

      const env = parseBackupEnv({
        DATABASE_URL: dbUrl,
        DATA_DIR: join(root, "node"),
        BACKUP_DIR: join(root, "backups"),
        ...(process.env.PG_BIN ? { PG_BIN: process.env.PG_BIN } : {}),
      });
      const err = await runBackup(env).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(OpsError);
      expect((err as OpsError).exitCode).toBe(2);
      expect((err as OpsError).message).toMatch(/node is running/);

      node!.kill("SIGTERM");
      expect(await run.exited).toBe(0);
      expect(await snapshot()).toEqual(before);
    } finally {
      await app`DELETE FROM schema_migrations WHERE id = ${SCHEMA_VERSION + 1}`;
    }
  });

  it("refuses it to the operator commands that write, too", async () => {
    await app`INSERT INTO schema_migrations (id, filename, checksum) VALUES (${SCHEMA_VERSION + 1}, 'future.sql', 'future')`;
    try {
      const before = await snapshot();
      const env = { PATH: process.env.PATH ?? "", ...PG_ENV, DATABASE_URL: dbUrl, DATA_DIR: join(root, "node") };
      for (const args of [["reset-password", "alice"], ["media-scan"]]) {
        const run = spawnSync(process.execPath, [BIN, ...args], { cwd: "/", encoding: "utf8", timeout: 60_000, env });
        expect(run.stderr, args[0]).toContain(`error: refusing this database: it is at schema ${SCHEMA_VERSION + 1}`);
        expect(run.status, args[0]).toBe(2);
      }
      expect(await snapshot()).toEqual(before);
    } finally {
      await app`DELETE FROM schema_migrations WHERE id = ${SCHEMA_VERSION + 1}`;
    }
  });

  it("refuses another embedding width before it backs anything up", async () => {
    // Data a release served: this build from source would back it up before upgrading it.
    await app`UPDATE node_state SET app_version = '1.0.0'`;
    const before = await snapshot();
    const run = await serve({ PORT: String(await freePort()), AI_EMBED_DIMS: "768" }, "AI_EMBED_DIMS is 768");
    expect(await run.exited).toBe(1);
    expect(run.output()).toContain("AI_EMBED_DIMS is 768 but this database stores doc_chunks.embedding as vector(1024)");
    expect(await snapshot()).toEqual(before);
  });
});
