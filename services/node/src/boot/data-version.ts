/**
 * Whether this build may touch the data at all, read before anything writes or
 * backs up: a schema newer than this build knows refuses every build, and data
 * a newer release served refuses an older release. An older build that refused
 * leaves the database exactly as it found it, and says which version to start
 * or which backup to restore. Only reads here; boot.ts parks the node on a
 * refusal (http/serving-gate.ts), and the operator commands that write exit 2.
 */
import { renderGatePage, type GateRefusal } from "@stuga/protocol/notify/render";
import { closeClients, createClient, lastNodeBoot, readSchemaVersion, SCHEMA_VERSION, type Sql } from "@stuga/db";
import type { BackupEnv } from "../ops/env.js";
import { listBackups, type BackupSummary } from "../ops/node-backups.js";
import { refused } from "../ops/outcome.js";
import { VERSION, versionChange } from "../version.js";

export interface ServedData {
  /** The highest migration recorded; 0 for a new database. */
  schema: number;
  /** The newest build that wrote to it; null on a new database, or when a newer schema made that unreadable here. */
  servedBy: string | null;
}

export async function readServedData(sql: Sql): Promise<ServedData> {
  const schema = await readSchemaVersion(sql);
  let servedBy: string | null;
  try {
    servedBy = (await lastNodeBoot(sql))?.version ?? null;
  } catch (err) {
    // A newer schema may have changed node_state; that schema is reason enough to refuse.
    if (schema <= SCHEMA_VERSION) throw err;
    servedBy = null;
  }
  return { schema, servedBy };
}

export type DataRefusal =
  | { kind: "newer-schema"; schema: number; known: number; servedBy: string | null; version: string }
  | { kind: "newer-release"; servedBy: string; version: string };

/** Why `build` must not touch `data`; null when it may. */
export function dataRefusal(build: { version: string; schema: number }, data: ServedData): DataRefusal | null {
  if (data.schema > build.schema) {
    return { kind: "newer-schema", schema: data.schema, known: build.schema, servedBy: data.servedBy, version: build.version };
  }
  if (data.servedBy && versionChange(data.servedBy, build.version) === "downgrade") {
    return { kind: "newer-release", servedBy: data.servedBy, version: build.version };
  }
  return null;
}

/** The backup that goes back to `version`: the newest taken before an upgrade from it, else the newest of its data. */
export async function goBackTo(env: BackupEnv, version: string): Promise<BackupSummary | null> {
  const own = (await listBackups(env)).filter((b) => b.stugaVersion === version);
  return own.find((b) => b.beforeUpgrade) ?? own[0] ?? null;
}

/** A name a shell takes as one word, never as an option. */
export const BACKUP_NAME = /^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/;

/** The packaging's restore command (STUGA_RESTORE_COMMAND) for one backup; null without one, or for a name unsafe in it. */
export function restoreCommandFor(template: string | null, name: string): string | null {
  return template && BACKUP_NAME.test(name) ? template.replaceAll("{backup}", name) : null;
}

export interface RefusalText {
  /** The log line, after `[node] `. */
  log: string;
  /**
   * What the page says, which anyone who reaches the node reads: versions, never a path. The page
   * writes it in the browser's language (@stuga/protocol/notify/render renderGatePage).
   */
  why: GateRefusal;
  /** The page's text in English. */
  title: string;
  body: string;
  /** Set only when the packaging names its restore command and a backup to restore is known. */
  command: string | null;
}

export function refusalText(r: DataRefusal, backup: string | null, restoreCommand: string | null): RefusalText {
  const command = backup ? restoreCommandFor(restoreCommand, backup) : null;
  const restore = backup
    ? `restore ${backup} with this version: ${command ?? `stop this node first, then run stuga-node restore ${backup}`}`
    : `restore a backup of Stuga ${r.version}'s data with this version.`;
  const page = (by: string | null) => {
    const why: GateRefusal = { servedBy: by, version: r.version };
    const { title, body } = renderGatePage(why, "en");
    return { why, title, body: body ?? "" };
  };
  if (r.kind === "newer-release") {
    return {
      log:
        `refusing this database: Stuga ${r.servedBy} served it last, and this is Stuga ${r.version}. Nothing was changed. ` +
        `Start Stuga ${r.servedBy} again, or ${restore}`,
      ...page(r.servedBy),
      command,
    };
  }
  // Name the build that served it only when it could be the newer one: never this version (a build from
  // source on a newer schema) and never an older release (stopped between its migrations and its stamp).
  const change = r.servedBy ? versionChange(r.servedBy, r.version) : "same";
  const by = change === "downgrade" || change === "unordered" ? r.servedBy : null;
  return {
    log:
      `refusing this database: it is at schema ${r.schema}, and this build knows schema ${r.known}; ` +
      `${by ? `Stuga ${by} served it last` : "a newer Stuga changed it"}. Nothing was changed. ` +
      `Start ${by ? `Stuga ${by}` : "the newer version"} again, or ${restore}`,
    ...page(by),
    command,
  };
}

/** For an operator command that writes: refuses (exit 2) data this build would refuse to serve. */
export async function refuseNewerData(databaseUrl: string): Promise<void> {
  const sql = createClient(databaseUrl);
  let refusal: DataRefusal | null;
  try {
    refusal = dataRefusal({ version: VERSION, schema: SCHEMA_VERSION }, await readServedData(sql));
  } finally {
    await closeClients();
  }
  if (refusal) throw refused(refusalText(refusal, null, null).log);
}
