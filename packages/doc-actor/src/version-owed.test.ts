/**
 * A head a flush saved inside the interval is owed a version. It gets one when
 * the interval ends or someone leaves, from the snapshot it already has, and a
 * restore first records what it replaces. A change is what the compare dialog
 * shows, formatting included. Alarms fire the way the host fires them: at their
 * time, consumed before the handler runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { SNAPSHOT_KEEP, snapshotKey } from "@stuga/protocol/domain/limits";
import type { IndexMessage } from "@stuga/protocol/internal/jobs";
import { encodeBinary } from "@stuga/protocol/wire/frame";
import { CloseCode, Opcode } from "@stuga/protocol/wire/opcodes";
import { yXmlFragmentToMarkdown } from "@stuga/crdt-ops";
import { DocActor } from "./doc-actor.js";
import { connect, disconnect, frameBuffer, harness, makeActor, type Harness, type MemorySocket } from "../test/harness.js";

// Counted, so a test can say how often the actor serialized the document.
vi.mock("@stuga/crdt-ops", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@stuga/crdt-ops")>();
  return { ...mod, yXmlFragmentToMarkdown: vi.fn(mod.yXmlFragmentToMarkdown) };
});

const DOC = "doc-owed";
const VERSION_INTERVAL_MS = 5 * 60_000; // mirrors the actor's constant
const FLUSH_INTERVAL_MS = 30_000; // mirrors DOC_FLUSH_INTERVAL_MS

type IndexJob = Extract<IndexMessage, { kind: "index_doc" }>;
const indexJobs = (h: Harness): IndexJob[] => h.queued.filter((m): m is IndexJob => m.kind === "index_doc");
const lastJob = (h: Harness): IndexJob | undefined => indexJobs(h).at(-1);

/** A headless write of `to` over `from`, as `who`. */
async function edit(actor: DocActor, from: string, to: string, who: string): Promise<void> {
  const res = await actor.fetch(
    new Request(`http://actor/apply-edits?docId=${DOC}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ str_edits: [{ old_string: from, new_string: to }], agent: who }),
    }),
  );
  expect(((await res.json()) as { applied: boolean }).applied).toBe(true);
}

/** A person's edit over a socket: a paragraph of its own. */
async function typeOver(actor: DocActor, ws: MemorySocket, text: string): Promise<void> {
  const doc = new Y.Doc();
  doc.transact(() => {
    const p = new Y.XmlElement("paragraph");
    p.insert(0, [new Y.XmlText(text)]);
    doc.getXmlFragment("default").insert(0, [p]);
  });
  await actor.webSocketMessage(ws, frameBuffer(encodeBinary(Opcode.UPDATE, Y.encodeStateAsUpdate(doc))));
}

/** A writer's update the Markdown serializer cannot read: text straight under the root, where blocks go. */
async function typeLoose(actor: DocActor, ws: MemorySocket, text: string): Promise<void> {
  const doc = new Y.Doc();
  doc.getXmlFragment("default").insert(0, [new Y.XmlText(text)]);
  await actor.webSocketMessage(ws, frameBuffer(encodeBinary(Opcode.UPDATE, Y.encodeStateAsUpdate(doc))));
}

/** Fire the armed alarm as the host does: at its time, consumed first. */
async function fireAlarm(h: Harness, actor: DocActor): Promise<void> {
  const at = h.state.storage.alarm;
  if (at === null) throw new Error("no alarm armed");
  if (at > Date.now()) vi.setSystemTime(at);
  await h.state.storage.deleteAlarm();
  await actor.alarm();
}

interface Meta {
  seq: number;
  ring: { seqs: number[]; lastHash: string };
}

function meta(h: Harness): Meta {
  return h.state.storage.map.get("meta") as Meta;
}

/** A snapshot as the compare dialog shows it. */
function snapshotMarkdown(h: Harness, seq: number): string {
  const bytes = h.snapshots.bytesOf(snapshotKey(DOC, seq));
  if (!bytes) throw new Error(`no snapshot at seq ${seq}`);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, bytes, "assert");
  return yXmlFragmentToMarkdown(doc.getXmlFragment("default"));
}

function restore(actor: DocActor, seq: number): Promise<Response> {
  return actor.fetch(new Request(`http://actor/restore?docId=${DOC}&seq=${seq}`));
}

/** "alpha" by liv as seq 1, then "alpha bravo" by ada flushed inside the interval: seq 2 is owed. Returns v1's time. */
async function owedHead(h: Harness, actor: DocActor): Promise<number> {
  await edit(actor, "", "alpha", "liv");
  await fireAlarm(h, actor); // seq 1, the first version
  const v1At = Date.now();
  vi.setSystemTime(v1At + 60_000);
  await edit(actor, "alpha", "alpha bravo", "ada");
  await fireAlarm(h, actor); // the backstop: seq 2, inside the interval
  expect(lastJob(h)).toMatchObject({ snapshotSeq: 2, recordVersion: false });
  return v1At;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a head saved without its version", () => {
  it("records it when the interval ends, from the snapshot it already has", async () => {
    const h = harness();
    const actor = makeActor(h);
    const v1At = await owedHead(h, actor);
    expect(h.state.storage.alarm).toBe(v1At + VERSION_INTERVAL_MS);

    await fireAlarm(h, actor);

    expect(indexJobs(h)).toHaveLength(3);
    expect(lastJob(h)).toMatchObject({ snapshotSeq: 2, recordVersion: true, versionFloor: 1, versionAuthors: ["ada"] });
    expect(h.snapshots.keys()).not.toContain(snapshotKey(DOC, 3));
    expect(meta(h)).toMatchObject({ seq: 2, ring: { seqs: [1, 2] } });

    // Spent: nothing owed, nothing armed, and a stray wake-up records nothing.
    expect(h.state.storage.alarm).toBeNull();
    vi.setSystemTime(Date.now() + VERSION_INTERVAL_MS);
    await actor.alarm();
    expect(indexJobs(h)).toHaveLength(3);
    expect(h.state.storage.alarm).toBeNull();
  });

  it("records it when someone leaves, whatever the interval says", async () => {
    const h = harness();
    const actor = makeActor(h);
    await edit(actor, "", "alpha", "liv");
    await fireAlarm(h, actor); // seq 1
    const bob = await connect(actor, h, { docId: DOC, alias: "bob" });
    const ada = await connect(actor, h, { docId: DOC, alias: "ada" });
    await typeOver(actor, bob, "from bob");
    await fireAlarm(h, actor); // seq 2, inside the interval
    expect(lastJob(h)).toMatchObject({ snapshotSeq: 2, recordVersion: false });

    await disconnect(actor, bob);

    expect(lastJob(h)).toMatchObject({ snapshotSeq: 2, recordVersion: true, versionAuthors: ["bob"] });
    expect(h.snapshots.keys()).not.toContain(snapshotKey(DOC, 3));
    // The next one to leave finds nothing owed.
    await disconnect(actor, ada);
    expect(indexJobs(h)).toHaveLength(3);
  });

  it("is not recorded when a revoked socket leaves", async () => {
    const h = harness();
    const actor = makeActor(h);
    await edit(actor, "", "alpha", "liv");
    await fireAlarm(h, actor); // seq 1
    const bob = await connect(actor, h, { docId: DOC, alias: "bob" });
    await typeOver(actor, bob, "from bob");
    await fireAlarm(h, actor); // seq 2, owed

    await disconnect(actor, bob, CloseCode.ACCESS_REVOKED);

    expect(indexJobs(h)).toHaveLength(2);
  });

  it("is not owed when its text came back to the last version's: the interval finds that once, and nothing is armed after", async () => {
    const h = harness();
    const actor = makeActor(h);
    await edit(actor, "", "alpha", "liv");
    await fireAlarm(h, actor); // seq 1
    await edit(actor, "alpha", "alpha bravo", "ada");
    await edit(actor, "alpha bravo", "alpha", "ada");
    await fireAlarm(h, actor); // seq 2, the same text as seq 1
    expect(lastJob(h)).toMatchObject({ snapshotSeq: 2, recordVersion: false });

    await fireAlarm(h, actor); // the interval: nothing to record

    expect(h.state.storage.alarm).toBeNull();
    vi.setSystemTime(Date.now() + VERSION_INTERVAL_MS + 1);
    await actor.alarm();
    await disconnect(actor, await connect(actor, h, { docId: DOC, alias: "bob" }));
    expect(indexJobs(h)).toHaveLength(2);
    expect(h.state.storage.alarm).toBeNull();
  });

  it("tells the node nothing when its ring cannot be saved, so every version listed keeps its bytes", async () => {
    const h = harness();
    const actor = makeActor(h);
    await owedHead(h, actor);
    const bob = await connect(actor, h, { docId: DOC, alias: "bob" });
    const put = h.state.storage.put.bind(h.state.storage);
    // As when the host closes the store under the socket it is dropping.
    h.state.storage.put = (key, value) => (key === "meta" ? Promise.reject(new Error("database is not open")) : put(key, value));
    await disconnect(actor, bob);
    h.state.storage.put = put;
    expect(indexJobs(h)).toHaveLength(2);

    // The next instance is edited before the version's alarm fires, until HEAD leaves seq 2's window.
    const revived = makeActor(h);
    let text = "alpha bravo";
    for (let i = 0; i <= SNAPSHOT_KEEP; i++) {
      await edit(revived, text, `alpha w${i}`, "liv");
      text = `alpha w${i}`;
      await revived.alarm();
    }

    const versions = indexJobs(h).filter((j) => j.recordVersion);
    const floor = Math.max(...versions.map((j) => (j.recordVersion ? j.versionFloor : 0)));
    const listed = versions.map((j) => j.snapshotSeq!).filter((seq) => seq >= floor);
    expect(listed.filter((seq) => !h.snapshots.keys().includes(snapshotKey(DOC, seq)))).toEqual([]);
  });

  it("names everyone since the last version, while `authors` stays the last flush's", async () => {
    const h = harness();
    const actor = makeActor(h);
    await edit(actor, "", "alpha", "liv");
    await fireAlarm(h, actor); // seq 1
    const v1At = Date.now();
    vi.setSystemTime(v1At + 60_000);
    await edit(actor, "alpha", "alpha ada", "ada");
    await fireAlarm(h, actor); // seq 2, no version
    vi.setSystemTime(v1At + 120_000);
    await edit(actor, "alpha ada", "alpha ada liv", "liv");
    await fireAlarm(h, actor); // seq 3, no version
    // Bob's edit lands just before the interval ends; the flush at its end records it.
    vi.setSystemTime(v1At + VERSION_INTERVAL_MS - 10_000);
    await edit(actor, "alpha ada liv", "alpha ada liv bob", "bob");
    await fireAlarm(h, actor); // seq 4, a version

    const jobs = indexJobs(h);
    expect(jobs.map((j) => [j.snapshotSeq, j.recordVersion, j.authors])).toEqual([
      [1, true, ["liv"]],
      [2, false, ["ada"]],
      [3, false, ["liv"]],
      [4, true, ["bob"]],
    ]);
    expect(jobs[0]).toMatchObject({ versionAuthors: ["liv"] });
    expect(jobs[3]).toMatchObject({ versionAuthors: ["ada", "liv", "bob"] });
    expect(jobs[1]).not.toHaveProperty("versionAuthors");

    // The next version starts from nobody.
    vi.setSystemTime(Date.now() + 60_000);
    await edit(actor, "alpha ada liv bob", "alpha ada liv bob again", "ada");
    await fireAlarm(h, actor); // seq 5, no version
    await fireAlarm(h, actor); // the interval: seq 5 promoted
    expect(lastJob(h)).toMatchObject({ snapshotSeq: 5, recordVersion: true, authors: [], versionAuthors: ["ada"] });
  });

  it("is recorded by a fresh instance whose alarm fires after the interval", async () => {
    const h = harness();
    await owedHead(h, makeActor(h));

    const revived = makeActor(h); // a restart: the same storage, nothing in memory
    await fireAlarm(h, revived);

    // Who wrote it lived in the old instance's memory.
    expect(lastJob(h)).toMatchObject({ snapshotSeq: 2, recordVersion: true, versionFloor: 1, versionAuthors: [] });
    expect(meta(h)).toMatchObject({ seq: 2, ring: { seqs: [1, 2] } });
    expect(h.state.storage.alarm).toBeNull();
  });

  it("arms its version when the document is opened, if the store kept no alarm for it", async () => {
    const h = harness();
    await owedHead(h, makeActor(h));
    await h.state.storage.deleteAlarm(); // as an earlier build left it
    vi.setSystemTime(Date.now() + 60 * 60_000);

    const revived = makeActor(h);
    await connect(revived, h, { docId: DOC, alias: "bob" });
    expect(h.state.storage.alarm).toBe(Date.now() + FLUSH_INTERVAL_MS);
    await fireAlarm(h, revived);

    expect(lastJob(h)).toMatchObject({ snapshotSeq: 2, recordVersion: true });
  });

  it("rolls back a promotion that cannot enqueue, and retries it with its authors", async () => {
    const h = harness();
    const actor = makeActor(h);
    await owedHead(h, actor);
    const send = h.jobs.send.bind(h.jobs);
    h.jobs.send = () => Promise.reject(new Error("queue down"));

    await fireAlarm(h, actor);

    expect(meta(h).ring.seqs).toEqual([1]);
    expect(h.state.storage.alarm).toBe(Date.now() + FLUSH_INTERVAL_MS);
    h.jobs.send = send;
    await fireAlarm(h, actor);
    expect(lastJob(h)).toMatchObject({ snapshotSeq: 2, recordVersion: true, versionAuthors: ["ada"] });
    expect(meta(h).ring.seqs).toEqual([1, 2]);
  });

  it("holds a flush off while a promotion is in flight, and a restore waits for it", async () => {
    const h = harness();
    const actor = makeActor(h);
    const v1At = await owedHead(h, actor);
    vi.setSystemTime(v1At + VERSION_INTERVAL_MS);
    let entered!: () => void;
    const inSend = new Promise<void>((res) => (entered = res));
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const send = h.jobs.send.bind(h.jobs);
    h.jobs.send = async (m) => {
      entered();
      await gate;
      return send(m);
    };

    const promoting = actor.alarm();
    await inSend;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = (actor as any).store;
    await edit(actor, "alpha bravo", "alpha bravo charlie", "bob");
    await store.flush("threshold");
    expect(meta(h).seq).toBe(2); // held off: the promotion holds the slot
    const restoring = restore(actor, 1);
    for (let i = 0; i < 100 && !store.replacingHead; i++) await Promise.resolve();
    expect(store.replacingHead).toBe(true);
    expect(h.snapshots.keys()).not.toContain(snapshotKey(DOC, 3)); // waiting, not writing
    release();
    await promoting;
    expect((await restoring).status).toBe(200);

    // The promotion, the restore's checkpoint of bob's edit, the restored head: no seq claimed twice.
    expect(indexJobs(h).slice(2).map((j) => [j.snapshotSeq, j.recordVersion])).toEqual([
      [2, true],
      [3, true],
      [4, true],
    ]);
    expect(snapshotMarkdown(h, 3)).toContain("alpha bravo charlie");
  });

  it("is not recorded from a head the store could not read, and nothing is armed", async () => {
    const h = harness();
    await owedHead(h, makeActor(h));
    await h.snapshots.delete(snapshotKey(DOC, 2));
    const revived = makeActor(h); // reads a blank document where seq 2 should be

    await fireAlarm(h, revived); // the interval has passed
    expect(h.state.storage.alarm).toBeNull();
    await disconnect(revived, await connect(revived, h, { docId: DOC, alias: "bob" }));

    expect(indexJobs(h)).toHaveLength(2);
    expect(meta(h)).toMatchObject({ seq: 2, ring: { seqs: [1] } });
    expect(h.state.storage.alarm).toBeNull();
  });

  it("is held off while a restore replaces the head", async () => {
    const h = harness();
    const actor = makeActor(h);
    const v1At = await owedHead(h, actor);
    vi.setSystemTime(v1At + VERSION_INTERVAL_MS);
    let entered!: () => void;
    const inPut = new Promise<void>((res) => (entered = res));
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const put = h.snapshots.put.bind(h.snapshots);
    h.snapshots.put = async (...args) => {
      entered();
      await gate;
      return put(...args);
    };

    const restoring = restore(actor, 1);
    await inPut; // the checkpoint's snapshot, before its ring entry
    await actor.alarm(); // due, but the restore holds the head

    expect(indexJobs(h)).toHaveLength(2);
    expect(meta(h).ring.seqs).toEqual([1]);
    h.snapshots.put = put;
    release();
    expect((await restoring).status).toBe(200);

    // The checkpoint of seq 2's document, the restored head; seq 2 itself was never recorded.
    expect(indexJobs(h).slice(2).map((j) => [j.snapshotSeq, j.recordVersion])).toEqual([
      [3, true],
      [4, true],
    ]);
    // Nothing is owed afterwards: nothing armed, and a stray wake-up records nothing.
    expect(h.state.storage.alarm).toBeNull();
    await actor.alarm();
    expect(indexJobs(h)).toHaveLength(4);
  });
});

describe("a formatting-only edit", () => {
  it("is a change: a head saved inside the interval is owed its version", async () => {
    const h = harness();
    const actor = makeActor(h);
    await edit(actor, "", "alpha beta", "liv");
    await fireAlarm(h, actor); // seq 1
    const v1At = Date.now();
    vi.setSystemTime(v1At + 60_000);
    await edit(actor, "alpha beta", "**alpha beta**", "ada");
    await fireAlarm(h, actor); // seq 2, inside the interval
    expect(lastJob(h)).toMatchObject({ snapshotSeq: 2, recordVersion: false });
    expect(h.state.storage.alarm).toBe(v1At + VERSION_INTERVAL_MS);

    await fireAlarm(h, actor);

    expect(lastJob(h)).toMatchObject({ snapshotSeq: 2, recordVersion: true, versionAuthors: ["ada"] });
    expect(snapshotMarkdown(h, 2)).toBe("**alpha beta**");
  });

  it("is recorded when someone leaves", async () => {
    const h = harness();
    const actor = makeActor(h);
    await edit(actor, "", "alpha beta", "liv");
    await fireAlarm(h, actor); // seq 1
    const bob = await connect(actor, h, { docId: DOC, alias: "bob" });
    await edit(actor, "alpha beta", "alpha *beta*", "ada"); // unsaved

    await disconnect(actor, bob);

    expect(lastJob(h)).toMatchObject({ snapshotSeq: 2, recordVersion: true, versionAuthors: ["ada"] });
    expect(snapshotMarkdown(h, 2)).toBe("alpha *beta*");
  });
});

describe("restoring a version", () => {
  it("first records a saved head that has no version, and keeps its snapshot", async () => {
    const h = harness();
    const actor = makeActor(h);
    await edit(actor, "", "alpha", "liv");
    await fireAlarm(h, actor); // seq 1
    vi.setSystemTime(Date.now() + 60_000);
    await edit(actor, "alpha", "alpha seven", "liv");
    await fireAlarm(h, actor); // seq 2: saved, no version

    expect((await restore(actor, 1)).status).toBe(200);

    const jobs = indexJobs(h);
    expect(jobs.slice(2)).toMatchObject([
      { snapshotSeq: 3, recordVersion: true, versionAuthors: ["liv"] },
      { snapshotSeq: 4, recordVersion: true, authors: ["restore:v1"] },
    ]);
    expect(jobs[3]).not.toHaveProperty("versionAuthors");
    expect(snapshotMarkdown(h, 3)).toContain("alpha seven");
    expect(snapshotMarkdown(h, 4)).not.toContain("seven");
    expect(meta(h)).toMatchObject({ seq: 4, ring: { seqs: [1, 3, 4] } });

    // HEAD moves past the working window: the checkpoint stays, the plain flush below it goes.
    let text = "alpha";
    for (let i = 0; i <= SNAPSHOT_KEEP; i++) {
      await edit(actor, text, `alpha w${i}`, "liv");
      text = `alpha w${i}`;
      await actor.alarm();
    }
    expect(meta(h).seq).toBe(4 + SNAPSHOT_KEEP + 1);
    expect(h.snapshots.keys()).toContain(snapshotKey(DOC, 3));
    expect(h.snapshots.keys()).not.toContain(snapshotKey(DOC, 2));
  });

  it("records unsaved edits too, so the restore can be undone", async () => {
    const h = harness();
    const actor = makeActor(h);
    await edit(actor, "", "alpha", "bob");
    await fireAlarm(h, actor); // seq 1
    vi.setSystemTime(Date.now() + 60_000);
    await edit(actor, "alpha", "alpha seven", "liv");
    await fireAlarm(h, actor); // seq 2: saved, no version
    vi.setSystemTime(Date.now() + 60_000);
    await edit(actor, "alpha seven", "alpha seven six", "ada"); // pending: not flushed
    vi.setSystemTime(Date.now() + 2_000);

    expect((await restore(actor, 1)).status).toBe(200);

    expect(indexJobs(h).slice(2)).toMatchObject([
      { snapshotSeq: 3, recordVersion: true, authors: ["ada"], versionAuthors: ["liv", "ada"] },
      { snapshotSeq: 4, recordVersion: true, authors: ["restore:v1"] },
    ]);
    expect(snapshotMarkdown(h, 3)).toContain("alpha seven six");
    expect(snapshotMarkdown(h, 4)).not.toContain("seven");
    expect(h.state.storage.map.has("pending")).toBe(false);

    // Undone: the live text is the newest version's, so this restore writes no checkpoint.
    expect((await restore(actor, 3)).status).toBe(200);
    expect(indexJobs(h).slice(4)).toMatchObject([{ snapshotSeq: 5, recordVersion: true, authors: ["restore:v3"] }]);
    expect(snapshotMarkdown(h, 5)).toContain("alpha seven six");
  });

  it("first records a formatting-only change", async () => {
    const h = harness();
    const actor = makeActor(h);
    await edit(actor, "", "alpha beta", "liv");
    await fireAlarm(h, actor); // seq 1
    vi.setSystemTime(Date.now() + 60_000);
    await edit(actor, "alpha beta", "**alpha beta**", "ada");
    await fireAlarm(h, actor); // seq 2: saved, no version

    expect((await restore(actor, 1)).status).toBe(200);

    expect(indexJobs(h).slice(2)).toMatchObject([
      { snapshotSeq: 3, recordVersion: true, versionAuthors: ["ada"] },
      { snapshotSeq: 4, recordVersion: true, authors: ["restore:v1"] },
    ]);
    expect(snapshotMarkdown(h, 3)).toBe("**alpha beta**");
    expect(snapshotMarkdown(h, 4)).toBe("alpha beta");
  });

  it("clears the unsaved report, since nothing is left unsaved once the head is replaced", async () => {
    const h = harness();
    const actor = makeActor(h);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = (actor as any).store;
    await edit(actor, "", "alpha", "liv");
    await fireAlarm(h, actor); // seq 1
    // Typed and taken back, so the checkpoint has nothing to write; the flush of it fails.
    await edit(actor, "alpha", "alpha bravo", "ada");
    await edit(actor, "alpha bravo", "alpha", "ada");
    const put = h.snapshots.put.bind(h.snapshots);
    h.snapshots.put = () => Promise.reject(new Error("No space left on device"));
    await fireAlarm(h, actor);
    expect(store.persistDegraded).toBe(true);
    h.snapshots.put = put;

    expect((await restore(actor, 1)).status).toBe(200);

    expect(indexJobs(h).slice(1)).toMatchObject([{ snapshotSeq: 2, recordVersion: true, authors: ["restore:v1"] }]);
    expect(store.persistDegraded).toBe(false);
  });

  it("carries no author from before the restore into the next version", async () => {
    const h = harness();
    const actor = makeActor(h);
    await edit(actor, "", "alpha", "bob");
    await fireAlarm(h, actor); // seq 1
    // Typed and taken back: nothing to checkpoint, but ada was an author.
    await edit(actor, "alpha", "alpha bravo", "ada");
    await edit(actor, "alpha bravo", "alpha", "ada");
    await restore(actor, 1); // seq 2
    expect(indexJobs(h)).toHaveLength(2);

    await edit(actor, "alpha", "alpha charlie", "liv");
    vi.setSystemTime(Date.now() + VERSION_INTERVAL_MS);
    await actor.alarm(); // seq 3, a version

    expect(lastJob(h)).toMatchObject({ snapshotSeq: 3, recordVersion: true, authors: ["liv"], versionAuthors: ["liv"] });
  });
});

describe("a document the Markdown serializer cannot read", () => {
  it("still saves, opens, records versions and restores", async () => {
    const h = harness();
    const actor = makeActor(h);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = (actor as any).store;
    const bob = await connect(actor, h, { docId: DOC, alias: "bob" });
    await typeLoose(actor, bob, "loose");
    expect(() => store.markdown()).toThrow();

    await fireAlarm(h, actor); // seq 1, the first version
    expect(lastJob(h)).toMatchObject({ snapshotSeq: 1, recordVersion: true });
    expect(store.persistDegraded).toBe(false);

    vi.setSystemTime(Date.now() + 60_000);
    await typeOver(actor, bob, "more");
    await fireAlarm(h, actor); // seq 2, inside the interval
    expect(meta(h).seq).toBe(2);
    expect(store.seq).toBe(2);
    expect(store.isDirty).toBe(false);

    const revived = makeActor(h);
    await connect(revived, h, { docId: DOC, alias: "ada" });
    await fireAlarm(h, revived); // the interval: seq 2's version
    expect(lastJob(h)).toMatchObject({ snapshotSeq: 2, recordVersion: true });

    expect((await restore(revived, 1)).status).toBe(200);
    expect(indexJobs(h).slice(3)).toMatchObject([{ snapshotSeq: 3, recordVersion: true, authors: ["restore:v1"] }]);
  });
});

describe("the version hash", () => {
  it("is not computed by a flush inside the interval, and once at most for a saved head", async () => {
    const h = harness();
    const actor = makeActor(h);
    const serialized = vi.mocked(yXmlFragmentToMarkdown);
    await edit(actor, "", "alpha", "liv");
    await fireAlarm(h, actor); // seq 1
    await edit(actor, "alpha", "alpha bravo", "ada");
    await edit(actor, "alpha bravo", "alpha", "ada");

    serialized.mockClear();
    await fireAlarm(h, actor); // seq 2 inside the interval: the same text as seq 1
    expect(serialized).not.toHaveBeenCalled();

    for (let i = 0; i < 5; i++) await disconnect(actor, await connect(actor, h, { docId: DOC, alias: "bob" }));
    await fireAlarm(h, actor); // the interval
    expect(serialized).toHaveBeenCalledTimes(1);
    expect(indexJobs(h)).toHaveLength(2);
    expect(h.state.storage.alarm).toBeNull();
  });

  it("is computed once by a due flush, and not again for the head it leaves", async () => {
    const h = harness();
    const actor = makeActor(h);
    const serialized = vi.mocked(yXmlFragmentToMarkdown);
    await edit(actor, "", "alpha", "liv");
    await fireAlarm(h, actor); // seq 1
    await edit(actor, "alpha", "alpha bravo", "ada");
    await edit(actor, "alpha bravo", "alpha", "ada");
    vi.setSystemTime(Date.now() + VERSION_INTERVAL_MS);

    serialized.mockClear();
    await fireAlarm(h, actor); // seq 2, due: the same text as seq 1
    await disconnect(actor, await connect(actor, h, { docId: DOC, alias: "bob" }));

    expect(serialized).toHaveBeenCalledTimes(1);
    expect(lastJob(h)).toMatchObject({ snapshotSeq: 2, recordVersion: false });
    expect(h.state.storage.alarm).toBeNull();
  });
});
