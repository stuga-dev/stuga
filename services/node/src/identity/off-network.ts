/**
 * Passwords over plain http come only from the node's own network (docs/network-access.md). When the
 * LAN listener serves http (no TLS_CERT_DIR), a request that carries a password and whose connection
 * comes from a public address is refused before its body is read: on the way there it crossed
 * networks where anyone could read it. "Own network" is a private range (RFC 1918, carrier-grade NAT
 * and Tailscale, loopback, link-local, IPv6 unique-local), the IPv6 subnet of one of this machine's
 * interfaces (a home network's global prefix, which `.local` often resolves to), or a range in
 * LOCAL_PASSWORD_NETWORKS. Interface subnets count only on a machine with no public IPv4 address:
 * one that has one is on a hosting provider's network, whose on-link prefixes (a /20 or /24 of IPv4,
 * a /64 of IPv6) other customers share; a home machine sits behind its router's NAT.
 *
 * It only refuses: it never makes a request count as the remote address, which only the listener
 * decides. It reads the connection's own peer, never X-Forwarded-For, and a connection with none
 * (a unix socket) passes. Where the node sees only a gateway's private address (rootless Docker or
 * Podman, docker-proxy, Swarm ingress, Kubernetes SNAT, Docker Desktop), it passes everything; there
 * HOST_BIND keeps the port off the internet.
 */
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import { isNonPublicAddress } from "../net/addresses.js";
import { inCidr, parseCidr, type Cidr } from "../net/cidr.js";
import { arrivalOf } from "../http/arrival.js";
import { PEER_ADDRESS_HEADER } from "../platform/http-server.js";
import { fail } from "./http.js";

/** Where a password is sent: to sign in, to set or change one, to confirm who you are, and Revoke everything's new one. */
export const PASSWORD_PATHS: ReadonlySet<string> = new Set([
  "/auth/login",
  "/auth/register",
  "/auth/password",
  "/auth/reset",
  "/auth/oidc/link",
  "/auth/confirm",
  "/auth/revoke-everything",
]);

/** How often a refusal is logged. */
const WARN_EVERY_MS = 60 * 60 * 1000;
/** How long the machine's own subnets are trusted before they are read again: interfaces come and go. */
const INTERFACES_TTL_MS = 60 * 1000;

/**
 * This machine's own IPv6 subnets, as its interfaces report them; none when any interface carries a
 * public IPv4 address. Its IPv4 subnets are private ranges already, or a provider's shared one.
 */
function interfaceSubnets(read: () => NodeJS.Dict<NetworkInterfaceInfo[]>): Cidr[] {
  const infos = Object.values(read()).flatMap((list) => list ?? []);
  const v6 = (info: NetworkInterfaceInfo) => info.address.includes(":");
  if (infos.some((info) => !v6(info) && !isNonPublicAddress(info.address))) return [];
  const out: Cidr[] = [];
  for (const info of infos) {
    const cidr = v6(info) && info.cidr ? parseCidr(info.cidr) : null;
    if (cidr) out.push(cidr);
  }
  return out;
}

export interface PasswordNetworkOptions {
  /** The LAN listener serves https (TLS_CERT_DIR): nothing crosses in the clear, and nothing is refused. */
  tls: boolean;
  /** LOCAL_PASSWORD_NETWORKS. */
  networks: readonly Cidr[];
  /** The remote address while it is on, which the refusal points to; null otherwise. */
  remoteOrigin: () => string | null;
  /** Tests. */
  interfaces?: () => NodeJS.Dict<NetworkInterfaceInfo[]>;
  warn?: (message: string) => void;
  now?: () => number;
}

/**
 * The check: null to let a request through, the 403 to refuse it. Asked of every request that sends
 * a password: by the LAN listener's front door for /auth/*, and by checkPassword for the rest.
 */
export type PasswordNetworkCheck = (req: Request) => Response | null;

export function createPasswordNetworkCheck(options: PasswordNetworkOptions): PasswordNetworkCheck {
  if (options.tls) return () => null;
  const read = options.interfaces ?? networkInterfaces;
  const warn = options.warn ?? ((m: string) => console.warn(m));
  const now = options.now ?? Date.now;
  let subnets: Cidr[] = [];
  let readAt = -Infinity;
  let warnedAt = -Infinity;

  function ownNetwork(peer: string): boolean {
    if (isNonPublicAddress(peer)) return true;
    if (options.networks.some((cidr) => inCidr(peer, cidr))) return true;
    if (now() - readAt >= INTERFACES_TTL_MS) {
      try {
        subnets = interfaceSubnets(read);
      } catch {
        subnets = [];
      }
      readAt = now();
    }
    return subnets.some((cidr) => inCidr(peer, cidr));
  }

  return (req) => {
    if (arrivalOf(req) === "remote") return null;
    const peer = req.headers.get(PEER_ADDRESS_HEADER)?.trim();
    if (!peer || ownNetwork(peer)) return null;
    if (now() - warnedAt >= WARN_EVERY_MS) {
      warnedAt = now();
      warn(
        `[node] refused a password sent over plain http from ${peer}, outside this node's network. ` +
          `Set HOST_BIND to keep the port on your network, or list the range in LOCAL_PASSWORD_NETWORKS (docs/network-access.md).`,
      );
    }
    const remote = options.remoteOrigin();
    const elsewhere = remote ? `From anywhere else, use ${remote}.` : "Open it through an SSH tunnel or set up HTTPS.";
    return fail(403, "password_off_network", `Passwords work here only from this node's network. ${elsewhere}`);
  };
}
