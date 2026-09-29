/**
 * The node's LAN listener, `node:http` (or `node:https` with per-hostname certificates), and the
 * request pipeline it shares with the remote listener (./remote-listener.ts): Fetch
 * `Request`/`Response` over `node:http`. Every request URL is rebuilt on the listener's own origin,
 * never the Host header, so a forged Host cannot redirect a minted URL or widen the origin
 * allow-set. Bodies are capped at `maxBodyBytes`. Certificates under `certDir` are cached per
 * hostname until anything there changes.
 */
import { watch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import type { AddressInfo, Socket } from "node:net";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import tls from "node:tls";
import { WebSocketServer } from "ws";
import { attachSocket, isUpgradeResponse, serverSocketOf } from "@stuga/runtime";

export type RequestHandler = (request: Request) => Promise<Response>;

export interface TlsOptions {
  /** `certDir/<hostname>/fullchain.pem` and `privkey.pem` per served name. */
  certDir: string;
  /** Certificate presented to clients that send no server name. Optional. */
  defaultHost?: string;
}

/** Largest WebSocket frame: twice the largest document (a 4 MiB Markdown import); images travel over REST. */
const MAX_WS_PAYLOAD_BYTES = 8 * 1024 * 1024;

/** Which listener a request came in on: the LAN one, or the remote address's (docs/remote-access.md). */
export type Arrival = "local" | "remote";

interface HttpServerOptions {
  handler: RequestHandler;
  /** Answers `upgrade: websocket` requests: an upgrade response completes the handshake, anything else is written back. */
  upgrade: RequestHandler;
  /** The origin every request URL is rebuilt on, e.g. https://node.example. */
  publicOrigin: string;
  /** Address to bind. Default 127.0.0.1. */
  bind?: string;
  /** Port to bind; 0 picks a free one. */
  port: number;
  /** Largest request body read before answering 413, read per request. */
  maxBodyBytes: () => number;
  /**
   * Requests whose handler reads the body itself, as a stream, once it knows the caller; the
   * listener reads none of it. By method and path, without the query.
   */
  readsOwnBody?: (method: string, path: string) => boolean;
  tls?: TlsOptions;
  onError?: (error: unknown) => void;
}

export interface HttpServer {
  listen(): Promise<{ address: string; port: number }>;
  /** Stop accepting; open connections are ended. */
  close(): Promise<void>;
}

const BODYLESS_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

class BodyTooLarge extends Error {}
class BodyTooSlow extends Error {}

/** Buffer the request body up to `max` bytes, within `withinMs` when given. */
function readBody(req: IncomingMessage, max: number, withinMs?: number): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > max) {
      reject(new BodyTooLarge());
      return;
    }
    const timer =
      withinMs === undefined
        ? null
        : setTimeout(() => {
            req.removeAllListeners("data");
            reject(new BodyTooSlow());
          }, withinMs);
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) {
        if (timer) clearTimeout(timer);
        reject(new BodyTooLarge());
        req.removeAllListeners("data");
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (timer) clearTimeout(timer);
      resolvePromise(Buffer.concat(chunks));
    });
    req.on("error", (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
  });
}

function toHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i]!;
    const value = req.rawHeaders[i + 1]!;
    try {
      headers.append(name, value);
    } catch {
      // A header the Fetch API refuses is dropped rather than failing the request.
    }
  }
  return headers;
}

function requestUrl(origin: string, req: IncomingMessage): string {
  const path = req.url && req.url.startsWith("/") ? req.url : "/";
  return origin.replace(/\/+$/, "") + path;
}

/**
 * The connection's real peer address, stamped after removing any copy the client sent. Unlike
 * X-Forwarded-For it cannot be varied per request to dodge a throttle; behind a proxy it names the
 * proxy. At the remote address it is the source the PROXY header named.
 */
export const PEER_ADDRESS_HEADER = "x-stuga-peer";

/**
 * The Host the client sent, stamped after removing any copy it sent under this name. The request's
 * URL is always rebuilt on the listener's origin; this is only for telling whether a page came from
 * the very address the request went to (see http/cors.ts).
 */
export const REQUEST_HOST_HEADER = "x-stuga-host";

/** The listener a request came in on (Arrival), stamped after removing any copy the client sent. */
export const ARRIVAL_HEADER = "x-stuga-arrival";

/**
 * The client address a per-address budget is keyed on. Behind a trusted proxy it is the last
 * X-Forwarded-For entry, the one that proxy appended: every entry to its left is client-written.
 * At the remote address it is always the PROXY header's source: what a visitor sends is theirs to write.
 */
export function clientAddress(req: Request, trustProxyHeaders: boolean): string {
  if (trustProxyHeaders && req.headers.get(ARRIVAL_HEADER) !== "remote") {
    const hops = (req.headers.get("x-forwarded-for") ?? "").split(",").map((hop) => hop.trim()).filter(Boolean);
    const forwarded = hops.at(-1) || req.headers.get("x-real-ip")?.trim();
    if (forwarded) return forwarded;
  }
  return req.headers.get(PEER_ADDRESS_HEADER)?.trim() || "unknown";
}

/**
 * The request body as a stream its handler pulls from. Unread, it stays in the socket: cancelling
 * reads no further and leaves the connection to be closed once the response is written. With
 * `idleMs`, a client that sends nothing for that long while the handler waits on it is cut off.
 */
function bodyStream(req: IncomingMessage, idleMs?: number): ReadableStream<Uint8Array> {
  const chunks = req[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  let idle: NodeJS.Timeout | null = null;
  const stopIdle = () => {
    if (idle) clearTimeout(idle);
    idle = null;
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (idleMs !== undefined) idle = setTimeout(() => req.socket.destroy(), idleMs);
      try {
        const { value, done } = await chunks.next();
        if (done) controller.close();
        else controller.enqueue(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
      } finally {
        stopIdle();
      }
    },
    cancel: stopIdle,
  });
}

/** Where a request came from and how it went, stamped by the listener that accepted it. */
interface Arrived {
  origin: string;
  arrival: Arrival;
  peer: string | undefined;
}

function toRequest(arrived: Arrived, req: IncomingMessage, body: Buffer | ReadableStream<Uint8Array> | null): Request {
  const method = (req.method ?? "GET").toUpperCase();
  const headers = toHeaders(req);
  // Deleted first: a socket with no peer address would otherwise keep the client's own value.
  headers.delete(PEER_ADDRESS_HEADER);
  headers.delete(REQUEST_HOST_HEADER);
  headers.delete(ARRIVAL_HEADER);
  if (arrived.peer) headers.set(PEER_ADDRESS_HEADER, arrived.peer);
  if (req.headers.host) headers.set(REQUEST_HOST_HEADER, req.headers.host);
  headers.set(ARRIVAL_HEADER, arrived.arrival);
  const init: RequestInit & { duplex?: "half" } = { method, headers };
  if (body instanceof ReadableStream) Object.assign(init, { body, duplex: "half" });
  else if (body && body.length > 0 && !BODYLESS_METHODS.has(method)) init.body = body as Uint8Array<ArrayBuffer>;
  return new Request(requestUrl(arrived.origin, req), init);
}

function responseHeaders(response: Response): [string, string][] {
  const out: [string, string][] = [];
  for (const [name, value] of response.headers) {
    if (name === "set-cookie") continue;
    out.push([name, value]);
  }
  for (const cookie of response.headers.getSetCookie()) out.push(["set-cookie", cookie]);
  return out;
}

async function writeResponse(res: ServerResponse, response: Response, head: boolean): Promise<void> {
  const headers = responseHeaders(response);
  const body = response.body;
  if (!body || head) {
    res.writeHead(response.status, response.statusText, headers.flat());
    res.end();
    if (body) await body.cancel().catch(() => {});
    return;
  }
  res.writeHead(response.status, response.statusText, headers.flat());
  // pipeline() applies backpressure and cancels the body when the client goes away.
  await pipeline(Readable.fromWeb(body as import("node:stream/web").ReadableStream), res);
}

function textResponse(status: number, text: string): Response {
  return new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

function rawHttpResponse(response: Response, body: string): string {
  const lines = [`HTTP/1.1 ${response.status} ${response.statusText || http.STATUS_CODES[response.status] || ""}`];
  for (const [name, value] of responseHeaders(response)) lines.push(`${name}: ${value}`);
  lines.push(`content-length: ${Buffer.byteLength(body)}`, "connection: close", "", body);
  return lines.join("\r\n");
}

const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;

/** Per-hostname secure contexts, invalidated when anything under `certDir` changes. */
class CertificateCache {
  #contexts = new Map<string, Promise<tls.SecureContext>>();
  #watcher: FSWatcher | null = null;

  constructor(readonly certDir: string) {
    try {
      this.#watcher = watch(certDir, { recursive: true }, () => this.#contexts.clear());
      this.#watcher.unref();
      this.#watcher.on("error", () => {
        this.#watcher = null;
      });
    } catch {
      // Without a watcher a renewed certificate is picked up on restart.
      this.#watcher = null;
    }
  }

  load(hostname: string): Promise<tls.SecureContext> {
    if (!HOSTNAME.test(hostname)) return Promise.reject(new Error(`bad server name: ${hostname}`));
    let ctx = this.#contexts.get(hostname);
    if (!ctx) {
      const dir = join(this.certDir, hostname.toLowerCase());
      ctx = Promise.all([readFile(join(dir, "fullchain.pem")), readFile(join(dir, "privkey.pem"))]).then(([cert, key]) =>
        tls.createSecureContext({ cert, key }),
      );
      ctx.catch(() => this.#contexts.delete(hostname));
      this.#contexts.set(hostname, ctx);
    }
    return ctx;
  }

  close(): void {
    this.#watcher?.close();
    this.#watcher = null;
  }
}

export interface RequestPipelineOptions {
  handler: RequestHandler;
  /** Answers `upgrade: websocket` requests: an upgrade response completes the handshake, anything else is written back. */
  upgrade: RequestHandler;
  /** The origin every request URL is rebuilt on: PUBLIC_ORIGIN on the LAN, the remote origin at the remote address. */
  origin: string;
  arrival: Arrival;
  /** The address a connection came from, stamped as PEER_ADDRESS_HEADER. */
  peerOf: (socket: Socket) => string | undefined;
  /** Largest request body read before answering 413, read per request. */
  maxBodyBytes: () => number;
  /** As HttpServerOptions.readsOwnBody. */
  readsOwnBody?: (method: string, path: string) => boolean;
  onError?: (error: unknown) => void;
  /** The one name the Host header may carry, lowercase; any other is answered 421. The remote listener's. */
  hostname?: string;
  /** How long a body this pipeline reads itself may take, else 408. */
  bodyMs?: number;
  /** How long a body its handler reads may go without a byte before the connection is dropped. */
  bodyIdleMs?: number;
  /** Headers for an answer the pipeline makes itself (421, 413, 408, 500), which no handler sees. */
  decorate?: (response: Response) => Response;
}

export interface RequestPipeline {
  onRequest(req: IncomingMessage, res: ServerResponse): Promise<void>;
  onUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): Promise<void>;
  /** End every WebSocket this pipeline opened. */
  terminateSockets(): void;
}

/** Host as a client may write the name: any case, `:443`, a trailing dot. */
function hostMatches(host: string | undefined, hostname: string): boolean {
  if (!host) return false;
  return host.toLowerCase().replace(/:443$/, "").replace(/\.$/, "") === hostname;
}

/** One listener's requests as Fetch requests, and its answers back onto the connection; a WebSocketServer of its own. */
export function createRequestPipeline(options: RequestPipelineOptions): RequestPipeline {
  const { handler, upgrade, origin, arrival, peerOf, maxBodyBytes, readsOwnBody = () => false, hostname, bodyMs, bodyIdleMs } = options;
  const onError = options.onError ?? ((e: unknown) => console.error("[http] request failed", e));
  const decorate = options.decorate ?? ((response: Response) => response);
  const own = (status: number, text: string): Response => decorate(textResponse(status, text));
  const misdirected = (): Response => own(421, "misdirected request");
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_WS_PAYLOAD_BYTES });
  const arrived = (req: IncomingMessage): Arrived => ({ origin, arrival, peer: peerOf(req.socket) });

  const onRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = (req.method ?? "GET").toUpperCase();
    const ownBody = !BODYLESS_METHODS.has(method) && readsOwnBody(method, (req.url ?? "/").split("?")[0]!);
    let response: Response;
    let unread = false;
    try {
      if (hostname !== undefined && !hostMatches(req.headers.host, hostname)) {
        unread = true;
        response = misdirected();
      } else {
        const body = BODYLESS_METHODS.has(method)
          ? null
          : ownBody
            ? bodyStream(req, bodyIdleMs)
            : await readBody(req, maxBodyBytes(), bodyMs);
        if (body === null) req.resume();
        response = await handler(toRequest(arrived(req), req, body));
        if (isUpgradeResponse(response)) response = own(500, "upgrade response on a plain request");
      }
    } catch (e) {
      if (e instanceof BodyTooLarge) {
        response = own(413, "request body too large");
        response.headers.set("connection", "close");
      } else if (e instanceof BodyTooSlow) {
        unread = true;
        response = own(408, "request body too slow");
      } else {
        onError(e);
        response = own(500, "internal error");
      }
    }
    // A body left unread, by a handler that refused the caller or by a refusal here, stays unread: the connection closes after the answer.
    if (unread || (ownBody && !req.readableEnded)) res.shouldKeepAlive = false;
    try {
      await writeResponse(res, response, method === "HEAD");
    } catch {
      // The client went away mid-body; nothing to report.
      if (!res.destroyed) res.destroy();
    }
  };

  const onUpgrade = async (req: IncomingMessage, socket: Socket, head: Buffer): Promise<void> => {
    let response: Response;
    try {
      req.resume();
      response =
        hostname !== undefined && !hostMatches(req.headers.host, hostname)
          ? misdirected()
          : await upgrade(toRequest(arrived(req), req, null));
    } catch (e) {
      onError(e);
      response = own(500, "internal error");
    }
    if (socket.destroyed) {
      if (isUpgradeResponse(response)) serverSocketOf(response).markClosed(1006, "client went away");
      return;
    }
    if (!isUpgradeResponse(response)) {
      const text = await response.text().catch(() => "");
      socket.end(rawHttpResponse(response, text));
      return;
    }
    const server = serverSocketOf(response);
    wss.handleUpgrade(req, socket, head, (ws) => attachSocket(server, ws));
  };

  return {
    onRequest,
    onUpgrade,
    terminateSockets() {
      for (const ws of wss.clients) ws.terminate();
    },
  };
}

export function createHttpServer(options: HttpServerOptions): HttpServer {
  const bind = options.bind ?? "127.0.0.1";
  const certs = options.tls ? new CertificateCache(options.tls.certDir) : null;
  const { onRequest, onUpgrade, terminateSockets } = createRequestPipeline({
    handler: options.handler,
    upgrade: options.upgrade,
    origin: options.publicOrigin,
    arrival: "local",
    peerOf: (socket) => socket.remoteAddress,
    maxBodyBytes: options.maxBodyBytes,
    readsOwnBody: options.readsOwnBody,
    onError: options.onError,
  });

  const listener = (req: IncomingMessage, res: ServerResponse): void => {
    void onRequest(req, res);
  };
  const server = options.tls
    ? https.createServer(
        {
          SNICallback: (servername, cb) => {
            certs!.load(servername).then(
              (ctx) => cb(null, ctx),
              (e) => cb(e instanceof Error ? e : new Error(String(e))),
            );
          },
        },
        listener,
      )
    : http.createServer(listener);
  server.on("upgrade", (req, socket, head) => {
    void onUpgrade(req, socket as Socket, head);
  });
  server.on("clientError", (_err, socket) => {
    if (!socket.destroyed) socket.end("HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n");
  });

  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  return {
    async listen() {
      if (options.tls && certs) {
        const defaultHost = options.tls.defaultHost;
        if (defaultHost) (server as https.Server).setSecureContext(await defaultContext(certs, defaultHost));
      }
      await new Promise<void>((resolvePromise, reject) => {
        server.once("error", reject);
        server.listen(options.port, bind, () => {
          server.off("error", reject);
          resolvePromise();
        });
      });
      const address = server.address() as AddressInfo;
      return { address: address.address, port: address.port };
    },
    async close() {
      certs?.close();
      terminateSockets();
      await new Promise<void>((resolvePromise) => {
        server.close(() => resolvePromise());
        for (const socket of sockets) socket.destroy();
      });
    },
  };
}

async function defaultContext(certs: CertificateCache, host: string): Promise<tls.SecureContextOptions> {
  await certs.load(host);
  const dir = join(certs.certDir, host.toLowerCase());
  return { cert: await readFile(join(dir, "fullchain.pem")), key: await readFile(join(dir, "privkey.pem")) };
}
