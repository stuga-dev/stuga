import { describe, expect, it, vi } from "vitest";
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
import { OutboundRefusedError } from "../net/outbound.js";

/** How fetch fails when the connection refuses an address: the reason is its cause. */
const refusedAt = (address: string, reason: "private" | "fake-ip" = "private") =>
  new TypeError("fetch failed", { cause: new OutboundRefusedError(reason, "images.example.com", address) });

/** An answer whose body never ends and records whether it was let go. */
function answer(status: number, headers: HeadersInit = {}): { res: Response; cancelled: () => boolean } {
  let cancelled = false;
  const body = new ReadableStream({ cancel: () => void (cancelled = true) });
  return { res: new Response(body, { status, headers }), cancelled: () => cancelled };
}
const redirect = (location: string, status = 302) => answer(status, { location });

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

  it("says why when the connection refuses where a name resolves, never \"fetch failed\"", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(refusedAt("169.254.169.254"));
    const refused = await fetchRemoteImage("http://images.example.com/x.png").catch((e: unknown) => e);
    expect(refused).toMatchObject({ status: 400, message: "refusing to reach a private or loopback address" });
    fetchSpy.mockRejectedValueOnce(refusedAt("198.18.0.7", "fake-ip"));
    await expect(fetchRemoteImage("http://images.example.com/x.png")).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/fake-IP/) });
    fetchSpy.mockRestore();
  });

  it("names no socket error when a host cannot be reached", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 93.184.216.34:443") }));
    await expect(fetchRemoteImage("https://example.com/a.png")).rejects.toMatchObject({ status: 400, message: "could not reach the URL" });
    fetchSpy.mockRestore();
  });

  it("refuses a non-http scheme", async () => {
    await expect(fetchRemoteImage("file:///etc/passwd")).rejects.toThrow(MediaValidationError);
    await expect(fetchRemoteImage("not a url")).rejects.toThrow(MediaValidationError);
  });

  it("re-vets every redirect hop, so a public URL cannot bounce to metadata", async () => {
    const hop = redirect("http://169.254.169.254/");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(hop.res);
    await expect(fetchRemoteImage("https://example.com/a.png")).rejects.toMatchObject({ status: 400 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(hop.cancelled()).toBe(true);
    fetchSpy.mockRestore();
  });

  it("refuses a redirect to a location that is not a URL, without following it", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(redirect("http://[").res);
    const refused = await fetchRemoteImage("https://example.com/a.png").catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(MediaValidationError);
    expect(refused).toMatchObject({ status: 400, message: "not a valid absolute URL: http://[" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
  });

  it("follows a relative redirect, letting go of each hop's body, through the checked connection", async () => {
    const hops = [redirect("/b.png", 301), redirect("https://cdn.example.com/c.png", 307)];
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(hops[0]!.res)
      .mockResolvedValueOnce(hops[1]!.res)
      .mockResolvedValueOnce(new Response(PNG, { status: 200 }));
    await expect(fetchRemoteImage("https://example.com/a.png")).resolves.toEqual({ bytes: PNG, mime: "image/png" });
    expect(fetchSpy.mock.calls.map(([url]) => String(url))).toEqual(["https://example.com/a.png", "https://example.com/b.png", "https://cdn.example.com/c.png"]);
    for (const [, init] of fetchSpy.mock.calls) expect(init).toMatchObject({ redirect: "manual", dispatcher: expect.anything() });
    expect(hops.every((hop) => hop.cancelled())).toBe(true);
    fetchSpy.mockRestore();
  });

  it("follows at most three redirects", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => redirect("https://example.com/again.png").res);
    await expect(fetchRemoteImage("https://example.com/a.png")).rejects.toMatchObject({ status: 400, message: "too many redirects fetching the image" });
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    fetchSpy.mockRestore();
  });

  it("treats a 3xx that is not a redirect as the answer", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(redirect("https://example.com/b.png", 300).res);
    await expect(fetchRemoteImage("https://example.com/a.png")).rejects.toMatchObject({ status: 400, message: "the URL returned HTTP 300" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
  });

  it("lets go of the body of an answer that is not a success", async () => {
    const missing = answer(404);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(missing.res);
    await expect(fetchRemoteImage("https://example.com/a.png")).rejects.toMatchObject({ status: 400, message: "the URL returned HTTP 404" });
    expect(missing.cancelled()).toBe(true);
    fetchSpy.mockRestore();
  });

  it("refuses a declared size over the cap without reading, and lets go of the body", async () => {
    const large = answer(200, { "content-length": String(256 * 1024) });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(large.res);
    await expect(fetchRemoteImage("https://example.com/a.png", 128 * 1024)).rejects.toMatchObject({ status: 413 });
    expect(large.cancelled()).toBe(true);
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
