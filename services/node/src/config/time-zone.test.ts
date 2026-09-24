import { describe, expect, it } from "vitest";
import { knownTimeZone, lastScheduled, nextScheduled } from "./time-zone.js";

const at = (iso: string) => new Date(iso);

describe("the node's time zone", () => {
  it("takes a name the runtime knows and drops anything else", () => {
    expect(knownTimeZone("Asia/Shanghai")).toBe("Asia/Shanghai");
    expect(knownTimeZone(" Europe/Berlin ")).toBe("Europe/Berlin");
    expect(knownTimeZone("UTC")).toBe("UTC");
    expect(knownTimeZone("Mars/Olympus")).toBeNull();
    expect(knownTimeZone("")).toBeNull();
    expect(knownTimeZone(42)).toBeNull();
    expect(knownTimeZone("x".repeat(65))).toBeNull();
  });
});

describe("the daily hour", () => {
  it("is the most recent one at or before now, and the next one after", () => {
    expect(lastScheduled(at("2026-09-23T05:00:00Z"), 3, "UTC")).toEqual(at("2026-09-23T03:00:00Z"));
    expect(lastScheduled(at("2026-09-23T02:59:00Z"), 3, "UTC")).toEqual(at("2026-09-22T03:00:00Z"));
    expect(lastScheduled(at("2026-09-23T03:00:00Z"), 3, "UTC")).toEqual(at("2026-09-23T03:00:00Z"));
    expect(nextScheduled(at("2026-09-23T03:00:00Z"), 3, "UTC")).toEqual(at("2026-09-24T03:00:00Z"));
    expect(nextScheduled(at("2026-09-23T02:00:00Z"), 3, "UTC")).toEqual(at("2026-09-23T03:00:00Z"));
  });

  it("is on the node's own clock", () => {
    // 03:00 in Shanghai is 19:00 UTC the day before.
    expect(lastScheduled(at("2026-09-23T12:00:00Z"), 3, "Asia/Shanghai")).toEqual(at("2026-09-22T19:00:00Z"));
    expect(nextScheduled(at("2026-09-23T12:00:00Z"), 3, "Asia/Shanghai")).toEqual(at("2026-09-23T19:00:00Z"));
    // Late in the evening: tomorrow's is a whole day on, not two.
    expect(nextScheduled(at("2026-09-23T15:30:00Z"), 23, "Asia/Shanghai")).toEqual(at("2026-09-24T15:00:00Z"));
    expect(nextScheduled(at("2026-09-23T15:30:00Z"), 23, "UTC")).toEqual(at("2026-09-23T23:00:00Z"));
  });

  it("keeps to the wall clock across a change of the clocks", () => {
    // New York moves from EST (-5) to EDT (-4) on 2026-03-08.
    expect(nextScheduled(at("2026-03-07T12:00:00Z"), 3, "America/New_York")).toEqual(at("2026-03-08T07:00:00Z"));
    expect(nextScheduled(at("2026-03-08T12:00:00Z"), 3, "America/New_York")).toEqual(at("2026-03-09T07:00:00Z"));
    // And back on 2026-11-01.
    expect(lastScheduled(at("2026-11-01T12:00:00Z"), 3, "America/New_York")).toEqual(at("2026-11-01T08:00:00Z"));
    // An hour the change skips lands on a neighbour: once a season, an hour off.
    const skipped = nextScheduled(at("2026-03-07T12:00:00Z"), 2, "America/New_York").getTime();
    expect([at("2026-03-08T06:00:00Z").getTime(), at("2026-03-08T07:00:00Z").getTime()]).toContain(skipped);
  });
});
