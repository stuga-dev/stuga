/**
 * The backups a running node takes of itself: the daily one, at the hour the
 * Settings page names in the node's time zone, and one an administrator asks
 * for. The operator commands back up a stopped node; this backs up a running
 * one by making it quiet first (`quiesce`): new requests wait behind a
 * maintenance page, the ones already being answered finish, the job worker
 * stops and every actor closes its store. The node keeps its writer lock the
 * whole time, so nothing else can start writing, and the same `runBackup`
 * takes both halves as it would of a stopped node. Then everything resumes.
 *
 * A failed daily backup is recorded, and every node administrator hears of it
 * once; the next one is tried at the next scheduled hour.
 */
import { getNodeState, recordBackupAttempt, type Sql } from "@stuga/db";
import type { NotifyDeliverMessage } from "@stuga/protocol/internal/jobs";
import { lastScheduled, nextScheduled } from "../config/time-zone.js";
import { jobDeps, type JobsEnv } from "../jobs/deps.js";
import type { WriterLock } from "../writer-lock.js";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { databaseName } from "../writer-lock.js";
import { PARTIAL_SUFFIX, runBackup, type BackupResult } from "./backup.js";
import type { BackupEnv } from "./env.js";
import { ARCHIVE_NAME, DUMP_NAME, readManifest } from "./manifest.js";
import { messageOf } from "./outcome.js";

export const BACKUP_FAILED_EVENT = "BACKUP_FAILED";

/** Where a notification about backups opens. */
const BACKUPS_PATH = "/settings/node/backups";

export interface BackupSchedule {
  auto: boolean;
  /** 0–23, in `timeZone`. */
  hour: number;
  /** An IANA name. */
  timeZone: string;
}

/** Whether the daily backup is due: its hour has come since the last try, or since the node first booted. */
export function backupDue(now: Date, schedule: BackupSchedule, state: { attemptedAt: Date | null; firstBootAt: Date }): boolean {
  if (!schedule.auto) return false;
  const due = lastScheduled(now, schedule.hour, schedule.timeZone);
  return due.getTime() > (state.attemptedAt ?? state.firstBootAt).getTime();
}

export interface NodeBackups {
  /** Take the daily backup if it is due. The maintenance tick calls it, one tick at a time. */
  runIfDue(now?: Date): Promise<void>;
  /** Start a backup now, behind whatever maintenance is running; false when one is already under way. */
  startNow(): boolean;
  /** Whether a backup is under way now. */
  running(): boolean;
  /** When the next daily backup starts; null when they are off. */
  nextAt(now?: Date): Date | null;
  /** The schedule in force. */
  schedule(): BackupSchedule;
  /** This database's whole backups in the backup directory, newest first. */
  list(): Promise<BackupSummary[]>;
  /** Where backups go, and how many are kept. */
  where(): { dir: string; keep: number };
}

export interface BackupSummary {
  name: string;
  createdAt: string;
  bytes: number;
  /** The version whose data it holds. */
  stugaVersion: string | null;
  /** The version that took it; another than `stugaVersion` when it was taken before an upgrade. */
  runtimeVersion: string;
}

/** This database's whole backups in `env.backupDir`, newest first. */
export async function listBackups(env: BackupEnv): Promise<BackupSummary[]> {
  const database = databaseName(env.databaseUrl);
  const entries = await readdir(env.backupDir, { withFileTypes: true }).catch(() => []);
  const found: BackupSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.endsWith(PARTIAL_SUFFIX)) continue;
    const m = await readManifest(join(env.backupDir, entry.name)).catch(() => null);
    if (!m || m.database !== database) continue;
    found.push({
      name: entry.name,
      createdAt: m.created_at,
      bytes: m.files[DUMP_NAME].bytes + m.files[ARCHIVE_NAME].bytes,
      stugaVersion: m.stuga_version,
      runtimeVersion: m.runtime_version,
    });
  }
  return found.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

export interface NodeBackupsDeps {
  sql: Sql;
  env: BackupEnv;
  writer: Pick<WriterLock, "stillHeld">;
  schedule: () => BackupSchedule;
  /** Make the node quiet; resolves to what makes it serve again. */
  quiesce: () => Promise<() => Promise<void>>;
  /** Runs work one at a time with the maintenance tick. */
  exclusive: <T>(work: () => Promise<T>) => Promise<T>;
  /** Tell the node's administrators a daily backup failed. */
  notifyFailure: (message: string, at: Date) => Promise<void>;
  log?: Pick<Console, "info" | "error">;
}

export function createNodeBackups(d: NodeBackupsDeps): NodeBackups {
  const log = d.log ?? console;
  let underWay = false;
  /** Asked for, and waiting for the maintenance tick to finish. */
  let queued = false;

  async function takeOne(why: string): Promise<BackupResult> {
    underWay = true;
    try {
      const resume = await d.quiesce();
      try {
        const result = await runBackup(d.env, { writer: d.writer });
        log.info(`[node] ${why} backup complete: ${result.path}`);
        return result;
      } finally {
        await resume();
      }
    } finally {
      underWay = false;
    }
  }

  return {
    async runIfDue(now = new Date()) {
      if (underWay || queued) return;
      const schedule = d.schedule();
      if (!schedule.auto) return;
      const state = await getNodeState(d.sql);
      if (!state || !backupDue(now, schedule, { attemptedAt: state.backup_attempted_at, firstBootAt: state.first_boot_at })) return;
      try {
        await takeOne("daily");
        await recordBackupAttempt(d.sql, { at: now, error: null });
      } catch (err) {
        const message = messageOf(err);
        log.error(`[node] the daily backup failed: ${message}`);
        await recordBackupAttempt(d.sql, { at: now, error: message });
        await d.notifyFailure(message, now).catch((e: unknown) => log.error("[node] could not tell the administrators", e));
      }
    },
    startNow() {
      if (underWay || queued) return false;
      queued = true;
      void d
        .exclusive(async () => {
          queued = false;
          const at = new Date();
          try {
            await takeOne("requested");
            await recordBackupAttempt(d.sql, { at, error: null });
          } catch (err) {
            log.error(`[node] the requested backup failed: ${messageOf(err)}`);
            await recordBackupAttempt(d.sql, { at, error: messageOf(err) });
          }
        })
        .catch((err: unknown) => log.error("[node] could not record a backup", err));
      return true;
    },
    running: () => underWay || queued,
    nextAt(now = new Date()) {
      const schedule = d.schedule();
      return schedule.auto ? nextScheduled(now, schedule.hour, schedule.timeZone) : null;
    },
    schedule: () => d.schedule(),
    list: () => listBackups(d.env),
    where: () => ({ dir: d.env.backupDir, keep: d.env.keep }),
  };
}

/** One notification per administrator per failed day, in the app and through the sink. */
export async function notifyBackupFailed(env: JobsEnv, message: string, at: Date): Promise<void> {
  const db = jobDeps(env, {}).db;
  const title = "The daily backup failed";
  const url = `${env.publicOrigin}${BACKUPS_PATH}`;
  const day = at.toISOString().slice(0, 10);
  for (const admin of await db.listNodeAdmins()) {
    const delivery: NotifyDeliverMessage | null =
      env.settings.current().notify.sink === "none"
        ? null
        : { kind: "notify_deliver", recipient: admin.alias, title, body: message, url };
    await db.insertNotification(
      {
        id: `${BACKUP_FAILED_EVENT}:${day}:${admin.alias}`,
        workspace_id: null,
        recipient_alias: admin.alias,
        event_type: BACKUP_FAILED_EVENT,
        resource_id: null,
        resource_title: title,
        resource_url: url,
        actor_alias: null,
        payload: { error: message },
      },
      delivery,
    );
  }
}
