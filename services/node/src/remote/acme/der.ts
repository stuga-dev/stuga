/**
 * Just enough DER for ACME: a PKCS#10 request with an empty subject and one dNSName, which is all a
 * CA reads from it; the two fields of a certificate that name it to the CA's renewal information
 * (RFC 9773); and the PEM wrapping either side of them.
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

/** One DER element: its tag, and where its contents start and end in the buffer. */
interface Element {
  tag: number;
  start: number;
  end: number;
}

function element(buf: Buffer, at: number, end = buf.length): Element {
  if (at + 2 > end) throw new Error("DER runs out");
  const tag = buf[at]!;
  let length = buf[at + 1]!;
  let start = at + 2;
  if (length & 0x80) {
    const n = length & 0x7f;
    // DER has no indefinite length, and nothing in a certificate needs more than four bytes of it.
    if (n === 0 || n > 4 || start + n > end) throw new Error("DER length is not one");
    length = 0;
    for (let i = 0; i < n; i++) length = length * 256 + buf[start + i]!;
    start += n;
  }
  if (start + length > end) throw new Error("DER runs out");
  return { tag, start, end: start + length };
}

function children(buf: Buffer, parent: Element): Element[] {
  const out: Element[] = [];
  for (let at = parent.start; at < parent.end; ) {
    const child = element(buf, at, parent.end);
    out.push(child);
    at = child.end;
  }
  return out;
}

/** 2.5.29.35, authorityKeyIdentifier. */
const OID_AUTHORITY_KEY_ID = Buffer.from("551d23", "hex");

/**
 * The certificate's identifier for the CA's renewal information and for an order's `replaces`
 * (RFC 9773 4.1): its authority key identifier's keyIdentifier and its serial's DER contents, a
 * leading zero byte included, each base64url, joined by a dot. Null when it has no keyIdentifier or
 * does not parse.
 */
export function ariCertId(der: Buffer): string | null {
  try {
    const certificate = element(der, 0);
    const tbs = children(der, certificate)[0];
    if (certificate.tag !== 0x30 || tbs?.tag !== 0x30) return null;
    const fields = children(der, tbs);
    // [0] version, then the serial.
    const serial = fields[fields[0]?.tag === 0xa0 ? 1 : 0];
    if (serial?.tag !== 0x02 || serial.end === serial.start) return null;
    const extensions = fields.find((f) => f.tag === 0xa3);
    if (!extensions) return null;
    const list = children(der, extensions)[0];
    if (list?.tag !== 0x30) return null;
    for (const extension of children(der, list)) {
      const [id, ...rest] = children(der, extension);
      if (id?.tag !== 0x06 || !der.subarray(id.start, id.end).equals(OID_AUTHORITY_KEY_ID)) continue;
      // critical BOOLEAN DEFAULT FALSE, then the OCTET STRING holding the extension's value.
      const value = rest.at(-1);
      if (value?.tag !== 0x04) return null;
      const aki = element(der, value.start, value.end);
      if (aki.tag !== 0x30) return null;
      // keyIdentifier [0] IMPLICIT OCTET STRING.
      const keyId = children(der, aki).find((f) => f.tag === 0x80);
      if (!keyId || keyId.end === keyId.start) return null;
      const b64 = (e: Element) => der.subarray(e.start, e.end).toString("base64url");
      return `${b64(keyId)}.${b64(serial)}`;
    }
    return null;
  } catch {
    return null;
  }
}
