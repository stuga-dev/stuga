/**
 * The backups a running node takes of itself, against a real Postgres, pg_dump
 * and tar; the node's quieting is a stand-in that records what it was asked.
 * Needs TEST_DATABASE_URL (Postgres 18 preloading pg_search) and client tools
 * of major 18+ from PG_BIN or PATH; skips without the URL.
 */
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getNodeState, initSchema, recordNodeBoot, runBootRepairs } from "@stuga/db";
import { createExclusive } from "../platform/exclusive.js";
import { holdWriterLock, sessionConnection, withDatabase, type LockSql, type WriterLock } from "../writer-lock.js";
import { parseBackupEnv } from "./env.js";
import { BACKUP_WAIT_MAX_MS, backupDue, createNodeBackups, type BackupSchedule, type NodeBackups } from "./node-backups.js";

const URL = process.env.TEST_DATABASE_URL;
const DB = `stuga_nb_${process.pid}`;
const DAY = 24 * 60 * 60_000;

let root: string;
let dbUrl: string;
let maintenance: LockSql;
let app: LockSql;
let writer: WriterLock;

describe("when the daily backup is due", () => {
  const schedule: BackupSchedule = { auto: true, hour: 3, timeZone: "UTC" };
  const now = new Date("2026-09-23T10:00:00Z");

  it("is due once its hour has passed since the last try", () => {
    expect(backupDue(now, schedule, { attemptedAt: new Date("2026-09-22T03:00:00Z"), firstBootAt: new Date(0) })).toBe(true);
    expect(backupDue(now, schedule, { attemptedAt: new Date("2026-09-23T03:00:05Z"), firstBootAt: new Date(0) })).toBe(false);
  });

  it("waits for the first hour after the node first booted, not at once", () => {
    expect(backupDue(now, schedule, { attemptedAt: null, firstBootAt: new Date("2026-09-23T09:00:00Z") })).toBe(false);
    expect(backupDue(now, schedule, { attemptedAt: null, firstBootAt: new Date("2026-09-22T09:00:00Z") })).toBe(true);
  });

  it("is never due when turned off", () => {
    expect(backupDue(now, { ...schedule, auto: false }, { attemptedAt: null, firstBootAt: new Date(0) })).toBe(false);
  });
});

describe.skipIf(!URL)("the backups a running node takes of itself", { timeout: 60_000 }, () => {
  let calls: string[];
  let failures: string[];
  let current: BackupSchedule;
  let quiesceFails: Error | null;
  /** What the node is doing that a backup waits for. */
  let busy: string | null;
  /** What begins as the node pauses, before the pause turns new work away. */
  let beginsAsItPauses: string | null;
  /** Whether new such work is held back, as the backups last said. */
  let held: boolean;

  function backups(): NodeBackups {
    const env = parseBackupEnv({
      DATABASE_URL: dbUrl,
      DATA_DIR: join(root, "node"),
      BACKUP_DIR: join(root, "backups"),
      BACKUP_KEEP: "5",
      ...(process.env.PG_BIN ? { PG_BIN: process.env.PG_BIN } : {}),
    });
    return createNodeBackups({
      sql: app as never,
      env,
      writer,
      schedule: () => current,
      quiesce: async () => {
        calls.push("quiesce");
        busy ??= beginsAsItPauses;
        if (quiesceFails) throw quiesceFails;
        return async () => {
          calls.push("resume");
        };
      },
      busy: () => busy,
      hold: (hold) => {
        held = hold;
      },
      exclusive: createExclusive(),
      notifyFailure: async (message) => {
        failures.push(message);
      },
      log: { info: () => {}, error: () => {} },
    });
  }

  const taken = async () => (await readdir(join(root, "backups")).catch(() => [])).filter((n) => !n.startsWith("."));

  beforeAll(async () => {
    dbUrl = withDatabase(URL!, DB);
    maintenance = sessionConnection(URL!, "postgres");
    await maintenance`DROP DATABASE IF EXISTS ${maintenance(DB)} WITH (FORCE)`;
    await maintenance`CREATE DATABASE ${maintenance(DB)}`;
    app = sessionConnection(dbUrl);
    await initSchema(app as never);
    await runBootRepairs(app as never);
    await recordNodeBoot(app as never, "1.0.0");
    const held = await holdWriterLock(dbUrl, () => {});
    if (!held.held) throw new Error(`could not take the writer lock: ${held.reason}`);
    writer = held;
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
    root = await mkdtemp(join(tmpdir(), "stuga-node-backups-"));
    await mkdir(join(root, "node/actors/docs"), { recursive: true });
    calls = [];
    failures = [];
    quiesceFails = null;
    busy = null;
    beginsAsItPauses = null;
    held = false;
    current = { auto: true, hour: 3, timeZone: "UTC" };
    // A node that has run for two days and never tried a daily backup.
    await app`UPDATE node_state SET first_boot_at = now() - interval '2 days', backup_attempted_at = NULL, backup_error = NULL`;
  });

  it("takes the daily backup once it is due, with the node quiet, and records the try", async () => {
    const node = backups();
    await node.runIfDue();
    expect(calls).toEqual(["quiesce", "resume"]);
    const names = await taken();
    expect(names).toHaveLength(1);
    expect(await node.list()).toMatchObject([{ name: names[0], stugaVersion: "1.0.0", runtimeVersion: "0.0.0-dev" }]);
    const state = await getNodeState(app as never);
    expect(state?.backup_attempted_at).toBeInstanceOf(Date);
    expect(state?.backup_error).toBeNull();

    // Taken: nothing more until tomorrow's hour.
    await node.runIfDue();
    expect(calls).toEqual(["quiesce", "resume"]);
  });

  it("takes nothing when turned off", async () => {
    current = { ...current, auto: false };
    const node = backups();
    await node.runIfDue();
    expect(calls).toEqual([]);
    expect(node.nextAt()).toBeNull();
  });

  it("records a failed daily backup, tells the administrators, and waits for the next hour", async () => {
    quiesceFails = new Error("requests were still being answered after 60s");
    const node = backups();
    await node.runIfDue();
    expect(failures).toEqual(["requests were still being answered after 60s"]);
    expect((await getNodeState(app as never))?.backup_error).toBe("requests were still being answered after 60s");
    expect(await taken()).toEqual([]);

    quiesceFails = null;
    await node.runIfDue(new Date(Date.now() + 60_000));
    expect(calls).toEqual(["quiesce"]);
    await node.runIfDue(new Date(Date.now() + DAY + 60_000));
    expect(calls).toEqual(["quiesce", "quiesce", "resume"]);
    expect((await getNodeState(app as never))?.backup_error).toBeNull();
  });

  it("takes one now when asked, one at a time", async () => {
    const node = backups();
    expect(node.startNow()).toBeNull();
    expect(node.startNow()).toBe("a backup is already under way");
    expect(node.running()).toBe(true);
    for (let i = 0; i < 200 && node.running(); i++) await new Promise((r) => setTimeout(r, 50));
    expect(node.running()).toBe(false);
    expect(calls).toEqual(["quiesce", "resume"]);
    expect(await taken()).toHaveLength(1);
  });

  it("waits while the node is busy, without pausing it or counting a failed try, holding new such work, and takes the daily backup after", async () => {
    busy = "a workspace is being imported or exported";
    const node = backups();
    await node.runIfDue();
    expect(calls).toEqual([]);
    expect(failures).toEqual([]);
    expect((await getNodeState(app as never))?.backup_attempted_at).toBeNull();
    expect(held).toBe(true);
    expect(node.waiting()).toBe("a workspace is being imported or exported");

    busy = null;
    await node.runIfDue();
    expect(calls).toEqual(["quiesce", "resume"]);
    expect(await taken()).toHaveLength(1);
    expect(held).toBe(false);
    expect(node.waiting()).toBeNull();
  });

  it("takes one asked for while the node is busy once it is not, holding new such work meanwhile", async () => {
    busy = "a workspace is being imported or exported";
    current = { ...current, auto: false };
    const node = backups();
    expect(node.startNow()).toBeNull();
    for (let i = 0; i < 100 && !held; i++) await new Promise((r) => setTimeout(r, 10));
    expect(held).toBe(true);
    expect(node.running()).toBe(true);
    expect(node.waiting()).toBe("a workspace is being imported or exported");
    expect(node.startNow()).toBe("a backup is already under way");
    expect(calls).toEqual([]);
    expect((await getNodeState(app as never))?.backup_attempted_at).toBeNull();

    await node.runIfDue();
    expect(calls).toEqual([]);
    busy = null;
    await node.runIfDue();
    expect(calls).toEqual(["quiesce", "resume"]);
    expect(await taken()).toHaveLength(1);
    expect(node.running()).toBe(false);
    expect(held).toBe(false);
    expect((await getNodeState(app as never))?.backup_error).toBeNull();
  });

  it("fails one asked for still waiting after three hours, without a notification", async () => {
    busy = "a workspace is being imported or exported";
    current = { ...current, auto: false };
    const node = backups();
    expect(node.startNow()).toBeNull();
    for (let i = 0; i < 100 && !held; i++) await new Promise((r) => setTimeout(r, 10));
    await node.runIfDue(new Date(Date.now() + BACKUP_WAIT_MAX_MS));
    expect((await getNodeState(app as never))?.backup_error).toBe("still waiting after 3 hours: a workspace is being imported or exported");
    expect(failures).toEqual([]);
    expect(node.running()).toBe(false);
    expect(held).toBe(false);
  });

  it("fails a daily backup still waiting after three hours, and tells the administrators", async () => {
    busy = "a workspace is being imported or exported";
    const node = backups();
    const start = Date.now();
    await node.runIfDue(new Date(start));
    await node.runIfDue(new Date(start + BACKUP_WAIT_MAX_MS - 60_000));
    expect(failures).toEqual([]);
    expect((await getNodeState(app as never))?.backup_attempted_at).toBeNull();

    expect(held).toBe(true);

    await node.runIfDue(new Date(start + BACKUP_WAIT_MAX_MS));
    const message = "still waiting after 3 hours: a workspace is being imported or exported";
    expect(failures).toEqual([message]);
    expect((await getNodeState(app as never))?.backup_error).toBe(message);
    expect(calls).toEqual([]);
    expect(held).toBe(false);

    // Tried again at the next day's hour, with three hours to wait again.
    await node.runIfDue(new Date(start + DAY + BACKUP_WAIT_MAX_MS - 60_000));
    expect(failures).toEqual([message]);
    busy = null;
    await node.runIfDue(new Date(start + DAY + BACKUP_WAIT_MAX_MS));
    expect(calls).toEqual(["quiesce", "resume"]);
    expect((await getNodeState(app as never))?.backup_error).toBeNull();
  });

  it("waits, too, when such work began as the node paused and kept its requests from finishing", async () => {
    beginsAsItPauses = "a workspace is being imported or exported";
    quiesceFails = new Error("requests were still being answered after 60s");
    const node = backups();
    await node.runIfDue();
    expect(calls).toEqual(["quiesce"]);
    expect(failures).toEqual([]);
    expect((await getNodeState(app as never))?.backup_attempted_at).toBeNull();
  });
});
