/**
 * Versions run slower than flushes, and the ring keeps them past the working
 * window: a snapshot the ring holds survives HEAD moving past it and is reclaimed
 * when the ring lets go. Each `applyEdits(); await actor.alarm()` pair is one flush.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { SNAPSHOT_KEEP, VERSION_KEEP } from "@stuga/protocol/domain/limits";
import { DocActor } from "./doc-actor.js";
import { harness, makeActor, connect, type Harness } from "../test/harness.js";

const DOC = "doc-cadence";
const VERSION_INTERVAL_MS = 5 * 60_000; // mirrors the actor's constant

/** A headless write of `text` as the whole body; replaces whatever is there. */
function applyEdits(actor: DocActor, oldText: string, newText: string): Promise<Response> {
  return actor.fetch(
    new Request(`http://actor/apply-edits?docId=${DOC}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ str_edits: [{ old_string: oldText, new_string: newText }], agent: "tester" }),
    }),
  );
}

/** One write plus the backstop that flushes it: exactly one snapshot seq. */
async function flushOnce(h: Harness, oldText: string, newText: string): Promise<void> {
  const actor = makeActor(h);
  await applyEdits(actor, oldText, newText);
  await actor.alarm();
}

const indexJobs = (h: Harness) => h.queued.filter((m) => m.kind === "index_doc");

afterEach(() => {
  vi.useRealTimers();
});

describe("version cadence", () => {
  it("records the first snapshot, then indexes without recording inside the interval", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const h = harness();

    await flushOnce(h, "", "alpha");
    vi.setSystemTime(Date.now() + 30_000); // a flush later, well inside the interval
    await flushOnce(h, "alpha", "alpha bravo");

    const jobs = indexJobs(h);
    expect(jobs).toHaveLength(2); // search still indexes on EVERY flush
    expect(jobs[0]).toMatchObject({ snapshotSeq: 1, recordVersion: true, versionFloor: 1 });
    expect(jobs[1]).toMatchObject({ snapshotSeq: 2, recordVersion: false });
    expect(jobs[1]).not.toHaveProperty("versionFloor");
  });

  it("records again once the interval has passed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const h = harness();

    await flushOnce(h, "", "alpha");
    vi.setSystemTime(Date.now() + VERSION_INTERVAL_MS + 1);
    await flushOnce(h, "alpha", "alpha bravo");

    expect(indexJobs(h)[1]).toMatchObject({ snapshotSeq: 2, recordVersion: true, versionFloor: 1 });
  });

  it("records nothing when the interval elapsed but the text came back to where it started", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const h = harness();

    await flushOnce(h, "", "alpha");
    // Typed and taken back again, all inside one flush window.
    const actor = makeActor(h);
    await applyEdits(actor, "alpha", "alpha bravo");
    await applyEdits(actor, "alpha bravo", "alpha");
    vi.setSystemTime(Date.now() + VERSION_INTERVAL_MS + 1);
    await actor.alarm();

    const jobs = indexJobs(h);
    expect(jobs).toHaveLength(2);
    expect(jobs[1]).toMatchObject({ snapshotSeq: 2, recordVersion: false }); // due, but nothing to commemorate
  });

  it("records when the last writer leaves, whatever the interval says", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const h = harness();

    await flushOnce(h, "", "alpha"); // seq 1, the first version
    const actor = makeActor(h);
    const ws = await connect(actor, h, { docId: DOC, alias: "alice", write: "1" });
    await applyEdits(actor, "alpha", "alpha bravo");
    vi.setSystemTime(Date.now() + 1_000); // deep inside the interval
    await actor.webSocketClose(ws, 1000, "", true);

    const jobs = indexJobs(h);
    expect(jobs.at(-1)).toMatchObject({ snapshotSeq: 2, recordVersion: true, versionFloor: 1 });
  });
});

describe("version retention", () => {
  it("keeps a recorded version's snapshot after HEAD passes the working window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const h = harness();

    // Seq 1 is the only recorded version; the clock never advances again, so no
    // later flush is due for one.
    await flushOnce(h, "", "w0");
    for (let i = 1; i <= SNAPSHOT_KEEP + 1; i++) {
      await flushOnce(h, `w${i - 1}`, `w${i}`);
    }

    // HEAD is SNAPSHOT_KEEP + 2, so seqs 1 and 2 have both left the window.
    expect(h.snapshots.keys()).toContain(`${DOC}/1.bin`); // held by the ring
    expect(h.snapshots.keys()).not.toContain(`${DOC}/2.bin`); // never a version
  });

  it("reclaims a version's snapshot when the ring pushes it out, and raises the floor", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const h = harness();

    // VERSION_KEEP + 1 versions: one per flush, each an interval apart.
    for (let i = 0; i <= VERSION_KEEP; i++) {
      await flushOnce(h, i === 0 ? "" : `w${i - 1}`, `w${i}`);
      vi.setSystemTime(Date.now() + VERSION_INTERVAL_MS + 1);
    }

    const jobs = indexJobs(h);
    expect(jobs).toHaveLength(VERSION_KEEP + 1);
    expect(jobs.every((m) => m.kind === "index_doc" && m.recordVersion === true)).toBe(true);
    // The last message publishes the floor the ring now stands at: seq 1 is out.
    expect(jobs.at(-1)).toMatchObject({ snapshotSeq: VERSION_KEEP + 1, versionFloor: 2 });
    expect(h.snapshots.keys()).not.toContain(`${DOC}/1.bin`);
    expect(h.snapshots.keys()).toContain(`${DOC}/2.bin`);
  });

  it("persists the ring across an eviction, so a revived actor keeps holding it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const h = harness();

    await flushOnce(h, "", "alpha"); // seq 1 recorded by one instance
    // Every later flush runs on a FRESH instance (the shape of an evicted actor),
    // so the ring has to come back from storage or seq 1 is pruned as ordinary.
    for (let i = 1; i <= SNAPSHOT_KEEP + 1; i++) {
      await flushOnce(h, i === 1 ? "alpha" : `w${i - 1}`, `w${i}`);
    }

    expect(h.snapshots.keys()).toContain(`${DOC}/1.bin`);
    const meta = h.state.storage.map.get("meta") as { ring: { seqs: number[] } };
    expect(meta.ring.seqs).toEqual([1]);
  });
});
