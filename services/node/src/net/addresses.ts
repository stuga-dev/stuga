/** Whether a host means something only on this machine or its network: for outbound vetting and agent reachability. */

/** Names that resolve only on this machine or the network it sits on. */
const LOCAL_NAME_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];

/** Lowercased, with IPv6 brackets and any zone id ("fe80::1%eth0") removed. */
function bare(host: string): string {
  return host.toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
}

/** The four octets of a dotted-quad, or null when the host is not one. */
function ipv4Octets(host: string): [number, number, number, number] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : -1));
  if (octets.some((n) => n < 0 || n > 255)) return null;
  return octets as [number, number, number, number];
}

/** An IPv4-mapped IPv6 address (::ffff:127.0.0.1, ::ffff:7f00:1) as a dotted quad. */
function unwrapMappedV4(h: string): string | null {
  const dotted = /^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h);
  if (dotted) return dotted[1]!;
  const hex = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (!hex) return null;
  const hi = parseInt(hex[1]!, 16);
  const lo = parseInt(hex[2]!, 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/** An IPv4 client as a dual-stack socket names it (`::ffff:203.0.113.7`) back as `203.0.113.7`; anything else as given. */
export function unmappedAddress(address: string): string {
  return unwrapMappedV4(bare(address)) ?? address;
}

/** Is this host written as a numeric address rather than a name to resolve? */
export function isIpLiteral(host: string): boolean {
  const h = bare(host);
  return h.includes(":") || ipv4Octets(h) !== null;
}

/** A name that means this machine or its network without resolving anything. */
export function isLocalName(host: string): boolean {
  const h = bare(host);
  return h === "localhost" || LOCAL_NAME_SUFFIXES.some((suffix) => h.endsWith(suffix));
}

/** Loopback: localhost names, 127/8, ::1, and 127/8 mapped into IPv6. */
export function isLoopbackHost(host: string): boolean {
  const h = bare(host);
  if (h === "localhost" || h.endsWith(".localhost") || h === "::1") return true;
  const v4 = ipv4Octets(unwrapMappedV4(h) ?? h);
  return v4 !== null && v4[0] === 127;
}

/**
 * A numeric address nobody outside this machine or network can reach: unspecified, loopback,
 * RFC 1918, link-local, carrier-grade NAT, IPv6 unique-local or link-local. Never pass a name.
 */
export function isNonPublicAddress(ip: string): boolean {
  const h = bare(ip);
  const v4 = ipv4Octets(unwrapMappedV4(h) ?? h);
  if (v4) {
    const [a, b] = v4;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return a === 100 && b >= 64 && b <= 127;
  }
  if (!h.includes(":")) return false;
  if (h === "::" || h === "::1") return true;
  return /^fe[89ab]/.test(h) || /^f[cd]/.test(h);
}

/**
 * What a per-source count is keyed on: an IPv6 address by its /64, which one subscriber holds whole
 * and can walk through at will (`2001:db8:5:17::/64`); anything else as given.
 */
export function perSubnet(address: string): string {
  const groups = ipv6Groups(bare(address));
  if (!groups) return address;
  return `${groups
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(":")}::/64`;
}

/**
 * The wider block a per-source count also keys on: an IPv6 address's /48, the size a site is
 * commonly given, holding 65,536 /64s. Null for anything else: IPv4 has no such block.
 */
export function perSite(address: string): string | null {
  const h = bare(address);
  if (unwrapMappedV4(h) !== null) return null;
  const groups = ipv6Groups(h);
  if (!groups) return null;
  return `${groups
    .slice(0, 3)
    .map((g) => g.toString(16))
    .join(":")}::/48`;
}

/** The eight groups of an IPv6 address, a dotted-quad tail included, or null when it is not one. */
function ipv6Groups(h: string): number[] | null {
  if (!h.includes(":")) return null;
  let text = h;
  const tail = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(text);
  if (tail) {
    const v4 = ipv4Octets(tail[1]!);
    if (!v4) return null;
    text = `${text.slice(0, tail.index)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === "") return [];
    const out = part.split(":").map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : -1));
    return out.some((g) => g < 0) ? null : out;
  };
  const head = parse(halves[0]!);
  const rest = halves.length === 2 ? parse(halves[1]!) : [];
  if (!head || !rest) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const zeros = 8 - head.length - rest.length;
  return zeros >= 1 ? [...head, ...Array.from({ length: zeros }, () => 0), ...rest] : null;
}
