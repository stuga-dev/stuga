import { describe, expect, it } from "vitest";
import { inCidr, parseCidr } from "./cidr.js";

const cidr = (text: string) => {
  const c = parseCidr(text);
  if (!c) throw new Error(`not a CIDR: ${text}`);
  return c;
};

describe("CIDR ranges", () => {
  it("matches IPv4 inside the prefix and nothing outside it", () => {
    expect(inCidr("203.0.113.9", cidr("203.0.113.0/24"))).toBe(true);
    expect(inCidr("203.0.114.9", cidr("203.0.113.0/24"))).toBe(false);
    expect(inCidr("198.51.100.7", cidr("198.51.100.7"))).toBe(true);
    expect(inCidr("198.51.100.8", cidr("198.51.100.7"))).toBe(false);
    expect(inCidr("1.2.3.4", cidr("0.0.0.0/0"))).toBe(true);
  });

  it("reads an IPv4 client named the IPv6 way as IPv4", () => {
    expect(inCidr("::ffff:203.0.113.9", cidr("203.0.113.0/24"))).toBe(true);
  });

  it("matches IPv6 however it is written", () => {
    const site = cidr("2001:db8:5::/48");
    expect(inCidr("2001:db8:5:17::abcd", site)).toBe(true);
    expect(inCidr("2001:0DB8:0005:ffff:1:2:3:4", site)).toBe(true);
    expect(inCidr("2001:db8:6::1", site)).toBe(false);
    expect(inCidr("fe80::1%en0", cidr("fe80::/10"))).toBe(true);
  });

  it("never matches across families, or what is not an address", () => {
    expect(inCidr("203.0.113.9", cidr("2001:db8::/32"))).toBe(false);
    expect(inCidr("unknown", cidr("0.0.0.0/0"))).toBe(false);
  });

  it("refuses what is not a range", () => {
    for (const bad of ["", "203.0.113.0/33", "2001:db8::/129", "1.2.3", "a.b.c.d/8", "1::2::3/64", "10.0.0.0/8/8", "10.0.0.0/x"]) {
      expect(parseCidr(bad), bad).toBeNull();
    }
  });
});
