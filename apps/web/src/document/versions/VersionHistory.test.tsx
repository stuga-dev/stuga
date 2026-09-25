// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Version } from "../../api";
import { VersionHistory } from "./VersionHistory";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function version(over: Partial<Version> & { seq: number; ts: string }): Version {
  return {
    doc_id: "d1",
    authors: ["alice"],
    chars: null,
    chars_added: null,
    chars_removed: null,
    ...over,
  };
}

/** An ISO timestamp `ms` before now. */
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

let container: HTMLDivElement;
let root: Root;
const opened: number[] = [];

beforeEach(() => {
  // Local midday, so "N hours ago" fixtures land on today whatever time the suite runs.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date(2026, 7, 19, 12, 0, 0));
  opened.length = 0;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

/** `currentSeq` defaults to the newest version's seq. */
function render(versions: Version[], currentSeq: number | null = versions[0]?.seq ?? null) {
  act(() => {
    root.render(<VersionHistory versions={versions} currentSeq={currentSeq} onOpen={(seq) => opened.push(seq)} />);
  });
  return container;
}

const text = () => container.textContent ?? "";
const rows = () => [...container.querySelectorAll<HTMLButtonElement>(".version-open")];
const days = () => [...container.querySelectorAll(".version-day")].map((h) => h.textContent);

describe("VersionHistory", () => {
  it("says so when there is no history yet", () => {
    render([]);
    expect(text()).toContain("No versions yet");
    expect(rows()).toHaveLength(0);
  });

  it("names versions by date and time, never by sequence number", () => {
    render([
      version({ seq: 7, ts: ago(2 * HOUR) }),
      version({ seq: 6, ts: ago(3 * HOUR) }),
      version({ seq: 5, ts: ago(DAY + HOUR) }),
    ]);
    expect(text()).not.toMatch(/\bv\d+\b/);
    for (const row of rows()) expect(row.querySelector(".vtime")?.textContent).toMatch(/\d/);
  });

  it("groups rows under the day they belong to", () => {
    render([
      version({ seq: 7, ts: ago(2 * HOUR) }),
      version({ seq: 6, ts: ago(3 * HOUR) }),
      version({ seq: 5, ts: ago(DAY + HOUR) }),
    ]);
    expect(days()).toEqual(["Today", "Yesterday"]);
    expect(rows()).toHaveLength(3);
  });

  it("marks the current version, and only that one", () => {
    render([version({ seq: 7, ts: ago(HOUR) }), version({ seq: 6, ts: ago(2 * HOUR) })], 7);
    const current = [...container.querySelectorAll(".vcurrent")];
    expect(current).toHaveLength(1);
    expect(rows()[0]!.contains(current[0]!)).toBe(true);
  });

  it("marks none current when the document has moved on past every version", () => {
    render([version({ seq: 7, ts: ago(HOUR) }), version({ seq: 6, ts: ago(2 * HOUR) })], null);
    expect(container.querySelector(".vcurrent")).toBeNull();
    expect(text()).not.toContain("Current");
  });

  it("prints how much text each version added and removed", () => {
    render([version({ seq: 7, ts: ago(HOUR), chars: 1280, chars_added: 312, chars_removed: 45 })]);
    expect(text()).toContain("+312");
    expect(text()).toContain("−45"); // U+2212, not a hyphen
    expect(container.querySelector(".vchange")?.getAttribute("title")).toContain("1,280 characters");
  });

  it("shows only the side that moved for a pure insertion or deletion", () => {
    render([
      version({ seq: 7, ts: ago(HOUR), chars_added: 400, chars_removed: 0 }),
      version({ seq: 6, ts: ago(2 * HOUR), chars_added: 0, chars_removed: 90 }),
    ]);
    expect(rows()[0]!.textContent).toContain("+400");
    expect(rows()[0]!.textContent).not.toContain("−0");
    expect(rows()[1]!.textContent).toContain("−90");
    expect(rows()[1]!.textContent).not.toContain("+0");
  });

  it("distinguishes a measured zero change from an unknown one", () => {
    render([
      version({ seq: 7, ts: ago(HOUR), chars: 900, chars_added: 0, chars_removed: 0 }),
      version({ seq: 6, ts: ago(2 * HOUR) }), // counts never recorded
    ]);
    expect(rows()[0]!.textContent).toContain("No text change");
    // Unknown counts make no claim.
    expect(rows()[1]!.querySelector(".vchange")).toBeNull();
    expect(rows()[1]!.textContent).not.toContain("No text change");
  });

  it("names the version a restore came from by its time, not its seq", () => {
    const source = version({ seq: 5, ts: ago(2 * DAY) });
    render([version({ seq: 7, ts: ago(HOUR), authors: ["restore:v5"] }), version({ seq: 6, ts: ago(3 * HOUR) }), source]);
    expect(text()).toContain("restored from");
    expect(text()).not.toContain("restore:v5");
    expect(text()).not.toMatch(/\bv5\b/);
  });

  it("falls back to the raw marker when the restored-from version is gone", () => {
    render([version({ seq: 7, ts: ago(HOUR), authors: ["restore:v2"] })]);
    expect(text()).toContain("restored from v2");
  });

  it("opens the version that was clicked", () => {
    render([version({ seq: 7, ts: ago(HOUR) }), version({ seq: 6, ts: ago(2 * HOUR) })]);
    act(() => {
      rows()[1]!.click();
    });
    expect(opened).toEqual([6]);
  });
});
