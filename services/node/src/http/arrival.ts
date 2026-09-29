/**
 * Which listener a request came in on, and what follows from it. The LAN listener serves on
 * PUBLIC_ORIGIN; the remote listener serves on the remote origin alone and never answers for the
 * LAN's (docs/remote-access.md). Each rebuilds request URLs on its own origin, so the URL says
 * which one a request was served on.
 */
import type { NodeEnv } from "../env.js";
import { perSubnet } from "../net/addresses.js";
import { ARRIVAL_HEADER, clientAddress, type Arrival } from "../platform/http-server.js";

export { ARRIVAL_HEADER };
export type { Arrival };

/** What the listener stamped; absent (a request a test built by hand) means local. */
export function arrivalOf(req: Request): Arrival {
  return req.headers.get(ARRIVAL_HEADER) === "remote" ? "remote" : "local";
}

/** The origin the request was served on: where links handed back to its caller point. */
export function servedOrigin(req: Request): string {
  return new URL(req.url).origin;
}

/**
 * A per-source budget's key: `${arrival}:${address}`, so the LAN and the remote address never
 * share a bucket. A remote IPv6 address counts by its /64 (`remote:2001:db8:5:17::/64`).
 */
export function clientBucket(req: Request, trustProxyHeaders: boolean): string {
  const arrival = arrivalOf(req);
  const address = clientAddress(req, trustProxyHeaders);
  return `${arrival}:${arrival === "remote" ? perSubnet(address) : address}`;
}

/** This node's own origins: PUBLIC_ORIGIN, EXTRA_ORIGINS, and the remote origin once bound, on or off. */
export function ownOrigins(env: Pick<NodeEnv, "publicOrigin" | "extraOrigins" | "remote">): string[] {
  const origins = [env.publicOrigin, ...env.extraOrigins];
  const remote = env.remote?.current().origin;
  if (remote && !origins.includes(remote)) origins.push(remote);
  return origins;
}
