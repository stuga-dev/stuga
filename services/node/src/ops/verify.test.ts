import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "@stuga/db";
import type { BackupEnv } from "./env.js";
import type { Manifest } from "./manifest.js";
import { exitCodeOf } from "./outcome.js";
import { checkCompatibility, checkSameExtensions } from "./verify.js";

const BACKUP = { plpgsql: "1.0", btree_gin: "1.3", pg_trgm: "1.6", vector: "0.8.1" };

function refusal(live: Record<string, string>): unknown {
  try {
    checkSameExtensions(new Map(Object.entries(live)), BACKUP);
    return null;
  } catch (err) {
    return err;
  }
}

describe("checkSameExtensions", () => {
  it("passes the backup's own extensions", () => {
    expect(refusal(BACKUP)).toBeNull();
  });

  it("refuses an extension both hold at another version", () => {
    const err = refusal({ ...BACKUP, vector: "0.9.0" });
    expect(exitCodeOf(err)).toBe(2);
    expect((err as Error).message).toBe(
      "the current data has vector 0.9.0 and this backup vector 0.8.1: going back across an extension update is not supported. Nothing was changed.",
    );
  });

  it("passes an extension only one side holds: the older build never opens it, or the dump brings it back", () => {
    expect(refusal({ ...BACKUP, unaccent: "1.1" })).toBeNull();
    const { btree_gin: _dropped, ...live } = BACKUP;
    expect(refusal(live)).toBeNull();
    expect(refusal({ plpgsql: "1.0" })).toBeNull();
  });
});

describe("checkCompatibility", () => {
  const env = { version: "1.1.0", embeddingDims: 1024, publicOrigin: "http://localhost:8787" } as BackupEnv;
  // Taken by 1.1.0 of 1.0.0's data before it upgraded it, one schema back.
  const manifest = {
    stuga_version: "1.0.0",
    runtime_version: "1.1.0",
    schema_version: SCHEMA_VERSION - 1,
    postgres_version_num: 180001,
    embedding_dims: 1024,
    public_origin: "http://localhost:8787",
  } as Manifest;

  it("notes that this runtime migrates an older schema when it starts", () => {
    expect(checkCompatibility(env, manifest, 180001)).toEqual([
      `the backup is at schema ${SCHEMA_VERSION - 1}; the node migrates it to schema ${SCHEMA_VERSION} when it starts`,
    ]);
  });

  it("going back, leaves that out: the backup's own release serves it at its own schema", () => {
    expect(checkCompatibility(env, manifest, 180001, { goingBack: true })).toEqual([]);
  });
});
