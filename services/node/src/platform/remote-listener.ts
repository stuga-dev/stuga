/**
 * The remote address's listener (docs/remote-access.md): a unix socket the connector hands each
 * visitor's connection to, a PROXY v2 header naming the visitor ahead of it, then TLS the node
 * terminates with its own certificate for its one hostname. Requests then go through the pipeline
 * the LAN listener uses, on the remote origin. A connection is dropped before TLS when its header is
 * late or malformed, or when its source already holds `perSource` of them.
 */
import { chmod, chown, lstat, unlink } from "node:fs/promises";
import http from "node:http";
import net, { type Socket } from "node:net";
import { Duplex } from "node:stream";
import tls from "node:tls";
import { perSubnet } from "../net/addresses.js";
import { RemoteDirError } from "../remote/files.js";
import { createRequestPipeline, type RequestHandler } from "./http-server.js";
import { parseProxyV2 } from "./proxy-v2.js";

export interface RemoteListenerOptions {
  /** Checked to fit in `sun_path` (103 bytes) before it gets here. */
  socketPath: string;
  /** Lowercase; the origin is `https://${hostname}`. */
  hostname: string;
  /** withRemoteHeaders(withSecurityHeaders(gate.handler)) */
  handler: RequestHandler;
  /** withRemoteHeaders(withSecurityHeaders(gate.upgrade)) */
  upgrade: RequestHandler;
  /** applyRemoteHeaders: the same headers on an answer the listener makes itself, which neither of those sees. */
  decorate: (response: Response) => Response;
  /** The group the socket is given, where the connector is kept apart by one; the directory's otherwise. */
  gid?: number | undefined;
  maxBodyBytes: () => number;
  readsOwnBody: (method: string, path: string) => boolean;
  /** Defaults below; tests shrink them. */
  limits?: Partial<RemoteListenerLimits>;
  onError?: (e: unknown) => void;
}

export interface RemoteListenerLimits {
  maxConnections: number;
  /** Open connections per PROXY source, an IPv6 one by its /64. */
  perSource: number;
  proxyHeaderMs: number;
  handshakeMs: number;
  /** For a request's headers, from the end of the handshake or of the request before. */
  headersMs: number;
  /** For a body the listener reads itself (buffered). */
  bodyMs: number;
  /** Silence allowed in a body its handler reads as a stream (uploads, imports), however long it runs. */
  bodyIdleMs: number;
}

export interface RemoteListener {
  /** Swap the certificate for new handshakes; connections already open keep theirs. */
  setCertificate(pem: { key: string; cert: string }): void;
  /** Needs a certificate first. */
  listen(): Promise<void>;
  /** Stop accepting, drop every connection, remove the socket file. */
  close(): Promise<void>;
}

const DEFAULT_LIMITS: RemoteListenerLimits = {
  maxConnections: 512,
  perSource: 32,
  proxyHeaderMs: 5_000,
  handshakeMs: 10_000,
  headersMs: 10_000,
  bodyMs: 60_000,
  bodyIdleMs: 120_000,
};

const KEEP_ALIVE_MS = 5_000;
/** How often the server checks for connections past `headersMs`. */
const CONNECTIONS_CHECK_MS = 1_000;

export function createRemoteListener(options: RemoteListenerOptions): RemoteListener {
  const limits: RemoteListenerLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const { socketPath, hostname } = options;
  let context: tls.SecureContext | null = null;
  let listening = false;
  /** Every connection accepted, from before its PROXY header on. */
  const open = new Set<Socket>();
  const perSource = new Map<string, number>();
  /** The PROXY source per TLS socket, which is what the HTTP server sees as the connection. */
  const peers = new WeakMap<Socket, string>();

  const pipeline = createRequestPipeline({
    handler: options.handler,
    upgrade: options.upgrade,
    origin: `https://${hostname}`,
    arrival: "remote",
    peerOf: (socket) => peers.get(socket),
    maxBodyBytes: options.maxBodyBytes,
    readsOwnBody: options.readsOwnBody,
    onError: options.onError,
    decorate: options.decorate,
    hostname,
    bodyMs: limits.bodyMs,
    bodyIdleMs: limits.bodyIdleMs,
  });

  // No limit on a whole request or on a quiet socket: a slow import and a long SSE answer are both
  // fine. Headers are held to headersMs, a streamed body to the pipeline's bodyIdleMs.
  const server = http.createServer(
    {
      requestTimeout: 0,
      headersTimeout: limits.headersMs,
      keepAliveTimeout: KEEP_ALIVE_MS,
      connectionsCheckingInterval: CONNECTIONS_CHECK_MS,
    },
    (req, res) => void pipeline.onRequest(req, res),
  );
  server.timeout = 0;
  server.on("upgrade", (req, socket, head) => void pipeline.onUpgrade(req, socket as Socket, head));
  server.on("clientError", (err: NodeJS.ErrnoException, socket) => {
    if (socket.destroyed) return;
    const status = err.code === "ERR_HTTP_REQUEST_TIMEOUT" ? 408 : 400;
    const headers = [...options.decorate(new Response(null, { status })).headers].map(([name, value]) => `${name}: ${value}\r\n`).join("");
    socket.once("finish", () => socket.destroy());
    socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\n${headers}connection: close\r\n\r\n`);
  });

  const release = (source: string): void => {
    const left = (perSource.get(source) ?? 1) - 1;
    if (left > 0) perSource.set(source, left);
    else perSource.delete(source);
  };

  /** TLS for the one hostname, over what follows the header; the HTTP server gets the connection once it is secure. */
  const secure = (raw: Socket, address: string): void => {
    // Over a JS stream rather than the socket itself: TLS on the raw handle would skip the bytes unshifted back.
    // The { readable, writable } form takes Node streams as well; the types know only web ones.
    const transport = Duplex.from({ readable: raw, writable: raw } as unknown as Parameters<typeof Duplex.from>[0]);
    const socket = new tls.TLSSocket(transport, {
      isServer: true,
      // No default certificate: a handshake without the hostname gets none.
      SNICallback: (servername, cb) => {
        if (context && servername.toLowerCase().replace(/\.$/, "") === hostname) cb(null, context);
        else cb(new Error("unknown server name"));
      },
      ALPNProtocols: ["http/1.1"],
      minVersion: "TLSv1.2",
    });
    const handshake = setTimeout(() => socket.destroy(), limits.handshakeMs);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => {
      clearTimeout(handshake);
      raw.destroy();
    });
    raw.once("close", () => socket.destroy());
    socket.once("secure", () => {
      clearTimeout(handshake);
      peers.set(socket, address);
      server.emit("connection", socket);
    });
  };

  const accept = (raw: Socket): void => {
    raw.on("error", () => {});
    if (open.size >= limits.maxConnections) {
      raw.destroy();
      return;
    }
    open.add(raw);
    const late = setTimeout(() => raw.destroy(), limits.proxyHeaderMs);
    raw.once("close", () => {
      open.delete(raw);
      clearTimeout(late);
    });
    let buffered: Buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buffered = buffered.length > 0 ? Buffer.concat([buffered, chunk]) : chunk;
      const parsed = parseProxyV2(buffered);
      if (parsed.kind === "need-more") return;
      clearTimeout(late);
      raw.off("data", onData);
      raw.pause();
      if (parsed.kind === "reject") {
        raw.destroy();
        return;
      }
      const source = perSubnet(parsed.source.address);
      const count = (perSource.get(source) ?? 0) + 1;
      if (count > limits.perSource) {
        raw.destroy();
        return;
      }
      perSource.set(source, count);
      raw.once("close", () => release(source));
      const rest = buffered.subarray(parsed.headerLength);
      if (rest.length > 0) raw.unshift(rest);
      secure(raw, parsed.source.address);
    };
    raw.on("data", onData);
  };

  const listener = net.createServer(accept);

  return {
    setCertificate({ key, cert }) {
      context = tls.createSecureContext({ key, cert });
    },

    async listen() {
      if (!context) throw new Error("the remote listener has no certificate");
      if (listening) return;
      await removeSocketFile(socketPath, { refuseOther: true });
      await new Promise<void>((resolve, reject) => {
        listener.once("error", reject);
        listener.listen(socketPath, () => {
          listener.off("error", reject);
          resolve();
        });
      });
      listening = true;
      await chmod(socketPath, 0o660);
      if (options.gid !== undefined) await chown(socketPath, -1, options.gid);
      // Node starts the tracking headersTimeout relies on when a server starts listening, and this
      // one never does: it is only handed connections. Started by hand, as if it had.
      server.emit("listening");
    },

    async close() {
      const closed = listening ? new Promise<void>((resolve) => listener.close(() => resolve())) : Promise.resolve();
      listening = false;
      pipeline.terminateSockets();
      for (const raw of open) raw.destroy();
      // Stops the header-timeout checks; the server itself never listened.
      server.close();
      await closed;
      await removeSocketFile(socketPath, { refuseOther: false });
    },
  };
}

/** Clear a socket file a previous run left, never anything else at that path; with `refuseOther`, anything else there is an error. */
export async function removeSocketFile(path: string, { refuseOther }: { refuseOther: boolean }): Promise<void> {
  let isSocket: boolean;
  try {
    isSocket = (await lstat(path)).isSocket();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  if (isSocket) await unlink(path).catch(() => {});
  else if (refuseOther) throw new RemoteDirError("remote_dir_unusable", `${path} exists and is not a socket`);
}
