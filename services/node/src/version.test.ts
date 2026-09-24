import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEV_VERSION, bootSummary, readVersion } from "./version.js";

describe("readVersion", () => {
  let root: string;
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("uses the VERSION file packaging wrote at the app root", () => {
    root = mkdtempSync(join(tmpdir(), "stuga-version-"));
    writeFileSync(join(root, "VERSION"), "  0.3.1\n");
    expect(readVersion(root)).toEqual({ version: "0.3.1", build: "release", releasedAt: null });
  });

  it("reads the day of the release from RELEASED, and nothing that is not a day", () => {
    root = mkdtempSync(join(tmpdir(), "stuga-version-"));
    writeFileSync(join(root, "VERSION"), "0.3.1\n");
    writeFileSync(join(root, "RELEASED"), "2026-10-01\n");
    expect(readVersion(root).releasedAt).toBe("2026-10-01");
    writeFileSync(join(root, "RELEASED"), "yesterday\n");
    expect(readVersion(root).releasedAt).toBeNull();
  });

  it("never passes an unstamped tree off as a release", () => {
    root = mkdtempSync(join(tmpdir(), "stuga-version-"));
    expect(readVersion(root)).toEqual({ version: DEV_VERSION, build: "source", releasedAt: null });
    writeFileSync(join(root, "VERSION"), "   \n");
    expect(readVersion(root)).toEqual({ version: DEV_VERSION, build: "source", releasedAt: null });
    // A date with no version beside it says nothing about what is running.
    writeFileSync(join(root, "RELEASED"), "2026-10-01\n");
    expect(readVersion(root).releasedAt).toBeNull();
  });
});

describe("bootSummary", () => {
  it("names both builds when the version changed", () => {
    expect(bootSummary({ version: "0.3.0", previousVersion: "0.2.0", schema: { from: 7, to: 9 } })).toBe(
      "stuga 0.2.0 → 0.3.0, schema 7 → 9",
    );
  });

  it("prints on an unchanged boot", () => {
    expect(bootSummary({ version: "0.3.0", previousVersion: "0.3.0", schema: { from: 9, to: 9 } })).toBe(
      "stuga 0.3.0, schema 9",
    );
  });

  it("marks a new database", () => {
    expect(bootSummary({ version: "0.3.0", previousVersion: null, schema: { from: 0, to: 1 } })).toBe(
      "stuga 0.3.0, schema 1 (new database)",
    );
  });

  it("reports a schema change even when the build did not move", () => {
    expect(bootSummary({ version: "0.3.0", previousVersion: "0.3.0", schema: { from: 8, to: 9 } })).toBe(
      "stuga 0.3.0, schema 8 → 9",
    );
  });
});
