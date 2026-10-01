import type { NetworkInterfaceInfo } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { createLocalFrontDoor } from "../http/front-door.js";
import { parseCidr } from "../net/cidr.js";
import { ARRIVAL_HEADER, PEER_ADDRESS_HEADER } from "../platform/http-server.js";
import { PASSWORD_PATHS, createPasswordNetworkCheck, type PasswordNetworkOptions } from "./off-network.js";

const ORIGIN = "http://livs-air.local:8787";
const REMOTE = "https://k7f3q2.mystuga.com";

/** This machine: a home LAN with a global IPv6 prefix beside its private IPv4 one. */
const interfaces = (): NodeJS.Dict<NetworkInterfaceInfo[]> => ({
  en0: [
    { address: "192.168.1.50", netmask: "255.255.255.0", family: "IPv4", mac: "", internal: false, cidr: "192.168.1.50/24" },
    { address: "2001:db8:aa:1::50", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", mac: "", internal: false, cidr: "2001:db8:aa:1::50/64", scopeid: 0 },
  ],
});

function check(over: Partial<PasswordNetworkOptions> = {}) {
  return createPasswordNetworkCheck({ tls: false, networks: [], remoteOrigin: () => null, interfaces, warn: () => {}, ...over });
}

const from = (peer: string | null, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(peer ? { [PEER_ADDRESS_HEADER]: peer } : {}), ...headers },
    body: "{}",
  });

describe("passwords over plain http", () => {
  it("come from private ranges, Tailscale, loopback and link-local, IPv4-mapped or not", () => {
    const c = check();
    for (const peer of [
      "10.1.2.3",
      "172.16.0.9",
      "172.31.255.1",
      "192.168.7.7",
      "100.64.0.1",
      "100.101.102.103",
      "127.0.0.1",
      "169.254.3.3",
      "::1",
      "fd7a:115c:a1e0::1",
      "fe80::1",
      "::ffff:192.168.7.7",
      "::ffff:10.0.0.1",
    ]) {
      expect(c(from(peer)), peer).toBeNull();
    }
  });

  it("come from a subnet of this machine's own interfaces, such as a home network's global IPv6 prefix", () => {
    expect(check()(from("2001:db8:aa:1::77"))).toBeNull();
  });

  it("never from a hosting provider's shared on-link prefix: a machine with a public IPv4 address trusts no interface subnet", () => {
    // A VPS: its public IPv4 /20 and its IPv6 /64 hold other customers' servers.
    const vps = (): NodeJS.Dict<NetworkInterfaceInfo[]> => ({
      eth0: [
        { address: "198.51.100.50", netmask: "255.255.240.0", family: "IPv4", mac: "", internal: false, cidr: "198.51.100.50/20" },
        { address: "2001:db8:cc:1::50", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", mac: "", internal: false, cidr: "2001:db8:cc:1::50/64", scopeid: 0 },
      ],
    });
    const c = check({ interfaces: vps });
    for (const neighbour of ["198.51.100.99", "2001:db8:cc:1::99"]) expect(c(from(neighbour))?.status, neighbour).toBe(403);
    // Private ranges and LOCAL_PASSWORD_NETWORKS still count.
    expect(c(from("10.0.0.5"))).toBeNull();
    expect(check({ interfaces: vps, networks: [parseCidr("198.51.100.0/20")!] })(from("198.51.100.99"))).toBeNull();
  });

  it("are refused from a public address, IPv4 or IPv6, before anything is read", async () => {
    for (const peer of ["203.0.113.7", "::ffff:203.0.113.7", "2001:db8:bb::1", "8.8.8.8"]) {
      const res = check()(from(peer));
      expect(res?.status, peer).toBe(403);
      expect(await res!.json()).toEqual({
        error: "password_off_network",
        message: "Passwords work here only from this node's network. Open it through an SSH tunnel or set up HTTPS.",
      });
    }
  });

  it("point to the remote address while it is on", async () => {
    const res = check({ remoteOrigin: () => REMOTE })(from("203.0.113.7"));
    expect((await res!.json()).message).toBe(`Passwords work here only from this node's network. From anywhere else, use ${REMOTE}.`);
  });

  it("come from the ranges LOCAL_PASSWORD_NETWORKS names", () => {
    const c = check({ networks: [parseCidr("203.0.113.0/24")!, parseCidr("2001:db8:bb::/48")!] });
    expect(c(from("203.0.113.7"))).toBeNull();
    expect(c(from("2001:db8:bb:4::1"))).toBeNull();
    expect(c(from("198.51.100.1"))).not.toBeNull();
  });

  it("are taken from anywhere when the listener serves https (TLS_CERT_DIR)", () => {
    expect(check({ tls: true })(from("203.0.113.7"))).toBeNull();
  });

  it("never believe X-Forwarded-For, either way", () => {
    expect(check()(from("203.0.113.7", { "x-forwarded-for": "192.168.1.9" }))).not.toBeNull();
    expect(check()(from("192.168.1.9", { "x-forwarded-for": "203.0.113.7" }))).toBeNull();
  });

  it("pass a connection with no address of its own (a unix socket)", () => {
    expect(check()(from(null))).toBeNull();
  });

  it("leave the remote address alone, which has its own rules", () => {
    expect(check()(from("203.0.113.7", { [ARRIVAL_HEADER]: "remote" }))).toBeNull();
  });

  it("log a refusal at most once an hour", () => {
    let t = 0;
    const warn = vi.fn();
    const c = check({ warn, now: () => t });
    c(from("203.0.113.7"));
    c(from("203.0.113.8"));
    expect(warn).toHaveBeenCalledOnce();
    t += 60 * 60 * 1000;
    c(from("203.0.113.9"));
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe("the LAN listener's front door", () => {
  const door = createLocalFrontDoor(check());
  const head = (method: string, path: string, peer: string) =>
    new Request(`${ORIGIN}${path}`, { method, headers: { [PEER_ADDRESS_HEADER]: peer } });

  it("refuses every route that takes a password, claiming the node and redeeming a reset link included", async () => {
    expect([...PASSWORD_PATHS].sort()).toEqual([
      "/auth/confirm",
      "/auth/login",
      "/auth/oidc/link",
      "/auth/password",
      "/auth/register",
      "/auth/reset",
      "/auth/revoke-everything",
    ]);
    for (const path of PASSWORD_PATHS) {
      const answer = await door(head("POST", path, "203.0.113.7"));
      expect(answer instanceof Response && answer.status, path).toBe(403);
    }
  });

  it("lets everything else through as before, from anywhere", async () => {
    for (const [method, path] of [
      ["GET", "/auth/config"],
      ["POST", "/auth/refresh"],
      ["POST", "/auth/oidc/start"],
      ["GET", "/"],
      ["POST", "/api/workspaces"],
    ] as const) {
      expect(await door(head(method, path, "203.0.113.7")), `${method} ${path}`).toEqual({});
    }
    expect(await door(head("POST", "/auth/login", "192.168.1.9"))).toEqual({});
  });
});
