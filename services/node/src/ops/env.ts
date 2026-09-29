/**
 * The environment of a backup, restore, verify or list. The node's own variables
 * come through config/env.ts, so these commands see the node's database and data
 * directory. Their own: BACKUP_DIR (default `backups` beside the data
 * directory) and PG_BIN (where pg_dump and pg_restore live). How many backups
 * are kept is a node setting, read from the database each backup takes.
 */
import { dirname, join, resolve } from "node:path";
import { parseOpsConfig, type Env, type OpsConfig } from "../config/env.js";
import { VERSION } from "../version.js";
import type { ToolEnv } from "./tools.js";

export interface BackupEnv extends OpsConfig, ToolEnv {
  backupDir: string;
  /** The build running this command. */
  version: string;
}

export function parseBackupEnv(env: Env = process.env): BackupEnv {
  const ops = parseOpsConfig(env);
  return {
    ...ops,
    backupDir: resolve(env.BACKUP_DIR?.trim() || join(dirname(ops.dataDir), "backups")),
    pgBin: env.PG_BIN?.trim() ? resolve(env.PG_BIN.trim()) : null,
    version: VERSION,
  };
}
