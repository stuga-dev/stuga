import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTestCert } from "../../testing/cert.js";
import { generateP256 } from "../keys.js";
import { FAKE_CA, fakeCa } from "../testing/fake-ca.js";
import { AcmeClient, AcmeError, fetchDirectory, fetchRenewalInfo, retryAfterSeconds } from "./client.js";
import { ariCertId, csrDer, toPem } from "./der.js";
import type { AcmeTransport } from "./transport.js";

const CA = FAKE_CA;
const HOST = "k7f3q2.remote.stuga.test";

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
    expect(paths).toEqual(["/acct", "/order", "/authz/1", "/chall/1", "/authz/1", "/authz/1", "/order/1", "/finalize/1", "/order/1", "/cert/1", "/authz/1"]);
    // The authorization is given up once the certificate is in hand, so the next one needs a challenge.
    expect(JSON.parse(Buffer.from(ca.posted.at(-1)!.payload, "base64url").toString())).toEqual({ status: "deactivated" });
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
    const last = ca.posted.at(-1)!;
    expect(last.url).toBe(`${CA}/authz/1`);
    expect(JSON.parse(Buffer.from(last.payload, "base64url").toString())).toEqual({ status: "deactivated" });
  });

  it("needs the challenge again for the next certificate, because it gave the last authorization up", async () => {
    const ca = fakeCa();
    const c = await client(ca);
    await c.ensureAccount();
    await c.issue({ hostname: HOST, key: generateP256(), dns: dns() });
    const second = dns();
    await c.issue({ hostname: HOST, key: generateP256(), dns: second });
    expect(second.calls).toEqual([`present ${c.dnsValue("t-dns")}`, `verify ${c.dnsValue("t-dns")}`, "cleanup"]);
  });

  it("gives up an authorization it was granted when the order fails after it", async () => {
    const ca = fakeCa({ failCert: true });
    const c = await client(ca);
    await c.ensureAccount();
    await expect(c.issue({ hostname: HOST, key: generateP256(), dns: dns() })).rejects.toBeInstanceOf(AcmeError);
    expect(ca.state.authz).toBe("deactivated");
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

  it("names the CA's renewal information in the directory, and nothing that is not a URL", async () => {
    expect((await fetchDirectory(fakeCa().transport, `${CA}/dir`)).renewalInfo).toBe(`${CA}/ari`);
    expect((await fetchDirectory(fakeCa({ renewalInfo: false }).transport, `${CA}/dir`)).renewalInfo).toBeUndefined();
    const odd: AcmeTransport = {
      async request() {
        const dir = { newNonce: `${CA}/n`, newAccount: `${CA}/a`, newOrder: `${CA}/o`, renewalInfo: { url: `${CA}/ari` } };
        return { status: 200, headers: new Headers(), body: new Uint8Array(Buffer.from(JSON.stringify(dir))) };
      },
    };
    expect(await fetchDirectory(odd, `${CA}/dir`)).not.toHaveProperty("renewalInfo");
  });

  it("names the certificate it renews, and orders again without that when the CA refuses it", async () => {
    const ca = fakeCa();
    const c = await client(ca);
    await c.ensureAccount();
    await c.issue({ hostname: HOST, key: generateP256(), replaces: "aYhba4dGQEHhs3uEe6CuLN4ByNQ.AIdlQyE", dns: dns() });
    expect(ca.orders).toEqual([{ identifiers: [{ type: "dns", value: HOST }], replaces: "aYhba4dGQEHhs3uEe6CuLN4ByNQ.AIdlQyE" }]);

    ca.refuseReplaces("alreadyReplaced");
    const chain = await c.issue({ hostname: HOST, key: generateP256(), replaces: "aYhba4dGQEHhs3uEe6CuLN4ByNQ.AIdlQyE", dns: dns() });
    expect(new X509Certificate(chain).subjectAltName).toBe(`DNS:${HOST}`);
    expect(ca.orders.slice(1)).toEqual([
      { identifiers: [{ type: "dns", value: HOST }], replaces: "aYhba4dGQEHhs3uEe6CuLN4ByNQ.AIdlQyE" },
      { identifiers: [{ type: "dns", value: HOST }] },
    ]);
  });

  it("does not order again without it when the refusal is a rate limit", async () => {
    const ca = fakeCa();
    const c = await client(ca);
    await c.ensureAccount();
    ca.refuseReplaces("rateLimited");
    const err = (await c.issue({ hostname: HOST, key: generateP256(), replaces: "x.y", dns: dns() }).catch((e: unknown) => e)) as AcmeError;
    expect(err.is("rateLimited")).toBe(true);
    expect(ca.orders).toHaveLength(1);
  });

  it("reads the CA's renewal window, with Retry-After held between an hour and a day", async () => {
    const ca = fakeCa();
    const start = new Date("2026-10-20T00:00:00Z");
    const end = new Date("2026-10-21T00:00:00Z");
    const read = async (retryAfter?: string) => {
      ca.setAri("*", { window: { start, end }, ...(retryAfter !== undefined ? { retryAfter } : {}) });
      return fetchRenewalInfo(ca.transport, `${CA}/ari`, "aYhba4dGQEHhs3uEe6CuLN4ByNQ.AIdlQyE");
    };
    expect(await read("21600")).toEqual({ start, end, explanationUrl: `${CA}/ari-docs`, retryAfterMs: 6 * 3_600_000 });
    expect(ca.ariRequests.at(-1)).toBe("aYhba4dGQEHhs3uEe6CuLN4ByNQ.AIdlQyE");
    expect((await read("60")).retryAfterMs).toBe(3_600_000);
    expect((await read("604800")).retryAfterMs).toBe(24 * 3_600_000);
    expect((await read()).retryAfterMs).toBe(6 * 3_600_000);
    expect((await read("soon")).retryAfterMs).toBe(6 * 3_600_000);
  });

  it("takes a window that ends before it starts, an answer that is no window, or an error, for no answer", async () => {
    const ca = fakeCa();
    const get = () => fetchRenewalInfo(ca.transport, `${CA}/ari`, "a.b");
    ca.setAri("*", { window: { start: new Date("2026-10-21T00:00:00Z"), end: new Date("2026-10-21T00:00:00Z") } });
    await expect(get()).rejects.toBeInstanceOf(AcmeError);
    ca.setAri("*", { body: '{"suggestedWindow":{"start":"soon"}}' });
    await expect(get()).rejects.toBeInstanceOf(AcmeError);
    ca.setAri("*", { body: "<html>" });
    await expect(get()).rejects.toBeInstanceOf(AcmeError);
    ca.setAri("*", { status: 503, body: '{"type":"urn:ietf:params:acme:error:serverInternal","detail":"busy"}' });
    await expect(get()).rejects.toMatchObject({ status: 503, detail: "busy" });
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

/** RFC 9773 appendix A. */
const RFC_9773_EXAMPLE = `-----BEGIN CERTIFICATE-----
MIIBQzCB66ADAgECAgUAh2VDITAKBggqhkjOPQQDAjAVMRMwEQYDVQQDEwpFeGFt
cGxlIENBMCIYDzAwMDEwMTAxMDAwMDAwWhgPMDAwMTAxMDEwMDAwMDBaMBYxFDAS
BgNVBAMTC2V4YW1wbGUuY29tMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEeBZu
7cbpAYNXZLbbh8rNIzuOoqOOtmxA1v7cRm//AwyMwWxyHz4zfwmBhcSrf47NUAFf
qzLQ2PPQxdTXREYEnKMjMCEwHwYDVR0jBBgwFoAUaYhba4dGQEHhs3uEe6CuLN4B
yNQwCgYIKoZIzj0EAwIDRwAwRAIge09+S5TZAlw5tgtiVvuERV6cT4mfutXIlwTb
+FYN/8oCIClDsqBklhB9KAelFiYt9+6FDj3z4KGVelYM5MdsO3pK
-----END CERTIFICATE-----
`;

const derOf = (pem: string): Buffer => Buffer.from(pem.replace(/-----[^-]+-----|\s/g, ""), "base64");

describe("a certificate's identifier for renewal information", () => {
  it("is the RFC's for its example certificate, the serial's leading zero byte kept", () => {
    expect(ariCertId(derOf(RFC_9773_EXAMPLE))).toBe("aYhba4dGQEHhs3uEe6CuLN4ByNQ.AIdlQyE");
  });

  it("reads a leaf a CA signed with openssl, as Let's Encrypt's are made", () => {
    const dir = mkdtempSync(join(tmpdir(), "stuga-ari-"));
    dirs.push(dir);
    const at = (name: string) => join(dir, name);
    const openssl = (...args: string[]) => execFileSync("openssl", args, { encoding: "utf8", stdio: "pipe", cwd: dir });
    openssl("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "ca.key");
    writeFileSync(
      at("ext.cnf"),
      "[ca]\nbasicConstraints=critical,CA:true\nsubjectKeyIdentifier=hash\n[leaf]\nauthorityKeyIdentifier=keyid:always\nsubjectAltName=DNS:k7f3q2.mystuga.com\n",
    );
    openssl("req", "-new", "-key", "ca.key", "-subj", "/CN=Stuga test CA", "-out", "ca.csr");
    openssl("x509", "-req", "-in", "ca.csr", "-signkey", "ca.key", "-days", "1", "-extfile", "ext.cnf", "-extensions", "ca", "-out", "ca.pem");
    openssl("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "leaf.key");
    openssl("req", "-new", "-key", "leaf.key", "-subj", "/CN=k7f3q2.mystuga.com", "-out", "leaf.csr");
    openssl("x509", "-req", "-in", "leaf.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-set_serial", "0x87654321", "-days", "1",
      "-extfile", "ext.cnf", "-extensions", "leaf", "-out", "leaf.pem");
    const text = openssl("x509", "-in", "leaf.pem", "-noout", "-text");
    // LibreSSL prints "keyid:AB:CD…" under the heading, OpenSSL 3 the bare "AB:CD…".
    const keyId = /Authority Key Identifier:\s*\n\s*(?:keyid:)?([0-9A-F:]+)/.exec(text)![1]!.replace(/:/g, "");
    expect(ariCertId(derOf(readFileSync(at("leaf.pem"), "utf8")))).toBe(
      `${Buffer.from(keyId, "hex").toString("base64url")}.${Buffer.from("0087654321", "hex").toString("base64url")}`,
    );
  });

  it("is none for a certificate with no authority key identifier, or bytes that are no certificate", () => {
    expect(ariCertId(makeTestCert().der)).toBeNull();
    expect(ariCertId(Buffer.from("3003020101", "hex"))).toBeNull();
    expect(ariCertId(Buffer.from([0x30, 0x84, 0xff, 0xff, 0xff, 0xff]))).toBeNull();
    expect(ariCertId(Buffer.alloc(0))).toBeNull();
  });

  it("keeps a serial without a high bit as it is", () => {
    const leaf = makeTestCert({ serial: Buffer.from("01020304", "hex"), authorityKeyId: Buffer.from("aabb", "hex") });
    expect(ariCertId(leaf.der)).toBe("qrs.AQIDBA");
  });
});
