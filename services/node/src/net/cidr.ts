/** CIDR ranges, for telling whether an address is on a network the operator named. */
import { unmappedAddress } from "./addresses.js";

/** A parsed CIDR: the address as a big integer, its family and prefix length. */
export interface Cidr {
  family: 4 | 6;
  bits: bigint;
  prefix: number;
}

function v4Bits(text: string): bigint | null {
  const parts = text.split(".");
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return null;
  return parts.reduce((acc, p) => (acc << 8n) | BigInt(Number(p)), 0n);
}

function v6Bits(text: string): bigint | null {
  let h = text.toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const tail = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h);
  if (tail) {
    const v4 = v4Bits(tail[1]!);
    if (v4 === null) return null;
    h = `${h.slice(0, tail.index)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const halves = h.split("::");
  if (halves.length > 2) return null;
  const groups = (part: string): number[] | null => {
    if (part === "") return [];
    const out = part.split(":").map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : -1));
    return out.some((g) => g < 0) ? null : out;
  };
  const head = groups(halves[0]!);
  const rest = halves.length === 2 ? groups(halves[1]!) : [];
  if (!head || !rest) return null;
  let all: number[];
  if (halves.length === 1) {
    if (head.length !== 8) return null;
    all = head;
  } else {
    const zeros = 8 - head.length - rest.length;
    if (zeros < 1) return null;
    all = [...head, ...Array.from({ length: zeros }, () => 0), ...rest];
  }
  return all.reduce((acc, g) => (acc << 16n) | BigInt(g), 0n);
}

/** An address as bits, an IPv4-mapped IPv6 one as IPv4. */
function addressBits(address: string): { family: 4 | 6; bits: bigint } | null {
  const plain = unmappedAddress(address);
  const v4 = v4Bits(plain);
  if (v4 !== null) return { family: 4, bits: v4 };
  const v6 = v6Bits(plain);
  return v6 === null ? null : { family: 6, bits: v6 };
}

/** `203.0.113.0/24`, `2001:db8::/48`, or a single address; null when it is none of these. */
export function parseCidr(text: string): Cidr | null {
  const [address, prefixText, extra] = text.trim().split("/");
  if (!address || extra !== undefined) return null;
  const parsed = addressBits(address);
  if (!parsed) return null;
  const width = parsed.family === 4 ? 32 : 128;
  if (prefixText === undefined) return { ...parsed, prefix: width };
  if (!/^\d{1,3}$/.test(prefixText) || Number(prefixText) > width) return null;
  return { ...parsed, prefix: Number(prefixText) };
}

export function inCidr(address: string, cidr: Cidr): boolean {
  const parsed = addressBits(address);
  if (!parsed || parsed.family !== cidr.family) return false;
  const width = cidr.family === 4 ? 32n : 128n;
  const shift = width - BigInt(cidr.prefix);
  return parsed.bits >> shift === cidr.bits >> shift;
}
