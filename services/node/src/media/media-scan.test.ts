import { describe, expect, it } from "vitest";
import {
  destroyTrashed,
  listMediaObjects,
  listTrash,
  mediaHashesIn,
  reclaimDeletedDocImages,
  trashObjects,
  type ScanEnv,
} from "./media-scan.js";

const H = "a".repeat(64);
const H2 = "b3".repeat(32);
const WS = "ws-tenantOne";
const WS2 = "ws-tenantTwo";

interface StoredBlob {
  body: string;
  size: number;
  uploaded: Date;
  contentType?: string;
}

/** An in-memory blob store that keeps bytes and content type, so a lossy move shows. */
function fakeEnv(seed: Array<{ key: string; body?: string; size?: number; uploaded?: Date; contentType?: string }> = []) {
  const store = new Map<string, StoredBlob>();
  for (const o of seed) {
    store.set(o.key, {
      body: o.body ?? "bytes",
      size: o.size ?? 100,
      uploaded: o.uploaded ?? new Date(0),
      contentType: o.contentType,
    });
  }
  const deleted: string[] = [];
  const env = {
    media: {
      get: async (k: string) => {
        const o = store.get(k);
        return o
          ? { arrayBuffer: async () => new TextEncoder().encode(o.body).buffer, httpMetadata: { contentType: o.contentType } }
          : null;
      },
      put: async (k: string, v: ArrayBuffer, opts?: { httpMetadata?: { contentType?: string } }) => {
        store.set(k, {
          body: new TextDecoder().decode(v),
          size: v.byteLength,
          uploaded: new Date(0),
          contentType: opts?.httpMetadata?.contentType,
        });
      },
      delete: async (k: string) => {
        deleted.push(k);
        store.delete(k);
      },
      list: async ({ prefix, limit }: { prefix: string; limit: number }) => {
        const matching = [...store.entries()].filter(([k]) => k.startsWith(prefix));
        return {
          objects: matching.slice(0, limit).map(([key, o]) => ({ key, size: o.size, uploaded: o.uploaded })),
          truncated: matching.length > limit,
          cursor: "next-page",
        };
      },
    },
  } as unknown as ScanEnv;
  return { env, store, deleted };
}

describe("mediaHashesIn", () => {
  it("finds hashes in ordinary image markdown, deduped", () => {
    const md = `![a](/api/docs/d1/media/${H})\n![b](/api/docs/d2/media/${H2})\n![a](/api/docs/d1/media/${H})`;
    expect(mediaHashesIn(md).sort()).toEqual([H, H2].sort());
  });

  it("counts references in code fences, links and prose, since a missed one deletes an image", () => {
    expect(mediaHashesIn("```\n![x](/api/docs/d1/media/" + H + ")\n```")).toEqual([H]);
    expect(mediaHashesIn(`[link](/api/docs/d/media/${H})`)).toEqual([H]);
    expect(mediaHashesIn(`see https://app.test/api/docs/d/media/${H} please`)).toEqual([H]);
  });

  it("ignores near-misses that are not real media paths", () => {
    expect(mediaHashesIn("nothing here")).toEqual([]);
    expect(mediaHashesIn("/api/docs/d1/media/deadbeef")).toEqual([]);
    expect(mediaHashesIn(`/api/docs/d1/media/${H.toUpperCase()}`)).toEqual([]);
    expect(mediaHashesIn(`/api/other/d1/media/${H}`)).toEqual([]);
  });
});

describe("listMediaObjects", () => {
  it("returns only keys of the exact shape the store mints", async () => {
    const { env } = fakeEnv([
      { key: `media/${WS}/${H}`, size: 1234, uploaded: new Date(5000) },
      { key: `media/${H2}`, size: 77 },
      { key: `media/${WS}/${H.toUpperCase()}` },
      { key: "media/short" },
      { key: `media/${WS}/${H}/thumbnail` },
      { key: `media/not a workspace/${H}` },
    ]);
    const page = await listMediaObjects(env, null);
    expect(page.items).toEqual([{ workspace: WS, hash: H, size: 1234, uploadedMs: 5000 }]);
  });

  it("pages, so a large store is not read in one call", async () => {
    const { env } = fakeEnv(Array.from({ length: 5 }, (_, i) => ({ key: `media/${WS}/${String(i).repeat(64)}` })));
    const page = await listMediaObjects(env, null, 2);
    expect(page.items).toHaveLength(2);
    expect(page.next).toBe("next-page");
  });
});

describe("trashObjects", () => {
  it("moves the object to the same key under trash/ rather than destroying it", async () => {
    const { env, store, deleted } = fakeEnv([{ key: `media/${WS}/${H}`, body: "PNGBYTES", contentType: "image/png" }]);
    expect(await trashObjects(env, [{ workspace: WS, hash: H }])).toEqual({ moved: 1, missing: [] });
    expect(store.has(`media/${WS}/${H}`)).toBe(false);
    expect(store.get(`trash/${WS}/${H}`)).toMatchObject({ body: "PNGBYTES", contentType: "image/png" });
    expect(deleted).toEqual([`media/${WS}/${H}`]);
  });

  it("keeps one workspace's copy when another workspace's is reclaimed", async () => {
    const { env, store } = fakeEnv([
      { key: `media/${WS}/${H}`, body: "PNGBYTES" },
      { key: `media/${WS2}/${H}`, body: "PNGBYTES" },
    ]);
    await trashObjects(env, [{ workspace: WS2, hash: H }]);
    expect(store.has(`media/${WS}/${H}`)).toBe(true);
    expect(store.has(`media/${WS2}/${H}`)).toBe(false);
  });

  it("reports objects it could not find instead of failing the batch", async () => {
    const { env } = fakeEnv([{ key: `media/${WS}/${H}` }]);
    const out = await trashObjects(env, [
      { workspace: WS, hash: H },
      { workspace: WS, hash: H2 },
    ]);
    expect(out).toEqual({ moved: 1, missing: [{ workspace: WS, hash: H2 }] });
  });

  it("refuses a ref that could address outside the media prefix, before moving anything", async () => {
    const { env, deleted } = fakeEnv([{ key: `media/${WS}/${H}` }]);
    await expect(trashObjects(env, [{ workspace: WS, hash: H }, { workspace: "../trash", hash: H }])).rejects.toThrow(
      /not a media object/,
    );
    await expect(trashObjects(env, [{ workspace: WS, hash: `${H}/../x` }])).rejects.toThrow(/not a media object/);
    expect(deleted).toEqual([]);
  });
});

describe("destroyTrashed", () => {
  it("only ever reaches into the trash prefix", async () => {
    const { env, store, deleted } = fakeEnv([{ key: `media/${WS}/${H}` }, { key: `trash/${WS}/${H}` }]);
    expect(await destroyTrashed(env, [{ workspace: WS, hash: H }])).toBe(1);
    expect(deleted).toEqual([`trash/${WS}/${H}`]);
    expect(store.has(`media/${WS}/${H}`)).toBe(true);
  });

  it("applies the same ref validation", async () => {
    const { env, deleted } = fakeEnv();
    await expect(destroyTrashed(env, [{ workspace: `${WS}/..`, hash: H }])).rejects.toThrow(/not a media object/);
    expect(deleted).toEqual([]);
  });
});

describe("listTrash", () => {
  it("lists the trash with the time each object was moved there", async () => {
    const { env } = fakeEnv([
      { key: `trash/${WS}/${H}`, size: 900, uploaded: new Date(7000) },
      { key: `media/${WS}/${H2}` },
      { key: "trash/not-a-hash" },
    ]);
    const page = await listTrash(env, null);
    expect(page.items).toEqual([{ workspace: WS, hash: H, size: 900, trashedMs: 7000 }]);
  });
});

describe("reclaiming a deleted document's images", () => {
  const WS = "ws-abc123";
  const OTHER = "ws-other9";

  /** An sql double answering with the hashes the query would find still referenced. */
  function fakeSql(stillUsed: string[], onQuery?: (sql: string) => void) {
    const tag = (strings: TemplateStringsArray) => {
      onQuery?.(strings.join("?"));
      return Promise.resolve(stillUsed.map((hash) => ({ hash })));
    };
    return tag as unknown as Parameters<typeof reclaimDeletedDocImages>[1];
  }

  it("moves this workspace's copy to the trash, keeping the bytes and type", async () => {
    const { env, store } = fakeEnv([{ key: `media/${WS}/${H}`, body: "PNG", contentType: "image/png" }]);
    const moved = await reclaimDeletedDocImages(env, fakeSql([]), WS, [H]);
    expect(moved).toBe(1);
    expect(store.has(`media/${WS}/${H}`)).toBe(false);
    expect(store.get(`trash/${WS}/${H}`)).toMatchObject({ body: "PNG", contentType: "image/png" });
  });

  it("keeps an image another document in the same workspace still uses", async () => {
    const { env, store } = fakeEnv([{ key: `media/${WS}/${H}` }, { key: `media/${WS}/${H2}` }]);
    const moved = await reclaimDeletedDocImages(env, fakeSql([H]), WS, [H, H2]);
    expect(moved).toBe(1);
    expect(store.has(`media/${WS}/${H}`)).toBe(true);
    expect(store.has(`media/${WS}/${H2}`)).toBe(false);
  });

  it("scopes the reference query to the workspace, whose copy is a separate object", async () => {
    let seen = "";
    await reclaimDeletedDocImages(
      fakeEnv().env,
      fakeSql([], (q) => {
        seen = q;
      }),
      WS,
      [H],
    );
    expect(seen).toContain("workspace_id");
  });

  it("never touches another workspace's copy of the same hash", async () => {
    const { env, store } = fakeEnv([{ key: `media/${WS}/${H}` }, { key: `media/${OTHER}/${H}` }]);
    await reclaimDeletedDocImages(env, fakeSql([]), WS, [H]);
    expect(store.has(`media/${WS}/${H}`)).toBe(false);
    expect(store.has(`media/${OTHER}/${H}`)).toBe(true);
  });

  it("refuses a workspace id that could address another prefix", async () => {
    const { env, store } = fakeEnv([{ key: `media/${WS}/${H}` }]);
    expect(await reclaimDeletedDocImages(env, fakeSql([]), "../..", [H])).toBe(0);
    expect(await reclaimDeletedDocImages(env, fakeSql([]), "", [H])).toBe(0);
    expect(store.has(`media/${WS}/${H}`)).toBe(true);
  });

  it("never fails the deletion it is part of", async () => {
    const { env } = fakeEnv([{ key: `media/${WS}/${H}` }]);
    const boom = (() => Promise.reject(new Error("database unreachable"))) as unknown as Parameters<
      typeof reclaimDeletedDocImages
    >[1];
    await expect(reclaimDeletedDocImages(env, boom, WS, [H])).resolves.toBe(0);
  });
});
