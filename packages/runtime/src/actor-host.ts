/**
 * The in-process actor host.
 *
 * One namespace holds every actor of one class. An actor's state is one SQLite
 * file under `dir`, so a restart or an idle eviction brings back its keys, SQL
 * tables and pending alarm exactly as they were. Every entry point on one actor
 * runs under a per-actor mutex; different actors run concurrently.
 *
 * Alarms are timers backed by a row in the actor's own database. On boot the
 * host re-arms every alarm it finds in `dir`, and an evicted actor keeps a cold
 * timer that reopens it when its alarm is due, and closes it again once the
 * alarm has run unless something else entered it meanwhile.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { deserialize, serialize } from "node:v8";
import type {
  Actor,
  ActorConstructor,
  ActorHandle,
  ActorNamespace,
  ActorSocket,
  ActorState,
  ActorStorage,
} from "./interfaces.js";
import { SavepointTransactions, SqliteActorSql, dropUserObjects } from "./sqlite.js";
import { ServerSocket, type Heartbeat, type SocketOwner } from "./sockets.js";

// ---- mutex ---------------------------------------------------------------------

/** A FIFO async lock: `run` queues `fn` behind whatever is already running. */
export class Mutex {
  #tail: Promise<unknown> = Promise.resolve();
  #pending = 0;

  /** True when nothing is running or queued. */
  get idle(): boolean {
    return this.#pending === 0;
  }

  run<T>(fn: () => Promise<T> | T): Promise<T> {
    this.#pending += 1;
    const next = this.#tail.then(fn, fn);
    this.#tail = next.then(
      () => {
        this.#pending -= 1;
      },
      () => {
        this.#pending -= 1;
      },
    );
    return next;
  }
}

// ---- file names ------------------------------------------------------------------

const SAFE = /[A-Za-z0-9_-]/;
const SUFFIX = ".sqlite";

/** Actor name → file stem. Only `[A-Za-z0-9_-]` pass through; the rest is
 *  percent-encoded so any name is a valid, unambiguous file name. */
export function encodeActorName(name: string): string {
  let out = "";
  for (const ch of name) {
    if (SAFE.test(ch) && ch.length === 1) out += ch;
    else for (const b of Buffer.from(ch, "utf8")) out += `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

export function decodeActorName(stem: string): string {
  return decodeURIComponent(stem);
}

// ---- storage ---------------------------------------------------------------------

const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Stamp a store no build has stamped, which is a new file, and refuse one a newer build stamped.
 * The stamp is SQLite's user_version: it sits in the file header, so deleteAll leaves it alone.
 */
function claimStoreVersion(db: DatabaseSync, version: number, label: string): void {
  const { user_version: found } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  if (found === version) return;
  if (found === 0) {
    db.exec(`PRAGMA user_version = ${version}`);
    return;
  }
  if (found > version) {
    throw new Error(
      `the store of ${label} is at version ${found}, but this build of Stuga only knows version ${version}. ` +
        `It was written by a NEWER version, which may have changed what it holds — opening it could corrupt data. ` +
        `Start the newer version again, or restore the backup you took before upgrading.`,
    );
  }
  // The step that brings an older store forward goes here, with the version bump that needs it.
  throw new Error(`the store of ${label} is at version ${found}, and this build has no step that brings it to ${version}`);
}

class FileActorStorage implements ActorStorage {
  readonly db: DatabaseSync;
  readonly sql: SqliteActorSql;
  readonly #txn: SavepointTransactions;

  constructor(
    path: string,
    store: { version: number; label: string },
    private readonly onAlarmChange: () => void,
  ) {
    this.db = new DatabaseSync(path);
    try {
      // Before anything is written: a store this build must not touch is left as it was found.
      claimStoreVersion(this.db, store.version, store.label);
    } catch (err) {
      this.db.close();
      throw err;
    }
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("CREATE TABLE IF NOT EXISTS _kv (key TEXT PRIMARY KEY, value BLOB NOT NULL)");
    this.db.exec("CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    this.sql = new SqliteActorSql(this.db);
    this.#txn = new SavepointTransactions(this.db);
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const row = this.db.prepare("SELECT value FROM _kv WHERE key = ?").get(key) as { value: Uint8Array } | undefined;
    return row === undefined ? undefined : (deserialize(row.value) as T);
  }

  async put(key: string, value: unknown): Promise<void> {
    this.db.prepare("INSERT OR REPLACE INTO _kv (key, value) VALUES (?, ?)").run(key, serialize(value));
  }

  async delete(key: string): Promise<boolean> {
    const { changes } = this.db.prepare("DELETE FROM _kv WHERE key = ?").run(key);
    return Number(changes) > 0;
  }

  async deleteAll(): Promise<void> {
    this.#txn.run(() => {
      dropUserObjects(this.db, ["_kv", "_meta"]);
      this.db.exec("DELETE FROM _kv");
      this.db.exec("DELETE FROM _meta");
    });
    this.onAlarmChange();
  }

  readAlarm(): number | null {
    return readAlarmRow(this.db);
  }

  async getAlarm(): Promise<number | null> {
    return this.readAlarm();
  }

  async setAlarm(at: number): Promise<void> {
    this.writeAlarmRow(at);
    this.onAlarmChange();
  }

  async deleteAlarm(): Promise<void> {
    this.clearAlarmRow();
    this.onAlarmChange();
  }

  writeAlarmRow(at: number): void {
    this.db.prepare("INSERT OR REPLACE INTO _meta (key, value) VALUES ('alarm', ?)").run(String(Math.floor(at)));
  }

  clearAlarmRow(): void {
    this.db.exec("DELETE FROM _meta WHERE key = 'alarm'");
  }

  transactionSync<T>(fn: () => T): T {
    return this.#txn.run(fn);
  }

  close(): void {
    this.db.close();
  }
}

function readAlarmRow(db: DatabaseSync): number | null {
  const exists = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = '_meta'").get();
  if (!exists) return null;
  const row = db.prepare("SELECT value FROM _meta WHERE key = 'alarm'").get() as { value: string } | undefined;
  return row === undefined ? null : Number(row.value);
}

/** Read the pending alarm of an actor file without keeping it open. */
function peekAlarm(path: string): number | null {
  const db = new DatabaseSync(path);
  try {
    return readAlarmRow(db);
  } finally {
    db.close();
  }
}

// ---- one hosted actor ------------------------------------------------------------

export interface ActorHostOptions {
  /** Namespace name, used in log lines (e.g. "docs"). */
  name: string;
  /** Directory holding one `<name>.sqlite` per actor. Created when missing. */
  dir: string;
  /** An actor with no open sockets and nothing running for this long is closed;
   *  the next request reopens it from disk. Default 10 minutes; `Infinity` keeps
   *  every actor resident. */
  idleMs?: number;
  /** The text ping/pong pair every socket in this namespace answers without entering the actor. */
  heartbeat: Heartbeat;
  /**
   * The version of what this namespace's actors keep in their stores, a whole number from 1. A new
   * store is stamped with it, and one stamped higher is refused: a newer build wrote it.
   */
  storeVersion: number;
  /** Receives unhandled actor failures. Defaults to console.error. */
  onError?: (error: unknown, context: { namespace: string; actor: string; entry: string }) => void;
}

const ALARM_RETRY_LIMIT = 6;
const DEFAULT_IDLE_MS = 10 * 60_000;

class HostedActor implements SocketOwner {
  readonly mutex = new Mutex();
  readonly storage: FileActorStorage;
  readonly state: ActorState;
  lastActive = Date.now();
  /**
   * Whoever opened it is done with it: the namespace closes it once it is idle with no alarm
   * pending, after the alarm that is pending has run. A request or a frame clears it.
   */
  released = false;
  #instance: Actor | null = null;
  #sockets = new Set<ServerSocket>();
  #timer: NodeJS.Timeout | null = null;
  /** The alarm `#timer` fires for; null while it only wakes up to look again. */
  #timerAt: number | null = null;
  #alarmRetries = 0;
  /** Set when close() starts: work queued from then on would run after the store closes. */
  #closed = false;
  /** Set once close() holds the lock: the instance is never entered again. */
  #done = false;
  /** Closes from peers that left while close() waited: they never reconnect, so close() runs these first. */
  #departures: Array<() => Promise<void>> = [];
  /** Frames that arrived while close() waited, by socket: its departure runs them, else they are dropped. */
  #held = new Map<ServerSocket, Array<string | ArrayBuffer>>();

  constructor(
    readonly actorName: string,
    private readonly factory: (state: ActorState) => Actor,
    path: string,
    private readonly opts: ActorHostOptions,
    /** Called once an alarm has run and the lock is free again. */
    private readonly afterAlarm: (hosted: HostedActor) => void,
  ) {
    this.storage = new FileActorStorage(path, { version: opts.storeVersion, label: `${opts.name}/${actorName}` }, () =>
      this.armAlarm(),
    );
    this.state = {
      storage: this.storage,
      acceptWebSocket: (ws, meta) => this.accept(ws, meta),
      getWebSockets: () => this.openSockets(),
    };
    this.armAlarm();
  }

  get heartbeat(): Heartbeat {
    return this.opts.heartbeat;
  }

  private instance(): Actor {
    // Never built or entered over a closed store; the namespace opens a new HostedActor instead.
    if (this.#done) throw new Error(`[actor ${this.opts.name}/${this.actorName}] entered after its store closed`);
    this.#instance ??= this.factory(this.state);
    return this.#instance;
  }

  private report(error: unknown, entry: string): void {
    const ctx = { namespace: this.opts.name, actor: this.actorName, entry };
    if (this.opts.onError) this.opts.onError(error, ctx);
    else console.error(`[actor ${ctx.namespace}/${ctx.actor}] ${entry} failed`, error);
  }

  private touch(): void {
    this.lastActive = Date.now();
  }

  // ---- entry points (all under the mutex) ----

  fetch(request: Request): Promise<Response> {
    this.touch();
    this.released = false;
    return this.mutex.run(() => {
      this.touch();
      return this.instance().fetch(request);
    });
  }

  deliverMessage(ws: ServerSocket, message: string | ArrayBuffer): Promise<void> {
    if (this.#done) return Promise.resolve();
    this.touch();
    this.released = false;
    try {
      // Still offered while close() waits: a cancel ends the work it waits for.
      if (this.instance().interceptWebSocketMessage?.(ws, message)) return Promise.resolve();
    } catch (e) {
      this.report(e, "interceptWebSocketMessage");
      return Promise.resolve();
    }
    // Queued behind close() it would meet the closed store: held for the peer's close instead.
    if (this.#closed) {
      const held = this.#held.get(ws);
      if (held) held.push(message);
      else this.#held.set(ws, [message]);
      return Promise.resolve();
    }
    return this.mutex.run(async () => {
      this.touch();
      await this.message(ws, message);
    });
  }

  private async message(ws: ServerSocket, message: string | ArrayBuffer): Promise<void> {
    try {
      await this.instance().webSocketMessage?.(ws, message);
    } catch (e) {
      this.report(e, "webSocketMessage");
    }
  }

  deliverClose(ws: ServerSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    if (this.#done) return Promise.resolve();
    const deliver = async (): Promise<void> => {
      try {
        await this.instance().webSocketClose?.(ws, code, reason, wasClean);
      } catch (e) {
        this.report(e, "webSocketClose");
      } finally {
        this.#sockets.delete(ws);
      }
    };
    if (this.#closed) {
      // The frames it sent while close() waited go first: the store must hold them before it closes.
      const held = this.#held.get(ws) ?? [];
      this.#held.delete(ws);
      return new Promise((resolve) =>
        this.#departures.push(async () => {
          for (const message of held) await this.message(ws, message);
          await deliver();
          resolve();
        }),
      );
    }
    this.touch();
    return this.mutex.run(async () => {
      this.touch();
      await deliver();
    });
  }

  deliverError(ws: ServerSocket, error: unknown): Promise<void> {
    // A close follows every error, and runs before the store closes.
    if (this.#closed) return Promise.resolve();
    this.touch();
    return this.mutex.run(async () => {
      this.touch();
      try {
        await this.instance().webSocketError?.(ws, error);
      } catch (e) {
        this.report(e, "webSocketError");
      }
    });
  }

  // ---- sockets ----

  private accept(ws: ActorSocket, meta: unknown): void {
    if (!(ws instanceof ServerSocket)) throw new TypeError("acceptWebSocket expects the server half of a SocketPair");
    ws.meta = meta;
    ws.owner = this;
    this.#sockets.add(ws);
  }

  private openSockets(): ActorSocket[] {
    const out: ActorSocket[] = [];
    for (const ws of this.#sockets) {
      if (ws.closed) this.#sockets.delete(ws);
      else out.push(ws);
    }
    return out;
  }

  openSocketCount(): number {
    return this.openSockets().length;
  }

  /** Idle: nothing running or queued, no open socket, quiet for `idleMs`. */
  isIdle(idleMs: number, now: number): boolean {
    return this.mutex.idle && this.openSocketCount() === 0 && now - this.lastActive >= idleMs;
  }

  // ---- alarms ----

  /** (Re)schedule the timer from the alarm row. Cheap; called on every change. */
  armAlarm(): void {
    const at = this.#closed ? null : this.storage.readAlarm();
    // A timer due no later than the row stays, and fireAlarm re-reads the row. Made anew on every
    // change, it would never fire while a stream of frames keeps setting the alarm for now.
    if (at !== null && this.#timer && this.#timerAt !== null && this.#timerAt <= at) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#timerAt = null;
    if (at === null) return;
    const delay = Math.max(0, at - Date.now());
    if (delay > MAX_TIMER_MS) {
      // Beyond what one timer can hold: wake up later and look again.
      this.#timer = setTimeout(() => this.armAlarm(), MAX_TIMER_MS);
      return;
    }
    this.#timer = setTimeout(() => void this.fireAlarm(), delay);
    this.#timerAt = at;
  }

  private async fireAlarm(): Promise<void> {
    this.#timer = null;
    this.#timerAt = null;
    this.touch();
    await this.mutex.run(async () => {
      if (this.#closed) return;
      this.touch();
      const at = this.storage.readAlarm();
      if (at === null) return; // deleted while we waited for the lock
      if (at > Date.now()) {
        this.armAlarm(); // moved later while we waited for the lock
        return;
      }
      // The alarm is consumed before the handler runs, so a handler that sets
      // a new one is not clobbered afterwards.
      this.storage.clearAlarmRow();
      try {
        await this.instance().alarm?.();
        this.#alarmRetries = 0;
      } catch (e) {
        this.report(e, "alarm");
        if (this.storage.readAlarm() === null && this.#alarmRetries < ALARM_RETRY_LIMIT) {
          const backoffMs = Math.min(60_000, 1000 * 2 ** this.#alarmRetries);
          this.#alarmRetries += 1;
          this.storage.writeAlarmRow(Date.now() + backoffMs);
        }
      }
      this.armAlarm();
    });
    this.afterAlarm(this);
  }

  /** Nothing running or queued, no open socket, and no alarm pending: closing it now loses nothing it has not stored. */
  get settled(): boolean {
    return !this.#closed && this.isIdle(0, Date.now()) && this.storage.readAlarm() === null;
  }

  /**
   * Stop timers, drop every socket with 1012 (service restart — clients reconnect and resend what
   * the store lacks) and close the database once whatever is running has finished and the peers
   * that left meanwhile are handled. Returns the pending alarm, for the namespace's cold timer.
   */
  async close(): Promise<number | null> {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    return this.mutex.run(async () => {
      for (let next = this.#departures.shift(); next; next = this.#departures.shift()) await next();
      this.#done = true;
      // Frames held for the peers that stay: they resend what the store lacks when they reconnect.
      this.#held.clear();
      for (const ws of this.#sockets) ws.close(1012, "service restart");
      this.#sockets.clear();
      const alarm = this.storage.readAlarm();
      this.storage.close();
      return alarm;
    });
  }
}

// ---- namespace ---------------------------------------------------------------------

export interface HostedNamespace extends ActorNamespace {
  release(name: string): Promise<void>;
  /** Names of the actors currently resident in memory. */
  resident(): string[];
  /** Close every actor that has been idle for at least `idleMs` (default: the
   *  namespace's own setting). Runs on a timer. */
  evictIdle(idleMs?: number): Promise<void>;
  /** Cancel every timer and close every actor's database, evictions under way included; no actor opens afterwards. */
  close(): Promise<void>;
  /**
   * Close every actor and keep them closed: each finishes what it is doing, its sockets drop with
   * 1012 (clients reconnect), alarms wait, and no actor opens until `resume`. Resolves once every
   * store is closed, so nothing writes to them: what a backup of a running node needs.
   */
  pause(): Promise<void>;
  /** Let actors open again; alarms that fell due meanwhile fire now. */
  resume(): void;
}

export function createActorNamespace<Env, Meta>(
  ActorClass: ActorConstructor<Env, Meta>,
  env: Env,
  opts: ActorHostOptions,
): HostedNamespace {
  // 0 is what SQLite calls a store nobody stamped, so it cannot be a version.
  if (!Number.isInteger(opts.storeVersion) || opts.storeVersion < 1) {
    throw new Error(`[actor ${opts.name}] storeVersion must be a whole number from 1, got ${opts.storeVersion}`);
  }
  mkdirSync(opts.dir, { recursive: true });
  const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
  const actors = new Map<string, HostedActor>();
  /** Timers for evicted actors whose alarm is still pending. */
  const coldAlarms = new Map<string, { timer: NodeJS.Timeout; at: number }>();
  /** While paused: the alarms to arm on resume. */
  const heldAlarms = new Map<string, number>();
  /** Actors out of `actors` whose close() is still running: none reopens before its store is closed. */
  const closing = new Map<string, Promise<unknown>>();
  let closed = false;
  let paused = false;

  const open = (actorName: string): HostedActor => {
    if (closed) throw new Error(`[actor ${opts.name}] closed; the node is shutting down`);
    if (paused) throw new Error(`[actor ${opts.name}] paused while the node backs up; try again shortly`);
    const cold = coldAlarms.get(actorName);
    if (cold) {
      clearTimeout(cold.timer);
      coldAlarms.delete(actorName);
    }
    let hosted = actors.get(actorName);
    if (!hosted) {
      const path = join(opts.dir, encodeActorName(actorName) + SUFFIX);
      hosted = new HostedActor(
        actorName,
        (state) => new ActorClass(state as ActorState<Meta>, env) as Actor,
        path,
        opts,
        (after) => void closeIfReleased(actorName, after),
      );
      actors.set(actorName, hosted);
    }
    return hosted;
  };

  /** Close a released actor that is still this name's and has settled; one with work or an alarm left stays. */
  const closeIfReleased = async (actorName: string, hosted: HostedActor): Promise<void> => {
    if (!hosted.released || actors.get(actorName) !== hosted || !hosted.settled) return;
    await evict(actorName, hosted).catch((e: unknown) => console.error(`[actor ${opts.name}] closing ${actorName} failed`, e));
  };

  const armCold = (actorName: string, at: number): void => {
    if (closed) return;
    if (paused) {
      heldAlarms.set(actorName, at);
      return;
    }
    const delay = Math.min(MAX_TIMER_MS, Math.max(0, at - Date.now()));
    const timer = setTimeout(() => {
      coldAlarms.delete(actorName);
      if (closed) return;
      if (paused) {
        heldAlarms.set(actorName, at);
        return;
      }
      try {
        // Reopening re-arms the alarm from its row. Opened for the alarm alone, it closes again once that has run.
        open(actorName).released = true;
      } catch (e) {
        // A store this build refuses to open: thrown out of a timer it would take the process down.
        const ctx = { namespace: opts.name, actor: actorName, entry: "alarm" };
        if (opts.onError) opts.onError(e, ctx);
        else console.error(`[actor ${ctx.namespace}/${ctx.actor}] ${ctx.entry} failed`, e);
      }
    }, delay);
    coldAlarms.set(actorName, { timer, at });
  };

  /** Close an actor already taken out of `actors`, listed in `closing` until its store is closed. */
  const closeActor = (actorName: string, hosted: HostedActor): Promise<number | null> => {
    const done = hosted.close();
    const settled = done.catch(() => null);
    closing.set(actorName, settled);
    void settled.then(() => {
      if (closing.get(actorName) === settled) closing.delete(actorName);
    });
    return done;
  };

  const evict = async (actorName: string, hosted: HostedActor): Promise<void> => {
    actors.delete(actorName);
    const alarm = await closeActor(actorName, hosted);
    if (alarm !== null && !actors.has(actorName)) armCold(actorName, alarm);
  };

  const evictIdle = async (threshold = idleMs): Promise<void> => {
    const now = Date.now();
    const victims = [...actors].filter(([, hosted]) => hosted.isIdle(threshold, now));
    await Promise.all(victims.map(([actorName, hosted]) => evict(actorName, hosted)));
  };

  // Boot: re-arm every alarm that was pending when the process last stopped.
  for (const entry of readdirSync(opts.dir)) {
    if (!entry.endsWith(SUFFIX)) continue;
    let alarm: number | null = null;
    try {
      alarm = peekAlarm(join(opts.dir, entry));
    } catch (e) {
      console.error(`[actor ${opts.name}] cannot read ${entry}`, e);
      continue;
    }
    if (alarm !== null) armCold(decodeActorName(entry.slice(0, -SUFFIX.length)), alarm);
  }

  const sweep =
    Number.isFinite(idleMs) && idleMs > 0
      ? setInterval(() => void evictIdle().catch((e) => console.error(`[actor ${opts.name}] eviction failed`, e)), Math.min(idleMs, 60_000))
      : null;
  sweep?.unref();

  return {
    get(name: string): ActorHandle {
      return {
        // async, so a store that cannot be opened rejects like any other failure and reaches a caller's .catch().
        async fetch(input, init) {
          const request = input instanceof Request && init === undefined ? input : new Request(input, init);
          // An eviction still closing this actor finishes first, so one file never has two hosts. Paused
          // or closed, open refuses at once, so a caller holding another actor's lock never waits on a
          // close that waits on it.
          while (!paused && !closed && closing.has(name)) await closing.get(name);
          return open(name).fetch(request);
        },
      };
    },
    async release(name: string) {
      const hosted = actors.get(name);
      // In use by someone else: the idle timeout closes it as usual.
      if (!hosted || !hosted.isIdle(0, Date.now())) return;
      hosted.released = true;
      await closeIfReleased(name, hosted);
    },
    resident: () => [...actors.keys()],
    evictIdle,
    async close() {
      closed = true;
      if (sweep) clearInterval(sweep);
      for (const cold of coldAlarms.values()) clearTimeout(cold.timer);
      coldAlarms.clear();
      heldAlarms.clear();
      const resident = [...actors.values()];
      actors.clear();
      await Promise.all([...resident.map((a) => a.close()), ...closing.values()]);
    },
    async pause() {
      paused = true;
      for (const [actorName, cold] of coldAlarms) {
        clearTimeout(cold.timer);
        heldAlarms.set(actorName, cold.at);
      }
      coldAlarms.clear();
      const resident = [...actors];
      actors.clear();
      const held = resident.map(async ([actorName, hosted]) => {
        const alarm = await closeActor(actorName, hosted);
        if (alarm !== null) heldAlarms.set(actorName, alarm);
      });
      // Evictions under way too: a backup must not read a store that is still open.
      await Promise.all([...held, ...closing.values()]);
    },
    resume() {
      if (!paused) return;
      paused = false;
      const held = [...heldAlarms];
      heldAlarms.clear();
      for (const [actorName, at] of held) armCold(actorName, at);
    },
  };
}
