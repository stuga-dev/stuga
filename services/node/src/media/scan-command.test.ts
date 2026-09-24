import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { fsBlobStore } from "@stuga/runtime";
import type { ScanEnv, StoredObject } from "./media-scan.js";
import { parseMediaScanArgs, partition, runMediaScan } from "./scan-command.js";

const HOUR = 3_600_000;
const NOW = 1_700_000_000_000;

function obj(hash: string, ageHours: number, workspace = "ws1"): StoredObject {
  return { workspace, hash, size: 1024, uploadedMs: NOW - ageHours * HOUR };
}

describe("what may be reclaimed", () => {
  it("leaves anything a document still points at", () => {
    const objects = [obj("aaa", 100), obj("bbb", 100)];
    const { reclaimable } = partition(objects, new Set(["ws1/aaa"]), NOW, 24 * HOUR);
    expect(reclaimable.map((o) => o.hash)).toEqual(["bbb"]);
  });

  it("holds back an unreferenced object still inside the grace window", () => {
    const { tooNew, reclaimable } = partition([obj("fresh", 1)], new Set(), NOW, 24 * HOUR);
    expect(tooNew.map((o) => o.hash)).toEqual(["fresh"]);
    expect(reclaimable).toEqual([]);
  });

  it("reclaims once an unreferenced object is older than the window", () => {
    const { tooNew, reclaimable } = partition([obj("old", 25)], new Set(), NOW, 24 * HOUR);
    expect(reclaimable.map((o) => o.hash)).toEqual(["old"]);
    expect(tooNew).toEqual([]);
  });

  it("treats the boundary as reclaimable, so a window of 0 reclaims everything unreferenced", () => {
    expect(partition([obj("edge", 24)], new Set(), NOW, 24 * HOUR).reclaimable).toHaveLength(1);
    expect(partition([obj("any", 0)], new Set(), NOW, 0).reclaimable).toHaveLength(1);
  });

  it("scopes reachability by workspace, because the store is keyed that way", () => {
    const objects = [obj("shared", 100, "ws1"), obj("shared", 100, "ws2")];
    const { reclaimable } = partition(objects, new Set(["ws1/shared"]), NOW, 24 * HOUR);
    expect(reclaimable).toEqual([expect.objectContaining({ workspace: "ws2", hash: "shared" })]);
  });

  it("reclaims nothing when everything is referenced", () => {
    const objects = [obj("a", 100), obj("b", 100)];
    const { tooNew, reclaimable } = partition(objects, new Set(["ws1/a", "ws1/b"]), NOW, 24 * HOUR);
    expect(reclaimable).toEqual([]);
    expect(tooNew).toEqual([]);
  });
});

describe("stuga-node media-scan, in-process", () => {
  it("empties a trash of more than a listing page's worth of objects", async () => {
    const dir = await mkdtemp(join(tmpdir(), "stuga-media-scan-"));
    try {
      const media = fsBlobStore(dir);
      const count = 507;
      const old = new Date(NOW - 40 * 24 * HOUR);
      for (let i = 0; i < count; i++) {
        const hash = i.toString(16).padStart(64, "0");
        await media.put(`trash/ws1/${hash}`, new Uint8Array([1, 2, 3]), { httpMetadata: { contentType: "image/png" } });
        await utimes(join(dir, "trash", "ws1", `${hash}.blob`), old, old);
      }
      const lines: string[] = [];
      const env = { media, snapshots: media, sql: undefined } as unknown as ScanEnv;
      const code = await runMediaScan(env, parseMediaScanArgs(["--empty-trash=30", "--reclaim"]), (l) => lines.push(l), NOW);
      expect(code).toBe(0);
      expect(lines.join("\n")).toContain(`destroyed ${count} objects`);
      expect((await media.list({ prefix: "trash/" })).objects).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses flags it does not know rather than scanning with a guess", () => {
    expect(() => parseMediaScanArgs(["--reclaimm"])).toThrow(/unknown argument --reclaimm/);
    expect(() => parseMediaScanArgs(["--empty-trash=0"])).toThrow(/at least 1/);
    expect(parseMediaScanArgs([])).toEqual({ reclaim: false, emptyTrashDays: null, graceHours: 24 });
    expect(parseMediaScanArgs(["--empty-trash"]).emptyTrashDays).toBe(30);
  });
});
