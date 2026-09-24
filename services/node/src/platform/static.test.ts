import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { serveStatic } from "./static.js";

const PUBLIC = "https://node.example";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn();
});

describe("serveStatic", () => {
  it("serves files, falls back to index.html for routes, and never escapes the directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stuga-static-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "index.html"), "<html>app</html>");
    writeFileSync(join(dir, "assets", "app-abc123.js"), "console.log(1)");
    writeFileSync(join(dir, "logo.png"), Buffer.from([137, 80, 78, 71]));
    writeFileSync(join(tmpdir(), "stuga-static-outside.txt"), "secret");
    cleanups.push(() => rmSync(join(tmpdir(), "stuga-static-outside.txt"), { force: true }));

    const handler = serveStatic(dir);
    const get = (path: string, method = "GET") => handler(new Request(`${PUBLIC}${path}`, { method }));

    const js = await get("/assets/app-abc123.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toMatch(/javascript/);
    expect(js.headers.get("cache-control")).toContain("immutable");
    expect(await js.text()).toBe("console.log(1)");

    const index = await get("/");
    expect(index.headers.get("content-type")).toMatch(/text\/html/);
    expect(index.headers.get("cache-control")).toBe("no-cache");
    expect(await (await get("/d/doc_123/edit")).text()).toBe("<html>app</html>");
    expect((await get("/logo.png")).headers.get("content-type")).toBe("image/png");
    expect((await get("/missing.png")).status).toBe(404);
    expect((await get("/", "POST")).status).toBe(405);

    const head = await get("/logo.png", "HEAD");
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("4");
    expect(head.body).toBeNull();

    for (const path of ["/../stuga-static-outside.txt", "/%2e%2e/stuga-static-outside.txt", "/assets/../../stuga-static-outside.txt"]) {
      const res = await get(path);
      expect(await res.text()).not.toBe("secret");
    }
  });
});
