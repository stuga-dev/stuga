import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEV_VERSION, bootSummary, compareVersions, isReleaseVersion, readVersion, versionChange } from "./version.js";

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

describe("isReleaseVersion", () => {
  it("is true only for a plain version, which is what a release carries", () => {
    expect(isReleaseVersion("1.2.3")).toBe(true);
    for (const v of ["0.0.0-dev", "0.0.0-ci", "1.2", "v1.2.3", "1.2.3-rc.1", "01.2.3", ""]) {
      expect(isReleaseVersion(v)).toBe(false);
    }
  });
});

describe("compareVersions", () => {
  it("orders by number, not by text", () => {
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(compareVersions("1.9.0", "1.10.0")).toBeLessThan(0);
    expect(compareVersions("2.0.0", "1.99.99")).toBeGreaterThan(0);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
  });
});

describe("versionChange", () => {
  it("is the same for one version on both sides, release or not", () => {
    expect(versionChange("1.2.3", "1.2.3")).toBe("same");
    expect(versionChange("0.0.0-dev", "0.0.0-dev")).toBe("same");
  });

  it("orders two releases by number", () => {
    expect(versionChange("1.2.3", "1.3.0")).toBe("upgrade");
    expect(versionChange("0.1.9", "0.1.10")).toBe("upgrade");
    expect(versionChange("1.3.0", "1.2.3")).toBe("downgrade");
    expect(versionChange("0.1.10", "0.1.9")).toBe("downgrade");
  });

  it("orders nothing that is not a release, on either side", () => {
    for (const other of ["0.0.0-dev", "0.0.0-ci", "local-abc1234", "0.0.0-drill", "9.9.9-test"]) {
      expect(versionChange(other, "1.0.0"), other).toBe("unordered");
      expect(versionChange("1.0.0", other), other).toBe("unordered");
    }
    expect(versionChange("0.0.0-ci", "0.0.0-dev")).toBe("unordered");
  });
});
