/**
 * Before answering a dns-01 challenge, the node asks the zone's authoritative servers itself
 * whether the TXT record the service published is there yet: the service does not wait for it to
 * spread, and a CA that looks too early fails the authorization.
 *
 * Some networks answer port 53 themselves, whatever address a query names, and cache "no such
 * record" for many minutes. Their answers lack the AA flag an authoritative server sets, so the node
 * builds its own queries to read that flag, and takes such an answer for no answer.
 */
import { randomInt } from "node:crypto";
import { createSocket } from "node:dgram";
import { promises as dns } from "node:dns";
import { isIPv6 } from "node:net";

export interface TxtAnswer {
  /** The AA flag: the server answered from its own zone. */
  authoritative: boolean;
  /** Each record's strings; empty when the name or the record isn't there. */
  records: string[][];
}

export interface ChallengeResolver {
  /** The zone's authoritative servers, as addresses (ip, ip:port or [ipv6]:port). */
  servers(zone: string): Promise<string[]>;
  /** One query, no retry. Rejects with code ETIMEOUT when nothing answers. */
  txt(server: string, fqdn: string): Promise<TxtAnswer>;
}

const QUERY_TIMEOUT_MS = 2_000;
const TYPE_TXT = 16;
const CLASS_IN = 1;
const FLAG_QR = 0x8000;
const FLAG_AA = 0x0400;
const FLAG_TC = 0x0200;
const RCODE_NXDOMAIN = 3;

class DnsQueryError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function parseServer(server: string): { host: string; port: number } {
  const bracketed = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(server);
  if (bracketed) return { host: bracketed[1]!, port: Number(bracketed[2] ?? 53) };
  if (isIPv6(server)) return { host: server, port: 53 };
  const [host, port] = server.split(":");
  return { host: host!, port: Number(port ?? 53) };
}

function encodeQuery(id: number, fqdn: string): Buffer {
  const labels = fqdn.replace(/\.$/, "").split(".");
  if (labels.some((l) => l.length < 1 || l.length > 63)) throw new DnsQueryError("EBADNAME", `not a DNS name: ${fqdn}`);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  // Flags 0: a standard query that asks for no recursion.
  header.writeUInt16BE(1, 4);
  const question = Buffer.concat([...labels.flatMap((l) => [Buffer.from([l.length]), Buffer.from(l, "ascii")]), Buffer.from([0, 0, TYPE_TXT, 0, CLASS_IN])]);
  return Buffer.concat([header, question]);
}

/** A name at `offset`, following compression pointers, and where the data after it starts. */
function readName(buf: Buffer, offset: number): { name: string; next: number } {
  const labels: string[] = [];
  let at = offset;
  let next: number | null = null;
  for (let jumps = 0; ; ) {
    const len = buf[at];
    if (len === undefined) throw new DnsQueryError("EBADRESP", "a name runs past the end of the answer");
    if ((len & 0xc0) === 0xc0) {
      if (++jumps > 16 || at + 1 >= buf.length) throw new DnsQueryError("EBADRESP", "a bad compression pointer");
      next ??= at + 2;
      at = ((len & 0x3f) << 8) | buf[at + 1]!;
    } else if (len === 0) {
      return { name: labels.join(".").toLowerCase(), next: next ?? at + 1 };
    } else {
      if (at + 1 + len > buf.length) throw new DnsQueryError("EBADRESP", "a label runs past the end of the answer");
      labels.push(buf.toString("latin1", at + 1, at + 1 + len));
      at += 1 + len;
    }
  }
}

/** The answer to query `id`, or null when `buf` answers something else. */
export function parseTxtResponse(buf: Buffer, id: number, fqdn: string): TxtAnswer | null {
  if (buf.length < 12 || buf.readUInt16BE(0) !== id) return null;
  const flags = buf.readUInt16BE(2);
  if (!(flags & FLAG_QR)) return null;
  const authoritative = (flags & FLAG_AA) !== 0;
  const rcode = flags & 0x000f;
  if (rcode === RCODE_NXDOMAIN) return { authoritative, records: [] };
  if (rcode !== 0) throw new DnsQueryError("ESERVFAIL", `the server answered with rcode ${rcode}`);
  if (flags & FLAG_TC) throw new DnsQueryError("ETRUNCATED", "the answer was truncated");

  const want = fqdn.replace(/\.$/, "").toLowerCase();
  let at = 12;
  for (let q = buf.readUInt16BE(4); q > 0; q--) at = readName(buf, at).next + 4;
  const records: string[][] = [];
  for (let n = buf.readUInt16BE(6); n > 0; n--) {
    const { name, next } = readName(buf, at);
    if (next + 10 > buf.length) throw new DnsQueryError("EBADRESP", "a record runs past the end of the answer");
    const type = buf.readUInt16BE(next);
    const cls = buf.readUInt16BE(next + 2);
    const rdlength = buf.readUInt16BE(next + 8);
    const start = next + 10;
    const end = start + rdlength;
    if (end > buf.length) throw new DnsQueryError("EBADRESP", "a record runs past the end of the answer");
    if (type === TYPE_TXT && cls === CLASS_IN && name === want) {
      const strings: string[] = [];
      for (let i = start; i < end; ) {
        const len = buf[i]!;
        if (i + 1 + len > end) throw new DnsQueryError("EBADRESP", "a TXT string runs past its record");
        strings.push(buf.toString("utf8", i + 1, i + 1 + len));
        i += 1 + len;
      }
      records.push(strings);
    }
    at = end;
  }
  return { authoritative, records };
}

/** One TXT query over UDP to one server, with no retry and no fallback to another. */
export function queryTxt(server: string, fqdn: string, timeoutMs = QUERY_TIMEOUT_MS): Promise<TxtAnswer> {
  const { host, port } = parseServer(server);
  const id = randomInt(0x10000);
  const query = encodeQuery(id, fqdn);
  const socket = createSocket(isIPv6(host) ? "udp6" : "udp4");
  return new Promise<TxtAnswer>((resolve, reject) => {
    const finish = (settle: () => void) => {
      clearTimeout(timer);
      socket.close();
      settle();
    };
    const timer = setTimeout(() => finish(() => reject(new DnsQueryError("ETIMEOUT", `${server} did not answer within ${timeoutMs} ms`))), timeoutMs);
    socket.on("error", (e) => finish(() => reject(e)));
    // A connected socket takes datagrams from this address only.
    socket.on("message", (msg) => {
      let answer: TxtAnswer | null;
      try {
        answer = parseTxtResponse(msg, id, fqdn);
      } catch (e) {
        finish(() => reject(e));
        return;
      }
      if (answer) finish(() => resolve(answer));
    });
    socket.connect(port, host, () => socket.send(query));
  });
}

/** Production: the zone's NS records through the system resolver, and one address for each. */
export function systemChallengeResolver(): ChallengeResolver {
  return {
    async servers(zone) {
      const names = await dns.resolveNs(zone);
      const addresses = await Promise.all(
        names.map(async (name) => {
          const v4 = await dns.resolve4(name).catch(() => [] as string[]);
          if (v4[0]) return v4[0];
          const v6 = await dns.resolve6(name).catch(() => [] as string[]);
          return v6[0] ?? null;
        }),
      );
      return addresses.filter((a): a is string => a !== null);
    },
    txt: (server, fqdn) => queryTxt(server, fqdn),
  };
}

/** Tests: these servers stand for the zone's, such as Pebble's challtestsrv, which never sets AA. */
export function fixedChallengeResolver(servers: string[]): ChallengeResolver {
  return {
    servers: async () => [...servers],
    txt: async (server, fqdn) => ({ ...(await queryTxt(server, fqdn)), authoritative: true }),
  };
}

export class DnsNotVisible extends Error {
  readonly code = "dns_not_visible";
}

export interface DnsWaitOptions {
  resolver: ChallengeResolver;
  /** The certificate's name: its zone is everything after the first label. */
  hostname: string;
  fqdn: string;
  value: string;
  pollMs?: number;
  timeoutMs?: number;
  /** When no server's first answer can be trusted (port 53 blocked, or answered by the network), wait this long and go on. */
  blindWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

type Seen = "yes" | "no" | "timeout" | "not_authoritative";

/** Resolve once every authoritative server answers `value` for `fqdn`; DnsNotVisible when they don't in time. */
export async function waitForTxt(opts: DnsWaitOptions): Promise<void> {
  const pollMs = opts.pollMs ?? 2_000;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const blindWaitMs = opts.blindWaitMs ?? 20_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const zone = opts.hostname.slice(opts.hostname.indexOf(".") + 1);
  const servers = await opts.resolver.servers(zone);
  if (servers.length === 0) throw new DnsNotVisible(`no authoritative servers found for ${zone}`);

  const deadline = now() + timeoutMs;
  const pending = new Set(servers);
  for (let round = 0; ; round++) {
    const answers = await Promise.all(
      [...pending].map(async (server): Promise<{ server: string; seen: Seen }> => {
        try {
          const { authoritative, records } = await opts.resolver.txt(server, opts.fqdn);
          if (!authoritative) return { server, seen: "not_authoritative" };
          return { server, seen: records.some((chunks) => chunks.join("") === opts.value) ? "yes" : "no" };
        } catch (e) {
          return { server, seen: (e as NodeJS.ErrnoException).code === "ETIMEOUT" ? "timeout" : "no" };
        }
      }),
    );
    if (round === 0 && answers.every((a) => a.seen === "timeout" || a.seen === "not_authoritative")) {
      await sleep(blindWaitMs);
      return;
    }
    // Asking again reaches the same stand-in, so a server behind one is left to the others.
    for (const a of answers) if (a.seen === "yes" || a.seen === "not_authoritative") pending.delete(a.server);
    if (pending.size === 0) return;
    if (now() + pollMs > deadline) {
      throw new DnsNotVisible(`${opts.fqdn} was not visible on ${[...pending].join(", ")} within ${timeoutMs / 1000}s`);
    }
    await sleep(pollMs);
  }
}
