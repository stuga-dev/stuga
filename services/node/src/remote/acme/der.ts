/**
 * Just enough DER for ACME: a PKCS#10 request with an empty subject and one dNSName, which is all a
 * CA reads from it, and the PEM wrapping either side of it.
 */
import { createPublicKey, sign, type KeyObject } from "node:crypto";

function tlv(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const n = body.length;
  let length: Buffer;
  if (n < 0x80) length = Buffer.from([n]);
  else {
    const bytes: number[] = [];
    for (let rest = n; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest & 0xff);
    length = Buffer.from([0x80 | bytes.length, ...bytes]);
  }
  return Buffer.concat([Buffer.from([tag]), length, body]);
}

const seq = (...parts: Buffer[]): Buffer => tlv(0x30, ...parts);

/** 1.2.840.113549.1.9.14, PKCS#9 extensionRequest. */
const OID_EXTENSION_REQUEST = Buffer.from("06092a864886f70d01090e", "hex");
/** 2.5.29.17, subjectAltName. */
const OID_SUBJECT_ALT_NAME = Buffer.from("0603551d11", "hex");
/** 1.2.840.10045.4.3.2, ecdsa-with-SHA256. */
const OID_ECDSA_SHA256 = Buffer.from("06082a8648ce3d040302", "hex");

/**
 * A CSR for `hostname` on a P-256 key: version 0, an empty subject, the SAN as an extension request,
 * signed ES256 with the signature in DER, as X.509 has it (unlike a JWS's r||s).
 */
export function csrDer(key: KeyObject, hostname: string): Buffer {
  const spki = createPublicKey(key).export({ type: "spki", format: "der" });
  const san = seq(tlv(0x82, Buffer.from(hostname, "ascii")));
  const extensions = seq(seq(OID_SUBJECT_ALT_NAME, tlv(0x04, san)));
  const attributes = tlv(0xa0, seq(OID_EXTENSION_REQUEST, tlv(0x31, extensions)));
  const info = seq(tlv(0x02, Buffer.from([0])), seq(), spki, attributes);
  const signature = sign("sha256", info, key);
  return seq(info, seq(OID_ECDSA_SHA256), tlv(0x03, Buffer.from([0]), signature));
}

export function toPem(label: string, der: Buffer): string {
  const lines = der.toString("base64").match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

/** Every PEM block with `label` in `text`, in order, each ending in a newline. */
export function pemBlocks(text: string, label: string): string[] {
  const re = new RegExp(`-----BEGIN ${label}-----[\\s\\S]+?-----END ${label}-----`, "g");
  return (text.match(re) ?? []).map((block) => `${block}\n`);
}
