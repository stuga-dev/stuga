import { beforeEach, describe, expect, it, vi } from "vitest";
import { lookup } from "node:dns/promises";
import { MAX_INLINE_IMAGE_BYTES } from "@stuga/agent-surface/catalog";
import type { SafeImageMime } from "@stuga/protocol/api/media";
import {
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_MAX_UPLOAD_BYTES,
  MediaValidationError,
  decodeBase64Image,
  fetchRemoteImage,
  matchesImageSignature,
  sniffImageMime,
  imageUploadLimits,
  validateImageBytes,
  validateImageUpload,
} from "./media.js";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));
const lookupMock = vi.mocked(lookup);

/** Resolve every name to one public address unless a test says otherwise. */
function resolvesTo(...addresses: string[]) {
  lookupMock.mockResolvedValue(addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })) as never);
}

beforeEach(() => {
  lookupMock.mockReset();
  resolvesTo("93.184.216.34");
});

describe("image upload validation", () => {
  it.each<[SafeImageMime, number[]]>([
    ["image/png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
    ["image/jpeg", [0xff, 0xd8, 0xff, 0xe0]],
    ["image/gif", [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]],
    ["image/webp", [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]],
  ])("accepts %s only when its magic bytes match", async (mime, signature) => {
    const bytes = new Uint8Array(signature);
    expect(matchesImageSignature(bytes, mime)).toBe(true);
    await expect(validateImageUpload(new Blob([bytes], { type: mime }))).resolves.toEqual({ bytes, mime });
  });

  it("rejects SVG and MIME spoofing", async () => {
    await expect(validateImageUpload(new Blob(["<svg/>"], { type: "image/svg+xml" }))).rejects.toMatchObject({
      status: 415,
    });
    await expect(
      validateImageUpload(new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: "image/png" })),
    ).rejects.toMatchObject({ status: 415 });
  });

  it("rejects an oversized Blob before reading it", async () => {
    let read = false;
    const blob = {
      type: "image/png",
      size: DEFAULT_MAX_UPLOAD_BYTES + 1,
      arrayBuffer: async () => {
        read = true;
        return new ArrayBuffer(0);
      },
    } as unknown as Blob;

    await expect(validateImageUpload(blob)).rejects.toEqual(
      new MediaValidationError(413, "image too large (max 10 MB)"),
    );
    expect(read).toBe(false);
  });
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const PNG_B64 = btoa(String.fromCharCode(...PNG));

describe("agent-supplied image bytes", () => {
  it("sniffs the real type instead of trusting a declared one", () => {
    expect(sniffImageMime(PNG)).toBe("image/png");
    expect(sniffImageMime(new Uint8Array([0xff, 0xd8, 0xff]))).toBe("image/jpeg");
    expect(sniffImageMime(new TextEncoder().encode("<svg/>"))).toBeNull();
  });

  it("decodes raw base64 and a whole data: URI to the same bytes", () => {
    expect(decodeBase64Image(PNG_B64)).toEqual(PNG);
    expect(decodeBase64Image(`data:image/png;base64,${PNG_B64}`)).toEqual(PNG);
    expect(decodeBase64Image(`${PNG_B64.slice(0, 4)}\n  ${PNG_B64.slice(4)}`)).toEqual(PNG);
  });

  it("rejects payloads that are not base64 at all", () => {
    expect(() => decodeBase64Image("not base64!!")).toThrow(MediaValidationError);
    expect(() => decodeBase64Image("")).toThrow(MediaValidationError);
  });

  it("applies the inline cap separately from the upload cap", () => {
    expect(validateImageBytes(PNG).mime).toBe("image/png");
    const big = new Uint8Array(MAX_INLINE_IMAGE_BYTES + 1);
    big.set(PNG.subarray(0, 8));
    expect(() => validateImageBytes(big, MAX_INLINE_IMAGE_BYTES)).toThrow(MediaValidationError);
    expect(validateImageBytes(big).mime).toBe("image/png");
  });

  it("refuses an SVG even when it arrives as base64", () => {
    expect(() => validateImageBytes(decodeBase64Image(btoa("<svg/>")))).toThrow(MediaValidationError);
  });
});

describe("remote image fetch", () => {
  it("refuses private, loopback and metadata addresses before any request", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    for (const url of [
      "http://localhost/x.png",
      "http://127.0.0.1/x.png",
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.5/x.png",
      "http://192.168.1.1/x.png",
      "http://172.16.0.1/x.png",
      "http://[::1]/x.png",
      "http://db.internal/x.png",
    ]) {
      await expect(fetchRemoteImage(url)).rejects.toMatchObject({ status: 400 });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("refuses IPv4-mapped and other non-public IPv6 literals", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    for (const url of [
      "http://[::ffff:169.254.169.254]/latest/meta-data/",
      "http://[::ffff:127.0.0.1]/x.png",
      "http://[::ffff:a9fe:a9fe]/x.png",
      "http://[::ffff:7f00:1]/x.png",
      "http://[::]/x.png",
      "http://[fd00::1]/x.png",
      "http://[fe80::1]/x.png",
    ]) {
      await expect(fetchRemoteImage(url)).rejects.toMatchObject({ status: 400 });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("refuses a public name that resolves to a private address", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    resolvesTo("127.0.0.1");
    await expect(fetchRemoteImage("http://images.example.com/x.png")).rejects.toMatchObject({ status: 400 });
    resolvesTo("169.254.169.254");
    await expect(fetchRemoteImage("http://images.example.com/x.png")).rejects.toMatchObject({ status: 400 });
    // Every resolved address has to pass.
    resolvesTo("93.184.216.34", "10.0.0.5");
    await expect(fetchRemoteImage("http://images.example.com/x.png")).rejects.toMatchObject({ status: 400 });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("refuses a non-http scheme", async () => {
    await expect(fetchRemoteImage("file:///etc/passwd")).rejects.toThrow(MediaValidationError);
    await expect(fetchRemoteImage("not a url")).rejects.toThrow(MediaValidationError);
  });

  it("re-vets every redirect hop, so a public URL cannot bounce to metadata", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } }),
    );
    await expect(fetchRemoteImage("https://example.com/a.png")).rejects.toMatchObject({ status: 400 });
    fetchSpy.mockRestore();
  });

  it("stops a body that streams past the cap even with no content-length", async () => {
    const chunk = new Uint8Array(64 * 1024);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
      },
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { status: 200 }));
    await expect(fetchRemoteImage("https://example.com/a.png", 128 * 1024)).rejects.toMatchObject({ status: 413 });
    fetchSpy.mockRestore();
  });

  it("accepts a real image and reports its sniffed type", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(PNG, { status: 200, headers: { "content-type": "application/octet-stream" } }));
    await expect(fetchRemoteImage("https://example.com/a.png")).resolves.toEqual({ bytes: PNG, mime: "image/png" });
    fetchSpy.mockRestore();
  });

  it("refuses a URL that serves something that is not an image", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("<html>404</html>", { status: 200 }));
    await expect(fetchRemoteImage("https://example.com/a.png")).rejects.toMatchObject({ status: 415 });
    fetchSpy.mockRestore();
  });
});

describe("the upload ceiling and the request-body ceiling", () => {
  it("carries a full-size image when the body ceiling is the default", () => {
    expect(imageUploadLimits(DEFAULT_MAX_BODY_BYTES).bytes).toBe(DEFAULT_MAX_UPLOAD_BYTES);
    expect(imageUploadLimits(DEFAULT_MAX_BODY_BYTES).label).toBe("10 MB");
  });

  it("follows a lowered body ceiling, in the message as well as the check", () => {
    const limits = imageUploadLimits(4 * 1024 * 1024);
    expect(limits.bytes).toBe(4 * 1024 * 1024 - 64 * 1024);
    expect(limits.requestBytes).toBe(4 * 1024 * 1024);
    expect(limits.label).toBe("3 MB");
  });

  it("never reports a negative ceiling for an absurdly small body limit", () => {
    expect(imageUploadLimits(1024).bytes).toBe(0);
  });

  it("enforces the derived ceiling, not the constant", async () => {
    const blob = { type: "image/png", size: 5 * 1024 * 1024, arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Blob;
    await expect(validateImageUpload(blob, imageUploadLimits(4 * 1024 * 1024).bytes)).rejects.toEqual(
      new MediaValidationError(413, "image too large (max 3 MB)"),
    );
  });
});
