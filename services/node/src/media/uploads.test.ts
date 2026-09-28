import { MemoryBlobStore } from "@stuga/runtime/testing";
import { describe, expect, it } from "vitest";
import { MEDIA_UPLOAD_TTL_MS, sweepExpiredMediaUploads, uploadExpiry } from "./uploads.js";

describe("staged uploads", () => {
  it("reads its expiry from an id, and sweeps only the stagings past it", async () => {
    const now = Date.UTC(2026, 8, 28);
    const id = (exp: number) => `upl_${exp.toString(36)}_${"a".repeat(18)}`;
    expect(uploadExpiry(id(now + MEDIA_UPLOAD_TTL_MS))).toBe(now + MEDIA_UPLOAD_TTL_MS);
    expect(uploadExpiry("imp_1_x")).toBeNull();
    const snapshots = new MemoryBlobStore();
    const stale = id(now - 1);
    const live = id(now + 1);
    for (const key of [`media-uploads/d1/${stale}.meta`, `media-uploads/d1/${stale}.body`, `media-uploads/d1/${live}.meta`, "db-imports/d1/other.meta"]) {
      await snapshots.put(key, "x");
    }
    expect(await sweepExpiredMediaUploads({ snapshots }, now)).toBe(2);
    expect((await snapshots.list()).objects.map((o) => o.key).sort()).toEqual(["db-imports/d1/other.meta", `media-uploads/d1/${live}.meta`]);
  });
});
