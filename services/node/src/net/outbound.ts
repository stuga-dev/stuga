/**
 * Requests to a URL someone else chose: an agent's image or file by URL, a webhook delivery, an
 * app's client metadata document. Every connection is checked as it is made: a name is resolved
 * once, every answer is checked, and the socket goes only to an address that passed, so a name that
 * answers differently the second time (DNS rebinding) gets nowhere. An IP literal is checked before
 * any socket opens. Host, SNI and the certificate check keep the URL's own name.
 *
 * Everything else the node fetches (AI providers, sign-in, notifications, samples, updates, remote
 * access) uses plain fetch, where a private address is often the point. Never install this agent
 * globally.
 */
import { lookup as dnsLookup, type LookupAddress, type LookupAllOptions } from "node:dns";
import { lookup as resolveAll } from "node:dns/promises";
import { isIP, type LookupFunction, type TcpNetConnectOpts } from "node:net";
import type { ConnectionOptions } from "node:tls";
import { Agent, buildConnector, type Dispatcher } from "undici";
import { type ForbiddenReason, forbiddenReason, isRefusedName } from "./destination.js";

/** One wording for each refusal, so every surface says the same thing. */
const PRIVATE_ADDRESS_REFUSAL = "refusing to reach a private or loopback address";
const FAKE_IP_REFUSAL = "the name resolves into 198.18.0.0/15, where fake-IP proxies answer; give Stuga real DNS";

/** The node would not connect: the address, or the name, is one it must not reach. */
export class OutboundRefusedError extends Error {
  constructor(
    readonly reason: ForbiddenReason,
    readonly host: string,
    /** The address refused, for logs only; null when the name itself was. */
    readonly address: string | null,
  ) {
    super(reason === "fake-ip" ? FAKE_IP_REFUSAL : PRIVATE_ADDRESS_REFUSAL);
    this.name = "OutboundRefusedError";
  }
}

/** Why an outbound URL was refused, or the parsed URL when it is allowed. */
export type OutboundVerdict = { ok: true; url: URL } | { ok: false; reason: string };

/** The refusal for connecting to `host`, a name or an address as a URL or undici writes it. */
function refusalFor(host: string, forbidden: (ip: string) => ForbiddenReason | null): OutboundRefusedError | null {
  const plain = host.replace(/^\[|\]$/g, "");
  if (isIP(plain.replace(/%.*$/, "")) !== 0) {
    const reason = forbidden(plain);
    return reason ? new OutboundRefusedError(reason, host, plain) : null;
  }
  return isRefusedName(host) ? new OutboundRefusedError("private", host, null) : null;
}

/** The URL, or why it is refused before anything is sent: its scheme, a local name or an IP literal. */
function checkUrl(raw: string): URL | OutboundRefusedError | TypeError {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return new TypeError(`not a valid absolute URL: ${raw}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return new TypeError(`unsupported URL scheme "${url.protocol}" — use http(s)`);
  }
  return refusalFor(url.hostname, forbiddenReason) ?? url;
}

/** Parse one outbound URL and check what can be checked without DNS. */
export function parseOutboundUrl(raw: string): OutboundVerdict {
  const checked = checkUrl(raw);
  return checked instanceof URL ? { ok: true, url: checked } : { ok: false, reason: checked.message };
}

/**
 * parseOutboundUrl, then a look at where the name resolves now: for an early, plain refusal when a
 * webhook is registered. It proves nothing about later connections, which are checked on their own.
 */
export async function vetOutboundUrl(raw: string): Promise<OutboundVerdict> {
  const verdict = parseOutboundUrl(raw);
  if (!verdict.ok || isIP(verdict.url.hostname.replace(/^\[|\]$/g, "")) !== 0) return verdict;
  let answers: LookupAddress[];
  try {
    answers = await resolveAll(verdict.url.hostname, { all: true });
  } catch {
    return { ok: false, reason: `could not resolve "${verdict.url.hostname}"` };
  }
  if (answers.length === 0) return { ok: false, reason: `could not resolve "${verdict.url.hostname}"` };
  for (const answer of answers) {
    const reason = forbiddenReason(answer.address);
    if (reason) return { ok: false, reason: new OutboundRefusedError(reason, verdict.url.hostname, answer.address).message };
  }
  return verdict;
}

/** dns.lookup as the agent calls it: always for every answer. */
type LookupAll = (hostname: string, options: LookupAllOptions, callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => void;

export interface OutboundAgentOptions {
  /** Tests: answers in place of DNS, a policy in place of the address rule, and socket options such as `ca`. */
  lookup?: LookupAll;
  forbidden?: (ip: string) => ForbiddenReason | null;
  connect?: ConnectionOptions & Pick<TcpNetConnectOpts, "autoSelectFamily">;
}

/** How long a connection is waited for, and how long an idle one is kept. */
const CONNECT_TIMEOUT_MS = 10_000;
const KEEP_ALIVE_MAX_MS = 60_000;

/** An undici agent whose every new connection is checked where it is made. */
export function createOutboundAgent(options: OutboundAgentOptions = {}): Agent {
  const lookup = options.lookup ?? dnsLookup;
  const forbidden = options.forbidden ?? forbiddenReason;

  // net.connect's own lookup: resolve once, refuse the whole answer if any address in it is
  // forbidden, and hand back exactly what was checked. Every answer, so Happy Eyeballs still works.
  const vettedLookup: LookupFunction = (hostname, lookupOptions, callback) => {
    lookup(hostname, { ...lookupOptions, all: true }, (err, answers) => {
      if (err) return callback(err, "", 0);
      if (answers.length === 0) return callback(Object.assign(new Error(`could not resolve "${hostname}"`), { code: "ENOTFOUND" }), "", 0);
      for (const answer of answers) {
        const reason = forbidden(answer.address);
        if (reason) return callback(new OutboundRefusedError(reason, hostname, answer.address), "", 0);
      }
      if (lookupOptions.all) return callback(null, answers);
      callback(null, answers[0]!.address, answers[0]!.family);
    });
  };
  const connector = buildConnector({ ...options.connect, lookup: vettedLookup, timeout: CONNECT_TIMEOUT_MS });

  return new Agent({
    keepAliveMaxTimeout: KEEP_ALIVE_MAX_MS,
    connect(opts, callback) {
      // net.connect never calls lookup for an IP literal, so a literal is checked here.
      const refused = refusalFor(opts.hostname, forbidden);
      if (refused) return callback(refused, null);
      connector(opts, callback);
    },
  });
}

let shared: Agent | undefined;

/**
 * fetch through the checked agent. A redirect is never followed, and a refusal throws
 * OutboundRefusedError rather than fetch's "fetch failed". The agent also keeps any proxy the
 * environment names out of the way: a proxy would resolve the name itself. `agent` is for tests.
 */
export async function outboundFetch(url: string | URL, init: RequestInit = {}, agent?: Dispatcher): Promise<Response> {
  const checked = checkUrl(String(url));
  if (!(checked instanceof URL)) throw checked;
  const dispatcher = agent ?? (shared ??= createOutboundAgent());
  try {
    // Looked up when called, so a test that stubs fetch still sees the call.
    return await globalThis.fetch(url, { ...init, redirect: "manual", dispatcher } as RequestInit);
  } catch (e) {
    if (e instanceof TypeError && e.cause instanceof OutboundRefusedError) throw e.cause;
    throw e;
  }
}
