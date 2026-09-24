/** The media reclaim's reachable-set queries against a real Postgres. Needs TEST_DATABASE_URL; skips without it. */
import { applyMarkdownToYXmlFragment } from "@stuga/crdt-ops";
import { createDoc, initSchema, runBootRepairs, type MediaRef } from "@stuga/db";
import type { BlobStore } from "@stuga/runtime";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { sessionConnection, withDatabase, type LockSql } from "../writer-lock.js";
import { mediaKey } from "./media.js";
import { reclaimDeletedDocImages, referencesInBodies, referencesInSnapshots, type ScanEnv } from "./media-scan.js";

const URL = process.env.TEST_DATABASE_URL;
const DB = `stuga_ms_${process.pid}`;
const WS1 = "ws-one";
const WS2 = "ws-two";
const hash = (c: string) => c.repeat(64);
const path = (docId: string, h: string) => `/api/docs/${docId}/media/${h}`;

let maintenance: LockSql;
let sql: LockSql;

/** A blob store over a map, with snapshots encoded from Markdown. */
function blobs(entries: Record<string, string> = {}) {
  const store = new Map<string, { bytes: Uint8Array; contentType?: string }>();
  for (const [key, markdown] of Object.entries(entries)) {
    const doc = new Y.Doc();
    applyMarkdownToYXmlFragment(doc.getXmlFragment("default"), markdown);
    store.set(key, { bytes: Y.encodeStateAsUpdate(doc) });
  }
  const put = (key: string, bytes: Uint8Array, contentType?: string) => store.set(key, { bytes, contentType });
  const blob: Partial<BlobStore> = {
    get: async (key: string) => {
      const o = store.get(key);
      return o
        ? ({ arrayBuffer: async () => o.bytes.slice().buffer, httpMetadata: { contentType: o.contentType } } as never)
        : null;
    },
    put: async (key: string, value: unknown) => {
      put(key, new Uint8Array(value as ArrayBuffer));
      return null as never;
    },
    delete: async (keys: string | string[]) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
    },
  };
  return { store: blob as BlobStore, keys: () => [...store.keys()].sort(), put };
}

const env = (snapshots: BlobStore, media: BlobStore = blobs().store): ScanEnv => ({ sql: sql as never, snapshots, media });

async function doc(docId: string, workspaceId: string, fields: { search_text?: string; snapshot_seq?: number; search_hidden?: boolean } = {}) {
  await createDoc(sql as never, { docId, workspaceId, owner: "user:alice", title: docId });
  await sql`UPDATE docs SET search_text = ${fields.search_text ?? ""}, snapshot_seq = ${fields.snapshot_seq ?? 0},
    search_hidden = ${fields.search_hidden ?? false} WHERE doc_id = ${docId}`;
}

const sorted = (refs: MediaRef[]) => [...refs].sort((a, b) => `${a.workspace}${a.hash}`.localeCompare(`${b.workspace}${b.hash}`));

describe.skipIf(!URL)("media reclaim queries", () => {
  beforeAll(async () => {
    maintenance = sessionConnection(URL!, "postgres");
    await maintenance`DROP DATABASE IF EXISTS ${maintenance(DB)} WITH (FORCE)`;
    await maintenance`CREATE DATABASE ${maintenance(DB)}`;
    sql = sessionConnection(withDatabase(URL!, DB));
    await initSchema(sql as never);
    await runBootRepairs(sql as never);
    await sql`INSERT INTO workspaces (workspace_id, name) VALUES (${WS1}, 'One'), (${WS2}, 'Two')`;
  });

  afterAll(async () => {
    await sql?.end({ timeout: 5 }).catch(() => {});
    if (maintenance) {
      await maintenance`DROP DATABASE IF EXISTS ${maintenance(DB)} WITH (FORCE)`;
      await maintenance.end({ timeout: 5 });
    }
  });

  beforeEach(async () => {
    await sql`TRUNCATE docs CASCADE`;
  });

  it("reads each body's references with its workspace, one page at a time", async () => {
    await doc("a1", WS1, { search_text: `![x](${path("a1", hash("a"))}) and ${path("zz", hash("b"))} and ${path("a1", hash("a"))}` });
    await doc("a2", WS2, { search_text: `![y](${path("a2", hash("a"))})` });
    await doc("a3", WS1, { search_text: "no images" });

    const first = await referencesInBodies(env(blobs().store), null, 2);
    expect(first.scanned).toBe(2);
    expect(first.next).toBe("a2");
    expect(sorted(first.items)).toEqual([
      { workspace: WS1, hash: hash("a") },
      { workspace: WS1, hash: hash("b") },
      { workspace: WS2, hash: hash("a") },
    ]);

    const second = await referencesInBodies(env(blobs().store), first.next, 2);
    expect(second).toEqual({ items: [], scanned: 1, next: null });
  });

  it("reads hidden bodies and retained versions from their snapshots, pruned and corrupt ones reported", async () => {
    await doc("h1", WS1, { snapshot_seq: 3, search_hidden: true, search_text: "stale" });
    await doc("v1", WS2, { snapshot_seq: 100 });
    // Seq 10 is neither recent nor a milestone, so it is not retained; 50 is a milestone, 90 recent, 95 pruned.
    for (const seq of [10, 50, 90, 95]) {
      await sql`INSERT INTO versions (doc_id, seq, blob_key) VALUES ('v1', ${seq}, ${`v1/${seq}.bin`})`;
    }
    const snapshots = blobs({
      "h1/3.bin": `![hidden](${path("h1", hash("c"))})`,
      "v1/10.bin": `![old](${path("v1", hash("9"))})`,
      "v1/50.bin": `![milestone](${path("v1", hash("d"))})`,
    });
    snapshots.put("v1/90.bin", new Uint8Array([0xff, 0x00, 0x13]));

    const refs: MediaRef[] = [];
    let cursor: string | null = null;
    let scanned = 0;
    let pruned = 0;
    const corrupt: string[] = [];
    do {
      const page = await referencesInSnapshots(env(snapshots.store), cursor, 2);
      refs.push(...page.items);
      scanned += page.scanned;
      pruned += page.pruned;
      corrupt.push(...page.corrupt);
      cursor = page.next;
    } while (cursor);

    expect(scanned).toBe(4);
    expect(pruned).toBe(1);
    expect(corrupt).toEqual(["v1@90"]);
    expect(sorted(refs)).toEqual([
      { workspace: WS1, hash: hash("c") },
      { workspace: WS2, hash: hash("d") },
    ]);
  });

  it("trashes a deleted document's images unless another body in the same workspace still uses them", async () => {
    await doc("keep", WS1, { search_text: `![k](${path("keep", hash("1"))})` });
    await doc("other", WS2, { search_text: `![o](${path("other", hash("2"))})` });
    const media = blobs();
    for (const h of [hash("1"), hash("2")]) media.put(mediaKey(WS1, h), new Uint8Array([1]), "image/png");

    expect(await reclaimDeletedDocImages({ media: media.store }, sql as never, WS1, [hash("1"), hash("2")])).toBe(1);
    expect(media.keys()).toEqual([mediaKey(WS1, hash("1")), `trash/${WS1}/${hash("2")}`].sort());
  });
});
