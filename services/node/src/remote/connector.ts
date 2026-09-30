/**
 * The connector where the packaging runs it (docs/remote-access.md): the node writes what it wants,
 * `on <sha-256 of the connector's settings>` or `off`, as one line the packaging reads, and reads
 * back what the packaging did. The line is a desired state, not an event: the packaging keeps it and
 * compares it with what runs whenever it wakes, and the node writes it again, backing off, while the
 * two disagree. A refusal, or a runtime without the connector, waits for an administrator, or for a
 * different line. Only a status stamped since the line last changed answers it.
 *
 * Neither file's writer is trusted to have more privilege than the node: the request is written
 * through a new file no one else could have put there, and the status is read only from a regular
 * file, never through a link, a pipe or a device, and only when small.
 */
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ConnectorState, ConnectorStatus } from "@stuga/protocol/api/remote-access";
import type { ConnectorHints } from "../config/env.js";

export type ConnectorLine = "off" | `on ${string}`;

const LINE = /^(on [0-9a-f]{64}|off)$/;
const SHA = /^[0-9a-f]{64}$/;
const STATES = new Set<ConnectorState>(["installing", "running", "stopped", "refused", "failed", "unavailable"]);
/** A status is a few hundred bytes; anything larger is not one. */
const MAX_STATUS_BYTES = 4096;
const REQUEST_MODE = 0o640;

const MINUTE = 60_000;
/** Between writes of a line the packaging has not acted on: 1, 5, 15, then every 60 minutes. */
const BACKOFF_MINUTES = [1, 5, 15, 60];
/** An install silent for this long has been abandoned: its download gives up after 5 minutes. */
const INSTALL_SILENT_MS = 15 * MINUTE;

/**
 * Ask for `line`. Written whole and renamed in, so the packaging never reads half of it; through a
 * temporary file of a random name, created new and never through a link. With `gid`, the file is that
 * group's, for a connector kept apart by one.
 */
export async function writeConnectorRequest(hints: ConnectorHints, line: ConnectorLine, opts: { gid?: number | undefined } = {}): Promise<void> {
  if (!LINE.test(line)) throw new Error(`not a connector request: ${line}`);
  const tmp = join(dirname(hints.request), `.${basename(hints.request)}.${randomBytes(8).toString("hex")}.tmp`);
  // Named by the request, not the temporary file, so the same failure reads the same each time.
  const failed = (e: unknown) => new Error(`can't write ${hints.request}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`, { cause: e });
  let handle;
  try {
    handle = await open(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, REQUEST_MODE);
  } catch (e) {
    throw failed(e);
  }
  try {
    await handle.writeFile(`${line}\n`);
    // The umask narrows the mode given at creation.
    await handle.chmod(REQUEST_MODE);
    if (opts.gid !== undefined) await handle.chown(-1, opts.gid);
    await handle.close();
    await rename(tmp, hints.request);
  } catch (e) {
    await handle.close().catch(() => {});
    await unlink(tmp).catch(() => {});
    throw failed(e);
  }
}

/** The status file's text: a regular file of at most MAX_STATUS_BYTES, reached without a link; null otherwise. */
async function readStatusText(path: string): Promise<string | null> {
  let handle;
  try {
    // Non-blocking, so a pipe put there cannot hold the node up before it is told apart.
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_STATUS_BYTES) return null;
    // One byte more than allowed: a file that grew since is refused too.
    const buffer = Buffer.alloc(MAX_STATUS_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_STATUS_BYTES) return null;
    return buffer.subarray(0, length).toString("utf8");
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => {});
  }
}

/** What the packaging last reported, or null when there is nothing readable. */
export async function readConnectorStatus(hints: ConnectorHints): Promise<ConnectorStatus | null> {
  const text = await readStatusText(hints.status);
  if (!text) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || typeof raw.state !== "string" || !STATES.has(raw.state as ConnectorState)) return null;
  const sha = (v: unknown) => (typeof v === "string" && SHA.test(v) ? v : null);
  return {
    state: raw.state as ConnectorState,
    message: typeof raw.message === "string" ? raw.message : "",
    at: typeof raw.at === "string" ? raw.at : "",
    connector_sha: sha(raw.connector_sha),
    config_sha: sha(raw.config_sha),
  };
}

/** How long after its `rewrites`-th write a line not acted on is written again. */
export function connectorBackoffMs(rewrites: number): number {
  return (BACKOFF_MINUTES[rewrites] ?? BACKOFF_MINUTES.at(-1)!) * MINUTE;
}

/** Whether `status` shows `line` done, or under way; whether it answers `line` at all is the caller's to say. */
export function connectorSettled(line: ConnectorLine, status: ConnectorStatus | null, now: number): boolean {
  if (!status) return false;
  if (line === "off") return status.state === "stopped" || status.state === "unavailable";
  const sha = line.slice(3);
  if (status.state === "running") return status.config_sha === sha;
  if (status.state === "installing") {
    return (status.config_sha === null || status.config_sha === sha) && !(Date.parse(status.at) < now - INSTALL_SILENT_MS);
  }
  return false;
}

/** What the Settings page is told about the connector. */
export interface ConnectorReport {
  status: ConnectorStatus | null;
  /** The status is from before the node last changed what it asks for: not an answer to it yet. */
  stale: boolean;
  /** When the node asks again; null while nothing is wrong, or the answer waits for an administrator. */
  retryAt: Date | null;
  /** Asked on, and not done after being asked again: since when it was asked. */
  behindSince: Date | null;
}

export interface ConnectorControl {
  /** Ask for `line` now, unless it is what was last asked; `force` asks again all the same. */
  want(line: ConnectorLine, opts?: { force?: boolean }): Promise<void>;
  /** Read the status, and ask again when the packaging has not done what was asked and it is time. */
  reconcile(): Promise<ConnectorStatus | null>;
  /** Read the status, and nothing more. */
  read(): Promise<ConnectorStatus | null>;
  report(): Promise<ConnectorReport>;
  /** Running with the settings whose sha-256 is `configSha`, as last read. */
  running(configSha: string | null): boolean;
  /** What was last asked, or null before anything was. */
  line(): ConnectorLine | null;
  /** Forget what was asked, so the next `want` writes. */
  reset(): void;
}

export function createConnectorControl(opts: {
  hints: ConnectorHints;
  /** The group the request is given, where the connector is kept apart by one. */
  gid?: number | undefined;
  now: () => number;
  onError: (error: unknown) => void;
}): ConnectorControl {
  const { hints, now } = opts;
  let asked: ConnectorLine | null = null;
  /** When the line last changed, or an administrator asked again: an older status answers something else. */
  let changedAt: number | null = null;
  /** The last write, or the last time the line was seen done: the backoff counts from it. */
  let writtenAt = 0;
  /** Writes of the same line since it changed or was last seen done. */
  let rewrites = 0;
  let last: ConnectorStatus | null = null;
  let failing: string | null = null;

  /** False when the write failed: said once per reason, and tried again at the next call. */
  async function write(line: ConnectorLine): Promise<boolean> {
    try {
      await writeConnectorRequest(hints, line, { gid: opts.gid });
    } catch (e) {
      const why = (e as Error).message;
      if (why !== failing) opts.onError(e);
      failing = why;
      return false;
    }
    failing = null;
    writtenAt = now();
    return true;
  }

  const stale = (status: ConnectorStatus): boolean => {
    const at = Date.parse(status.at);
    // The packaging's clock may keep only whole seconds.
    return changedAt !== null && Number.isFinite(at) && at < Math.floor(changedAt / 1000) * 1000;
  };

  /** A refusal, or a runtime without the connector: asking again changes nothing. */
  const waitsForAdministrator = (status: ConnectorStatus | null): boolean =>
    status !== null && !stale(status) && (status.state === "refused" || (status.state === "unavailable" && asked !== "off"));

  /** Done or under way, in an answer to what was last asked. */
  const settled = (status: ConnectorStatus | null): boolean =>
    asked === null || (status !== null && !stale(status) && connectorSettled(asked, status, now()));

  async function read(): Promise<ConnectorStatus | null> {
    last = await readConnectorStatus(hints);
    return last;
  }

  return {
    async want(line, { force = false } = {}) {
      if (line === asked && !force) return;
      if (!(await write(line))) return;
      asked = line;
      changedAt = now();
      rewrites = 0;
    },
    async reconcile() {
      const status = await read();
      if (asked === null) return status;
      if (settled(status)) {
        // A later lapse waits a minute too: the packaging may be trying again already.
        rewrites = 0;
        writtenAt = now();
        return status;
      }
      if (waitsForAdministrator(status)) return status;
      if (now() < writtenAt + connectorBackoffMs(rewrites)) return status;
      if (await write(asked)) rewrites += 1;
      return status;
    },
    read,
    async report() {
      const status = await read();
      const isStale = status !== null && stale(status);
      const waiting = settled(status) || waitsForAdministrator(status);
      const retryAt = waiting ? null : new Date(Math.max(writtenAt + connectorBackoffMs(rewrites), now()));
      const behind = !waiting && asked !== null && asked !== "off" && rewrites > 0 && changedAt !== null;
      return { status, stale: isStale, retryAt, behindSince: behind ? new Date(changedAt!) : null };
    },
    running(configSha) {
      return configSha !== null && last !== null && !stale(last) && last.state === "running" && last.config_sha === configSha;
    },
    line: () => asked,
    reset() {
      asked = null;
    },
  };
}
