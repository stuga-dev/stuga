/** Files beside images: stored under the same content-hash keys, and served as downloads, never shown. */
import { MEDIA_GET_PATH } from "@stuga/protocol/api/media";
import { MemoryBlobStore } from "@stuga/runtime/testing";
import { describe, expect, it } from "vitest";
import { fileName, fileType, mediaUrl, storeFile } from "./media.js";
import { serveMedia } from "./serve.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const text = (s: string): Uint8Array => new TextEncoder().encode(s);
const env = () => ({ media: new MemoryBlobStore(), mediaCookieSameSite: "Lax" as const });

describe("a file's name and type", () => {
  it("keeps the last segment of a path, on one line, without control or direction characters", () => {
    expect(fileName("C:\\Users\\liv\\Brief.pdf")).toBe("Brief.pdf");
    expect(fileName("notes/plan\u202e.txt")).toBe("plan.txt");
    expect(fileName("  two\nlines .md ")).toBe("two lines .md");
    expect(fileName("")).toBe("file");
    expect(fileName("..")).toBe("file");
    expect([...fileName("é".repeat(300))]).toHaveLength(200);
  });

  it("is served as its extension says, and as plain bytes otherwise", () => {
    expect(fileType("Brief.PDF")).toBe("application/pdf");
    expect(fileType("clip.mp4")).toBe("video/mp4");
    expect(fileType("key.p8")).toBe("application/octet-stream");
  });

  it("puts the name in a file's url, where the media path finds the hash and the name", () => {
    const url = mediaUrl("d1", "a".repeat(64), "Q3 plan (final).pdf");
    expect(url).toBe(`/api/docs/d1/media/${"a".repeat(64)}/Q3%20plan%20(final).pdf`);
    expect(MEDIA_GET_PATH.exec(url)?.slice(1)).toEqual(["a".repeat(64), "Q3%20plan%20(final).pdf"]);
    expect(MEDIA_GET_PATH.exec(mediaUrl("d1", "a".repeat(64)))?.[1]).toBe("a".repeat(64));
  });
});

describe("storing and serving a file", () => {
  it("serves a file only where files are asked for, as a download under its link's name, never shown or sniffed", async () => {
    const e = env();
    const stored = await storeFile(e.media, "ws1", text("<script>alert(1)</script>"), "page.html");
    expect(stored).toMatchObject({ name: "page.html", mime: "application/octet-stream", size: 25 });
    expect((await serveMedia(e, "ws1", stored.hash)).status).toBe(404);

    const res = await serveMedia(e, "ws1", stored.hash, { files: true, name: encodeURIComponent("Plan “v2”.html") });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="Plan _v2_.html"; filename*=UTF-8''${encodeURIComponent("Plan “v2”.html")}`);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(new TextDecoder().decode(await res.arrayBuffer())).toBe("<script>alert(1)</script>");
    expect((await serveMedia(e, "ws1", stored.hash, { files: true })).headers.get("content-disposition")).toBe("attachment");
  });

  it("keeps a file that is an image of a safe type as that image, shown wherever it is linked", async () => {
    const e = env();
    const stored = await storeFile(e.media, "ws1", PNG, "shot.bin");
    expect(stored.mime).toBe("image/png");
    const res = await serveMedia(e, "ws1", stored.hash, { files: true, name: "shot.bin" });
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition")).toBeNull();
    expect((await serveMedia(e, "ws1", stored.hash)).status).toBe(200);
  });
});
