import { execFileSync } from "node:child_process";
import { X509Certificate, createPublicKey, generateKeyPairSync, verify, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTestCert } from "../../testing/cert.js";
import { generateP256 } from "../keys.js";
import { AcmeClient, AcmeError, fetchDirectory, retryAfterSeconds } from "./client.js";
import { csrDer, toPem } from "./der.js";
import type { AcmeResponse, AcmeTransport } from "./transport.js";

const CA = "https://ca.stuga.test";
const HOST = "k7f3q2.remote.stuga.test";

interface Posted {
  url: string;
  body: string;
  header: { alg: string; nonce: string; url: string; kid?: string; jwk?: Record<string, string> };
  payload: string;
  signature: Buffer;
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

/**
 * An ACME CA in memory: one account, one order at a time, dns-01 only. `badNonces` refuses that
 * many signed requests for their nonce first; `authzPolls` answers pending that many times.
 */
function fakeCa(opts: { badNonces?: number; authzPolls?: number; failAuthz?: boolean; retryAfter?: string } = {}) {
  let nonce = 0;
  let badNonces = opts.badNonces ?? 0;
  let authzPolls = opts.authzPolls ?? 1;
  const issued = new Set<string>();
  const posted: Posted[] = [];
  const caKey = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
  let accountKey: KeyObject | null = null;
  const state = { order: "pending", authz: "pending", challenge: "pending", chain: "" };
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

  const transport: AcmeTransport = {
    async request(url, init) {
      const path = url.slice(CA.length);
      if (init.method === "GET" && path === "/dir") {
        return answer(200, {
          newNonce: `${CA}/nonce`,
          newAccount: `${CA}/acct`,
          newOrder: `${CA}/order`,
          revokeCert: `${CA}/revoke`,
          keyChange: `${CA}/key-change`,
          renewalInfo: `${CA}/ari`,
          someFutureMember: { anything: true },
          meta: { termsOfService: `${CA}/terms`, profiles: { classic: "x" }, website: "https://ca.stuga.test" },
        });
      }
      if (init.method === "HEAD" && path === "/nonce") return answer(200, "");
      const jws = JSON.parse(init.body!) as { protected: string; payload: string; signature: string };
      const header = JSON.parse(Buffer.from(jws.protected, "base64url").toString()) as Posted["header"];
      const p: Posted = { url, body: init.body!, header, payload: jws.payload, signature: Buffer.from(jws.signature, "base64url") };
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
          return answer(201, { status: "valid" }, { location: `${CA}/acct/1` });
        case "/order":
          return answer(201, { status: state.order, authorizations: [`${CA}/authz/1`], finalize: `${CA}/finalize/1`, identifiers: payload!.identifiers }, { location: `${CA}/order/1` });
        case "/authz/1":
          if (state.challenge === "processing" && --authzPolls <= 0) {
            state.authz = opts.failAuthz ? "invalid" : "valid";
            state.challenge = state.authz;
            if (state.authz === "valid") state.order = "ready";
          }
          return answer(
            200,
            {
              status: state.authz,
              identifier: { type: "dns", value: HOST },
              challenges: [
                { type: "http-01", url: `${CA}/chall/http`, token: "t-http", status: "pending" },
                {
                  type: "dns-01",
                  url: `${CA}/chall/1`,
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
          const leaf = makeTestCert({ dnsNames: [HOST], publicKey: csrPublicKey(csr), issuerKey: caKey });
          state.chain = leaf.cert + makeTestCert({ dnsNames: ["ca.stuga.test"], privateKey: caKey }).cert;
          state.order = "valid";
          return answer(200, { status: "processing" });
        }
        case "/order/1":
          return answer(200, {
            status: state.order,
            authorizations: [`${CA}/authz/1`],
            finalize: `${CA}/finalize/1`,
            ...(state.order === "valid" ? { certificate: `${CA}/cert/1` } : {}),
          });
        case "/cert/1":
          return answer(200, state.chain, { "content-type": "application/pem-certificate-chain" });
        default:
          return problem(404, "malformed", "no such resource");
      }
    },
  };
  return { transport, posted, state };
}

const noSleep = { now: Date.now, sleep: async () => {} };

async function client(ca: ReturnType<typeof fakeCa>, accountKey = generateP256()) {
  const directory = await fetchDirectory(ca.transport, `${CA}/dir`);
  return new AcmeClient({ transport: ca.transport, directory, accountKey, clock: noSleep });
}

function dns() {
  const calls: string[] = [];
  return {
    calls,
    present: async (value: string) => void calls.push(`present ${value}`),
    verify: async (value: string) => void calls.push(`verify ${value}`),
    cleanup: async () => void calls.push("cleanup"),
  };
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("the ACME client", () => {
  it("takes a directory with members it does not know", async () => {
    const ca = fakeCa();
    const dir = await fetchDirectory(ca.transport, `${CA}/dir`);
    expect(dir.newOrder).toBe(`${CA}/order`);
    expect(dir.meta?.termsOfService).toBe(`${CA}/terms`);
  });

  it("orders, proves the name over dns-01, finalizes and downloads the chain for its key", async () => {
    const ca = fakeCa({ authzPolls: 2 });
    const c = await client(ca);
    await c.ensureAccount();
    const key = generateP256();
    const d = dns();
    const chain = await c.issue({ hostname: HOST, key, profile: "classic", dns: d });
    const leaf = new X509Certificate(chain);
    expect(leaf.subjectAltName).toBe(`DNS:${HOST}`);
    expect(leaf.checkPrivateKey(key)).toBe(true);
    expect(chain.match(/BEGIN CERTIFICATE/g)).toHaveLength(2);
    const value = c.dnsValue("t-dns");
    expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(d.calls).toEqual([`present ${value}`, `verify ${value}`, "cleanup"]);
    const paths = ca.posted.map((p) => p.url.slice(CA.length));
    expect(paths).toEqual(["/acct", "/order", "/authz/1", "/chall/1", "/authz/1", "/authz/1", "/order/1", "/finalize/1", "/order/1", "/cert/1"]);
    const order = ca.posted.find((p) => p.url.endsWith("/order"))!;
    expect(JSON.parse(Buffer.from(order.payload, "base64url").toString())).toEqual({ identifiers: [{ type: "dns", value: HOST }], profile: "classic" });
  });

  it("asks for a profile only when the directory offers it", async () => {
    const ca = fakeCa();
    const c = await client(ca);
    await c.ensureAccount();
    await c.issue({ hostname: HOST, key: generateP256(), profile: "shortlived", dns: dns() });
    const order = ca.posted.find((p) => p.url.endsWith("/order"))!;
    expect(JSON.parse(Buffer.from(order.payload, "base64url").toString())).not.toHaveProperty("profile");
  });

  it("signs ES256 with r||s, embeds its key for the account and names the account after, and POSTs-as-GET with an empty payload", async () => {
    const ca = fakeCa();
    const accountKey = generateP256();
    const c = await client(ca, accountKey);
    await c.ensureAccount();
    await c.issue({ hostname: HOST, key: generateP256(), dns: dns() });
    for (const p of ca.posted) {
      expect(p.header.alg).toBe("ES256");
      expect(p.header.url).toBe(p.url);
      expect(p.signature).toHaveLength(64);
    }
    expect(ca.posted[0]!.header.jwk).toMatchObject({ kty: "EC", crv: "P-256" });
    expect(ca.posted[0]!.header.kid).toBeUndefined();
    for (const p of ca.posted.slice(1)) expect(p.header.kid).toBe(`${CA}/acct/1`);
    expect(ca.posted.find((p) => p.url.endsWith("/authz/1"))!.payload).toBe("");
    expect(Buffer.from(ca.posted.find((p) => p.url.endsWith("/chall/1"))!.payload, "base64url").toString()).toBe("{}");
  });

  it("signs a request refused for its nonce again with the nonce the refusal carried, never resending the old body", async () => {
    const ca = fakeCa({ badNonces: 3 });
    const c = await client(ca);
    await c.ensureAccount();
    const tries = ca.posted.filter((p) => p.url.endsWith("/acct"));
    expect(tries).toHaveLength(4);
    expect(new Set(tries.map((t) => t.header.nonce)).size).toBe(4);
    expect(new Set(tries.map((t) => t.body)).size).toBe(4);
    // Each retry uses the nonce the refusal before it handed out.
    expect(tries.slice(1).map((t) => t.header.nonce)).toEqual(["nonce-3", "nonce-4", "nonce-5"]);
  });

  it("gives up on a fourth refusal for the nonce", async () => {
    const ca = fakeCa({ badNonces: 4 });
    const c = await client(ca);
    const err = await c.ensureAccount().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AcmeError);
    expect((err as AcmeError).is("badNonce")).toBe(true);
  });

  it("reports an authorization the CA would not grant as one, and still takes the record down", async () => {
    const ca = fakeCa({ failAuthz: true });
    const c = await client(ca);
    await c.ensureAccount();
    const d = dns();
    const err = (await c.issue({ hostname: HOST, key: generateP256(), dns: d }).catch((e: unknown) => e)) as AcmeError;
    expect(err).toBeInstanceOf(AcmeError);
    expect(err.authorization).toBe(true);
    expect(err.is("incorrectResponse")).toBe(true);
    expect(d.calls.at(-1)).toBe("cleanup");
  });

  it("carries the CA's problem type, status and Retry-After", async () => {
    const transport: AcmeTransport = {
      async request(url, init) {
        if (init.method === "GET") return { status: 200, headers: new Headers(), body: new Uint8Array(Buffer.from(JSON.stringify({ newNonce: `${CA}/n`, newAccount: `${CA}/a`, newOrder: `${CA}/o` }))) };
        if (init.method === "HEAD") return { status: 200, headers: new Headers({ "replay-nonce": "n" }), body: new Uint8Array() };
        return {
          status: 429,
          headers: new Headers({ "retry-after": "3600" }),
          body: new Uint8Array(Buffer.from(JSON.stringify({ type: "urn:ietf:params:acme:error:rateLimited", detail: "too many" }))),
        };
      },
    };
    const c = new AcmeClient({ transport, directory: await fetchDirectory(transport, `${CA}/dir`), accountKey: generateP256(), clock: noSleep });
    const err = (await c.ensureAccount().catch((e: unknown) => e)) as AcmeError;
    expect(err).toMatchObject({ status: 429, detail: "too many", retryAfter: 3600 });
    expect(err.is("rateLimited")).toBe(true);
  });

  it("reads Retry-After in seconds or as a date", () => {
    expect(retryAfterSeconds(new Headers({ "retry-after": "120" }))).toBe(120);
    const now = Date.parse("2026-10-02T00:00:00Z");
    expect(retryAfterSeconds(new Headers({ "retry-after": "Fri, 02 Oct 2026 00:10:00 GMT" }), now)).toBe(600);
    expect(retryAfterSeconds(new Headers())).toBeUndefined();
  });
});

describe("the certificate request", () => {
  it("reads back with openssl: a valid self-signature, the one name as a SAN, and an empty subject", () => {
    const dir = mkdtempSync(join(tmpdir(), "stuga-csr-"));
    dirs.push(dir);
    const path = join(dir, "csr.pem");
    writeFileSync(path, toPem("CERTIFICATE REQUEST", csrDer(generateP256(), HOST)));
    const run = (...args: string[]) => execFileSync("openssl", ["req", "-in", path, "-noout", ...args], { encoding: "utf8", stdio: "pipe" });
    expect(() => run("-verify")).not.toThrow();
    expect(run("-text")).toContain(`DNS:${HOST}`);
    expect(run("-subject").trim()).toMatch(/^subject=\s*$/);
  });

  it("is signed in DER, where a JWS is signed r||s", () => {
    const der = csrDer(generateP256(), HOST);
    // The last element is a BIT STRING holding an ECDSA-Sig-Value: SEQUENCE { r, s }.
    const bitString = der.lastIndexOf(0x03, der.length - 60);
    const sig = der.subarray(der.indexOf(0x30, bitString));
    expect(sig[0]).toBe(0x30);
    expect(sig.length).toBeGreaterThanOrEqual(70);
  });
});
