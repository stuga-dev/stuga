import { describe, expect, it } from "vitest";
import type { RemoteAccessView } from "../env.js";
import { ARRIVAL_HEADER, PEER_ADDRESS_HEADER } from "../platform/http-server.js";
import { arrivalOf, clientBucket, ownOrigins, servedOrigin } from "./arrival.js";

const REMOTE = "https://k7f3q2.stuga.test";

/** A request as a listener hands it on: rebuilt on its origin, stamped with where it came from. */
const arrived = (origin: string, arrival: "local" | "remote" | null, peer: string, headers: Record<string, string> = {}) =>
  new Request(`${origin}/auth/login`, {
    headers: { ...(arrival ? { [ARRIVAL_HEADER]: arrival } : {}), [PEER_ADDRESS_HEADER]: peer, ...headers },
  });

const view = (current: ReturnType<RemoteAccessView["current"]>): RemoteAccessView => ({ current: () => current });

describe("arrivalOf and servedOrigin", () => {
  it("read the listener's stamp and the URL it rebuilt", () => {
    const remote = arrived(REMOTE, "remote", "203.0.113.7");
    expect(arrivalOf(remote)).toBe("remote");
    expect(servedOrigin(remote)).toBe(REMOTE);
    const lan = arrived("http://livs-air.local:8787", "local", "10.0.0.7");
    expect(arrivalOf(lan)).toBe("local");
    expect(servedOrigin(lan)).toBe("http://livs-air.local:8787");
  });

  it("take a request no listener stamped as local", () => {
    expect(arrivalOf(new Request("https://node.test/"))).toBe("local");
    expect(arrivalOf(arrived(REMOTE, null, "203.0.113.7", { [ARRIVAL_HEADER]: "Remote" }))).toBe("local");
  });
});

describe("clientBucket", () => {
  it("keeps the LAN and the remote address apart, one address alike", () => {
    expect(clientBucket(arrived(REMOTE, "remote", "203.0.113.7"), false)).toBe("remote:203.0.113.7");
    expect(clientBucket(arrived("http://node.test", "local", "203.0.113.7"), false)).toBe("local:203.0.113.7");
  });

  it("counts a remote IPv6 visitor by its /64, which one subscriber can walk through", () => {
    const a = clientBucket(arrived(REMOTE, "remote", "2001:db8:5:17::1"), false);
    const b = clientBucket(arrived(REMOTE, "remote", "2001:db8:5:17:ffff:ffff:ffff:ffff"), false);
    expect(a).toBe("remote:2001:db8:5:17::/64");
    expect(b).toBe(a);
    expect(clientBucket(arrived(REMOTE, "remote", "2001:db8:5:18::1"), false)).not.toBe(a);
  });

  it("never takes a forwarded address at the remote address, trusted or not", () => {
    const req = arrived(REMOTE, "remote", "203.0.113.7", { "x-forwarded-for": "10.0.0.8" });
    expect(clientBucket(req, true)).toBe("remote:203.0.113.7");
    const lan = arrived("http://node.test", "local", "10.0.0.1", { "x-forwarded-for": "198.51.100.9" });
    expect(clientBucket(lan, true)).toBe("local:198.51.100.9");
  });
});

describe("ownOrigins", () => {
  const env = { publicOrigin: "http://livs-air.local:8787", extraOrigins: ["http://192.168.1.50:8787"] };

  it("are PUBLIC_ORIGIN and EXTRA_ORIGINS without remote access", () => {
    expect(ownOrigins(env)).toEqual(["http://livs-air.local:8787", "http://192.168.1.50:8787"]);
  });

  it("add the remote origin once the node is bound, on or off, and not before", () => {
    const bound = { enabled: false, id: "k7f3q2", hostname: "k7f3q2.stuga.test", origin: REMOTE };
    expect(ownOrigins({ ...env, remote: view(bound) })).toEqual([env.publicOrigin, ...env.extraOrigins, REMOTE]);
    expect(ownOrigins({ ...env, remote: view({ ...bound, enabled: true }) })).toContain(REMOTE);
    expect(ownOrigins({ ...env, remote: view({ enabled: false, id: null, hostname: null, origin: null }) })).toEqual(ownOrigins(env));
  });
});
