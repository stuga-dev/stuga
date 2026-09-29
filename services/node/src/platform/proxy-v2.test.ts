import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseProxyV2 } from "./proxy-v2.js";

const SIGNATURE = Buffer.from("0d0a0d0a000d0a515549540a", "hex");

/** A header as the connector writes one: PROXY over TCP, the visitor as source. */
function header(opts: {
  family?: number;
  command?: number;
  source?: number[];
  port?: number;
  tlvs?: Buffer;
  length?: number;
}): Buffer {
  const family = opts.family ?? 0x11;
  const v6 = (family & 0xf0) === 0x20;
  const addressBytes = v6 ? 16 : 4;
  const source = Buffer.from(opts.source ?? (v6 ? [0x20, 0x01, 0x0d, 0xb8, 0, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x17] : [203, 0, 113, 7]));
  const destination = Buffer.alloc(addressBytes, 1);
  const ports = Buffer.alloc(4);
  ports.writeUInt16BE(opts.port ?? 5555, 0);
  ports.writeUInt16BE(443, 2);
  const body = Buffer.concat([source, destination, ports, opts.tlvs ?? Buffer.alloc(0)]);
  const fixed = Buffer.alloc(4);
  fixed[0] = opts.command ?? 0x21;
  fixed[1] = family;
  fixed.writeUInt16BE(opts.length ?? body.length, 2);
  return Buffer.concat([SIGNATURE, fixed, body]);
}

describe("parseProxyV2", () => {
  it("reads an IPv4 source and says where the header ends", () => {
    const buf = header({});
    expect(parseProxyV2(buf)).toEqual({ kind: "ok", source: { address: "203.0.113.7", port: 5555 }, headerLength: 28 });
  });

  it("reads an IPv6 source in its canonical form", () => {
    expect(parseProxyV2(header({ family: 0x21 }))).toEqual({
      kind: "ok",
      source: { address: "2001:db8:5::17", port: 5555 },
      headerLength: 52,
    });
    const allSet = [0x20, 0x01, 0x0d, 0xb8, 0, 1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6];
    expect(parseProxyV2(header({ family: 0x21, source: allSet }))).toMatchObject({ source: { address: "2001:db8:1:2:3:4:5:6" } });
    const oneZero = [0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1];
    // A single zero group is not shortened (RFC 5952 §4.2.2).
    expect(parseProxyV2(header({ family: 0x21, source: oneZero }))).toMatchObject({ source: { address: "2001:db8:0:1:1:1:1:1" } });
  });

  it("gives an IPv4-mapped source as the IPv4 address it is", () => {
    const mapped = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 198, 51, 100, 23];
    expect(parseProxyV2(header({ family: 0x21, source: mapped }))).toMatchObject({ source: { address: "198.51.100.23" } });
  });

  it("skips TLVs, and leaves every byte after the header to the caller", () => {
    const tlvs = Buffer.from([0x04, 0x00, 0x02, 0xab, 0xcd]);
    const hello = Buffer.from([0x16, 0x03, 0x01, 0x02, 0x00]);
    const buf = Buffer.concat([header({ tlvs }), hello]);
    const parsed = parseProxyV2(buf);
    expect(parsed).toMatchObject({ kind: "ok", headerLength: 33 });
    if (parsed.kind !== "ok") throw new Error("unreachable");
    expect(buf.subarray(parsed.headerLength)).toEqual(hello);
  });

  it("asks for more at every point a header can be split", () => {
    for (const buf of [header({}), header({ family: 0x21 })]) {
      for (let cut = 0; cut < buf.length; cut++) expect(parseProxyV2(buf.subarray(0, cut))).toEqual({ kind: "need-more" });
      expect(parseProxyV2(buf).kind).toBe("ok");
    }
  });

  it.each([
    ["a v1 text header", Buffer.from("PROXY TCP4 203.0.113.7 10.0.0.1 5555 443\r\n")],
    ["a TLS ClientHello with no header", Buffer.from([0x16, 0x03, 0x01, 0x02, 0x00, 0x01])],
    ["a wrong signature", Buffer.concat([Buffer.from("0d0a0d0a000d0a515549540b", "hex"), Buffer.alloc(40)])],
    ["LOCAL", header({ command: 0x20 })],
    ["version 1 in binary", header({ command: 0x11 })],
    ["UNSPEC", header({ family: 0x00 })],
    ["UDP over IPv4", header({ family: 0x12 })],
    ["UDP over IPv6", header({ family: 0x22 })],
    ["UNIX stream", header({ family: 0x31 })],
    ["UNIX datagram", header({ family: 0x32 })],
    ["a header past 512 bytes", header({ tlvs: Buffer.alloc(500) })],
    ["a length too short for IPv4 addresses", header({ length: 11 })],
    ["a length too short for IPv6 addresses", header({ family: 0x21, length: 35 })],
  ])("refuses %s", (_what, buf) => {
    expect(parseProxyV2(buf).kind).toBe("reject");
  });

  it("refuses a bad command or family as soon as its byte arrives", () => {
    expect(parseProxyV2(header({ command: 0x20 }).subarray(0, 13)).kind).toBe("reject");
    expect(parseProxyV2(header({ family: 0x31 }).subarray(0, 14)).kind).toBe("reject");
    expect(parseProxyV2(Buffer.from("PR")).kind).toBe("reject");
  });

  it("never throws or hangs on random bytes", () => {
    const start = Date.now();
    for (let i = 0; i < 100_000; i++) {
      const junk = randomBytes(1 + (i % 96));
      // Half of them behind a real signature, to reach past the first check.
      const buf = i % 2 ? Buffer.concat([SIGNATURE, junk]) : junk;
      const parsed = parseProxyV2(buf);
      expect(["need-more", "ok", "reject"]).toContain(parsed.kind);
      if (parsed.kind === "ok") expect(parsed.headerLength).toBeLessThanOrEqual(Math.min(buf.length, 512));
    }
    expect(Date.now() - start).toBeLessThan(20_000);
  }, 30_000);
});
