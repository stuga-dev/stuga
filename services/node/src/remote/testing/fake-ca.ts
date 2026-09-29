/**
 * An ACME CA in memory, as an AcmeTransport: one account, one order at a time, dns-01 only, and
 * renewal information (RFC 9773) for what it issued. Every leaf carries the CA's key identifier and
 * a serial with its high bit set, so its identifier keeps a leading zero byte. For tests only.
 */
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, verify, type KeyObject } from "node:crypto";
import { makeTestCert } from "../../testing/cert.js";
import { ariCertId } from "../acme/der.js";
import type { AcmeResponse, AcmeTransport } from "../acme/transport.js";

export const FAKE_CA = "https://ca.stuga.test";
export const FAKE_CA_DIRECTORY = `${FAKE_CA}/dir`;

export interface FakeCaOptions {
  /** Signed requests refused for their nonce first. */
  badNonces?: number;
  /** Times an authorization answers pending once its challenge is answered. Default 1. */
  authzPolls?: number;
  failAuthz?: boolean;
  failCert?: boolean;
  /** Retry-After on an authorization. */
  retryAfter?: string;
  /** Default true. */
  renewalInfo?: boolean;
  /** Each leaf's life. Default a day. */
  lifetimeMs?: number;
}

export interface FakeCaPosted {
  url: string;
  body: string;
  header: { alg: string; nonce: string; url: string; kid?: string; jwk?: Record<string, string> };
  payload: string;
  signature: Buffer;
}

/** What the CA answers for renewal information: a window, a status with a body, or both. */
export interface FakeAri {
  status?: number;
  window?: { start: Date; end: Date };
  body?: string;
  /** Retry-After as sent; none when absent. */
  retryAfter?: string;
}

/** Just enough DER to take the public key out of a PKCS#10 request: its info's third element. */
function csrPublicKey(der: Buffer): KeyObject {
  const read = (buf: Buffer, at: number) => {
    let len = buf[at + 1]!;
    let start = at + 2;
    if (len & 0x80) {
      const n = len & 0x7f;
      len = 0;
      for (let i = 0; i < n; i++) len = len * 256 + buf[start + i]!;
      start += n;
    }
    return { start, end: start + len };
  };
  const outer = read(der, 0);
  const info = read(der, outer.start);
  let at = info.start;
  at = read(der, at).end; // version
  at = read(der, at).end; // subject
  const spki = read(der, at);
  return createPublicKey({ key: der.subarray(at, spki.end), format: "der", type: "spki" });
}

export function fakeCa(opts: FakeCaOptions = {}) {
  let nonce = 0;
  let badNonces = opts.badNonces ?? 0;
  let authzPolls = opts.authzPolls ?? 1;
  const lifetimeMs = opts.lifetimeMs ?? 24 * 60 * 60_000;
  const issued = new Set<string>();
  const posted: FakeCaPosted[] = [];
  const caKey = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
  const caKeyId = createHash("sha1").update(createPublicKey(caKey).export({ type: "spki", format: "der" })).digest();
  let accountKey: KeyObject | null = null;
  const state = { order: "pending", authz: "pending", challenge: "pending", chain: "", hostname: "" };
  /** Every newOrder's payload, refused ones included. */
  const orders: Array<Record<string, unknown>> = [];
  /** The certificate id of every renewal information request. */
  const ariRequests: string[] = [];
  /** What it issued, by certificate id. */
  const certs = new Map<string, { notBefore: Date; notAfter: Date; pem: string }>();
  const ari = new Map<string, FakeAri>();
  /** A problem type (`alreadyReplaced`, `rateLimited`...) for every order that names one it replaces. */
  let refuseReplaces: string | null = null;

  const newNonce = () => {
    const n = `nonce-${++nonce}`;
    issued.add(n);
    return n;
  };
  const answer = (status: number, body: unknown, headers: Record<string, string> = {}): AcmeResponse => ({
    status,
    headers: new Headers({ "replay-nonce": newNonce(), ...headers }),
    body: new Uint8Array(Buffer.from(typeof body === "string" ? body : JSON.stringify(body))),
  });
  const problem = (status: number, type: string, detail: string) => answer(status, { type: `urn:ietf:params:acme:error:${type}`, detail });

  function renewalInfo(certId: string): AcmeResponse {
    ariRequests.push(certId);
    const set = ari.get(certId) ?? ari.get("*");
    const cert = certs.get(certId);
    if (!set && !cert) return problem(404, "malformed", "no such certificate");
    const headers: Record<string, string> = { "content-type": "application/json" };
    const retryAfter = set ? set.retryAfter : "21600";
    if (retryAfter !== undefined) headers["retry-after"] = retryAfter;
    if (set?.body !== undefined) return answer(set.status ?? 200, set.body, headers);
    // Its own default: the tenth of the life from 60% in.
    const life = cert ? cert.notAfter.getTime() - cert.notBefore.getTime() : 0;
    const window = set?.window ?? {
      start: new Date(cert!.notBefore.getTime() + life * 0.6),
      end: new Date(cert!.notBefore.getTime() + life * 0.7),
    };
    const body = { suggestedWindow: { start: window.start.toISOString(), end: window.end.toISOString() }, explanationURL: `${FAKE_CA}/ari-docs` };
    return answer(set?.status ?? 200, body, headers);
  }

  const transport: AcmeTransport = {
    async request(url, init) {
      const path = url.slice(FAKE_CA.length);
      if (init.method === "GET" && path === "/dir") {
        return answer(200, {
          newNonce: `${FAKE_CA}/nonce`,
          newAccount: `${FAKE_CA}/acct`,
          newOrder: `${FAKE_CA}/order`,
          revokeCert: `${FAKE_CA}/revoke`,
          keyChange: `${FAKE_CA}/key-change`,
          ...(opts.renewalInfo === false ? {} : { renewalInfo: `${FAKE_CA}/ari` }),
          someFutureMember: { anything: true },
          meta: { termsOfService: `${FAKE_CA}/terms`, profiles: { classic: "x" }, website: FAKE_CA },
        });
      }
      if (init.method === "GET" && path.startsWith("/ari/")) return renewalInfo(path.slice("/ari/".length));
      if (init.method === "HEAD" && path === "/nonce") return answer(200, "");
      const jws = JSON.parse(init.body!) as { protected: string; payload: string; signature: string };
      const header = JSON.parse(Buffer.from(jws.protected, "base64url").toString()) as FakeCaPosted["header"];
      const p: FakeCaPosted = { url, body: init.body!, header, payload: jws.payload, signature: Buffer.from(jws.signature, "base64url") };
      posted.push(p);
      if (!issued.delete(header.nonce)) return problem(400, "badNonce", "unknown nonce");
      if (badNonces > 0) {
        badNonces -= 1;
        return problem(400, "badNonce", "try again");
      }
      const key = header.jwk ? createPublicKey({ key: header.jwk, format: "jwk" }) : accountKey!;
      if (!verify("sha256", Buffer.from(`${jws.protected}.${jws.payload}`), { key, dsaEncoding: "ieee-p1363" }, p.signature)) {
        return problem(400, "malformed", "bad signature");
      }
      const payload = jws.payload ? (JSON.parse(Buffer.from(jws.payload, "base64url").toString()) as Record<string, unknown>) : null;
      switch (path) {
        case "/acct":
          accountKey = key;
          return answer(201, { status: "valid" }, { location: `${FAKE_CA}/acct/1` });
        case "/order": {
          orders.push(payload!);
          if (payload!.replaces && refuseReplaces) return problem(409, refuseReplaces, "that certificate is not this order's to replace");
          state.hostname = (payload!.identifiers as Array<{ value: string }>)[0]!.value;
          // A valid authorization is reused, as Let's Encrypt does for 30 days; any other starts over.
          if (state.authz === "valid") state.order = "ready";
          else Object.assign(state, { order: "pending", authz: "pending", challenge: "pending" });
          return answer(
            201,
            { status: state.order, authorizations: [`${FAKE_CA}/authz/1`], finalize: `${FAKE_CA}/finalize/1`, identifiers: payload!.identifiers },
            { location: `${FAKE_CA}/order/1` },
          );
        }
        case "/authz/1":
          if (payload?.status === "deactivated") {
            // RFC 8555 7.5.2: only a pending or valid authorization can be deactivated.
            if (state.authz !== "pending" && state.authz !== "valid") return problem(403, "malformed", `the authorization is ${state.authz}`);
            state.authz = "deactivated";
          } else if (state.challenge === "processing" && --authzPolls <= 0) {
            state.authz = opts.failAuthz ? "invalid" : "valid";
            state.challenge = state.authz;
            if (state.authz === "valid") state.order = "ready";
          }
          return answer(
            200,
            {
              status: state.authz,
              identifier: { type: "dns", value: state.hostname },
              challenges: [
                { type: "http-01", url: `${FAKE_CA}/chall/http`, token: "t-http", status: "pending" },
                {
                  type: "dns-01",
                  url: `${FAKE_CA}/chall/1`,
                  token: "t-dns",
                  status: state.challenge,
                  ...(state.authz === "invalid" ? { error: { type: "urn:ietf:params:acme:error:incorrectResponse", detail: "no TXT" } } : {}),
                },
              ],
            },
            opts.retryAfter ? { "retry-after": opts.retryAfter } : {},
          );
        case "/chall/1":
          state.challenge = "processing";
          return answer(200, { type: "dns-01", status: "processing" });
        case "/finalize/1": {
          const csr = Buffer.from(payload!.csr as string, "base64url");
          const serial = randomBytes(16);
          serial[0]! |= 0x80;
          const notBefore = new Date(Date.now() - 60_000);
          const notAfter = new Date(notBefore.getTime() + lifetimeMs);
          const leaf = makeTestCert({
            dnsNames: [state.hostname],
            publicKey: csrPublicKey(csr),
            issuerKey: caKey,
            authorityKeyId: caKeyId,
            serial,
            notBefore,
            notAfter,
          });
          certs.set(ariCertId(leaf.der)!, { notBefore, notAfter, pem: leaf.cert });
          state.chain = leaf.cert + makeTestCert({ dnsNames: ["ca.stuga.test"], privateKey: caKey }).cert;
          state.order = "valid";
          return answer(200, { status: "processing" });
        }
        case "/order/1":
          return answer(200, {
            status: state.order,
            authorizations: [`${FAKE_CA}/authz/1`],
            finalize: `${FAKE_CA}/finalize/1`,
            ...(state.order === "valid" ? { certificate: `${FAKE_CA}/cert/1` } : {}),
          });
        case "/cert/1":
          if (opts.failCert) return problem(500, "serverInternal", "no certificate today");
          return answer(200, state.chain, { "content-type": "application/pem-certificate-chain" });
        default:
          return problem(404, "malformed", "no such resource");
      }
    },
  };
  return {
    transport,
    posted,
    state,
    orders,
    ariRequests,
    certs,
    /** Answer renewal information for this certificate id, or "*" for any, with this from now on. */
    setAri(certId: string, a: FakeAri): void {
      ari.set(certId, a);
    },
    refuseReplaces(type: string | null): void {
      refuseReplaces = type;
    },
  };
}

export type FakeCa = ReturnType<typeof fakeCa>;
