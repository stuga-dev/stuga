import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { NodeRemoteAccessRow } from "@stuga/db";
import { makeTestCert } from "../testing/cert.js";
import { AcmeError } from "./acme/client.js";
import {
  caTermsUrl,
  certFailure,
  certRenewAt,
  certUsable,
  issuanceEvidence,
  parseCertificateFile,
  readCertificate,
  writeCertificate,
  type CertOnDisk,
} from "./certificates.js";
import { DnsNotVisible } from "./dns-check.js";

const HOST = "k7f3q2.mystuga.com";
const DAY = 24 * 60 * 60_000;
const MIN = 60_000;
const T0 = Date.parse("2026-10-02T00:00:00Z");

function onDisk(opts: { names?: string[]; days?: number; key?: "own" | "other" } = {}): CertOnDisk {
  const cert = makeTestCert({ dnsNames: opts.names ?? [HOST], notBefore: new Date(T0), notAfter: new Date(T0 + (opts.days ?? 90) * DAY) });
  const key = opts.key === "other" ? (generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }) as string) : cert.key;
  return parseCertificateFile(key + cert.cert);
}

function row(over: Partial<NodeRemoteAccessRow> = {}): NodeRemoteAccessRow {
  return {
    hostname: HOST,
    cert_serial: null,
    cert_renew_at: null,
    cert_reissue_before: null,
    acme_reissue_before: null,
    acme_directory: "https://ca.stuga.test/dir",
    cert_directory: "https://ca.stuga.test/dir",
    ...over,
  } as NodeRemoteAccessRow;
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("the certificate file", () => {
  it("holds the key and the chain together, 0600 in a 0700 directory, and reads back whole", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "stuga-cert-"));
    dirs.push(dataDir);
    const leaf = makeTestCert({ dnsNames: [HOST] });
    const issuer = makeTestCert({ dnsNames: ["ca.stuga.test"] });
    await writeCertificate(dataDir, leaf.privateKey, leaf.cert + issuer.cert);
    const disk = await readCertificate(dataDir);
    expect(disk.kind).toBe("ok");
    if (disk.kind !== "ok") return;
    expect(disk.cert.chainPem).toBe(leaf.cert + issuer.cert);
    expect(disk.cert.leafPem).toBe(leaf.cert);
    expect(disk.cert.serial).toBe(leaf.serial.replace(/^(00)+/, ""));
    expect(disk.cert.spkiSha256).toBe(leaf.spkiSha256);
    const { statSync } = await import("node:fs");
    expect(statSync(join(dataDir, "remote", "certificate.pem")).mode & 0o777).toBe(0o600);
    expect(statSync(join(dataDir, "remote")).mode & 0o777).toBe(0o700);
  });

  it("is missing, unreadable, or a key that is not the certificate's", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "stuga-cert-"));
    dirs.push(dataDir);
    expect(await readCertificate(dataDir)).toEqual({ kind: "missing" });
    expect(parseCertificateFile("garbage").kind).toBe("unreadable");
    expect(onDisk({ key: "other" }).kind).toBe("mismatch");
  });
});

describe("the evidence that a new certificate is needed", () => {
  it.each<[string, CertOnDisk, Partial<NodeRemoteAccessRow>, string]>([
    ["no certificate", { kind: "missing" }, {}, "missing"],
    ["a certificate that does not parse", { kind: "unreadable", why: "x" }, {}, "unreadable"],
    ["a key that is not the certificate's", onDisk({ key: "other" }), {}, "key_mismatch"],
    ["another name", onDisk({ names: ["m9d4tz.mystuga.com"] }), {}, "names"],
    ["a name too many", onDisk({ names: [HOST, "www.mystuga.com"] }), {}, "names"],
    ["due for renewal", onDisk(), { cert_renew_at: new Date(T0 + DAY) }, "due"],
    ["a reissue asked for after it was issued", onDisk(), { acme_reissue_before: new Date(T0 + MIN) }, "reissue_requested"],
  ])("%s", (_name, disk, over, expected) => {
    const serial = disk.kind === "ok" ? disk.cert.serial : null;
    expect(issuanceEvidence(disk, row({ cert_serial: serial, ...over }), T0 + 2 * DAY)).toBe(expected);
  });

  it("renews an expired certificate, and one the row does not describe at two thirds of its own life", () => {
    const disk = onDisk({ days: 9 });
    expect(issuanceEvidence(disk, row(), T0 + 5 * DAY)).toBeNull();
    expect(issuanceEvidence(disk, row(), T0 + 6 * DAY)).toBe("due");
    expect(issuanceEvidence(disk, row(), T0 + 10 * DAY)).toBe("due");
  });

  it("is none for a good certificate, whatever the service or the CA directory says", () => {
    const disk = onDisk();
    const serial = disk.kind === "ok" ? disk.cert.serial : null;
    const quiet = row({
      cert_serial: serial,
      cert_renew_at: new Date(T0 + 60 * DAY),
      // A new directory from the service is used at the next renewal, not before.
      acme_directory: "https://other-ca.stuga.test/dir",
      // A reissue asked for before this certificate was issued is already answered.
      acme_reissue_before: new Date(T0 - MIN),
      last_error: { code: "service_refused", service_code: "cert_invalid", message: "m", at: "" },
    });
    expect(issuanceEvidence(disk, quiet, T0 + 2 * DAY)).toBeNull();
    const wrongCertificate = { ...quiet, last_error: { code: "wrong_certificate", message: "m", at: "" } };
    expect(issuanceEvidence(disk, wrongCertificate, T0 + 2 * DAY)).toBeNull();
  });

  it("reissues once per request, however far back the CA dates the new certificate", () => {
    // Let's Encrypt backdates notBefore by an hour: the certificate issued in answer (notBefore T0)
    // is still older than the request (T0 + 30 min).
    const disk = onDisk();
    const serial = disk.kind === "ok" ? disk.cert.serial : null;
    const asked = new Date(T0 + 30 * MIN);
    const answered = row({ cert_serial: serial, acme_reissue_before: asked, cert_reissue_before: asked });
    expect(issuanceEvidence(disk, answered, T0 + 2 * DAY)).toBeNull();
    // A later request asks again, once.
    expect(issuanceEvidence(disk, { ...answered, acme_reissue_before: new Date(T0 + 40 * MIN) }, T0 + 2 * DAY)).toBe("reissue_requested");
    // What the row says answers only the certificate it describes.
    expect(issuanceEvidence(disk, { ...answered, cert_serial: "04f1" }, T0 + 2 * DAY)).toBe("reissue_requested");
  });

  it("serves the hostname only while valid and naming it alone", () => {
    const disk = onDisk();
    if (disk.kind !== "ok") throw new Error("setup");
    expect(certUsable(disk.cert, HOST, T0 + DAY)).toBe(true);
    expect(certUsable(disk.cert, "m9d4tz.mystuga.com", T0 + DAY)).toBe(false);
    expect(certUsable(disk.cert, HOST, T0 + 91 * DAY)).toBe(false);
    expect(certUsable(null, HOST, T0)).toBe(false);
  });
});

describe("the CA's terms", () => {
  it("keeps an https link to them, and nothing else the directory names", () => {
    expect(caTermsUrl("https://letsencrypt.org/documents/LE-SA-v1.8-July-06-2026.pdf")).toBe(
      "https://letsencrypt.org/documents/LE-SA-v1.8-July-06-2026.pdf",
    );
    for (const value of ["data:text/plain,Do%20what%20thou%20wilt", "javascript:alert(1)", "http://ca.stuga.test/terms", "terms.pdf", 7, undefined]) {
      expect(caTermsUrl(value)).toBeNull();
    }
  });
});

describe("when to renew", () => {
  it("is two thirds into the life, less up to a twentieth of it", () => {
    const nb = new Date(T0);
    const na = new Date(T0 + 90 * DAY);
    expect(certRenewAt(nb, na, () => 0).getTime()).toBe(T0 + 60 * DAY);
    expect(certRenewAt(nb, na, () => 1).getTime()).toBe(T0 + 60 * DAY - 4.5 * DAY);
    for (let i = 0; i < 100; i++) {
      const at = certRenewAt(nb, na, Math.random).getTime();
      expect(at).toBeGreaterThanOrEqual(T0 + 55.5 * DAY);
      expect(at).toBeLessThanOrEqual(T0 + 60 * DAY);
    }
  });
});

describe("a failure to get a certificate", () => {
  const now = new Date(T0);
  const ctx = (failures = 1) => ({ now, failures, rand: () => 0.5 });
  const inMs = (d: Date | null) => (d ? d.getTime() - T0 : null);
  const acme = (type: string, status = 400, retryAfter?: number, authorization = false) =>
    new AcmeError(`urn:ietf:params:acme:error:${type}`, status, `the CA said ${type}`, retryAfter, authorization);

  it("waits out the CA's rate limit, between a minute and a week", () => {
    expect(inMs(certFailure(acme("rateLimited", 429, 7200), ctx()).retryAt)).toBe(7200_000);
    expect(inMs(certFailure(acme("rateLimited", 429, 5), ctx()).retryAt)).toBe(MIN);
    expect(inMs(certFailure(acme("rateLimited", 429, 30 * 86_400), ctx()).retryAt)).toBe(7 * DAY);
    expect(certFailure(acme("rateLimited", 429, 60), ctx()).lastError.code).toBe("acme_rate_limited");
  });

  it("waits at least 15 minutes after a failed authorization", () => {
    const f = certFailure(acme("incorrectResponse", 403, undefined, true), ctx());
    expect(f.lastError.code).toBe("acme_challenge_failed");
    expect(inMs(f.retryAt)).toBe(15 * MIN);
    expect(inMs(certFailure(acme("dns", 403, undefined, true), ctx(4)).retryAt)).toBe(60 * MIN);
  });

  it("stops for an administrator when the CA asks for one", () => {
    const f = certFailure(acme("userActionRequired", 403), ctx());
    expect(f).toMatchObject({ retryAt: null, lastError: { code: "acme_action_required", message: "the CA said userActionRequired" } });
  });

  it("makes a new account when the CA no longer knows this one", () => {
    const f = certFailure(acme("accountDoesNotExist", 400), ctx());
    expect(f.forgetAccount).toBe(true);
    expect(f.lastError.code).toBe("acme_error");
    expect(inMs(f.retryAt)).toBe(MIN);
  });

  it("backs off from a network error, a 5xx or anything else from the CA", () => {
    expect(inMs(certFailure(new Error("ECONNRESET"), ctx(3)).retryAt)).toBe(15 * MIN);
    expect(inMs(certFailure(acme("serverInternal", 500), ctx(5)).retryAt)).toBe(180 * MIN);
    expect(certFailure(acme("rejectedIdentifier"), ctx()).lastError.code).toBe("acme_error");
  });

  it("reports a record the zone's servers never showed as dns_not_visible", () => {
    const f = certFailure(new DnsNotVisible("not seen"), ctx(2));
    expect(f.lastError.code).toBe("dns_not_visible");
    expect(inMs(f.retryAt)).toBe(5 * MIN);
  });
});
