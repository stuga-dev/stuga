/**
 * What the co-author may be told about attached images: only media paths this
 * node serves, since the url is client-chosen and the model uses it verbatim.
 */
import { describe, expect, it } from "vitest";
import { sanitizeAttachments, toBase64 } from "./coauthor/inputs.js";

const HASH = "a".repeat(64);
const ok = { url: `/api/docs/d1/media/${HASH}`, name: "chart.png", mime: "image/png" };

describe("sanitizeAttachments", () => {
  it("keeps a well-formed media path", () => {
    expect(sanitizeAttachments([ok])).toEqual([{ url: ok.url, name: "chart.png" }]);
  });

  it("drops anything that is not a media path on this deployment", () => {
    expect(
      sanitizeAttachments([
        { url: "https://evil.example.com/pixel.gif", name: "x", mime: "image/gif" },
        { url: "/api/docs/d1/media/short", name: "x", mime: "image/png" },
        { url: "/api/docs/d1/media/" + "z".repeat(64), name: "x", mime: "image/png" },
        { url: "javascript:alert(1)", name: "x", mime: "image/png" },
        { url: `/api/docs/d1/media/${HASH}/../../secret`, name: "x", mime: "image/png" },
      ]),
    ).toEqual([]);
  });

  it("accepts a path in ANOTHER document — the hash is the capability", () => {
    const cross = { url: `/api/docs/other-doc/media/${HASH}`, name: "shared.png", mime: "image/png" };
    expect(sanitizeAttachments([cross])).toHaveLength(1);
  });

  it("caps the list and the name length so one frame can't fill the prompt", () => {
    const many = Array.from({ length: 30 }, () => ok);
    expect(sanitizeAttachments(many)).toHaveLength(8);
    const long = sanitizeAttachments([{ ...ok, name: "n".repeat(500) }]);
    expect(long[0]!.name).toHaveLength(120);
  });

  it("survives a malformed or absent list", () => {
    expect(sanitizeAttachments(undefined)).toEqual([]);
    expect(sanitizeAttachments([null as never, { url: 5 } as never])).toEqual([]);
    expect(sanitizeAttachments([{ ...ok, name: undefined as never }])).toEqual([{ url: ok.url, name: "image" }]);
  });
});

describe("toBase64", () => {
  it("round-trips", () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 255, 128]);
    expect(Uint8Array.from(atob(toBase64(bytes)), (c) => c.charCodeAt(0))).toEqual(bytes);
    expect(toBase64(new Uint8Array(0))).toBe("");
  });

  it("encodes a multi-megabyte image without blowing the stack", () => {
    // `String.fromCharCode(...bytes)` throws RangeError somewhere around 100k
    // arguments, so the obvious one-liner works in every test with a 10-byte
    // fixture and dies on the first real photo. Chunked encoding is the fix and
    // this is the only test that would ever have caught it.
    const big = new Uint8Array(3_000_000);
    for (let i = 0; i < big.length; i += 997) big[i] = i % 256;
    const encoded = toBase64(big);
    expect(encoded).toHaveLength(Math.ceil(big.length / 3) * 4);
    const decoded = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
    expect(decoded.length).toBe(big.length);
    expect(decoded[997]).toBe(big[997]);
    expect(decoded[big.length - 1]).toBe(big[big.length - 1]);
  });
});
