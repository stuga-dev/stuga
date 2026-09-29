/**
 * A visitor at the remote address as the connector presents one: a connection to the node's unix
 * socket, a PROXY v2 header naming the visitor, then TLS for the node's hostname. For tests only.
 */
import http from "node:http";
import net from "node:net";
import tls from "node:tls";

const SIGNATURE = Buffer.from("0d0a0d0a000d0a515549540a", "hex");

/** An IPv4 or IPv6 address as its 4 or 16 bytes, a dotted-quad tail included; null when it is not one. */
export function ipBytes(address: string): Buffer | null {
  if (net.isIPv4(address)) return Buffer.from(address.split(".").map(Number));
  if (!net.isIPv6(address)) return null;
  const tail = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(address);
  const text = tail ? `${address.slice(0, tail.index)}${((+tail[1]! << 8) | +tail[2]!).toString(16)}:${((+tail[3]! << 8) | +tail[4]!).toString(16)}` : address;
  const [head, rest] = text.split("::");
  const groups = (part: string | undefined) => (part ? part.split(":") : []);
  const all = rest === undefined ? groups(head) : [...groups(head), ...Array<string>(8 - groups(head).length - groups(rest).length).fill("0"), ...groups(rest)];
  const out = Buffer.alloc(16);
  all.forEach((g, i) => out.writeUInt16BE(parseInt(g, 16), i * 2));
  return out;
}

/** A PROXY v2 header for TCP from `address`:`port`, over IPv4 or IPv6 as the address is written. */
export function proxyV2Header(address: string, port = 5555): Buffer {
  const source = ipBytes(address);
  if (!source) throw new Error(`not an IP address: ${address}`);
  const v6 = source.length === 16;
  const ports = Buffer.alloc(4);
  ports.writeUInt16BE(port, 0);
  ports.writeUInt16BE(443, 2);
  const body = Buffer.concat([source, ipBytes(v6 ? "2001:db8::1" : "192.0.2.1")!, ports]);
  const fixed = Buffer.from([0x21, v6 ? 0x21 : 0x11, 0, 0]);
  fixed.writeUInt16BE(body.length, 2);
  return Buffer.concat([SIGNATURE, fixed, body]);
}

export interface DialOptions {
  /** The visitor's address in the PROXY header. Default 203.0.113.7. */
  source?: string;
  port?: number;
  /** Written in place of the header; null for none at all. */
  header?: Buffer | null;
  /** The SNI name; "" sends none. */
  servername: string;
  /** Trusted for the handshake, which then checks the name too; absent, anything is accepted. */
  ca?: string;
}

/** The socket connection, once it has written its header: for a test of what happens before TLS. */
export function connectRemote(socketPath: string, header: Buffer | null): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const raw = net.connect(socketPath, () => {
      if (header) raw.write(header);
      resolve(raw);
    });
    raw.once("error", reject);
  });
}

/** A TLS connection through the remote listener, open once the handshake is done. */
export async function dialRemote(socketPath: string, opts: DialOptions): Promise<tls.TLSSocket> {
  const header = opts.header === undefined ? proxyV2Header(opts.source ?? "203.0.113.7", opts.port) : opts.header;
  const raw = await connectRemote(socketPath, header);
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      {
        socket: raw,
        ALPNProtocols: ["http/1.1"],
        ...(opts.servername ? { servername: opts.servername } : {}),
        ...(opts.ca ? { ca: opts.ca } : { rejectUnauthorized: false }),
      },
      () => resolve(socket),
    );
    socket.once("error", (e) => {
      raw.destroy();
      reject(e);
    });
  });
}

export interface RemoteAnswer {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
}

/** One request over an open connection, to the name it was dialled for; it closes after unless `keepAlive`. */
export function remoteRequest(
  socket: tls.TLSSocket,
  opts: { method?: string; path?: string; headers?: Record<string, string>; body?: string | Buffer; keepAlive?: boolean },
): Promise<RemoteAnswer> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: opts.method ?? "GET",
        path: opts.path ?? "/",
        headers: { host: socket.servername || "localhost", connection: opts.keepAlive ? "keep-alive" : "close", ...opts.headers },
        createConnection: () => socket,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, text: Buffer.concat(chunks).toString() }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(opts.body);
  });
}

/** Resolves once `socket` has been closed, from either end. */
export function closed(socket: net.Socket): Promise<void> {
  return new Promise((resolve) => {
    if (socket.destroyed) resolve();
    else socket.once("close", () => resolve());
  });
}
