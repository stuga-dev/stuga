import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/** Set to make the next matching fs call fail, simulating a crash at that step. */
const failNext: { op: "writeFile" | "rename" | null; match: RegExp | null } = { op: null, match: null };

vi.mock("node:fs/promises", async (orig) => {
  const real = await orig<typeof import("node:fs/promises")>();
  const guard =
    <F extends (...args: never[]) => Promise<unknown>>(op: "writeFile" | "rename", fn: F, target: (...a: Parameters<F>) => string) =>
    (...args: Parameters<F>) => {
      if (failNext.op === op && failNext.match!.test(target(...args))) {
        failNext.op = null;
        return Promise.reject(new Error(`simulated crash in ${op}`));
      }
      return fn(...args);
    };
  return {
    ...real,
    writeFile: guard("writeFile", real.writeFile as never, (path: string) => path),
    rename: guard("rename", real.rename as never, (_from: string, to: string) => to),
  };
});

const { fsBlobStore } = await import("./blob-fs.js");

const dirs: string[] = [];
function store() {
  const dir = mkdtempSync(join(tmpdir(), "stuga-blobs-"));
  dirs.push(dir);
  return { dir, blobs: fsBlobStore(dir) };
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("fsBlobStore", () => {
  it("puts, heads, gets and deletes, with metadata in a sidecar", async () => {
    const { blobs } = store();
    await blobs.put("media/ws_1/abc", new Uint8Array([1, 2, 3]), { httpMetadata: { contentType: "image/png" } });
    const head = await blobs.head("media/ws_1/abc");
    expect(head).toMatchObject({ key: "media/ws_1/abc", size: 3, httpMetadata: { contentType: "image/png" } });
    expect(head!.uploaded).toBeInstanceOf(Date);

    const obj = await blobs.get("media/ws_1/abc");
    expect(new Uint8Array(await obj!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    const chunks: Uint8Array[] = [];
    for await (const chunk of (await blobs.get("media/ws_1/abc"))!.body) chunks.push(chunk);
    expect(Buffer.concat(chunks)).toEqual(Buffer.from([1, 2, 3]));

    await blobs.put("media/ws_1/abc", "text now"); // overwrite drops stale metadata
    expect(await (await blobs.get("media/ws_1/abc"))!.text()).toBe("text now");
    expect((await blobs.head("media/ws_1/abc"))!.httpMetadata).toBeUndefined();

    await blobs.delete("media/ws_1/abc");
    expect(await blobs.get("media/ws_1/abc")).toBeNull();
    expect(await blobs.head("media/ws_1/abc")).toBeNull();
    await blobs.delete("media/ws_1/abc"); // deleting a missing key is fine
  });

  it("deletes arrays and prunes emptied directories", async () => {
    const { dir, blobs } = store();
    await blobs.put("snap/d1/1", "a");
    await blobs.put("snap/d1/2", "b");
    await blobs.put("snap/d2/1", "c");
    await blobs.delete(["snap/d1/1", "snap/d1/2"]);
    expect(existsSync(join(dir, "snap", "d1"))).toBe(false);
    expect(await blobs.head("snap/d2/1")).not.toBeNull();
  });

  it("keeps hostile keys inside the directory and round-trips them", async () => {
    const { dir, blobs } = store();
    const keys = ["../escape", "a/../../b", "weird key/with spaces.blob", "ünïcode/☃", "a//b", ".hidden/..", "%41"];
    for (const key of keys) await blobs.put(key, key);
    for (const key of keys) expect(await (await blobs.get(key))!.text()).toBe(key);
    expect(readdirSync(dir).every((entry) => !entry.startsWith(".."))).toBe(true);
    expect(existsSync(join(dir, "..", "escape.blob"))).toBe(false);
    const listed = (await blobs.list()).objects.map((o) => o.key).sort();
    expect(listed).toEqual([...keys].sort());
  });

  it("never exposes a new object without its content type, nor a half-written sidecar", async () => {
    const { dir, blobs } = store();
    await blobs.put("media/w/a", "old", { httpMetadata: { contentType: "text/plain" } });

    // The sidecar write dies: the old object and its metadata stand untouched.
    failNext.op = "writeFile";
    failNext.match = /\.blob\.meta\.json\..*\.tmp$/;
    await expect(blobs.put("media/w/a", "new", { httpMetadata: { contentType: "image/png" } })).rejects.toThrow(/crash/);
    expect(await (await blobs.get("media/w/a"))!.text()).toBe("old");
    expect((await blobs.head("media/w/a"))!.httpMetadata).toEqual({ contentType: "text/plain" });

    // The data rename dies after the sidecar landed: whatever is readable still
    // carries a parseable content type.
    failNext.op = "rename";
    failNext.match = /\.blob$/;
    await expect(blobs.put("media/w/b", "fresh", { httpMetadata: { contentType: "image/png" } })).rejects.toThrow(/crash/);
    expect(await blobs.head("media/w/b")).toBeNull();

    const leftovers = readdirSync(join(dir, "media", "w"));
    expect(leftovers.filter((f) => f.endsWith(".tmp"))).toEqual([]);
    for (const f of leftovers.filter((f) => f.endsWith(".meta.json"))) {
      expect(() => JSON.parse(readFileSync(join(dir, "media", "w", f), "utf8"))).not.toThrow();
    }
  });

  it("lists by prefix with stable lexicographic paging", async () => {
    const { blobs } = store();
    const keys = Array.from({ length: 7 }, (_, i) => `snap/doc/${String(i).padStart(2, "0")}`);
    for (const key of [...keys].reverse()) await blobs.put(key, key);
    await blobs.put("snap/other/00", "x");
    await blobs.put("snapshot", "y");

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await blobs.list({ prefix: "snap/doc/", limit: 3, cursor });
      pages += 1;
      seen.push(...page.objects.map((o) => o.key));
      expect(page.truncated).toBe(page.cursor !== undefined);
      cursor = page.cursor;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toEqual(keys);

    expect((await blobs.list({ prefix: "snap/doc/0" })).objects.map((o) => o.key)).toEqual(keys);
    expect((await blobs.list({ prefix: "snap" })).objects).toHaveLength(9);
    expect((await blobs.list({ prefix: "nothing/" })).objects).toEqual([]);
    expect((await blobs.list({ prefix: "nothing/" })).truncated).toBe(false);
  });
});
