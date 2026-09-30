/**
 * The in-memory host the actor test suites run against.
 *
 * It keeps the semantics that matter: storage values round-trip through
 * structured clone, closed sockets vanish from `getWebSockets()`, `deleteAll`
 * drops SQL tables, keys and the alarm, `transactionSync` nests, and
 * boolean/undefined SQL bindings throw. Alarms are recorded, not fired — a test
 * calls `actor.alarm()` itself — and socket close callbacks are delivered only
 * when a test calls `closeSocket`.
 */
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  Actor,
  ActorSocket,
  ActorState,
  ActorStorage,
  BlobHead,
  BlobList,
  BlobMetadata,
  BlobObject,
  BlobStore,
  JobQueue,
} from "../interfaces.js";
import { SavepointTransactions, SqliteActorSql, dropUserObjects } from "../sqlite.js";
import { ServerSocket, isUpgradeResponse } from "../sockets.js";

export type { ActorState, ActorStorage, BlobStore, JobQueue } from "../interfaces.js";

// ---- storage ---------------------------------------------------------------------

export class MemoryActorStorage implements ActorStorage {
  /** The key-value half, inspectable and seedable behind the actor's back. */
  readonly map = new Map<string, unknown>();
  /** The SQL half, raw, for seeding and inspection. */
  readonly db = new DatabaseSync(":memory:");
  readonly sql = new SqliteActorSql(this.db);
  /** The pending alarm (epoch ms). Tests drive `alarm()` themselves. */
  alarm: number | null = null;
  readonly #txn = new SavepointTransactions(this.db);

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const v = this.map.get(key);
    return v === undefined ? undefined : (structuredClone(v) as T);
  }

  async put(key: string, value: unknown): Promise<void> {
    this.map.set(key, structuredClone(value));
  }

  async delete(key: string): Promise<boolean> {
    return this.map.delete(key);
  }

  async deleteAll(): Promise<void> {
    this.map.clear();
    this.alarm = null;
    dropUserObjects(this.db);
  }

  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }

  async setAlarm(at: number): Promise<void> {
    this.alarm = at;
  }

  async deleteAlarm(): Promise<void> {
    this.alarm = null;
  }

  transactionSync<T>(fn: () => T): T {
    return this.#txn.run(fn);
  }
}

// ---- sockets ---------------------------------------------------------------------

/** A socket with no transport: everything the actor sends stays in the outbox
 *  (`sent`, `sentStrings`) where `frames()`, `firstPayload()` and `has()` read it. */
export const MemorySocket = ServerSocket;
export type MemorySocket<Meta = unknown> = ServerSocket<Meta>;

export class MemoryActorState<Meta = unknown> implements ActorState<Meta> {
  readonly storage = new MemoryActorStorage();
  readonly #sockets: ActorSocket<Meta>[] = [];

  acceptWebSocket(ws: ActorSocket<Meta>, meta: Meta): void {
    ws.meta = meta;
    this.#sockets.push(ws);
  }

  getWebSockets(): ActorSocket<Meta>[] {
    return this.#sockets.filter((ws) => !(ws instanceof ServerSocket && ws.closed !== null));
  }
}

/**
 * Deliver the close callback the real host would for `ws`. A socket the actor
 * already closed reports the code it closed with; otherwise the peer closes it
 * with `code`.
 */
export async function closeSocket<Meta>(
  actor: Actor<Meta>,
  ws: ServerSocket<Meta>,
  code = 1000,
  reason = "",
): Promise<void> {
  ws.markClosed(code, reason);
  const closed = ws.closed!;
  await actor.webSocketClose?.(ws, closed.code, closed.reason, closed.code !== 1006);
}

/**
 * Open a connection to `actor` the way the node does — an upgrade request on
 * `path` with `params` in the query — and return the server socket it accepted.
 * Throws when the actor answered with something other than an upgrade.
 */
export async function connectActor<Meta>(
  actor: Actor<Meta>,
  state: MemoryActorState<Meta>,
  params: Record<string, string | string[]> = {},
  path = "/connect",
): Promise<MemorySocket<Meta>> {
  const url = new URL(`http://actor${path}`);
  // An array becomes a repeated param, the way the node passes any list.
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) for (const one of v) url.searchParams.append(k, one);
    else url.searchParams.set(k, v);
  }
  const before = new Set(state.getWebSockets());
  const res = await actor.fetch(new Request(url.toString(), { headers: { upgrade: "websocket" } }));
  if (!isUpgradeResponse(res)) {
    throw new Error(`connect refused: ${res.status} ${await res.text().catch(() => "")}`);
  }
  const ws = state.getWebSockets().find((s) => !before.has(s));
  if (!(ws instanceof ServerSocket)) throw new Error("no socket was accepted");
  return ws as ServerSocket<Meta>;
}

// ---- blobs -----------------------------------------------------------------------

interface StoredBlob {
  bytes: Uint8Array;
  uploaded: Date;
  httpMetadata?: BlobMetadata;
}

function toBytes(value: Uint8Array | ArrayBuffer | string): Uint8Array {
  if (typeof value === "string") return new TextEncoder().encode(value);
  return new Uint8Array(value);
}

export class MemoryBlobStore implements BlobStore {
  /** key → bytes; inspect with `bytesOf()` / `textOf()`. */
  readonly objects = new Map<string, StoredBlob>();

  keys(): string[] {
    return [...this.objects.keys()].sort();
  }

  bytesOf(key: string): Uint8Array | undefined {
    return this.objects.get(key)?.bytes;
  }

  textOf(key: string): string | undefined {
    const bytes = this.objects.get(key)?.bytes;
    return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
  }

  private headOf(key: string, stored: StoredBlob): BlobHead {
    const head: BlobHead = { key, size: stored.bytes.byteLength, uploaded: stored.uploaded };
    return stored.httpMetadata ? { ...head, httpMetadata: stored.httpMetadata } : head;
  }

  async head(key: string): Promise<BlobHead | null> {
    const stored = this.objects.get(key);
    return stored ? this.headOf(key, stored) : null;
  }

  async get(key: string): Promise<BlobObject | null> {
    const stored = this.objects.get(key);
    if (!stored) return null;
    const bytes = stored.bytes;
    return {
      ...this.headOf(key, stored),
      get body() {
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(bytes));
            controller.close();
          },
        });
      },
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      text: async () => new TextDecoder().decode(bytes),
    };
  }

  async put(key: string, value: Uint8Array | ArrayBuffer | string, opts?: { httpMetadata?: BlobMetadata }): Promise<void> {
    const stored: StoredBlob = { bytes: toBytes(value), uploaded: new Date() };
    if (opts?.httpMetadata) stored.httpMetadata = opts.httpMetadata;
    this.objects.set(key, stored);
  }

  async delete(key: string | string[]): Promise<void> {
    for (const k of Array.isArray(key) ? key : [key]) this.objects.delete(k);
  }

  async list(opts: { prefix?: string; cursor?: string; limit?: number } = {}): Promise<BlobList> {
    const prefix = opts.prefix ?? "";
    const limit = Math.max(1, opts.limit ?? 1000);
    const keys = this.keys().filter((k) => k.startsWith(prefix) && (opts.cursor === undefined || k > opts.cursor));
    const page = keys.slice(0, limit);
    const truncated = keys.length > limit;
    const out: BlobList = { objects: page.map((k) => this.headOf(k, this.objects.get(k)!)), truncated };
    if (truncated) out.cursor = page[page.length - 1]!;
    return out;
  }
}

// ---- jobs ------------------------------------------------------------------------

/** Records every message an actor enqueues, in order. */
export class MemoryJobQueue<T = unknown> implements JobQueue<T> {
  readonly sent: T[] = [];

  async send(message: T): Promise<void> {
    this.sent.push(structuredClone(message));
  }
}

// ---- store versions --------------------------------------------------------------

/**
 * An actor's store file as its store version pins it: every schema object, whitespace aside, and
 * the stamp, with a short fingerprint of them. `leaveOut` drops the objects on those tables, and
 * `rename` puts a placeholder for a table or column name the store's contents chose.
 */
export function storeSchema(
  path: string,
  opts: { leaveOut?: string[]; rename?: Record<string, string> } = {},
): { schema: string; fingerprint: string } {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const objects = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master").all() as {
      type: string;
      name: string;
      tbl_name: string;
      sql: string | null;
    }[];
    const { user_version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
    const rename = opts.rename ?? {};
    const quoted = (sql: string) => Object.entries(rename).reduce((t, [from, to]) => t.split(`"${from}"`).join(`"${to}"`), sql);
    const tidy = (sql: string) => quoted(sql.replace(/\s+/g, " ").replace(/\s*([(),])\s*/g, "$1"));
    const lines = objects
      .filter((o) => !opts.leaveOut?.includes(o.tbl_name))
      .map((o) => {
        const table = Object.hasOwn(rename, o.tbl_name) ? rename[o.tbl_name]! : o.tbl_name;
        const name = o.name.split(o.tbl_name).join(table);
        return `${o.type} ${name} on ${table}: ${o.sql === null ? "(automatic)" : tidy(o.sql)}`;
      })
      .sort();
    const schema = [`user_version ${user_version}`, ...lines].join("\n");
    return { schema, fingerprint: createHash("sha256").update(schema).digest("hex").slice(0, 16) };
  } finally {
    db.close();
  }
}
