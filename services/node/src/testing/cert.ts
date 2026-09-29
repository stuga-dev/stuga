/**
 * Self-signed certificates made while a test runs: a key from node:crypto and a DER certificate put
 * together by hand, with whatever names, validity and curve the test needs. Nothing here is checked
 * in, and nothing needs openssl. For tests only.
 */
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { ipBytes } from "./remote.js";

export interface TestCertOptions {
  /** dNSName entries in the SAN. Default `["localhost"]`. */
  dnsNames?: string[];
  /** iPAddress entries in the SAN, v4 or v6. */
  ipAddresses?: string[];
  notBefore?: Date;
  /** Default a day after notBefore. */
  notAfter?: Date;
  /** Default P-256. */
  curve?: "P-256" | "P-384";
  /** The certificate's key, instead of a fresh one on `curve`. */
  privateKey?: KeyObject;
  /** The subject's key when the test holds only its public half, as a CA signing a request does; needs `issuerKey`. */
  publicKey?: KeyObject;
  /** Signs the certificate in place of its own key, as a CA's does. */
  issuerKey?: KeyObject;
  /** An authority key identifier with this keyIdentifier, as a CA's leaf carries. */
  authorityKeyId?: Buffer;
  /** The serial's bytes, big-endian; a zero byte goes in front of a high first bit. Default 16 random ones. */
  serial?: Buffer;
}

export interface TestCert {
  /** The private key, PKCS#8 PEM. */
  key: string;
  /** The certificate, PEM. */
  cert: string;
  privateKey: KeyObject;
  der: Buffer;
  /** Lowercase hex, as the certificate carries it. */
  serial: string;
  /** SHA-256 over the SubjectPublicKeyInfo DER, hex. */
  spkiSha256: string;
}

export function makeTestCert(options: TestCertOptions = {}): TestCert {
  const curve = options.curve ?? "P-256";
  const privateKey = options.privateKey ?? generateKeyPairSync("ec", { namedCurve: curve }).privateKey;
  const signer = options.issuerKey ?? privateKey;
  const hash = signer.asymmetricKeyDetails?.namedCurve === "secp384r1" ? "sha384" : "sha256";
  const notBefore = options.notBefore ?? new Date(Date.now() - 60_000);
  const notAfter = options.notAfter ?? new Date(notBefore.getTime() + 24 * 60 * 60 * 1000);
  const spki = (options.publicKey ?? createPublicKey(privateKey)).export({ type: "spki", format: "der" });

  const serialBytes = options.serial ?? randomBytes(16);
  if (!options.serial) serialBytes[0] = (serialBytes[0]! & 0x7f) | 0x01;
  const signatureAlgorithm = seq(oid(hash === "sha384" ? "1.2.840.10045.4.3.3" : "1.2.840.10045.4.3.2"));
  const name = seq(set(seq(oid("2.5.4.3"), tlv(0x0c, Buffer.from("Stuga test")))));
  const names = [
    ...(options.dnsNames ?? (options.ipAddresses ? [] : ["localhost"])).map((n) => tlv(0x82, Buffer.from(n, "ascii"))),
    ...(options.ipAddresses ?? []).map((ip) => {
      const bytes = ipBytes(ip);
      if (!bytes) throw new Error(`not an IP address: ${ip}`);
      return tlv(0x87, bytes);
    }),
  ];
  const akid = options.authorityKeyId ? [seq(oid("2.5.29.35"), tlv(0x04, seq(tlv(0x80, options.authorityKeyId))))] : [];
  const extensions = tlv(0xa3, seq(seq(oid("2.5.29.17"), tlv(0x04, seq(...names))), ...akid));
  const tbs = seq(
    tlv(0xa0, integer(Buffer.from([2]))),
    integer(serialBytes),
    signatureAlgorithm,
    name,
    seq(time(notBefore), time(notAfter)),
    name,
    spki,
    extensions,
  );
  const signature = sign(hash, tbs, signer);
  const der = seq(tbs, signatureAlgorithm, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
  return {
    key: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    cert: pem("CERTIFICATE", der),
    privateKey,
    der,
    serial: serialBytes.toString("hex"),
    spkiSha256: createHash("sha256").update(spki).digest("hex"),
  };
}

function pem(label: string, der: Buffer): string {
  const lines = der.toString("base64").match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

// ---- DER ---------------------------------------------------------------------------

function tlv(tag: number, content: Buffer): Buffer {
  const n = content.length;
  let length: Buffer;
  if (n < 0x80) length = Buffer.from([n]);
  else {
    const bytes: number[] = [];
    for (let rest = n; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
    length = Buffer.from([0x80 | bytes.length, ...bytes]);
  }
  return Buffer.concat([Buffer.from([tag]), length, content]);
}

const seq = (...items: Buffer[]): Buffer => tlv(0x30, Buffer.concat(items));
const set = (...items: Buffer[]): Buffer => tlv(0x31, Buffer.concat(items));

/** A non-negative INTEGER from big-endian bytes. */
function integer(bytes: Buffer): Buffer {
  return tlv(0x02, bytes[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes);
}

function oid(dotted: string): Buffer {
  const [a, b, ...rest] = dotted.split(".").map(Number) as [number, number, ...number[]];
  const out = [40 * a + b];
  for (const arc of rest) {
    const base128: number[] = [arc & 0x7f];
    for (let v = arc >>> 7; v > 0; v >>>= 7) base128.unshift((v & 0x7f) | 0x80);
    out.push(...base128);
  }
  return tlv(0x06, Buffer.from(out));
}

/** UTCTime through 2049, GeneralizedTime after, as RFC 5280 has it. */
function time(d: Date): Buffer {
  const iso = d.toISOString();
  const digits = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
  const year = d.getUTCFullYear();
  if (year >= 1950 && year < 2050) return tlv(0x17, Buffer.from(digits.slice(2), "ascii"));
  return tlv(0x18, Buffer.from(digits, "ascii"));
}
