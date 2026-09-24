import { describe, expect, it } from "vitest";
import { compareVersions, isReleaseVersion, parseFeed, pendingUpdate, sourceUrl, storedReleases } from "./feed.js";

const RELEASES = [
  { version: "1.10.0", date: "2026-12-01", security: false },
  { version: "1.9.1", date: "2026-11-10", security: true },
  { version: "1.9.0", date: "2026-11-03", security: false },
  { version: "1.2.0", date: "2026-10-01", security: true },
];

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

describe("sourceUrl", () => {
  it("points a release at its tag and a build from source at the repository", () => {
    expect(sourceUrl("1.9.0", "release")).toBe("https://github.com/stuga-dev/stuga/tree/v1.9.0");
    expect(sourceUrl("0.0.0-dev", "source")).toBe("https://github.com/stuga-dev/stuga");
  });
});

describe("parseFeed", () => {
  it("reads the releases and ignores what this build does not know", () => {
    const feed = { format: 7, generated_by: "a later workflow", releases: [{ ...RELEASES[0], channel: "stable" }] };
    expect(parseFeed(feed)).toEqual([RELEASES[0]]);
  });

  it("skips an entry it cannot read rather than refusing the feed", () => {
    const releases = parseFeed({
      releases: [
        { version: "2.0.0-rc.1", date: "2027-01-01", security: false },
        { version: "1.9.0", date: "soon", security: false },
        { version: 19, date: "2026-11-03" },
        null,
        "1.9.0",
        { version: "1.9.0", date: "2026-11-03" },
      ],
    });
    expect(releases).toEqual([{ version: "1.9.0", date: "2026-11-03", security: false }]);
  });

  it("calls a release a security release only when the feed says exactly that", () => {
    const [release] = parseFeed({ releases: [{ version: "1.0.1", date: "2026-10-02", security: "true" }] });
    expect(release?.security).toBe(false);
  });

  it("refuses what is not a release list", () => {
    for (const doc of [null, "<html>", [], {}, { releases: "none" }]) {
      expect(() => parseFeed(doc)).toThrow("not a release list");
    }
  });
});

describe("storedReleases", () => {
  it("reads nothing from a row that holds no feed", () => {
    expect(storedReleases(null)).toEqual([]);
    expect(storedReleases({ releases: RELEASES })).toEqual(RELEASES);
  });
});

describe("pendingUpdate", () => {
  it("names the newest release, whatever order the feed lists them in", () => {
    const pending = pendingUpdate("1.9.0", [...RELEASES].reverse());
    expect(pending).toEqual({
      version: "1.10.0",
      date: "2026-12-01",
      securityVersion: "1.9.1",
      notesUrl: "https://github.com/stuga-dev/stuga/releases/tag/v1.10.0",
    });
  });

  it("counts only the security releases after the running version", () => {
    expect(pendingUpdate("1.9.1", RELEASES)?.securityVersion).toBeNull();
    expect(pendingUpdate("1.1.0", RELEASES)?.securityVersion).toBe("1.9.1");
  });

  it("is nothing for a node that is current, ahead of the feed, or not a release", () => {
    expect(pendingUpdate("1.10.0", RELEASES)).toBeNull();
    expect(pendingUpdate("2.0.0", RELEASES)).toBeNull();
    expect(pendingUpdate("0.0.0-dev", RELEASES)).toBeNull();
    expect(pendingUpdate("1.0.0", [])).toBeNull();
  });
});
