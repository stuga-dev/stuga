/**
 * The connector where the packaging runs it (docs/remote-access.md): the node writes what it wants,
 * `on <sha-256 of the connector's settings>` or `off`, as one line the packaging reads, and reads
 * back what the packaging did. The line is a desired state, not an event: the packaging keeps it and
 * compares it with what runs whenever it wakes, and the node writes it again, backing off, while the
 * two disagree. A refusal waits for an administrator, or for a different line.
 */
import { readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ConnectorState, ConnectorStatus } from "@stuga/protocol/api/remote-access";
import type { ConnectorHints } from "../config/env.js";

export type ConnectorLine = "off" | `on ${string}`;

const LINE = /^(on [0-9a-f]{64}|off)$/;
const SHA = /^[0-9a-f]{64}$/;
const STATES = new Set<ConnectorState>(["installing", "running", "stopped", "refused", "failed", "unavailable"]);

const MINUTE = 60_000;
/** Between writes of a line the packaging has not acted on: 1, 5, 15, then every 60 minutes. */
const BACKOFF_MINUTES = [1, 5, 15, 60];
/** An install silent for this long has been abandoned: its download gives up after 5 minutes. */
const INSTALL_SILENT_MS = 15 * MINUTE;

/** Ask for `line`. Written whole and renamed in, so the packaging never reads half of it. */
export async function writeConnectorRequest(hints: ConnectorHints, line: ConnectorLine): Promise<void> {
  if (!LINE.test(line)) throw new Error(`not a connector request: ${line}`);
  const tmp = join(dirname(hints.request), `.${basename(hints.request)}.${process.pid}.tmp`);
  await writeFile(tmp, `${line}\n`, { mode: 0o640 });
  await rename(tmp, hints.request);
}

/** What the packaging last reported, or null when there is nothing readable. */
export async function readConnectorStatus(hints: ConnectorHints): Promise<ConnectorStatus | null> {
  const text = await readFile(hints.status, "utf8").catch(() => null);
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

/** Whether `status` shows `line` done, or under way. */
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
  /** When the node asks again; null while nothing is wrong, or a refusal waits for an administrator. */
  retryAt: Date | null;
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
      await writeConnectorRequest(hints, line);
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

  const waitsForAdministrator = (status: ConnectorStatus | null): boolean => status?.state === "refused" && !stale(status);

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
      if (connectorSettled(asked, status, now())) {
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
      const settled = asked === null || connectorSettled(asked, status, now());
      const retryAt = settled || waitsForAdministrator(status) ? null : new Date(Math.max(writtenAt + connectorBackoffMs(rewrites), now()));
      return { status, stale: isStale, retryAt };
    },
    running(configSha) {
      return configSha !== null && last?.state === "running" && last.config_sha === configSha;
    },
    line: () => asked,
    reset() {
      asked = null;
    },
  };
}
