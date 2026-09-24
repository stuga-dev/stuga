/**
 * The environment of a backup, restore, verify or list. The node's own variables
 * come through config/env.ts, so these commands see the node's database and data
 * directory. Their own: BACKUP_DIR (default `backups` beside the data
 * directory), BACKUP_KEEP (at least 1) and PG_BIN (where pg_dump and
 * pg_restore live).
 */
import { dirname, join, resolve } from "node:path";
import { ConfigError, parseOpsConfig, type Env, type OpsConfig } from "../config/env.js";
import { VERSION } from "../version.js";
import type { ToolEnv } from "./tools.js";

export interface BackupEnv extends OpsConfig, ToolEnv {
  backupDir: string;
  keep: number;
  /** The build running this command. */
  version: string;
}

/** A week of daily backups. */
const DEFAULT_KEEP = 7;

export function parseBackupEnv(env: Env = process.env): BackupEnv {
  const ops = parseOpsConfig(env);
  const rawKeep = env.BACKUP_KEEP?.trim();
  const keep = rawKeep ? Number(rawKeep) : DEFAULT_KEEP;
  if (!Number.isSafeInteger(keep) || keep < 1) {
    throw new ConfigError(
      `BACKUP_KEEP must be a whole number of at least 1 (got ${JSON.stringify(rawKeep)}): ` +
        `anything less would delete the backup it was just asked to take`,
    );
  }
  return {
    ...ops,
    backupDir: resolve(env.BACKUP_DIR?.trim() || join(dirname(ops.dataDir), "backups")),
    keep,
    pgBin: env.PG_BIN?.trim() ? resolve(env.PG_BIN.trim()) : null,
    version: VERSION,
  };
}
