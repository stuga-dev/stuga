/**
 * An ACME client (RFC 8555) for one certificate with one DNS name, dns-01 only, on node:crypto
 * alone. Requests are JWS signed ES256 by the account key (r||s signatures); every answer's
 * Replay-Nonce is kept for the next request, and a badNonce is signed again with the nonce the
 * refusal carried, never resent as it was.
 */
import { createHash, createPublicKey, sign, type KeyObject } from "node:crypto";
import { csrDer, pemBlocks } from "./der.js";
import type { AcmeResponse, AcmeTransport } from "./transport.js";

export const ACME_ERROR_PREFIX = "urn:ietf:params:acme:error:";

/** A problem document (RFC 7807) from the CA, or a failure of the protocol shaped like one. */
export class AcmeError extends Error {
  constructor(
    /** `urn:ietf:params:acme:error:*`, or "" when the CA sent no type. */
    readonly type: string,
    readonly status: number,
    readonly detail: string,
    /** Seconds, from Retry-After. */
    readonly retryAfter?: number,
    /** An authorization the CA would not grant, as opposed to a request it refused. */
    readonly authorization = false,
  ) {
    super(`${type.replace(ACME_ERROR_PREFIX, "") || "error"} (${status}): ${detail}`);
    this.name = "AcmeError";
  }

  /** Whether this is `urn:ietf:params:acme:error:<short>`. */
  is(short: string): boolean {
    return this.type === ACME_ERROR_PREFIX + short;
  }
}

export interface AcmeDirectory {
  newNonce: string;
  newAccount: string;
  newOrder: string;
  meta?: { termsOfService?: string; profiles?: Record<string, unknown> };
}

interface Problem {
  type?: string;
  detail?: string;
}

export interface AcmeOrder {
  status: "pending" | "ready" | "processing" | "valid" | "invalid";
  authorizations: string[];
  finalize: string;
  certificate?: string;
  error?: Problem;
}

interface AcmeChallenge {
  type: string;
  url: string;
  token: string;
  status: string;
  error?: Problem;
}

interface AcmeAuthorization {
  status: string;
  identifier: { type: string; value: string };
  challenges: AcmeChallenge[];
}

export interface AcmeClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const realClock: AcmeClock = { now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

/** Retries of one request refused for its nonce, each signed afresh. */
const BAD_NONCE_RETRIES = 3;
/** How long to wait on an authorization, and on an order, before giving up. */
const POLL_DEADLINE_MS = 90_000;
/** Between polls when the CA names no Retry-After. */
const DEFAULT_POLL_MS = 2_000;

const b64u = (data: string | Buffer): string => Buffer.from(data).toString("base64url");

/** Retry-After as delay-seconds or an HTTP date (RFC 9110 §10.2.3), in seconds. */
export function retryAfterSeconds(headers: Headers, now = Date.now()): number | undefined {
  const value = headers.get("retry-after");
  if (!value) return undefined;
  if (/^\d+$/.test(value.trim())) return Number(value.trim());
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - now) / 1000));
}

function parseJson<T>(res: AcmeResponse): T {
  try {
    return JSON.parse(Buffer.from(res.body).toString("utf8")) as T;
  } catch {
    throw new AcmeError("", res.status, "the CA's answer is not JSON");
  }
}

function problemOf(res: AcmeResponse, now: number): AcmeError {
  let problem: Problem = {};
  try {
    problem = JSON.parse(Buffer.from(res.body).toString("utf8")) as Problem;
  } catch {
    // A body that is not a problem document says no more than the status does.
  }
  return new AcmeError(
    typeof problem.type === "string" ? problem.type : "",
    res.status,
    typeof problem.detail === "string" ? problem.detail : `HTTP ${res.status}`,
    retryAfterSeconds(res.headers, now),
  );
}

/** The directory, with any member this client does not use ignored. */
export async function fetchDirectory(transport: AcmeTransport, url: string): Promise<AcmeDirectory> {
  const res = await transport.request(url, { method: "GET", headers: { accept: "application/json" } });
  if (res.status !== 200) throw problemOf(res, Date.now());
  const dir = parseJson<Partial<AcmeDirectory>>(res);
  for (const name of ["newNonce", "newAccount", "newOrder"] as const) {
    if (typeof dir[name] !== "string") throw new AcmeError("", res.status, `the directory has no ${name}`);
  }
  return dir as AcmeDirectory;
}

export interface AcmeClientOptions {
  transport: AcmeTransport;
  directory: AcmeDirectory;
  /** P-256. */
  accountKey: KeyObject;
  /** The account's URL (its `kid`) when it already exists. */
  accountUrl?: string | null;
  clock?: AcmeClock;
}

export class AcmeClient {
  readonly directory: AcmeDirectory;
  readonly #transport: AcmeTransport;
  readonly #key: KeyObject;
  readonly #jwk: { crv: string; kty: string; x: string; y: string };
  readonly #clock: AcmeClock;
  #accountUrl: string | null;
  #nonces: string[] = [];

  constructor(opts: AcmeClientOptions) {
    this.directory = opts.directory;
    this.#transport = opts.transport;
    this.#key = opts.accountKey;
    this.#accountUrl = opts.accountUrl ?? null;
    this.#clock = opts.clock ?? realClock;
    const { crv, x, y } = createPublicKey(opts.accountKey).export({ format: "jwk" }) as Record<string, string>;
    this.#jwk = { crv: crv!, kty: "EC", x: x!, y: y! };
  }

  get accountUrl(): string | null {
    return this.#accountUrl;
  }

  /** RFC 7638 over the account key: the second half of every key authorization. */
  thumbprint(): string {
    const { crv, kty, x, y } = this.#jwk;
    return b64u(createHash("sha256").update(JSON.stringify({ crv, kty, x, y })).digest());
  }

  /** The TXT value dns-01 wants for `token` (RFC 8555 §8.4). */
  dnsValue(token: string): string {
    return b64u(createHash("sha256").update(`${token}.${this.thumbprint()}`).digest());
  }

  async #nonce(): Promise<string> {
    const pooled = this.#nonces.pop();
    if (pooled) return pooled;
    const res = await this.#transport.request(this.directory.newNonce, { method: "HEAD" });
    const nonce = res.headers.get("replay-nonce");
    if (!nonce) throw new AcmeError("", res.status, "the CA gave no nonce");
    return nonce;
  }

  #keep(res: AcmeResponse): void {
    const nonce = res.headers.get("replay-nonce");
    if (nonce) this.#nonces.push(nonce);
  }

  /** A flattened JWS; a null payload is POST-as-GET, whose payload is the empty string. */
  #jws(url: string, nonce: string, payload: unknown, embedKey: boolean): string {
    const header = { alg: "ES256", nonce, url, ...(embedKey ? { jwk: this.#jwk } : { kid: this.#accountUrl }) };
    const protectedPart = b64u(JSON.stringify(header));
    const payloadPart = payload === null ? "" : b64u(JSON.stringify(payload));
    const signature = sign("sha256", Buffer.from(`${protectedPart}.${payloadPart}`), { key: this.#key, dsaEncoding: "ieee-p1363" });
    return JSON.stringify({ protected: protectedPart, payload: payloadPart, signature: b64u(signature) });
  }

  /** A signed POST; badNonce is signed again with a fresh nonce up to three times, any other error throws. */
  async post(url: string, payload: unknown, opts: { embedKey?: boolean; accept?: string } = {}): Promise<AcmeResponse> {
    if (!opts.embedKey && !this.#accountUrl) throw new Error("the ACME client has no account");
    for (let attempt = 0; ; attempt++) {
      const res = await this.#transport.request(url, {
        method: "POST",
        body: this.#jws(url, await this.#nonce(), payload, opts.embedKey ?? false),
        headers: { "content-type": "application/jose+json", ...(opts.accept ? { accept: opts.accept } : {}) },
      });
      this.#keep(res);
      if (res.status >= 200 && res.status < 300) return res;
      const error = problemOf(res, this.#clock.now());
      if (error.is("badNonce") && attempt < BAD_NONCE_RETRIES) continue;
      throw error;
    }
  }

  /** Find or create the account for this key, agreeing to the CA's terms; returns its URL. */
  async ensureAccount(): Promise<string> {
    if (this.#accountUrl) return this.#accountUrl;
    const res = await this.post(this.directory.newAccount, { termsOfServiceAgreed: true }, { embedKey: true });
    const url = res.headers.get("location");
    if (!url) throw new AcmeError("", res.status, "the CA created an account without saying where");
    this.#accountUrl = url;
    return url;
  }

  async #get<T>(url: string): Promise<{ body: T; res: AcmeResponse }> {
    const res = await this.post(url, null);
    return { body: parseJson<T>(res), res };
  }

  async #poll<T extends { status: string }>(url: string, done: (status: string) => boolean): Promise<T> {
    const deadline = this.#clock.now() + POLL_DEADLINE_MS;
    for (;;) {
      const { body, res } = await this.#get<T>(url);
      if (done(body.status)) return body;
      const wait = Math.min((retryAfterSeconds(res.headers, this.#clock.now()) ?? DEFAULT_POLL_MS / 1000) * 1000, 30_000);
      if (this.#clock.now() + wait > deadline) {
        throw new AcmeError("", 0, `${url} was still ${body.status} after ${POLL_DEADLINE_MS / 1000}s`);
      }
      await this.#clock.sleep(wait);
    }
  }

  /**
   * One certificate for `hostname` on `key`: order, prove control through `dns`, finalize, download.
   * The TXT record `dns.present` put up is taken down however the order ends. Returns
   * the chain, leaf first.
   */
  async issue(args: {
    hostname: string;
    key: KeyObject;
    profile?: string | null;
    dns: { present(value: string): Promise<void>; verify(value: string): Promise<void>; cleanup(): Promise<void> };
  }): Promise<string> {
    const payload: Record<string, unknown> = { identifiers: [{ type: "dns", value: args.hostname }] };
    if (args.profile && this.directory.meta?.profiles && args.profile in this.directory.meta.profiles) payload.profile = args.profile;
    const created = await this.post(this.directory.newOrder, payload);
    const orderUrl = created.headers.get("location");
    if (!orderUrl) throw new AcmeError("", created.status, "the CA created an order without saying where");
    let order = parseJson<AcmeOrder>(created);

    let presented = false;
    try {
      for (const authzUrl of order.authorizations) {
        const { body: authz } = await this.#get<AcmeAuthorization>(authzUrl);
        if (authz.status === "valid") continue;
        const challenge = authz.challenges.find((c) => c.type === "dns-01");
        if (!challenge) throw new AcmeError("", 0, `the CA offers no dns-01 challenge for ${authz.identifier.value}`, undefined, true);
        const value = this.dnsValue(challenge.token);
        presented = true;
        await args.dns.present(value);
        await args.dns.verify(value);
        await this.post(challenge.url, {});
        const done = await this.#poll<AcmeAuthorization>(authzUrl, (s) => s !== "pending");
        if (done.status !== "valid") {
          const problem = done.challenges.find((c) => c.type === "dns-01")?.error ?? {};
          throw new AcmeError(problem.type ?? "", 403, problem.detail ?? `the authorization is ${done.status}`, undefined, true);
        }
      }

      order = await this.#poll<AcmeOrder>(orderUrl, (s) => s !== "pending");
      if (order.status === "ready") {
        await this.post(order.finalize, { csr: b64u(csrDer(args.key, args.hostname)) });
        order = await this.#poll<AcmeOrder>(orderUrl, (s) => s !== "ready" && s !== "processing");
      }
      if (order.status !== "valid" || !order.certificate) {
        throw new AcmeError(order.error?.type ?? "", 0, order.error?.detail ?? `the order is ${order.status}`);
      }
      const res = await this.post(order.certificate, null, { accept: "application/pem-certificate-chain" });
      const chain = pemBlocks(Buffer.from(res.body).toString("utf8"), "CERTIFICATE");
      if (chain.length === 0) throw new AcmeError("", res.status, "the CA's certificate download holds no certificate");
      return chain.join("");
    } finally {
      // However the order ends; the service's sweeper takes down whatever this misses.
      if (presented) await args.dns.cleanup().catch(() => {});
    }
  }
}
