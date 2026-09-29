/**
 * The PROXY protocol v2 header the remote connector writes ahead of each visitor's bytes: where the
 * visitor connected from. Only the one shape the connector sends is taken, a PROXY command for TCP
 * over IPv4 or IPv6; anything else is refused rather than guessed at, since the address becomes the
 * visitor's identity for every budget. TLVs are skipped.
 */

export type ProxyV2Result =
  | { kind: "need-more" }
  | { kind: "ok"; source: { address: string; port: number }; headerLength: number }
  | { kind: "reject"; reason: string };

const SIGNATURE = Buffer.from("0d0a0d0a000d0a515549540a", "hex");
/** Signature, version and command, family and protocol, length. */
const FIXED_BYTES = 16;
const MAX_HEADER_BYTES = 512;
const VERSION_2_PROXY = 0x21;
const TCP_OVER_IPV4 = 0x11;
const TCP_OVER_IPV6 = 0x21;
/** Source and destination address, then source and destination port. */
const IPV4_ADDRESS_BYTES = 12;
const IPV6_ADDRESS_BYTES = 36;

/** Parse a header from the start of `buf`, or say more bytes are needed first. Never throws. */
export function parseProxyV2(buf: Buffer): ProxyV2Result {
  const reject = (reason: string): ProxyV2Result => ({ kind: "reject", reason });
  // Each byte is judged as soon as it is in, so a stranger's bytes are refused without waiting for more.
  const prefix = Math.min(buf.length, SIGNATURE.length);
  if (!buf.subarray(0, prefix).equals(SIGNATURE.subarray(0, prefix))) return reject("not a PROXY v2 header");
  if (buf.length > 12 && buf[12] !== VERSION_2_PROXY) return reject("not a v2 PROXY command");
  const family = buf[13];
  if (buf.length > 13 && family !== TCP_OVER_IPV4 && family !== TCP_OVER_IPV6) return reject("not TCP over IPv4 or IPv6");
  if (buf.length < FIXED_BYTES) return { kind: "need-more" };
  const length = buf.readUInt16BE(14);
  const headerLength = FIXED_BYTES + length;
  if (headerLength > MAX_HEADER_BYTES) return reject("header too long");
  if (length < (family === TCP_OVER_IPV4 ? IPV4_ADDRESS_BYTES : IPV6_ADDRESS_BYTES)) return reject("addresses truncated");
  if (buf.length < headerLength) return { kind: "need-more" };

  if (family === TCP_OVER_IPV4) {
    return { kind: "ok", source: { address: ipv4(buf.subarray(16, 20)), port: buf.readUInt16BE(24) }, headerLength };
  }
  return { kind: "ok", source: { address: ipv6(buf.subarray(16, 32)), port: buf.readUInt16BE(48) }, headerLength };
}

function ipv4(bytes: Buffer): string {
  return `${bytes[0]}.${bytes[1]}.${bytes[2]}.${bytes[3]}`;
}

/**
 * RFC 5952 text: lowercase, no leading zeros, the longest run of zero groups as `::`. An
 * IPv4-mapped address (`::ffff:a.b.c.d`) is the IPv4 address: the connector writes one when the
 * visitor and the relay spoke different families.
 */
function ipv6(bytes: Buffer): string {
  const groups = Array.from({ length: 8 }, (_, i) => bytes.readUInt16BE(i * 2));
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) return ipv4(bytes.subarray(12, 16));
  let bestStart = -1;
  let bestLength = 1;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j += 1;
    if (j - i > bestLength) {
      bestStart = i;
      bestLength = j - i;
    }
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (bestStart < 0) return hex.join(":");
  return `${hex.slice(0, bestStart).join(":")}::${hex.slice(bestStart + bestLength).join(":")}`;
}
