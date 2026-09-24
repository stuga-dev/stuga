import { describe, expect, it } from "vitest";
import { download } from "./respond.js";

describe("download", () => {
  const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00]);

  it("hands the browser a file to save, and no cache a copy", async () => {
    const res = download(bytes, "stuga.mcpb", "application/octet-stream");
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="stuga.mcpb"');
    expect(res.headers.get("content-length")).toBe("5");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([...bytes]);
  });

  it("streams a body it does not hold whole, with no length to promise", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("a,b\r\n"));
        controller.close();
      },
    });
    const res = download(stream, "stuga-audit-2026-09-14.csv", "text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="stuga-audit-2026-09-14.csv"');
    expect(res.headers.has("content-length")).toBe(false);
    expect(await res.text()).toBe("a,b\r\n");
  });

  it.each(['stuga";x=y', "stuga file.mcpb", "server/stuga.mcpb", ""])("refuses %o as a filename", (name) => {
    expect(() => download(bytes, name, "application/octet-stream")).toThrow();
  });
});
