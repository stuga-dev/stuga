import type { NetworkInterfaceInfo } from "node:os";
import { describe, expect, it } from "vitest";
import { createForbiddenReason, forbiddenReason, isRefusedName } from "./destination.js";

/** The rule on a machine with no interfaces of its own, so the tables do not depend on where they run. */
const rule = createForbiddenReason({ interfaces: () => ({}) });

describe("where the node may connect for someone else's URL", () => {
  it.each([
    // IPv4 that IANA marks not globally reachable, multicast, and Azure's WireServer.
    "0.0.0.0", "0.1.2.3", "10.0.0.1", "100.64.0.1", "100.100.100.200", "127.0.0.1", "169.254.169.254", "172.16.0.1",
    "192.168.1.1", "192.0.0.1", "192.0.0.2", "192.0.0.8", "192.0.0.170", "192.0.0.192", "192.0.2.1", "192.88.99.1",
    "192.88.99.2", "198.18.0.1", "198.19.255.254", "198.51.100.1", "203.0.113.1", "168.63.129.16", "224.0.0.1",
    "239.255.255.250", "240.0.0.1", "255.255.255.255",
    // IPv6 outside global unicast, and IPv4 inside IPv6.
    "::", "::1", "[::1]", "::ffff:7f00:1", "::ffff:127.0.0.1", "::ffff:a9fe:a9fe", "::7f00:1", "::808:808",
    "::ffff:0:a00:1", "64:ff9b::7f00:1", "64:ff9b::a00:1", "64:ff9b::a9fe:a9fe", "64:ff9b::192.168.1.1",
    "64:ff9b::a83f:8110", "64:ff9b:1::a00:1", "64:ff9b:1::808:808", "100::1", "100:0:0:1::1", "5f00::1", "fc00::1",
    "fd00:ec2::254", "fd7a:115c:a1e0::1", "fe80::1", "fe80::1%en0", "fec0::1", "feff::1", "ff02::1", "ff0e::1",
    "4000::1",
    // Global unicast that is still not global: Teredo and the IETF block, documentation, 6to4.
    "2001::1", "2001:0:4136:e378:8000:63bf:f5ff:fffe", "2001:1::1", "2001:2::1", "2001:3::1", "2001:10::1",
    "2001:20::1", "2001:30::1", "2001:1ff::1", "2001:db8::1", "2002:a00:1::1", "2002:808:808::1", "3fff::1",
    "3fff:fff::1",
    // Not an address in standard form: refused, never guessed at.
    "", "not-an-ip", "010.0.0.1", "127.1", "[fe80::1%25en0]",
  ])("refuses %s", (ip) => {
    expect(rule(ip)).not.toBeNull();
  });

  it.each([
    "8.8.8.8", "1.1.1.1", "192.0.1.1", "192.0.3.1", "192.31.196.1", "192.175.48.1", "198.17.255.255", "198.20.0.1",
    "223.255.255.254", "100.63.255.255", "100.128.0.1", "172.32.0.1", "168.63.129.17", "2606:4700::1111",
    "2001:200::1", "2001:4860:4860::8888", "2620:4f:8000::1", "2a00:1450:4001:80b::200e", "3fff:1000::1",
    "64:ff9b::808:808", "::ffff:8.8.8.8", "::ffff:808:808",
  ])("allows %s", (ip) => {
    expect(rule(ip)).toBeNull();
  });

  it("reads the IPv4 address inside a mapped or NAT64 one, however it is written", () => {
    expect(rule("64:ff9b::808:808")).toBeNull();
    expect(rule("64:ff9b::a00:1")).toBe("private");
    expect(rule("0:0:0:0:0:ffff:7f00:1")).toBe("private");
    expect(rule("0064:ff9b:0000:0000:0000:0000:0a00:0001")).toBe("private");
  });

  it("names the fake-IP range apart, inside IPv6 too", () => {
    expect(rule("198.18.0.1")).toBe("fake-ip");
    expect(rule("198.19.255.254")).toBe("fake-ip");
    expect(rule("::ffff:198.18.0.1")).toBe("fake-ip");
    expect(rule("10.0.0.1")).toBe("private");
  });

  it("refuses this machine's own addresses and its IPv6 networks, at the mask they report", () => {
    const iface = (address: string, cidr: string | null): NetworkInterfaceInfo =>
      ({ address, cidr, family: address.includes(":") ? "IPv6" : "IPv4", netmask: "", mac: "", internal: false }) as NetworkInterfaceInfo;
    const own = createForbiddenReason({
      interfaces: () => ({ en0: [iface("93.184.216.34", "93.184.216.34/24"), iface("2a02:1234:5678:9abc::10", "2a02:1234:5678:9abc::10/64")] }),
    });
    expect(own("93.184.216.34")).toBe("private");
    expect(own("::ffff:93.184.216.34")).toBe("private");
    // An IPv4 network is a provider's or a private range: only the address itself is this machine.
    expect(own("93.184.216.35")).toBeNull();
    expect(own("2a02:1234:5678:9abc::1")).toBe("private");
    expect(own("2a02:1234:5678:9abd::1")).toBeNull();
  });

  it("reads the interfaces at every check, so a network just joined is refused at once", () => {
    let address = "2a02:1234:5678:9abc::10/64";
    const own = createForbiddenReason({
      interfaces: () => ({ en0: [{ address: address.split("/")[0]!, cidr: address, family: "IPv6", netmask: "", mac: "", internal: false, scopeid: 0 }] }),
    });
    expect(own("2a02:1234:5678:9abc::1")).toBe("private");
    expect(own("2a02:1234:5678:ffff::1")).toBeNull();
    address = "2a02:1234:5678:ffff::10/64";
    expect(own("2a02:1234:5678:ffff::1")).toBe("private");
    expect(own("2a02:1234:5678:9abc::1")).toBeNull();
  });

  it("refuses loopback with this machine's real interfaces as well", () => {
    expect(forbiddenReason("127.0.0.1")).toBe("private");
    expect(forbiddenReason("::1")).toBe("private");
  });
});

describe("isRefusedName", () => {
  it.each(["localhost", "LOCALHOST.", "app.localhost", "nas.local", "nas.local.", "metadata.google.internal.", "router.home.arpa", "nas", "nas."])(
    "refuses %s without resolving it",
    (host) => {
      expect(isRefusedName(host)).toBe(true);
    },
  );

  it.each(["example.com", "example.com.", "hooks.slack.com", "local.example.com"])("lets %s resolve", (host) => {
    expect(isRefusedName(host)).toBe(false);
  });
});
