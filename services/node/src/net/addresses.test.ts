import { describe, expect, it } from "vitest";
import { isIpLiteral, isLocalName, isLoopbackHost, isNonPublicAddress, perSite, perSubnet, unmappedAddress } from "./addresses.js";
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

describe("perSubnet", () => {
  it("keys an IPv6 address on its /64, however it is written", () => {
    expect(perSubnet("2001:db8:5:17::abcd")).toBe("2001:db8:5:17::/64");
    expect(perSubnet("2001:0db8:0005:0017:ffff:1:2:3")).toBe("2001:db8:5:17::/64");
    expect(perSubnet("2001:DB8::1")).toBe("2001:db8:0:0::/64");
    expect(perSubnet("::1")).toBe("0:0:0:0::/64");
    expect(perSubnet("64:ff9b::192.0.2.33")).toBe("64:ff9b:0:0::/64");
  });

  it("keeps anything else as given", () => {
    expect(perSubnet("203.0.113.7")).toBe("203.0.113.7");
    expect(perSubnet("unknown")).toBe("unknown");
    expect(perSubnet("1:2:3")).toBe("1:2:3");
    expect(perSubnet("1::2::3")).toBe("1::2::3");
  });
});

describe("perSite", () => {
  it("keys an IPv6 address on its /48", () => {
    expect(perSite("2001:db8:5:17::abcd")).toBe("2001:db8:5::/48");
    expect(perSite("2001:db8:5:ffff:1:2:3:4")).toBe("2001:db8:5::/48");
  });

  it("has no block for IPv4, mapped or not", () => {
    expect(perSite("203.0.113.7")).toBeNull();
    expect(perSite("::ffff:203.0.113.7")).toBeNull();
    expect(perSite("unknown")).toBeNull();
  });
});

describe("unmappedAddress", () => {
  it("names an IPv4 client the way IPv4 does", () => {
    expect(unmappedAddress("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(unmappedAddress("2001:db8::1")).toBe("2001:db8::1");
    expect(unmappedAddress("203.0.113.7")).toBe("203.0.113.7");
  });
});
