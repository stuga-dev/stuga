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
