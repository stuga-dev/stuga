/**
 * The node's listener: `node:http` (or `node:https` with per-hostname certificates) adapted to
 * Fetch `Request`/`Response`. Every request URL is rebuilt on the public origin, never the Host
 * header, so a forged Host cannot redirect a minted URL or widen the origin allow-set. Bodies are
 * capped at `maxBodyBytes`. Certificates under `certDir` are cached per hostname until anything
 * there changes.
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

/** Buffer the request body up to `max` bytes. */
function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > max) {
      reject(new BodyTooLarge());
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) {
        reject(new BodyTooLarge());
        req.removeAllListeners("data");
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolvePromise(Buffer.concat(chunks)));
    req.on("error", reject);
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

function requestUrl(publicOrigin: string, req: IncomingMessage): string {
  const path = req.url && req.url.startsWith("/") ? req.url : "/";
  return publicOrigin.replace(/\/+$/, "") + path;
}

/**
 * The connection's real peer address, stamped after removing any copy the client sent. Unlike
 * X-Forwarded-For it cannot be varied per request to dodge a throttle; behind a proxy it names the proxy.
 */
export const PEER_ADDRESS_HEADER = "x-stuga-peer";

/**
 * The Host the client sent, stamped after removing any copy it sent under this name. The request's
 * URL is always rebuilt on PUBLIC_ORIGIN; this is only for telling whether a page came from the very
 * address the request went to (see http/cors.ts).
 */
export const REQUEST_HOST_HEADER = "x-stuga-host";

/**
 * The client address a per-address budget is keyed on. Behind a trusted proxy it is the last
 * X-Forwarded-For entry, the one that proxy appended: every entry to its left is client-written.
 */
export function clientAddress(req: Request, trustProxyHeaders: boolean): string {
  if (trustProxyHeaders) {
    const hops = (req.headers.get("x-forwarded-for") ?? "").split(",").map((hop) => hop.trim()).filter(Boolean);
    const forwarded = hops.at(-1) || req.headers.get("x-real-ip")?.trim();
    if (forwarded) return forwarded;
  }
  return req.headers.get(PEER_ADDRESS_HEADER)?.trim() || "unknown";
}

function toRequest(publicOrigin: string, req: IncomingMessage, body: Buffer | null): Request {
  const method = (req.method ?? "GET").toUpperCase();
  const headers = toHeaders(req);
  // Deleted first: a socket with no remoteAddress would otherwise keep the client's own value.
  headers.delete(PEER_ADDRESS_HEADER);
  headers.delete(REQUEST_HOST_HEADER);
  const peer = req.socket.remoteAddress;
  if (peer) headers.set(PEER_ADDRESS_HEADER, peer);
  if (req.headers.host) headers.set(REQUEST_HOST_HEADER, req.headers.host);
  const init: RequestInit = { method, headers };
  if (body && body.length > 0 && !BODYLESS_METHODS.has(method)) init.body = body as Uint8Array<ArrayBuffer>;
  return new Request(requestUrl(publicOrigin, req), init);
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

export function createHttpServer(options: HttpServerOptions): HttpServer {
  const { handler, upgrade, publicOrigin, maxBodyBytes } = options;
  const bind = options.bind ?? "127.0.0.1";
  const onError = options.onError ?? ((e: unknown) => console.error("[http] request failed", e));
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_WS_PAYLOAD_BYTES });
  const certs = options.tls ? new CertificateCache(options.tls.certDir) : null;

  const onRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = (req.method ?? "GET").toUpperCase();
    let response: Response;
    try {
      const body = BODYLESS_METHODS.has(method) ? null : await readBody(req, maxBodyBytes());
      if (body === null) req.resume();
      response = await handler(toRequest(publicOrigin, req, body));
      if (isUpgradeResponse(response)) response = textResponse(500, "upgrade response on a plain request");
    } catch (e) {
      if (e instanceof BodyTooLarge) {
        response = textResponse(413, "request body too large");
        response.headers.set("connection", "close");
      } else {
        onError(e);
        response = textResponse(500, "internal error");
      }
    }
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
      response = await upgrade(toRequest(publicOrigin, req, null));
    } catch (e) {
      onError(e);
      response = textResponse(500, "internal error");
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
      for (const ws of wss.clients) ws.terminate();
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
