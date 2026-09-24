import { describe, expect, it } from "vitest";
import { isIpLiteral, isLocalName, isLoopbackHost, isNonPublicAddress } from "./addresses.js";
import { reachableFromInternet } from "../agents/setup.js";

describe("isNonPublicAddress", () => {
  it.each([
    "0.0.0.0",
    "10.1.2.3",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "100.64.0.1",
    "100.127.255.254",
    "::",
    "::1",
    "[::1]",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "fe80::1%eth0",
    "fd12:3456::1",
  ])("%s is not reachable from outside", (ip) => {
    expect(isNonPublicAddress(ip)).toBe(true);
  });

  it.each(["8.8.8.8", "100.63.0.1", "100.128.0.1", "172.32.0.1", "2606:4700::1111", "fec0::1"])("%s is public", (ip) => {
    expect(isNonPublicAddress(ip)).toBe(false);
  });
});

describe("outbound vetting and agent reachability agree", () => {
  it.each(["http://100.101.102.103:8787", "http://[::ffff:c0a8:101]", "http://stuga.home.arpa", "https://app.localhost"])(
    "%s is private to both",
    (origin) => {
      expect(reachableFromInternet(origin)).toBe(false);
      const host = new URL(origin).hostname;
      expect(isIpLiteral(host) ? isNonPublicAddress(host) : isLocalName(host)).toBe(true);
    },
  );

  it("reads loopback through an IPv4-mapped IPv6 address", () => {
    expect(isLoopbackHost("::ffff:7f00:1")).toBe(true);
    expect(isLoopbackHost("192.168.1.1")).toBe(false);
  });
});
