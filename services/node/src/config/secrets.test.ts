import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadOrCreateInternalSecret, readSecretFile, removeSecretFile, writeSecretFile } from "./secrets.js";

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("loadOrCreateInternalSecret", () => {
  it("generates once and persists under the data dir", () => {
    dir = mkdtempSync(join(tmpdir(), "stuga-config-"));
    const first = loadOrCreateInternalSecret(dir);
    expect(first.length).toBeGreaterThanOrEqual(32);
    expect(readFileSync(join(dir, "secrets", "internal"), "utf8").trim()).toBe(first);
    expect(loadOrCreateInternalSecret(dir)).toBe(first);
  });
});

describe("secret files", () => {
  it("round-trip with owner-only permissions, and removing an absent one is fine", () => {
    dir = mkdtempSync(join(tmpdir(), "stuga-config-"));
    expect(readSecretFile(dir, "k")).toBeNull();
    writeSecretFile(dir, "k", "value");
    expect(readSecretFile(dir, "k")).toBe("value");
    expect(statSync(join(dir, "secrets", "k")).mode & 0o777).toBe(0o600);
    removeSecretFile(dir, "k");
    removeSecretFile(dir, "k");
    expect(readSecretFile(dir, "k")).toBeNull();
  });
});
