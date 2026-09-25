/**
 * The contract between Stuga's actors and the process that hosts them.
 *
 * An actor is a single-threaded object addressed by name. The host runs every
 * entry point on one actor — `fetch`, the socket callbacks and `alarm` — to
 * completion before the next one starts, so actor code may hold invariants
 * across an `await` without taking its own locks.
 */

// ---- storage ------------------------------------------------------------------

export interface SqlCursor {
  readonly columnNames: string[];
  toArray(): Record<string, unknown>[];
  /** Exactly one row, or throws. */
  one(): Record<string, unknown>;
  [Symbol.iterator](): IterableIterator<Record<string, unknown>>;
}

/** A read that hands back rows one at a time instead of materialising them. */
export interface SqlStream {
  columnNames: string[];
  /** Must be consumed inside the transaction it was opened in; abandoning it part-way stops the statement. */
  rows: IterableIterator<Record<string, unknown>>;
}

/** Synchronous SQL over the actor's private SQLite database. Bindings accept
 *  null | number | string | Uint8Array; booleans and undefined throw. */
export interface ActorSql {
  exec(query: string, ...bindings: unknown[]): SqlCursor;
  /**
   * Row-at-a-time, for queries whose result size is not bounded by construction
   * (e.g. an agent-written SELECT): `exec` materialises every row before a cap
   * could look at the first.
   */
  iterate(query: string, ...bindings: unknown[]): SqlStream;
}

export interface ActorStorage {
  /** Key-value store. Values round-trip through structured clone. */
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  /** Drops every key, every SQL table and the pending alarm. */
  deleteAll(): Promise<void>;

  /** One durable alarm per actor (epoch ms). Survives restarts. */
  getAlarm(): Promise<number | null>;
  setAlarm(at: number): Promise<void>;
  deleteAlarm(): Promise<void>;

  readonly sql: ActorSql;
  /** Run `fn` inside a savepoint; nests. Must not await inside. */
  transactionSync<T>(fn: () => T): T;
}

// ---- sockets ------------------------------------------------------------------

/**
 * A server-side WebSocket owned by an actor. `meta` is the session state the
 * actor handed to `acceptWebSocket`; it lives exactly as long as the socket,
 * which is enough because the host only evicts actors with no open sockets and
 * a restart or a pause closes every socket.
 */
export interface ActorSocket<Meta = unknown> {
  send(data: string | Uint8Array | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  meta: Meta;
}

/** Client half of a pair, handed back to the host inside an upgrade response. */
export interface ClientSocket {
  readonly __brand: "ClientSocket";
}

export interface ActorState<Meta = unknown> {
  readonly storage: ActorStorage;
  /** Hand a server socket to the host with its session state; from now on the
   *  actor's socket callbacks fire for it, until the host closes (see `Actor`),
   *  and it appears in `getWebSockets()`. */
  acceptWebSocket(ws: ActorSocket<Meta>, meta: Meta): void;
  /** Open sockets (closed ones are not returned). */
  getWebSockets(): ActorSocket<Meta>[];
}

/**
 * What an actor class implements. Every method runs under the actor's lock —
 * except `interceptWebSocketMessage`.
 *
 * Once the host starts closing the actor (a restart, a pause, an eviction), work
 * already queued still runs and a due alarm waits for the next open. A new frame
 * reaches `interceptWebSocketMessage` and is otherwise held; an error reaches
 * nothing. A peer that leaves before the store closes never reconnects, so its
 * held frames and then its close still run first. The sockets left are dropped
 * with 1012 and their held frames with them: those clients resend what the
 * store lacks when they reconnect. No callback fires for them.
 */
export interface Actor<Meta = unknown> {
  fetch(request: Request): Promise<Response>;
  webSocketMessage?(ws: ActorSocket<Meta>, message: string | ArrayBuffer): void | Promise<void>;
  /**
   * Synchronous and lock-free: the host calls it before queueing a frame and
   * drops the frame when it returns true. It exists for frames that interrupt
   * the work holding the lock (a cancel), so it may only signal — never read or
   * write storage or state the locked code relies on.
   */
  interceptWebSocketMessage?(ws: ActorSocket<Meta>, message: string | ArrayBuffer): boolean;
  webSocketClose?(ws: ActorSocket<Meta>, code: number, reason: string, wasClean: boolean): void | Promise<void>;
  webSocketError?(ws: ActorSocket<Meta>, error: unknown): void | Promise<void>;
  alarm?(): void | Promise<void>;
}

export interface ActorConstructor<Env, Meta = unknown> {
  new (state: ActorState<Meta>, env: Env): Actor<Meta>;
}

// ---- addressing ---------------------------------------------------------------

/** A handle to one named actor. An upgrade request (header `upgrade: websocket`)
 *  may be answered with an upgrade response (see `isUpgradeResponse`). */
export interface ActorHandle {
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
}

/** Every actor of one class, addressed by a stable name (e.g. the doc id). */
export interface ActorNamespace {
  get(name: string): ActorHandle;
}

// ---- blobs --------------------------------------------------------------------

export interface BlobMetadata {
  contentType?: string;
}

export interface BlobHead {
  readonly key: string;
  readonly size: number;
  readonly uploaded: Date;
  readonly httpMetadata?: BlobMetadata;
}

export interface BlobObject extends BlobHead {
  readonly body: ReadableStream<Uint8Array>;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}

export interface BlobList {
  objects: BlobHead[];
  truncated: boolean;
  cursor?: string;
}

/** Byte storage on disk (snapshots, media, run bodies). */
export interface BlobStore {
  get(key: string): Promise<BlobObject | null>;
  head(key: string): Promise<BlobHead | null>;
  put(key: string, value: Uint8Array | ArrayBuffer | string, opts?: { httpMetadata?: BlobMetadata }): Promise<void>;
  delete(key: string | string[]): Promise<void>;
  list(opts?: { prefix?: string; cursor?: string; limit?: number }): Promise<BlobList>;
}

// ---- jobs ---------------------------------------------------------------------

/** Durable, at-least-once background jobs (indexing, notifications, GC). */
export interface JobQueue<T = unknown> {
  send(message: T): Promise<void>;
}

// ---- internal calls -----------------------------------------------------------

/** In-process calls from an actor into the node's internal handler. `path` is absolute (`/internal/retrieve`). */
export interface InternalApi {
  fetch(path: string, init?: RequestInit): Promise<Response>;
}
