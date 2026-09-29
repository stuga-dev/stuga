import { X509Certificate, createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { makeTestCert } from "./cert.js";
import { ipBytes } from "./remote.js";

describe("makeTestCert", () => {
  it("makes a P-256 certificate node:crypto parses, for its own key and names", () => {
    const made = makeTestCert({ dnsNames: ["k7f3q2.stuga.test"] });
    const x509 = new X509Certificate(made.cert);
    expect(x509.subjectAltName).toBe("DNS:k7f3q2.stuga.test");
    expect(x509.checkPrivateKey(made.privateKey)).toBe(true);
    expect(x509.verify(x509.publicKey)).toBe(true);
    expect(x509.publicKey.asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
    expect(x509.serialNumber.toLowerCase()).toBe(made.serial);
    const spki = x509.publicKey.export({ type: "spki", format: "der" });
    expect(createHash("sha256").update(spki).digest("hex")).toBe(made.spkiSha256);
    expect(made.key).toMatch(/^-----BEGIN PRIVATE KEY-----\n/);
  });

  it("takes any validity, either side of 2050, and any mix of names", () => {
    const made = makeTestCert({
      dnsNames: ["a.example.test", "b.example.test"],
      ipAddresses: ["203.0.113.7", "2001:db8::17"],
      notBefore: new Date("2049-12-31T23:00:00Z"),
      notAfter: new Date("2051-01-01T00:00:00Z"),
      curve: "P-384",
    });
    const x509 = new X509Certificate(made.cert);
    expect(x509.subjectAltName).toBe("DNS:a.example.test, DNS:b.example.test, IP Address:203.0.113.7, IP Address:2001:DB8:0:0:0:0:0:17");
    expect(new Date(x509.validFrom).toISOString()).toBe("2049-12-31T23:00:00.000Z");
    expect(new Date(x509.validTo).toISOString()).toBe("2051-01-01T00:00:00.000Z");
    expect(x509.publicKey.asymmetricKeyDetails?.namedCurve).toBe("secp384r1");
    expect(x509.verify(x509.publicKey)).toBe(true);
  });

  it("puts a given key in a fresh certificate, and a fresh key in every other", () => {
    const first = makeTestCert();
    const again = makeTestCert({ privateKey: first.privateKey });
    expect(again.spkiSha256).toBe(first.spkiSha256);
    expect(again.serial).not.toBe(first.serial);
    expect(makeTestCert().spkiSha256).not.toBe(first.spkiSha256);
    expect(new X509Certificate(again.cert).checkPrivateKey(makeTestCert().privateKey)).toBe(false);
  });
});

describe("ipBytes", () => {
  it("gives an address's bytes, v4 or v6, and null for anything else", () => {
    expect(ipBytes("203.0.113.7")).toEqual(Buffer.from([203, 0, 113, 7]));
    expect(ipBytes("2001:db8::17")?.toString("hex")).toBe("20010db8000000000000000000000017");
    expect(ipBytes("2001:db8:5:17:ffff:1:2:3")?.toString("hex")).toBe("20010db800050017ffff000100020003");
    expect(ipBytes("::ffff:198.51.100.23")?.toString("hex")).toBe("00000000000000000000ffffc6336417");
    expect(ipBytes("livs-air.local")).toBeNull();
    expect(ipBytes("300.0.0.1")).toBeNull();
  });
});
