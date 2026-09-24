import { beforeEach, describe, expect, it, vi } from "vitest";
import { hostExternalImages, ingestNote, ingestWarning } from "./media-ingest.js";
import type { IngestEnv } from "./media-ingest.js";
import { DEFAULT_MAX_BODY_BYTES, bodyBytesFor } from "./media.js";

// A remote fetch vets the addresses a host resolves to, so the fictional hosts need a public answer.
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]),
}));

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const WS = "ws-testTenant1";
/** A well-formed hash for cases that never fetch; `expectedPath()` gives PNG's. */
const HASH = "5b4c04bb52cb7f19bbd4e0b8b6a0f2a41f5db9c9d0f65c1f7b1a4e5f2c6a3d90";

const settingsWithBody = (maxBodyBytes: number) => ({ current: () => ({ maxBodyBytes }) }) as unknown as IngestEnv["settings"];

/** A blob store double that records puts. */
function fakeEnv(): IngestEnv & { puts: string[] } {
  const store = new Map<string, Uint8Array>();
  const puts: string[] = [];
  return {
    publicOrigin: "https://app.stuga.test",
    settings: settingsWithBody(DEFAULT_MAX_BODY_BYTES),
    media: {
      head: async (k: string) => (store.has(k) ? { key: k } : null),
      put: async (k: string, v: Uint8Array) => {
        puts.push(k);
        store.set(k, v);
      },
    },
    puts,
  } as unknown as IngestEnv & { puts: string[] };
}

/** Every fetch answers a fresh Response with the same PNG, so a rewritten path is deterministic. */
function mockImageFetch() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(PNG, { status: 200 }));
}

let env: IngestEnv & { puts: string[] };
beforeEach(() => {
  env = fakeEnv();
  vi.restoreAllMocks();
});

/** The `/api/docs/d1/media/<hash>` path an ingest of PNG must produce. */
async function expectedPath(): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", PNG);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `/api/docs/d1/media/${hex}`;
}

describe("hosting external images in agent markdown", () => {
  it("downloads an external image and rewrites the destination", async () => {
    mockImageFetch();
    const path = await expectedPath();
    const r = await hostExternalImages(env, WS, "d1", "Intro\n\n![a chart](https://cdn.example.com/c.png)\n");
    expect(r.markdown).toBe(`Intro\n\n![a chart](${path})\n`);
    expect(r.hosted).toEqual([{ from: "https://cdn.example.com/c.png", to: path }]);
    expect(env.puts).toEqual([`media/${WS}/${path.split("/").pop()}`]);
  });

  it("ingests a data: URI, which the markdown parser would otherwise drop", async () => {
    const b64 = btoa(String.fromCharCode(...PNG));
    const path = await expectedPath();
    const r = await hostExternalImages(env, WS, "d1", `![x](data:image/png;base64,${b64})`);
    expect(r.markdown).toBe(`![x](${path})`);
  });

  it("meets the upload ceiling an administrator set, not a compiled-in default", async () => {
    const b64 = btoa(String.fromCharCode(...PNG));
    const md = `![x](data:image/png;base64,${b64})`;
    env.settings = settingsWithBody(bodyBytesFor(1));
    const refused = await hostExternalImages(env, WS, "d1", md);
    expect(refused.markdown).toBe(md);
    expect(refused.hosted).toEqual([]);
    expect(refused.failures).toHaveLength(1);
    expect(env.puts).toEqual([]);

    env.settings = settingsWithBody(DEFAULT_MAX_BODY_BYTES);
    const allowed = await hostExternalImages(env, WS, "d1", md);
    expect(allowed.markdown).toBe(`![x](${await expectedPath()})`);
  });

  it("leaves example syntax inside fenced code blocks alone", async () => {
    const fetchSpy = mockImageFetch();
    const md = [
      "Use it like this:",
      "",
      "```markdown",
      "![logo](https://cdn.example.com/logo.png)",
      "```",
      "",
      "~~~",
      "![other](https://cdn.example.com/other.png)",
      "~~~",
    ].join("\n");
    const r = await hostExternalImages(env, WS, "d1", md);
    expect(r.markdown).toBe(md);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps a fence open past a line that only looks like a closer", async () => {
    const fetchSpy = mockImageFetch();
    const md = [
      "```js",
      "![a](https://cdn.example.com/a.png)",
      "```js",
      "![b](https://cdn.example.com/b.png)",
      "~~~",
      "![c](https://cdn.example.com/c.png)",
      "```",
    ].join("\n");
    const r = await hostExternalImages(env, WS, "d1", md);
    expect(r.markdown).toBe(md);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("hosts an image after a fence closes", async () => {
    mockImageFetch();
    const path = await expectedPath();
    const md = "  ```\n![a](https://cdn.example.com/a.png)\n   ```\n![b](https://cdn.example.com/b.png)";
    const r = await hostExternalImages(env, WS, "d1", md);
    expect(r.markdown).toBe(`  \`\`\`\n![a](https://cdn.example.com/a.png)\n   \`\`\`\n![b](${path})`);
  });

  it("leaves an image inside an inline code span alone", async () => {
    const fetchSpy = mockImageFetch();
    const md = "Write `![logo](https://cdn.example.com/logo.png)` to embed it.";
    expect((await hostExternalImages(env, WS, "d1", md)).markdown).toBe(md);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not touch links — only images", async () => {
    const fetchSpy = mockImageFetch();
    const md = "See [the chart](https://cdn.example.com/c.png) for detail.";
    expect((await hostExternalImages(env, WS, "d1", md)).markdown).toBe(md);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("handles an angle-bracketed destination and keeps that form", async () => {
    mockImageFetch();
    const path = await expectedPath();
    const r = await hostExternalImages(env, WS, "d1", "![s](<https://cdn.example.com/my file.png>)");
    expect(r.markdown).toBe(`![s](<${path}>)`);
  });

  it("keeps a title and a badge's link wrapper intact", async () => {
    mockImageFetch();
    const path = await expectedPath();
    const r = await hostExternalImages(env, WS, "d1", '[![CI](https://img.example.com/b.svg "build")](https://ci.example.com)');
    expect(r.markdown).toBe(`[![CI](${path} "build")](https://ci.example.com)`);
  });

  it("fetches a repeated URL exactly once", async () => {
    const fetchSpy = mockImageFetch();
    const r = await hostExternalImages(env, WS, "d1",
      "![a](https://cdn.example.com/c.png)\n\n![b](https://cdn.example.com/c.png)",
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(r.hosted).toHaveLength(2);
    expect(env.puts).toHaveLength(1);
  });

  it("leaves a failing URL in place and reports it, without failing the edit", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 404 }));
    const r = await hostExternalImages(env, WS, "d1", "![a](https://cdn.example.com/gone.png)");
    expect(r.markdown).toBe("![a](https://cdn.example.com/gone.png)");
    expect(r.hosted).toEqual([]);
    expect(r.failures[0]?.url).toBe("https://cdn.example.com/gone.png");
    expect(ingestWarning(r.failures, r.truncated)).toContain("left as-is");
  });

  it("stops after the per-edit cap and says so", async () => {
    mockImageFetch();
    const md = Array.from({ length: 12 }, (_, i) => `![i${i}](https://cdn.example.com/${i}.png)`).join("\n\n");
    const r = await hostExternalImages(env, WS, "d1", md);
    expect(r.hosted).toHaveLength(8);
    expect(r.truncated).toBe(true);
    expect(r.markdown).toContain("![i11](https://cdn.example.com/11.png)");
  });

  it("collapses our own absolute media URL to the relative form without fetching", async () => {
    const fetchSpy = mockImageFetch();
    const abs = `https://app.stuga.test/api/docs/other/media/${HASH}`;
    const r = await hostExternalImages(env, WS, "d1", `![a](${abs})`);
    expect(r.markdown).toBe(`![a](/api/docs/other/media/${HASH})`);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("leaves an already-relative media path untouched", async () => {
    const fetchSpy = mockImageFetch();
    const md = `![a](/api/docs/d1/media/${HASH})`;
    expect((await hostExternalImages(env, WS, "d1", md)).markdown).toBe(md);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("ignores a relative path that is not media", async () => {
    const fetchSpy = mockImageFetch();
    const md = "![a](./assets/local.png)";
    expect((await hostExternalImages(env, WS, "d1", md)).markdown).toBe(md);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("tells the agent about rewrites but tells the human only about failures", async () => {
    const hosted = [{ from: "https://x/a.png", to: "/api/docs/d1/media/x" }];
    expect(ingestNote(hosted, [], false)).toContain("Hosted 1 image");
    expect(ingestWarning([], false)).toBe("");
  });
});
