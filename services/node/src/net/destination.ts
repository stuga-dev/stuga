/**
 * Where the node may connect for a URL someone else chose: globally reachable unicast only, and
 * never this machine or its own IPv6 network. Stricter than isNonPublicAddress, which also decides
 * who counts as being on the node's network (passwords over plain http), so it stays as it is.
 */
import { isIP } from "node:net";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import { isLocalName } from "./addresses.js";
import { ipv4Bits, ipv6Bits, parseCidr, type Cidr } from "./cidr.js";

/** Why an address is refused: private or reserved, or one a fake-IP proxy hands out. */
export type ForbiddenReason = "private" | "fake-ip";

/** `10.0.0.0/8` or `::ffff:0:0/96`, read in the family it is written in. */
function block(text: string): Cidr {
  const [address = "", prefix] = text.split("/");
  const v4 = ipv4Bits(address);
  return v4 !== null ? { family: 4, bits: v4, prefix: Number(prefix) } : { family: 6, bits: ipv6Bits(address)!, prefix: Number(prefix) };
}
const blocks = (list: string[]): Cidr[] => list.map(block);

/** Every IPv4 block IANA marks not globally reachable, plus multicast and Azure's WireServer. */
const V4_DENY = blocks([
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.88.99.0/24",
  "192.168.0.0/16",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
  "168.63.129.16/32",
]);
/** Benchmarking space, where Clash, Surge and sing-box in fake-IP mode answer every name. */
const V4_FAKE_IP = block("198.18.0.0/15");

/** IPv6 is allowed only in global unicast, minus Teredo and the IETF block, documentation and 6to4. */
const V6_GLOBAL = block("2000::/3");
const V6_DENY = blocks(["2001::/23", "2001:db8::/32", "2002::/16", "3fff::/20"]);
/** IPv6 forms that carry an IPv4 address in their last 32 bits: mapped, and the well-known NAT64 prefix. */
const V6_EMBEDS_V4 = blocks(["::ffff:0:0/96", "64:ff9b::/96"]);

const within = (bits: bigint, width: bigint, block: Cidr): boolean => {
  const shift = width - BigInt(block.prefix);
  return bits >> shift === block.bits >> shift;
};

/** This machine's own addresses, and the IPv6 networks its interfaces sit on. */
interface OwnNetwork {
  v4: Set<bigint>;
  v6: Cidr[];
}

/** Read now, never kept: none when the interfaces cannot be read. */
function readOwnNetwork(read: () => NodeJS.Dict<NetworkInterfaceInfo[]>): OwnNetwork {
  const own: OwnNetwork = { v4: new Set(), v6: [] };
  let interfaces: NetworkInterfaceInfo[];
  try {
    interfaces = Object.values(read()).flatMap((list) => list ?? []);
  } catch {
    return own;
  }
  for (const info of interfaces) {
    const v4 = ipv4Bits(info.address);
    if (v4 !== null) {
      own.v4.add(v4);
      continue;
    }
    // At the mask the interface reports, never a guessed /48 or /56.
    const cidr = parseCidr(info.cidr ?? info.address);
    if (cidr?.family === 6) own.v6.push(cidr);
  }
  return own;
}

export interface DestinationOptions {
  /** Tests. */
  interfaces?: () => NodeJS.Dict<NetworkInterfaceInfo[]>;
}

/**
 * The rule, with this machine's own network read from `interfaces` at every check: a machine that
 * joins another network has another IPv6 prefix at once, and the read is cheap.
 */
export function createForbiddenReason(options: DestinationOptions = {}): (ip: string) => ForbiddenReason | null {
  const read = options.interfaces ?? networkInterfaces;
  const ownNetwork = () => readOwnNetwork(read);

  function v4Reason(bits: bigint): ForbiddenReason | null {
    if (within(bits, 32n, V4_FAKE_IP)) return "fake-ip";
    if (V4_DENY.some((block) => within(bits, 32n, block))) return "private";
    return ownNetwork().v4.has(bits) ? "private" : null;
  }

  /** A numeric address, bracketed or not; anything that is not one is refused. */
  return (ip) => {
    const plain = ip.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
    const family = isIP(plain);
    if (family === 4) return v4Reason(ipv4Bits(plain)!);
    if (family !== 6) return "private";
    const bits = ipv6Bits(plain);
    if (bits === null) return "private";
    if (V6_EMBEDS_V4.some((block) => within(bits, 128n, block))) return v4Reason(bits & 0xffffffffn);
    if (!within(bits, 128n, V6_GLOBAL) || V6_DENY.some((block) => within(bits, 128n, block))) return "private";
    return ownNetwork().v6.some((block) => within(bits, 128n, block)) ? "private" : null;
  };
}

/** Why the node must not connect to `ip`, or null when it may. */
export const forbiddenReason = createForbiddenReason();

/**
 * A name that means this machine or its network without resolving anything: localhost, .local,
 * .internal, .home.arpa, or a single label, which only a local search domain completes.
 */
export function isRefusedName(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, "");
  return isLocalName(name) || !name.includes(".");
}
