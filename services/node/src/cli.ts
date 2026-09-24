/**
 * stuga-node serve|backup|verify|restore|list|reset-password|media-scan.
 *
 * backup, verify, restore and list take --json for one JSON object on stdout; with it only
 * notes and errors go to stderr. Operator command exit codes: 0 done, 2 refused with nothing
 * changed, 3 failed with nothing changed, 4 failed after a change; serve exits 1 when it cannot
 * start. Operator commands never boot a node, so none is a second writer beside a running one.
 */
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { closeClients, createClient } from "@stuga/db";
import { fsBlobStore } from "@stuga/runtime";
import { ConfigError, parseOpsConfig } from "./config/env.js";
import { runBackup } from "./ops/backup.js";
import { parseBackupEnv, type BackupEnv } from "./ops/env.js";
import { runList } from "./ops/list.js";
import { exitCodeOf, messageOf, refused, type ExitCode } from "./ops/outcome.js";
import { runRestore } from "./ops/restore.js";
import { runVerify } from "./ops/verify.js";
import { RESET_PASSWORD_USAGE, runResetPassword } from "./identity/reset-command.js";
import { MEDIA_SCAN_USAGE, parseMediaScanArgs, runMediaScan } from "./media/scan-command.js";

const USAGE = `usage:
  stuga-node serve
  stuga-node backup [--json]
  stuga-node verify <backup> [--json]
  stuga-node restore <backup> [--yes] [--json]
  stuga-node list [--json]
  ${RESET_PASSWORD_USAGE}
  ${MEDIA_SCAN_USAGE}`;

const tell = (line: string): void => void process.stderr.write(`${line}\n`);

/** A backup named by path, or by its bare name under BACKUP_DIR. */
function backupPath(env: BackupEnv, arg: string | undefined): string {
  if (!arg) throw refused(`name the backup to use\n${USAGE}`);
  return arg.includes("/") ? resolve(arg) : resolve(env.backupDir, arg);
}

async function confirmInteractively(name: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(`This REPLACES the current database and data directory. Type the backup name to confirm: `);
    return answer.trim() === name;
  } finally {
    rl.close();
  }
}

/** Outside signals abort `work` instead of killing it: a restore killed mid-swap would leave the two halves mismatched. */
const INTERRUPTS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"];

async function interruptible<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const onSignal = (name: NodeJS.Signals) => {
    if (controller.signal.aborted) {
      tell(`${name} again: still stopping; it exits when it reaches a safe point`);
      return;
    }
    tell(`${name}: stopping at the next safe point — what was made so far is removed, and a restore that has begun swapping finishes the swap first`);
    controller.abort();
  };
  for (const name of INTERRUPTS) process.on(name, onSignal);
  try {
    return await work(controller.signal);
  } finally {
    for (const name of INTERRUPTS) process.off(name, onSignal);
  }
}

async function mediaScan(argv: string[]): Promise<ExitCode> {
  const opts = parseMediaScanArgs(argv);
  const ops = parseOpsConfig(process.env);
  const env = {
    sql: createClient(ops.databaseUrl),
    media: fsBlobStore(join(ops.dataDir, "blobs", "media")),
    snapshots: fsBlobStore(join(ops.dataDir, "blobs", "snapshots")),
  };
  try {
    return await runMediaScan(env, opts, (line) => void process.stdout.write(`${line}\n`));
  } finally {
    await closeClients();
  }
}

/** Run one command; resolves to its exit code. `serve` resolves once the node is listening. */
async function run(argv: string[]): Promise<ExitCode> {
  const [command, ...rest] = argv;
  if (command === "serve") {
    // Imported here so an operator command never loads the node's serving graph.
    await (await import("./boot/boot.js")).serve();
    return 0;
  }
  const args = rest.filter((a) => !a.startsWith("--"));
  const flags = new Set(rest.filter((a) => a.startsWith("--")));
  const json = flags.has("--json");
  const say = (line: string): void => {
    if (!json) tell(line);
  };
  const out = (value: unknown): void => {
    if (json) process.stdout.write(`${JSON.stringify(value)}\n`);
  };
  const [target] = args;
  try {
    if (command === "reset-password") {
      return await runResetPassword(target, () => parseOpsConfig(process.env), (text) => void process.stdout.write(text));
    }
    if (command === "media-scan") return await mediaScan(rest);
    if (!command || !["backup", "verify", "restore", "list"].includes(command)) throw refused(USAGE);
    const env = parseBackupEnv(process.env);

    if (command === "backup") {
      say(`Backing up database and ${env.dataDir} to ${env.backupDir}`);
      const result = await interruptible((signal) => runBackup(env, { signal }));
      say(`Backup complete: ${result.path}`);
      for (const name of result.pruned) tell(`  removed old backup ${name}`);
      out({ ok: true, path: result.path, manifest: result.manifest, pruned: result.pruned });
      return 0;
    }
    if (command === "verify") {
      const result = await runVerify(env, backupPath(env, target));
      say(`${result.path} is whole and restorable by this runtime`);
      for (const note of result.notes) tell(`  note: ${note}`);
      out({ ok: true, path: result.path, manifest: result.manifest, notes: result.notes });
      return 0;
    }
    if (command === "restore") {
      const dir = backupPath(env, target);
      const name = dir.split("/").pop()!;
      const confirmed = flags.has("--yes") || (await confirmInteractively(name));
      const result = await interruptible((signal) => runRestore(env, dir, { confirmed }, { signal }));
      say(`Restored ${result.path}`);
      if (result.replacedDatabase) say(`  the database it replaced is kept as "${result.replacedDatabase}"`);
      if (result.replacedDataDir) say(`  the data directory it replaced is kept at ${result.replacedDataDir}`);
      for (const note of result.notes) tell(`  note: ${note}`);
      out({ ok: true, ...result });
      return 0;
    }
    const result = await runList(env);
    if (!json) {
      for (const b of result.backups) say(`${b.name}  stuga ${b.stuga_version ?? "?"}, schema ${b.schema_version}, ${b.bytes} bytes`);
      for (const p of result.partial) say(`unfinished: ${p}`);
      for (const d of result.replacedDataDirs) say(`replaced data directory: ${d}`);
      for (const d of result.replacedDatabases ?? []) say(`replaced database: ${d}`);
      for (const d of result.unfinishedRestoreDirs) say(`unfinished restore (the next restore removes it): ${d}`);
      for (const d of result.unfinishedRestoreDatabases ?? []) say(`unfinished restore database (the next restore removes it): ${d}`);
    }
    out({ ok: true, ...result });
    return 0;
  } catch (err) {
    const code = err instanceof ConfigError ? 2 : exitCodeOf(err);
    tell(`error: ${messageOf(err)}`);
    out({ ok: false, exit_code: code, error: messageOf(err) });
    return code;
  }
}

const code = await run(process.argv.slice(2));
if (process.argv[2] !== "serve") process.exitCode = code;
