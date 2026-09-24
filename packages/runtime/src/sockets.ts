/**
 * WebSockets as actors see them.
 *
 * An actor answers an upgrade by creating a `SocketPair`, accepting the server
 * half through `state.acceptWebSocket`, and returning
 * `upgradeResponse(pair.client)`. The host completes the handshake and attaches
 * the transport with `attachSocket`; anything the actor sent before that sits in
 * the socket's outbox and is flushed in order when the transport arrives. The
 * in-memory test host never attaches one, so the outbox is what a test reads.
 */
import type { WebSocket as WsSocket } from "ws";
import type { ActorSocket, ClientSocket } from "./interfaces.js";

/** A text frame the host answers itself, without entering the actor. */
export interface Heartbeat {
  request: string;
  response: string;
}

/** What the host offers the transport bridge so inbound events reach the actor under its lock. */
export interface SocketOwner {
  deliverMessage(ws: ServerSocket, message: string | ArrayBuffer): Promise<void>;
  deliverClose(ws: ServerSocket, code: number, reason: string, wasClean: boolean): Promise<void>;
  deliverError(ws: ServerSocket, error: unknown): Promise<void>;
  readonly heartbeat: Heartbeat;
}

/** The wire the server half writes to once the handshake is done. */
export interface SocketTransport {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

const kServer = Symbol("stuga.server-socket");

/** The server half of a pair: the object an actor holds and the host routes to. */
export class ServerSocket<Meta = unknown> implements ActorSocket<Meta> {
  /** Binary frames sent while no transport was attached (copies). */
  readonly sent: Uint8Array[] = [];
  /** Text frames sent while no transport was attached. */
  readonly sentStrings: string[] = [];
  /** Set once the socket is closed from either side; a second close is a no-op. */
  closed: { code: number; reason: string } | null = null;
  /** Set by the host when the actor accepts the socket. */
  owner: SocketOwner | null = null;
  /** Assigned by `acceptWebSocket` before the actor can see the socket. */
  meta!: Meta;

  #transport: SocketTransport | null = null;

  send(data: string | Uint8Array | ArrayBuffer): void {
    if (this.closed) throw new Error("send on a closed socket");
    if (typeof data === "string") {
      if (this.#transport) this.#transport.send(data);
      else this.sentStrings.push(data);
      return;
    }
    const bytes = new Uint8Array(data);
    if (this.#transport) this.#transport.send(bytes);
    else this.sent.push(bytes);
  }

  close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = { code: code ?? 1000, reason: reason ?? "" };
    this.#transport?.close(this.closed.code, this.closed.reason);
  }

  /** Mark the socket closed by the peer without sending anything back. */
  markClosed(code: number, reason: string): void {
    this.closed ??= { code, reason };
  }

  /** Wire a transport: flush the outbox in order, then send live. */
  attach(transport: SocketTransport): void {
    for (const s of this.sentStrings) transport.send(s);
    for (const b of this.sent) transport.send(b);
    this.sentStrings.length = 0;
    this.sent.length = 0;
    this.#transport = transport;
    if (this.closed) transport.close(this.closed.code, this.closed.reason);
  }

  // ---- outbox inspection (no transport attached) ------------------------------

  /** Binary frames in the outbox, decoded as [opcode byte, payload]. */
  frames(): Array<{ opcode: number; payload: Uint8Array }> {
    return this.sent.map((f) => ({ opcode: f[0]!, payload: f.subarray(1) }));
  }

  /** Payload of the first outbox frame with this opcode, or null. */
  firstPayload(opcode: number): Uint8Array | null {
    return this.frames().find((f) => f.opcode === opcode)?.payload ?? null;
  }

  has(opcode: number): boolean {
    return this.frames().some((f) => f.opcode === opcode);
  }
}

class ClientToken implements ClientSocket {
  readonly __brand = "ClientSocket" as const;
  readonly [kServer]: ServerSocket;
  constructor(server: ServerSocket) {
    this[kServer] = server;
  }
}

/** A connected pair: the actor keeps `server`, the host receives `client`. */
export class SocketPair<Meta = unknown> {
  readonly server: ServerSocket<Meta>;
  readonly client: ClientSocket;
  constructor() {
    this.server = new ServerSocket<Meta>();
    this.client = new ClientToken(this.server as ServerSocket);
  }
}

// ---- upgrade responses -------------------------------------------------------------

const kClient = Symbol("stuga.upgrade-client");

/** The Fetch `Response` constructor refuses status 101, so this is built as a 200
 *  that reports 101; `isUpgradeResponse` is the reliable check. */
class UpgradeResponse extends Response {
  readonly [kClient]: ClientSocket;
  constructor(client: ClientSocket) {
    super(null, { status: 200 });
    this[kClient] = client;
  }
  override get status(): number {
    return 101;
  }
  override get ok(): boolean {
    return false;
  }
}

export function upgradeResponse(client: ClientSocket): Response {
  return new UpgradeResponse(client);
}

export function isUpgradeResponse(res: Response): boolean {
  return kClient in res;
}

/** The server half behind an upgrade response (throws for a plain response). */
export function serverSocketOf(res: Response): ServerSocket {
  if (!isUpgradeResponse(res)) throw new Error("not an upgrade response");
  const client = (res as UpgradeResponse)[kClient] as ClientToken;
  return client[kServer];
}

// ---- the host-side bridge ------------------------------------------------------------

function toArrayBuffer(data: Buffer | ArrayBuffer | Buffer[]): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data;
  const buf = Array.isArray(data) ? Buffer.concat(data) : data;
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/**
 * Pump frames between a live `ws` connection and the server half an actor
 * accepted. Inbound events are routed into the owning actor under its lock; the
 * owner's heartbeat request is answered here.
 */
export function attachSocket(server: ServerSocket, ws: WsSocket): void {
  const owner = server.owner;
  if (!owner) {
    ws.close(1011, "socket was not accepted");
    server.markClosed(1011, "socket was not accepted");
    return;
  }

  server.attach({
    send: (data) => ws.send(data),
    close: (code, reason) => {
      try {
        ws.close(code, reason);
      } catch {
        // A code the protocol does not allow on the wire, or a socket already gone.
        ws.terminate();
      }
    },
  });

  ws.on("message", (data, isBinary) => {
    if (!isBinary) {
      const text = Array.isArray(data) ? Buffer.concat(data).toString() : data.toString();
      if (text === owner.heartbeat.request) {
        if (ws.readyState === ws.OPEN) ws.send(owner.heartbeat.response);
        return;
      }
      void owner.deliverMessage(server, text);
      return;
    }
    void owner.deliverMessage(server, toArrayBuffer(data));
  });

  ws.on("error", (err) => {
    void owner.deliverError(server, err);
  });

  ws.on("close", (code, reason) => {
    const wasClean = code !== 1006;
    // Still listed by getWebSockets() while the actor handles the close.
    void owner.deliverClose(server, code, reason.toString(), wasClean).finally(() => {
      server.markClosed(code, reason.toString());
    });
  });
}
