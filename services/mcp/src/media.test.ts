import { describe, expect, it } from "vitest";
import { MAX_INLINE_IMAGE_BYTES } from "@stuga/agent-surface/catalog";
import { decodeImage, sniffImageMime } from "./media.js";

const png = () => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const jpeg = () => Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
const gif = () => Uint8Array.from([...Buffer.from("GIF89a"), 0x00]);
const webp = () => Uint8Array.from([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBP")]);
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

describe("sniffImageMime", () => {
  it("names each stored type from its magic bytes", () => {
    expect(sniffImageMime(png())).toBe("image/png");
    expect(sniffImageMime(jpeg())).toBe("image/jpeg");
    expect(sniffImageMime(gif())).toBe("image/gif");
    expect(sniffImageMime(webp())).toBe("image/webp");
  });

  it("refuses SVG and anything else", () => {
    expect(sniffImageMime(Uint8Array.from(Buffer.from("<svg xmlns='http://x'></svg>")))).toBeNull();
    expect(sniffImageMime(Uint8Array.from([0x00, 0x01, 0x02]))).toBeNull();
  });

  it("does not take a RIFF file that is not WebP", () => {
    expect(sniffImageMime(Uint8Array.from([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WAVE")]))).toBeNull();
  });
});

describe("decodeImage", () => {
  it("decodes raw base64 and names the type", () => {
    const out = decodeImage(b64(png()));
    expect(out).toMatchObject({ mime: "image/png" });
    expect("bytes" in out && Array.from(out.bytes.subarray(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("accepts a whole data: URI and whitespace inside the payload", () => {
    expect(decodeImage(`data:image/png;base64,${b64(png())}`)).toMatchObject({ mime: "image/png" });
    expect(decodeImage(b64(png()).replace(/(.{4})/g, "$1\n"))).toMatchObject({ mime: "image/png" });
  });

  it("calls a truncated payload bad base64, not a bad image type", () => {
    expect(decodeImage(b64(png()).slice(0, -1))).toEqual({ error: "image data is not valid base64" });
    expect(decodeImage("not base64!!")).toEqual({ error: "image data is not valid base64" });
  });

  it("refuses an empty payload", () => {
    expect(decodeImage("")).toEqual({ error: "image data is empty" });
    expect(decodeImage("data:image/png;base64,")).toEqual({ error: "image data is empty" });
  });

  it("refuses SVG bytes", () => {
    expect(decodeImage(b64(Uint8Array.from(Buffer.from("<svg xmlns='http://x'/>"))))).toEqual({
      error: "unsupported image type — expected PNG, JPEG, GIF or WebP (SVG is not accepted)",
    });
  });

  it("refuses an oversized image and points at writing its URL instead", () => {
    const big = new Uint8Array(MAX_INLINE_IMAGE_BYTES + 1);
    big.set(png());
    const out = decodeImage(b64(big));
    expect("error" in out && out.error).toContain("image too large (max 3 MB inline)");
    expect("error" in out && out.error).toContain("write its URL into the document with `markdown`");
  });
});
