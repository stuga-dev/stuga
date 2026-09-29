/**
 * Before answering a dns-01 challenge, the node asks the zone's authoritative servers itself
 * whether the TXT record the service published is there yet: the service does not wait for it to
 * spread, and a CA that looks too early fails the authorization.
 */
import { promises as dns } from "node:dns";

export interface ChallengeResolver {
  /** The zone's authoritative servers, as addresses (ip, or ip:port). */
  servers(zone: string): Promise<string[]>;
  txt(server: string, fqdn: string): Promise<string[][]>;
}

const QUERY_TIMEOUT_MS = 2_000;

/** One query to one server, with no retry and no fallback to another. */
async function queryTxt(server: string, fqdn: string): Promise<string[][]> {
  const resolver = new dns.Resolver({ timeout: QUERY_TIMEOUT_MS, tries: 1 });
  resolver.setServers([server]);
  return resolver.resolveTxt(fqdn);
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
    txt: queryTxt,
  };
}

/** Tests: these servers stand for the zone's, such as Pebble's challtestsrv. */
export function fixedChallengeResolver(servers: string[]): ChallengeResolver {
  return { servers: async () => [...servers], txt: queryTxt };
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
  /** When every server's first answer timed out (UDP 53 blocked), wait this long and go on. */
  blindWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

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
      [...pending].map(async (server) => {
        try {
          const records = await opts.resolver.txt(server, opts.fqdn);
          return { server, seen: records.some((chunks) => chunks.join("") === opts.value), timedOut: false };
        } catch (e) {
          return { server, seen: false, timedOut: (e as NodeJS.ErrnoException).code === "ETIMEOUT" };
        }
      }),
    );
    if (round === 0 && answers.every((a) => a.timedOut)) {
      await sleep(blindWaitMs);
      return;
    }
    for (const a of answers) if (a.seen) pending.delete(a.server);
    if (pending.size === 0) return;
    if (now() + pollMs > deadline) {
      throw new DnsNotVisible(`${opts.fqdn} was not visible on ${[...pending].join(", ")} within ${timeoutMs / 1000}s`);
    }
    await sleep(pollMs);
  }
}
