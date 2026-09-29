/**
 * A stand-in for the remote-access service, on loopback in the test's process: the six endpoints a
 * node calls and the checks each request goes through, as docs/remote-access.md describes them,
 * answered in the shapes of ./contract. It holds everything in memory and signs relay credentials
 * with a key made at start. Controls let a test mint codes, deny a node, change what check-ins say,
 * inject any answer, and hold every answer back. For tests only.
 */
import {
  X509Certificate,
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { makeTestCert } from "../../testing/cert.js";
import { okpThumbprint } from "../keys.js";
import type { RelayEntry } from "../service-client.js";

const ID_ALPHABET = "0123456789bcdfghjkmnpqrstvwxz";
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const MAX_BODY_BYTES = 16384;
const NONCE_TTL_S = 300;

export interface FakeRemoteServiceOptions {
  /** The zone addresses are made under. Default `remote.stuga.test`. */
  zone?: string;
  acmeDirectory: string;
  /** The ACME profile check-ins name. Default none. */
  acmeProfile?: string | null;
  /** Seconds. Default 86400. */
  credentialTtl?: number;
  /** Seconds. Default 21600. */
  checkinInterval?: number;
  /** Default: one relay, `relay-1`, with a self-signed certificate made at start. */
  relays?: RelayEntry[];
  /** challtestsrv's management URL; without one, TXT records are only recorded. */
  challtestsrv?: string;
  /** Default 1. */
  minProtocol?: number;
  /** Epoch milliseconds. */
  now?: () => number;
}

export interface FakeRequest {
  path: string;
  /** Unix seconds. */
  at: number;
  status: number;
  /** The payload's keys, and `iss` when there is one: enough to tell requests apart, nothing secret. */
  keys: string[];
  iss?: string;
}

export interface FakeCredential {
  credential: string;
  sub: string;
  iat: number;
  exp: number;
}

export interface FakeRemoteService {
  /** The service's origin, which it also names as `api`. */
  url: string;
  zone: string;
  /** Verifies every credential it issues. */
  signingPublicKey: KeyObject;
  mintCode(kind: "enroll" | "rebind", nodeId?: string): string;
  deny(id: string, opts: { reason: "abuse" | "unpaid" | "compromised" | "other"; notBefore?: number; expiresAt?: number }): void;
  undeny(id: string): void;
  retire(id: string): void;
  /** Answer the next `times` requests to `path` (or "*" for any) with this, before any check. */
  failNext(path: string, status: number, body: Record<string, unknown>, times?: number): void;
  clearFailures(): void;
  setMinProtocol(n: number): void;
  /** Unix seconds, or null. */
  setReissueBefore(t: number | null): void;
  setAcmeDirectory(url: string): void;
  setCredentialTtl(seconds: number): void;
  setCheckinInterval(seconds: number): void;
  /** The relays check-ins name from now on. */
  setRelays(relays: RelayEntry[]): void;
  /** Hold every answer until `resume`. */
  pause(): void;
  resume(): void;
  /** The thumbprints of a node's keys, revoked ones included. */
  keysOf(id: string): Array<{ thumbprint: string; revoked: boolean }>;
  requests: FakeRequest[];
  txtWrites: Array<{ fqdn: string; value: string; at: number }>;
  /** What each challenge name holds now; a cleanup deletes it. */
  txtRecords: Map<string, string>;
  issuedCredentials: FakeCredential[];
  close(): Promise<void>;
}

interface NodeRecord {
  status: "active" | "retired";
}

interface KeyRecord {
  nodeId: string;
  x: string;
  revoked: boolean;
}

interface CodeRecord {
  kind: "enroll" | "rebind";
  nodeId: string | null;
  expiresAt: number;
  usedBy: string | null;
}

interface Deny {
  reason: string;
  notBefore: number | null;
  expiresAt: number | null;
}

class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const b64u = (data: Buffer | string): string => Buffer.from(data).toString("base64url");
const sha256hex = (s: string): string => createHash("sha256").update(s).digest("hex");

/** Crockford base32: spaces and dashes dropped, upper case, O as 0, I and L as 1. */
export function normalizeCode(code: string): string | null {
  const c = code.replace(/[\s-]/g, "").toUpperCase().replace(/O/g, "0").replace(/[IL]/g, "1");
  return /^[0-9A-HJKMNP-TV-Z]{16}$/.test(c) ? c : null;
}

function newCode(): string {
  const bytes = randomBytes(10);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD[(value >>> bits) & 31];
    }
    value &= (1 << bits) - 1;
  }
  return out.match(/.{4}/g)!.join("-");
}

function newId(): string {
  let id = "";
  while (id.length < 6) {
    const b = randomBytes(1)[0]!;
    if (b < 232) id += ID_ALPHABET[b % 29];
  }
  return id;
}

async function challtest(base: string | undefined, path: string, body: Record<string, string>): Promise<void> {
  if (!base) return;
  const res = await fetch(`${base}${path}`, { method: "POST", body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`challtestsrv ${path}: ${res.status}`);
}

export async function startFakeRemoteService(opts: FakeRemoteServiceOptions): Promise<FakeRemoteService> {
  const zone = opts.zone ?? "remote.stuga.test";
  const now = () => Math.floor((opts.now ?? Date.now)() / 1000);
  let acmeDirectory = opts.acmeDirectory;
  const acmeProfile = opts.acmeProfile ?? null;
  let credentialTtl = opts.credentialTtl ?? 86_400;
  let checkinInterval = opts.checkinInterval ?? 21_600;
  let minProtocol = opts.minProtocol ?? 1;
  let reissueBefore: number | null = null;
  let relays: RelayEntry[] = opts.relays ?? [
    {
      name: "relay-1",
      addr: `relay-1.${zone}`,
      port: 7000,
      server_name: `relay-1.${zone}`,
      ca_pem: makeTestCert({ dnsNames: [`relay-1.${zone}`] }).cert,
    },
  ];
  const signing = generateKeyPairSync("ed25519");
  const signingX = (signing.publicKey.export({ format: "jwk" }) as { x: string }).x;
  const signingKid = okpThumbprint(signingX);

  const nodes = new Map<string, NodeRecord>();
  const keys = new Map<string, KeyRecord>();
  const codes = new Map<string, CodeRecord>();
  const denies = new Map<string, Deny>();
  const nonces = new Map<string, { id: string; expiresAt: number; used: boolean }>();
  const failures: Array<{ path: string; status: number; body: Record<string, unknown>; times: number }> = [];
  let paused = false;
  let held: Array<() => void> = [];

  const requests: FakeRequest[] = [];
  const txtWrites: FakeRemoteService["txtWrites"] = [];
  const txtRecords = new Map<string, string>();
  const issuedCredentials: FakeCredential[] = [];
  let origin = "";

  const activeDeny = (id: string): Deny | null => {
    const d = denies.get(id);
    if (!d) return null;
    return d.expiresAt === null || d.expiresAt > now() ? d : null;
  };

  const hostnameOf = (id: string) => `${id}.${zone}`;

  const bindingAnswer = (id: string) => ({ id, hostname: hostnameOf(id), zone, api: origin });

  /** The checks of the protocol, in order; returns the payload, the key's node, and the key. */
  function authenticate(
    path: string,
    contentType: string | undefined,
    body: string,
  ): { payload: Record<string, unknown>; nodeId: string | null; thumbprint: string; x: string } {
    const bare = path === "/v1/enroll" || path === "/v1/rebind";
    if (contentType !== "application/jose" || Buffer.byteLength(body) > MAX_BODY_BYTES) {
      throw new Refusal(400, "bad_request", "The request is not a signed request.");
    }
    const parts = body.split(".");
    if (parts.length !== 3) throw new Refusal(400, "bad_request", "The request is not a compact JWS.");
    let header: Record<string, unknown>;
    let payload: Record<string, unknown>;
    try {
      header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")) as Record<string, unknown>;
    } catch {
      throw new Refusal(400, "bad_request", "The header is not JSON.");
    }
    if (header.alg !== "EdDSA" || header.typ !== "stuga-node+jwt") throw new Refusal(400, "bad_request", "Wrong alg or typ.");
    if (bare ? !header.jwk || "kid" in header : !header.kid || "jwk" in header) throw new Refusal(400, "bad_request", "Wrong key header.");
    try {
      payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
    } catch {
      throw new Refusal(400, "bad_request", "The payload is not JSON.");
    }
    if (payload === null || typeof payload !== "object" || !Number.isInteger(payload.pv)) {
      throw new Refusal(400, "bad_request", "The payload has no protocol version.");
    }
    if ((payload.pv as number) < minProtocol) {
      throw new Refusal(426, "upgrade_required", "Update Stuga to use remote access.", { min_protocol: minProtocol });
    }
    const t = now();
    const { iat, exp } = payload as { iat?: unknown; exp?: unknown };
    if (!Number.isInteger(iat) || !Number.isInteger(exp)) throw new Refusal(400, "bad_request", "The request's iat and exp must be integers.");
    const iatN = iat as number;
    const expN = exp as number;
    if (!(expN > t && iatN <= t + 60 && expN - iatN > 0 && expN - iatN <= 60)) {
      throw new Refusal(401, "stale_request", "The request's time is outside the allowed window.");
    }
    let x: string;
    let nodeId: string | null = null;
    let thumbprint: string;
    if (bare) {
      const jwk = header.jwk as Record<string, unknown>;
      if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string" || Buffer.from(jwk.x, "base64url").length !== 32) {
        throw new Refusal(401, "unknown_key", "The key is not an Ed25519 key.");
      }
      x = jwk.x;
      thumbprint = okpThumbprint(x);
    } else {
      thumbprint = String(header.kid);
      const key = keys.get(thumbprint);
      if (!key || key.revoked || !nodes.has(key.nodeId)) throw new Refusal(401, "unknown_key", "This key is not known.");
      x = key.x;
      nodeId = key.nodeId;
    }
    const publicKey = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" });
    if (!verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, Buffer.from(parts[2]!, "base64url"))) {
      throw new Refusal(401, "bad_signature", "The signature does not verify.");
    }
    if (payload.aud !== `${origin}${path}`) throw new Refusal(400, "bad_request", "The audience is not this endpoint.");
    if (!bare) {
      if (payload.iss !== nodeId) throw new Refusal(400, "bad_request", "The issuer is not this key's node.");
      if (nodes.get(nodeId!)!.status === "retired") throw new Refusal(403, "node_retired", "This address is retired.");
      const deny = activeDeny(nodeId!);
      if (deny && deny.notBefore === null) {
        throw new Refusal(403, "node_denied", "Remote access is off for this address.", { reason: deny.reason });
      }
    }
    return { payload, nodeId, thumbprint, x };
  }

  function claimCode(raw: unknown, kind: "enroll" | "rebind", thumbprint: string): { record: CodeRecord; fresh: boolean } {
    const normalized = typeof raw === "string" ? normalizeCode(raw) : null;
    const record = normalized ? codes.get(sha256hex(normalized)) : undefined;
    if (!record) throw new Refusal(404, "enroll_code_invalid", "That code isn't valid.");
    if (record.kind !== kind) throw new Refusal(409, "enroll_code_wrong_kind", "That code is for the other endpoint.");
    if (record.usedBy !== null) {
      if (record.usedBy !== thumbprint) throw new Refusal(409, "enroll_code_used", "That code has already been used.");
      return { record, fresh: false };
    }
    if (record.expiresAt <= now()) throw new Refusal(410, "enroll_code_expired", "That code has expired.");
    record.usedBy = thumbprint;
    return { record, fresh: true };
  }

  function handle(path: string, auth: ReturnType<typeof authenticate>): { status: number; body: unknown } {
    const { payload, nodeId, thumbprint, x } = auth;
    switch (path) {
      case "/v1/enroll": {
        const { record, fresh } = claimCode(payload.code, "enroll", thumbprint);
        if (!fresh && record.nodeId) return { status: 200, body: bindingAnswer(record.nodeId) };
        let id = newId();
        while (nodes.has(id)) id = newId();
        nodes.set(id, { status: "active" });
        keys.set(thumbprint, { nodeId: id, x, revoked: false });
        record.nodeId = id;
        return { status: 201, body: bindingAnswer(id) };
      }
      case "/v1/rebind": {
        const { record } = claimCode(payload.code, "rebind", thumbprint);
        const id = record.nodeId!;
        if (nodes.get(id)?.status === "retired") throw new Refusal(403, "node_retired", "This address is retired.");
        if (!keys.has(thumbprint)) {
          for (const key of keys.values()) if (key.nodeId === id) key.revoked = true;
          keys.set(thumbprint, { nodeId: id, x, revoked: false });
        }
        return { status: 200, body: bindingAnswer(id) };
      }
      case "/v1/checkin": {
        const nonce = b64u(randomBytes(32));
        nonces.set(nonce, { id: nodeId!, expiresAt: now() + NONCE_TTL_S, used: false });
        const deny = activeDeny(nodeId!);
        return {
          status: 200,
          body: {
            node: { id: nodeId!, hostname: hostnameOf(nodeId!) },
            api: origin,
            nonce,
            nonce_expires_at: now() + NONCE_TTL_S,
            next_checkin_at: now() + checkinInterval,
            credential_ttl: credentialTtl,
            credential_not_before: deny?.notBefore ?? null,
            relays,
            acme: { directory: acmeDirectory, profile: acmeProfile, reissue_before: reissueBefore },
          },
        };
      }
      case "/v1/acme/txt": {
        if (typeof payload.value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(payload.value)) {
          throw new Refusal(400, "bad_request", "The TXT value is not a key authorization digest.");
        }
        return { status: 200, body: { fqdn: `_acme-challenge.${hostnameOf(nodeId!)}`, value: payload.value } };
      }
      case "/v1/acme/txt/cleanup":
        return { status: 200, body: { remaining: 0, fqdn: `_acme-challenge.${hostnameOf(nodeId!)}` } };
      case "/v1/relay-credential":
        return { status: 200, body: issueCredential(nodeId!, payload) };
      default:
        throw new Refusal(404, "not_found", "No such endpoint.");
    }
  }

  function issueCredential(id: string, payload: Record<string, unknown>): unknown {
    const entry = typeof payload.nonce === "string" ? nonces.get(payload.nonce) : undefined;
    if (!entry || entry.used || entry.id !== id || entry.expiresAt <= now()) throw new Refusal(409, "nonce_invalid", "The nonce is not valid.");
    entry.used = true;
    let leaf: X509Certificate;
    try {
      leaf = new X509Certificate(String(payload.certificate));
    } catch {
      throw new Refusal(422, "cert_invalid", "The certificate does not parse.");
    }
    const t = now();
    const key = leaf.publicKey;
    if (
      leaf.subjectAltName !== `DNS:${hostnameOf(id)}` ||
      new Date(leaf.validFrom).getTime() / 1000 > t + 300 ||
      new Date(leaf.validTo).getTime() / 1000 <= t ||
      key.asymmetricKeyType !== "ec" ||
      key.asymmetricKeyDetails?.namedCurve !== "prime256v1"
    ) {
      throw new Refusal(422, "cert_invalid", "The certificate is not this address's.");
    }
    const pop = Buffer.from(String(payload.pop), "base64url");
    const message = Buffer.from(`stuga-relay-pop:v1:${id}:${payload.nonce as string}`);
    if (!verify("sha256", message, { key, dsaEncoding: "ieee-p1363" }, pop)) {
      throw new Refusal(422, "pop_invalid", "The proof of possession does not verify.");
    }
    const header = { alg: "EdDSA", kid: signingKid, typ: "JWT" };
    const claims = { iss: origin, sub: id, aud: "relay", iat: t, exp: t + credentialTtl };
    const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(claims))}`;
    const credential = `${input}.${b64u(sign(null, Buffer.from(input), signing.privateKey))}`;
    issuedCredentials.push({ credential, sub: id, iat: t, exp: claims.exp });
    const u = Math.random() * 0.1 - 0.05;
    return { credential, issued_at: t, expires_at: claims.exp, refresh_at: t + Math.round((credentialTtl / 4) * (1 + u)) };
  }

  const errorBody = (status: number, code: string, message: string, extra: Record<string, unknown>) => ({
    error: code,
    message,
    ...extra,
    ...(status === 429 || status === 503 ? { retry_after: extra.retry_after ?? 60 } : {}),
    server_time: now(),
  });

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const answer = () => void respond(req, Buffer.concat(chunks).toString("utf8"), res);
      if (paused) held.push(answer);
      else answer();
    });
  });

  async function respond(req: http.IncomingMessage, body: string, res: http.ServerResponse): Promise<void> {
    const path = new URL(req.url ?? "/", origin).pathname;
    let status = 200;
    let out: unknown;
    const record: FakeRequest = { path, at: now(), status: 0, keys: [] };
    try {
      const payload = JSON.parse(Buffer.from(body.split(".")[1] ?? "", "base64url").toString("utf8") || "{}") as Record<string, unknown>;
      record.keys = Object.keys(payload).sort();
      if (typeof payload.iss === "string") record.iss = payload.iss;
    } catch {
      // Not a request anything could parse; recorded by its path alone.
    }
    requests.push(record);
    try {
      const injected = failures.find((f) => f.path === path || f.path === "*");
      if (injected) {
        injected.times -= 1;
        if (injected.times <= 0) failures.splice(failures.indexOf(injected), 1);
        throw new Refusal(injected.status, String(injected.body.error ?? "injected"), String(injected.body.message ?? "Injected."), injected.body);
      }
      if (req.method !== "POST") throw new Refusal(405, "method_not_allowed", "Use POST.");
      const auth = authenticate(path, req.headers["content-type"], body);
      const result = handle(path, auth);
      if (path === "/v1/acme/txt") {
        const { fqdn, value } = result.body as { fqdn: string; value: string };
        await challtest(opts.challtestsrv, "/set-txt", { host: `${fqdn}.`, value });
        txtWrites.push({ fqdn, value, at: now() });
        txtRecords.set(fqdn, value);
        result.body = { fqdn };
      } else if (path === "/v1/acme/txt/cleanup") {
        const { fqdn } = result.body as { fqdn: string };
        await challtest(opts.challtestsrv, "/clear-txt", { host: `${fqdn}.` });
        txtRecords.delete(fqdn);
        result.body = { remaining: 0 };
      }
      status = result.status;
      out = result.body;
    } catch (e) {
      if (!(e instanceof Refusal)) {
        status = 503;
        out = errorBody(503, "unavailable", (e as Error).message, {});
      } else {
        status = e.status;
        const { error: _e, message: _m, ...extra } = e.extra;
        out = errorBody(e.status, e.code, e.message, extra);
      }
    }
    record.status = status;
    const headers: Record<string, string> = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
    const retryAfter = (out as { retry_after?: unknown }).retry_after;
    if (typeof retryAfter === "number") headers["retry-after"] = String(retryAfter);
    res.writeHead(status, headers);
    res.end(JSON.stringify(out));
  }

  function resume(): void {
    paused = false;
    const waiting = held;
    held = [];
    for (const answer of waiting) answer();
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url: origin,
    zone,
    signingPublicKey: signing.publicKey,
    mintCode(kind, nodeId) {
      if (kind === "rebind" && !nodeId) throw new Error("a restore code names the node it restores");
      const code = newCode();
      codes.set(sha256hex(normalizeCode(code)!), { kind, nodeId: nodeId ?? null, expiresAt: now() + 14 * 86_400, usedBy: null });
      return code;
    },
    deny(id, d) {
      denies.set(id, { reason: d.reason, notBefore: d.notBefore ?? null, expiresAt: d.expiresAt ?? null });
    },
    undeny(id) {
      denies.delete(id);
    },
    retire(id) {
      const node = nodes.get(id);
      if (node) node.status = "retired";
    },
    failNext(path, status, body, times = 1) {
      failures.push({ path, status, body, times });
    },
    clearFailures() {
      failures.length = 0;
    },
    setMinProtocol(n) {
      minProtocol = n;
    },
    setReissueBefore(t) {
      reissueBefore = t;
    },
    setAcmeDirectory(url) {
      acmeDirectory = url;
    },
    setCredentialTtl(seconds) {
      credentialTtl = seconds;
    },
    setCheckinInterval(seconds) {
      checkinInterval = seconds;
    },
    setRelays(next) {
      relays = next;
    },
    pause() {
      paused = true;
    },
    resume,
    keysOf(id) {
      return [...keys.entries()].filter(([, k]) => k.nodeId === id).map(([thumbprint, k]) => ({ thumbprint, revoked: k.revoked }));
    },
    requests,
    txtWrites,
    txtRecords,
    issuedCredentials,
    async close() {
      resume();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
