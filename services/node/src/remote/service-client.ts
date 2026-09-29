/**
 * Requests to the remote-access service (docs/remote-access.md): each one a POST whose body is a
 * compact JWS the binding key signs, with the protocol version, the endpoint's own URL and a
 * one-minute window. A clock the service says is off is corrected once per request. Every failure
 * comes back as a ServiceError, a network error or a timeout as a 503.
 */
import { X509Certificate, sign } from "node:crypto";
import type { BindingKey } from "./keys.js";

/** The protocol this node speaks: `pv` in every request. */
export const PROTOCOL_VERSION = 1;

const REQUEST_TIMEOUT_MS = 20_000;
/** How long a request stays valid: `exp - iat`. */
const REQUEST_WINDOW_S = 60;

export const NODE_ID_RE = /^[0-9bcdfghjkmnpqrstvwxz]{6,12}$/;
const HOSTNAME_RE = /^[0-9bcdfghjkmnpqrstvwxz]{6,12}(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const RELAY_NAME_RE = /^[a-z0-9-]{1,32}$/;
const DNS_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const B64U_43_RE = /^[A-Za-z0-9_-]{43}$/;

export interface ServiceErrorDetail {
  /** Seconds, from `retry_after` or the Retry-After header. */
  retryAfter?: number;
  /** Why the service turned this address off (403 node_denied). */
  reason?: string;
  /** The service's clock, unix seconds. */
  serverTime?: number;
  /** The oldest protocol the service still speaks (426). */
  minProtocol?: number;
}

/** A refusal or a failure: the HTTP status, and the service's code (or ours, for no answer at all). */
export class ServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail: ServiceErrorDetail = {},
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

export interface EnrollAnswer {
  id: string;
  hostname: string;
  zone: string;
  /** Where every later request goes; null when the service named an origin this node refuses. */
  api: string | null;
}

export interface RelayEntry {
  name: string;
  addr: string;
  port: number;
  server_name: string;
  ca_pem: string;
}

export interface CheckinAnswer {
  node: { id: string; hostname: string };
  api: string | null;
  nonce: string;
  nonce_expires_at: number;
  next_checkin_at: number;
  credential_ttl: number;
  credential_not_before: number | null;
  relays: RelayEntry[];
  acme: { directory: string; profile: string | null; reissue_before: number | null };
}

export interface CredentialAnswer {
  credential: string;
  issued_at: number;
  expires_at: number;
  refresh_at: number;
}

export interface ServiceClientOptions {
  /** Epoch milliseconds; tests move it. */
  now?: () => number;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Bounds on one call, a retry for the clock included, beyond each request's own 20 seconds. */
export interface CallOptions {
  /** The whole call's budget, in milliseconds. */
  timeoutMs?: number;
  /** Stops the call, and anything it would still send. */
  signal?: AbortSignal;
}

export interface ServiceClient {
  enroll(base: string, key: BindingKey, code: string, call?: CallOptions): Promise<EnrollAnswer>;
  rebind(base: string, key: BindingKey, code: string, call?: CallOptions): Promise<EnrollAnswer>;
  checkin(api: string, key: BindingKey, id: string, call?: CallOptions): Promise<CheckinAnswer>;
  acmeTxt(api: string, key: BindingKey, id: string, value: string, call?: CallOptions): Promise<{ fqdn: string }>;
  acmeTxtCleanup(api: string, key: BindingKey, id: string, call?: CallOptions): Promise<{ remaining: number }>;
  relayCredential(
    api: string,
    key: BindingKey,
    id: string,
    proof: { nonce: string; certificate: string; pop: string },
    call?: CallOptions,
  ): Promise<CredentialAnswer>;
  /** The service's clock minus this one's, in seconds, as last learned. */
  clockOffset(): number;
}

const b64u = (data: string | Buffer): string => Buffer.from(data).toString("base64url");

/**
 * An origin the node will send its requests to: https, or http on loopback for a service a test
 * runs. Anything else is refused, so a compromised answer cannot point the node at plain HTTP.
 */
export function acceptableServiceOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
  return url.origin;
}

/** A CA directory URL: https, or http on loopback for a test's CA. */
function acceptableDirectory(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
    return url.protocol === "https:" || (url.protocol === "http:" && loopback) ? url.href : null;
  } catch {
    return null;
  }
}

/** Sign one request: `jwk` in the header for enroll and rebind, the key's thumbprint as `kid` otherwise. */
export function signServiceRequest(key: BindingKey, payload: Record<string, unknown>, embedKey: boolean): string {
  const header = embedKey
    ? { alg: "EdDSA", typ: "stuga-node+jwt", jwk: { kty: "OKP", crv: "Ed25519", x: key.x } }
    : { alg: "EdDSA", typ: "stuga-node+jwt", kid: key.thumbprint };
  const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
  return `${input}.${b64u(sign(null, Buffer.from(input), key.privateKey))}`;
}

export function createServiceClient(options: ServiceClientOptions = {}): ServiceClient {
  const now = options.now ?? Date.now;
  const fetchFn = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  let offset = 0;

  async function post(
    base: string,
    path: string,
    key: BindingKey,
    fields: Record<string, unknown>,
    iss: string | null,
    call: CallOptions = {},
  ): Promise<unknown> {
    const aud = `${base}${path}`;
    // Started once, so a second request for the clock spends what is left of the same budget.
    const bounds: AbortSignal[] = [];
    if (call.signal) bounds.push(call.signal);
    if (call.timeoutMs !== undefined) bounds.push(AbortSignal.timeout(Math.max(0, Math.floor(call.timeoutMs))));
    const attempt = async (): Promise<{ status: number; headers: Headers; body: unknown }> => {
      const iat = Math.floor(now() / 1000) + offset;
      const payload = { pv: PROTOCOL_VERSION, ...(iss ? { iss } : {}), aud, iat, exp: iat + REQUEST_WINDOW_S, ...fields };
      let res: Response;
      try {
        res = await fetchFn(aud, {
          method: "POST",
          headers: { "content-type": "application/jose" },
          body: signServiceRequest(key, payload, iss === null),
          signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...bounds]),
          redirect: "error",
        });
      } catch (e) {
        throw new ServiceError(503, "network", `the remote access service did not answer: ${(e as Error).message}`);
      }
      const text = await res.text().catch(() => "");
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      return { status: res.status, headers: res.headers, body };
    };

    let answer = await attempt();
    if (answer.status === 401 && errorCode(answer.body) === "stale_request") {
      const serverTime = numberField(answer.body, "server_time");
      if (serverTime !== undefined) {
        offset = serverTime - Math.floor(now() / 1000);
        answer = await attempt();
      }
      // Still outside the window: the clocks cannot be squared, which is as good as no answer.
      if (answer.status === 401 && errorCode(answer.body) === "stale_request") {
        throw new ServiceError(503, "stale_request", "the remote access service keeps rejecting this node's clock", detailOf(answer));
      }
    }
    if (answer.status >= 200 && answer.status < 300) return answer.body;
    throw new ServiceError(
      answer.status,
      errorCode(answer.body) ?? (answer.status >= 500 ? "unavailable" : "bad_request"),
      stringField(answer.body, "message") ?? `the remote access service answered ${answer.status}`,
      detailOf(answer),
    );
  }

  return {
    async enroll(base, key, code, call) {
      return parseEnroll(await post(base, "/v1/enroll", key, { code }, null, call));
    },
    async rebind(base, key, code, call) {
      return parseEnroll(await post(base, "/v1/rebind", key, { code }, null, call));
    },
    async checkin(api, key, id, call) {
      return parseCheckin(await post(api, "/v1/checkin", key, {}, id, call));
    },
    async acmeTxt(api, key, id, value, call) {
      const body = await post(api, "/v1/acme/txt", key, { value }, id, call);
      const fqdn = stringField(body, "fqdn");
      if (!fqdn) throw malformed("acme/txt");
      return { fqdn };
    },
    async acmeTxtCleanup(api, key, id, call) {
      const remaining = numberField(await post(api, "/v1/acme/txt/cleanup", key, {}, id, call), "remaining");
      if (remaining === undefined) throw malformed("acme/txt/cleanup");
      return { remaining };
    },
    async relayCredential(api, key, id, proof, call) {
      return parseCredential(await post(api, "/v1/relay-credential", key, { ...proof }, id, call));
    },
    clockOffset: () => offset,
  };
}

function detailOf(answer: { headers: Headers; body: unknown }): ServiceErrorDetail {
  const detail: ServiceErrorDetail = {};
  const header = Number(answer.headers.get("retry-after"));
  const retryAfter = numberField(answer.body, "retry_after") ?? (Number.isFinite(header) && header > 0 ? header : undefined);
  if (retryAfter !== undefined) detail.retryAfter = retryAfter;
  const reason = stringField(answer.body, "reason");
  if (reason) detail.reason = reason;
  const serverTime = numberField(answer.body, "server_time");
  if (serverTime !== undefined) detail.serverTime = serverTime;
  const minProtocol = numberField(answer.body, "min_protocol");
  if (minProtocol !== undefined) detail.minProtocol = minProtocol;
  return detail;
}

function field(body: unknown, name: string): unknown {
  return body !== null && typeof body === "object" ? (body as Record<string, unknown>)[name] : undefined;
}

function stringField(body: unknown, name: string): string | undefined {
  const v = field(body, name);
  return typeof v === "string" ? v : undefined;
}

function numberField(body: unknown, name: string): number | undefined {
  const v = field(body, name);
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function errorCode(body: unknown): string | undefined {
  const code = stringField(body, "error");
  return code && /^[a-z_]{1,64}$/.test(code) ? code : undefined;
}

/** An answer this node cannot use is treated like no answer. */
function malformed(what: string): ServiceError {
  return new ServiceError(502, "malformed", `the remote access service's answer to ${what} is not what this node expects`);
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);

export function parseEnroll(body: unknown): EnrollAnswer {
  const id = field(body, "id");
  const hostname = field(body, "hostname");
  const zone = field(body, "zone");
  if (typeof id !== "string" || !NODE_ID_RE.test(id)) throw malformed("enroll");
  if (typeof hostname !== "string" || !HOSTNAME_RE.test(hostname) || !hostname.startsWith(`${id}.`)) throw malformed("enroll");
  if (typeof zone !== "string" || hostname !== `${id}.${zone}`) throw malformed("enroll");
  return { id, hostname, zone, api: acceptableServiceOrigin(field(body, "api")) };
}

export function parseCheckin(body: unknown): CheckinAnswer {
  const node = field(body, "node");
  const id = field(node, "id");
  const hostname = field(node, "hostname");
  if (typeof id !== "string" || !NODE_ID_RE.test(id)) throw malformed("checkin");
  if (typeof hostname !== "string" || !HOSTNAME_RE.test(hostname) || !hostname.startsWith(`${id}.`)) throw malformed("checkin");
  const nonce = field(body, "nonce");
  if (typeof nonce !== "string" || !B64U_43_RE.test(nonce)) throw malformed("checkin");
  const nonceExpiresAt = field(body, "nonce_expires_at");
  const next = field(body, "next_checkin_at");
  const ttl = field(body, "credential_ttl");
  const notBefore = field(body, "credential_not_before");
  if (!isInt(nonceExpiresAt) || !isInt(next) || !isInt(ttl) || ttl <= 0) throw malformed("checkin");
  if (notBefore !== null && !isInt(notBefore)) throw malformed("checkin");
  const relays = field(body, "relays");
  if (!Array.isArray(relays)) throw malformed("checkin");
  const acme = field(body, "acme");
  const directory = acceptableDirectory(field(acme, "directory"));
  const profile = field(acme, "profile");
  const reissueBefore = field(acme, "reissue_before");
  if (!directory) throw malformed("checkin");
  if (profile !== null && (typeof profile !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(profile))) throw malformed("checkin");
  if (reissueBefore !== null && !isInt(reissueBefore)) throw malformed("checkin");
  return {
    node: { id, hostname },
    api: acceptableServiceOrigin(field(body, "api")),
    nonce,
    nonce_expires_at: nonceExpiresAt,
    next_checkin_at: next,
    credential_ttl: ttl,
    credential_not_before: notBefore,
    relays: relays.map(parseRelay),
    acme: { directory, profile, reissue_before: reissueBefore },
  };
}

/** A relay, checked hard: its name becomes file names and its fields go into the connector's config. */
function parseRelay(relay: unknown): RelayEntry {
  const name = field(relay, "name");
  const addr = field(relay, "addr");
  const port = field(relay, "port");
  const serverName = field(relay, "server_name");
  const caPem = field(relay, "ca_pem");
  if (typeof name !== "string" || !RELAY_NAME_RE.test(name)) throw malformed("checkin");
  if (typeof addr !== "string" || !DNS_NAME_RE.test(addr)) throw malformed("checkin");
  if (!isInt(port) || port < 1 || port > 65535) throw malformed("checkin");
  if (typeof serverName !== "string" || !DNS_NAME_RE.test(serverName)) throw malformed("checkin");
  if (typeof caPem !== "string") throw malformed("checkin");
  const blocks = caPem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  if (blocks.length < 1 || blocks.length > 2) throw malformed("checkin");
  try {
    for (const block of blocks) new X509Certificate(block);
  } catch {
    throw malformed("checkin");
  }
  return { name, addr, port, server_name: serverName, ca_pem: `${blocks.join("\n")}\n` };
}

export function parseCredential(body: unknown): CredentialAnswer {
  const credential = field(body, "credential");
  const issuedAt = field(body, "issued_at");
  const expiresAt = field(body, "expires_at");
  const refreshAt = field(body, "refresh_at");
  if (typeof credential !== "string" || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(credential)) {
    throw malformed("relay-credential");
  }
  if (!isInt(issuedAt) || !isInt(expiresAt) || !isInt(refreshAt) || expiresAt <= issuedAt) throw malformed("relay-credential");
  return { credential, issued_at: issuedAt, expires_at: expiresAt, refresh_at: refreshAt };
}
