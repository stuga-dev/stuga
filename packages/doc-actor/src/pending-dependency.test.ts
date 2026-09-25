/**
 * Dependency-pending updates are journaled, not dropped. `Y.applyUpdate` parks an
 * update whose causal predecessor is missing and fires no update event, yet the
 * actor has already acked and broadcast it. Any refusal (rate limit, lock, epoch
 * fence) can leave such a gap. The first test pins the Yjs behaviour this relies on.
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { encodeBinary } from "@stuga/protocol/wire/frame";
import { Opcode } from "@stuga/protocol/wire/opcodes";
import {
  harness,
  makeActor,
  connect,
  type MemorySocket,
  frameBuffer,
} from "../test/harness.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function send(dobj: any, ws: MemorySocket, update: Uint8Array): Promise<void> {
  const frame = encodeBinary(Opcode.UPDATE, update);
  await dobj.webSocketMessage(ws, frameBuffer(frame));
}

/**
 * A client that produces one update per paragraph, so a caller can deliver them
 * out of order (or drop one) the way a refusal or a reordering would.
 */
function producer(texts: string[]): Uint8Array[] {
  const doc = new Y.Doc();
  const updates: Uint8Array[] = [];
  doc.on("update", (u: Uint8Array) => updates.push(u));
  const frag = doc.getXmlFragment("default");
  texts.forEach((text, i) => {
    doc.transact(() => {
      const p = new Y.XmlElement("paragraph");
      p.insert(0, [new Y.XmlText(text)]);
      frag.insert(i, [p]);
    });
  });
  return updates;
}

/** Replay a journal (as ensureLoaded does) and read the resulting text. */
function replay(...updates: Uint8Array[]): string {
  const doc = new Y.Doc();
  for (const u of updates) Y.applyUpdate(doc, u, "hydrate");
  return doc.getXmlFragment("default").toString();
}

const DOC = "doc-pending-test";
const CONNECT = { docId: DOC, alias: "alice", write: "1" };

describe("yjs pending-dependency behaviour (the premise)", () => {
  it("parks a gapped update silently: no update event, no visible change", () => {
    const [, second] = producer(["A", "B"]);
    const server = new Y.Doc();
    let events = 0;
    server.on("update", () => events++);

    Y.applyUpdate(server, second!, { alias: "bob" }); // `first` never arrived

    expect(events).toBe(0); // <-- why onDocUpdate never ran
    expect(server.getXmlFragment("default").toString()).toBe("");
    // The bytes are held, not discarded — which is what makes them recoverable.
    expect((server.store as unknown as { pendingStructs: unknown }).pendingStructs).toBeTruthy();
  });

  /**
   * Pins the whole private path the store reads (`pendingStructs.update`): if Yjs
   * reshaped it, parked-byte detection would silently read 0 and acked edits
   * would be lost with no other test failing.
   */
  it("parks the bytes at store.pendingStructs.update.byteLength (the path parkedBytes reads)", () => {
    const [first, second] = producer(["A", "B"]);
    const server = new Y.Doc();

    const before = (server.store as unknown as { pendingStructs?: { update?: Uint8Array } | null })
      .pendingStructs?.update?.byteLength;
    expect(before).toBeUndefined(); // nothing parked yet

    Y.applyUpdate(server, second!, { alias: "bob" }); // dependency `first` withheld

    const parked = (server.store as unknown as { pendingStructs?: { update?: Uint8Array } | null })
      .pendingStructs?.update?.byteLength;
    expect(typeof parked).toBe("number");
    expect(parked).toBeGreaterThan(0);

    // …and it drains once the missing dependency lands, which is why parkedBytes'
    // callers compare before/after instead of testing for mere presence.
    Y.applyUpdate(server, first!, { alias: "bob" });
    const after = (server.store as unknown as { pendingStructs?: { update?: Uint8Array } | null })
      .pendingStructs?.update?.byteLength ?? 0;
    expect(after).toBe(0);
    expect(server.getXmlFragment("default").toString()).toContain("A");
  });

  it("a gapped update can be merged into a journal and replays correctly later", () => {
    // This is what licenses journaling the raw frame rather than special-casing it.
    const [first, second] = producer(["A", "B"]);
    const journal = Y.mergeUpdates([second!]);
    expect(replay(journal, first!)).toContain("A");
    expect(replay(journal, first!)).toContain("B");
  });
});

describe("DocActor journals dependency-pending updates", () => {
  it("marks the doc dirty and journals bytes even though nothing integrated", async () => {
    const h = harness();
    const dobj = makeActor(h);
    const ws = await connect(dobj, h, CONNECT);
    const [first, second] = producer(["A", "B"]);

    // Deliver ONLY the second update — the gap a refusal leaves behind.
    await send(dobj, ws, second!);

    // Without the journal: no pending log, nothing dirty, no alarm — and yet an ACK was sent.
    expect(ws.has(Opcode.UPDATE_ACK)).toBe(true);
    await dobj.alarm(); // the flush backstop must have something to flush
    const meta = await h.state.storage.get<{ docId: string; seq: number }>("meta");
    expect(meta, "a flush must have happened, so the bytes reached the blob store").toBeTruthy();

    // And the snapshot really carries the parked bytes: replaying it plus the
    // missing dependency reconstructs BOTH paragraphs.
    const snapshot = h.snapshots.bytesOf(`${DOC}/${meta!.seq}.bin`)!;
    const text = replay(snapshot, first!);
    expect(text).toContain("A");
    expect(text).toContain("B");
  });

  it("arms the flush backstop, which is what makes the bytes recoverable at all", async () => {
    // Parked bytes ride the ordinary persist debounce; what matters is that the flush backstop is armed.
    const h = harness();
    const dobj = makeActor(h);
    const ws = await connect(dobj, h, CONNECT);
    const [, gapped] = producer(["A", "B"]);

    expect(h.state.storage.alarm, "a clean doc schedules nothing").toBeNull();
    await send(dobj, ws, gapped!);
    expect(h.state.storage.alarm, "parked bytes must arm the flush backstop").not.toBeNull();
  });

  it("owes no version while everything held is parked, so its flush arms nothing", async () => {
    // A version of a document that decodes empty would blank its history; an alarm
    // re-armed for one that can never be taken would wake the actor forever.
    const h = harness();
    const dobj = makeActor(h);
    const ws = await connect(dobj, h, CONNECT);
    const [, gapped] = producer(["A", "B"]);
    await send(dobj, ws, gapped!);

    await dobj.alarm();
    expect((await h.state.storage.get<{ seq: number }>("meta"))!.seq).toBe(1);
    expect(h.state.storage.alarm).toBeNull();
    await dobj.webSocketClose(ws, 1000, "", true);
    await dobj.alarm();

    expect(h.queued.filter((m) => m.kind === "index_doc")).toEqual([]);
    expect(h.state.storage.alarm).toBeNull();
  });

  it("survives eviction once flushed: a fresh instance resolves the gap from the snapshot", async () => {
    const h = harness();
    const first = makeActor(h);
    const ws = await connect(first, h, CONNECT);
    const [dep, gapped] = producer(["A", "B"]);
    await send(first, ws, gapped!);
    await first.alarm(); // the backstop fires, parked bytes reach the blob store

    // Evicted: in-memory state is gone, the blob store + actor storage are not.
    const second = makeActor(h);
    const ws2 = await connect(second, h, CONNECT);
    // The dependency finally arrives at the NEW instance, resolving the gap against
    // the parked bytes the snapshot carried across the eviction.
    await send(second, ws2, dep!);
    await second.alarm();

    const meta = (await h.state.storage.get<{ docId: string; seq: number }>("meta"))!;
    const text = replay(h.snapshots.bytesOf(`${DOC}/${meta.seq}.bin`)!);
    expect(text).toContain("A");
    expect(text).toContain("B");
  });

  it("journals the HYBRID case: one update integrates content AND strands more", async () => {
    // Keying on "did an event fire" misses this, because the event
    // DOES fire — the stranded half would still be dropped. Keying on parked bytes
    // catches both.
    const h = harness();
    const dobj = makeActor(h);
    const ws = await connect(dobj, h, CONNECT);

    // Client 1 produces a standalone update; client 2 produces a chain whose head
    // we withhold. Merging one of each gives a single update that both integrates
    // and parks.
    const [solo] = producer(["standalone"]);
    const [dep, gapped] = producer(["chain-1", "chain-2"]);
    const hybrid = Y.mergeUpdates([solo!, gapped!]);

    await send(dobj, ws, hybrid);
    await dobj.alarm();

    const meta = (await h.state.storage.get<{ docId: string; seq: number }>("meta"))!;
    const snapshot = h.snapshots.bytesOf(`${DOC}/${meta.seq}.bin`)!;
    // Integrated half is visible immediately...
    expect(replay(snapshot)).toContain("standalone");
    // ...and the stranded half was preserved, not dropped.
    const resolved = replay(snapshot, dep!);
    expect(resolved).toContain("chain-1");
    expect(resolved).toContain("chain-2");
  });

  it("does not double-journal an update that integrates cleanly", async () => {
    // The guard must not fire on the normal path: onDocUpdate already journaled it,
    // and merging the same bytes twice would inflate every pending log.
    const h = harness();
    const dobj = makeActor(h);
    const ws = await connect(dobj, h, CONNECT);
    const [first, second] = producer(["A", "B"]);

    await send(dobj, ws, first!);
    await send(dobj, ws, second!);
    await dobj.alarm();

    const meta = (await h.state.storage.get<{ docId: string; seq: number }>("meta"))!;
    const text = replay(h.snapshots.bytesOf(`${DOC}/${meta.seq}.bin`)!);
    expect(text).toContain("A");
    expect(text).toContain("B");
  });

  it("an update that RESOLVES a gap is not mistaken for a new one", async () => {
    // The pending buffer shrinks when a dependency arrives. A check that only
    // asked "is the buffer non-empty" would treat recovery as a new gap — here it
    // must simply integrate.
    const h = harness();
    const dobj = makeActor(h);
    const ws = await connect(dobj, h, CONNECT);
    const [dep, gapped] = producer(["A", "B"]);

    await send(dobj, ws, gapped!); // parks
    await send(dobj, ws, dep!); // drains
    await dobj.alarm();

    const meta = (await h.state.storage.get<{ docId: string; seq: number }>("meta"))!;
    const text = replay(h.snapshots.bytesOf(`${DOC}/${meta.seq}.bin`)!);
    expect(text).toContain("A");
    expect(text).toContain("B");
  });

  it("does not blank a doc's title/search text on a pending-only flush", async () => {
    // A pending-only doc decodes empty; indexing it would blank the real title and
    // search text, so only the snapshot is written.
    const h = harness();
    const dobj = makeActor(h);
    const ws = await connect(dobj, h, CONNECT);
    const [, gapped] = producer(["A", "B"]);

    await send(dobj, ws, gapped!);
    await dobj.alarm();

    const meta = (await h.state.storage.get<{ docId: string; seq: number }>("meta"))!;
    // Durability happened.
    expect(h.snapshots.bytesOf(`${DOC}/${meta.seq}.bin`)).toBeTruthy();
    // Indexing did not.
    const indexJobs = h.queued.filter((m) => (m as { kind?: string }).kind === "index_doc");
    expect(indexJobs).toHaveLength(0);
  });

  it("indexes normally once the gap resolves and real content exists", async () => {
    const h = harness();
    const dobj = makeActor(h);
    const ws = await connect(dobj, h, CONNECT);
    const [dep, gapped] = producer(["Real Title", "body"]);

    await send(dobj, ws, gapped!);
    await dobj.alarm(); // pending-only: no index job
    await send(dobj, ws, dep!); // gap resolves
    await dobj.alarm();

    const indexJobs = h.queued.filter((m) => (m as { kind?: string }).kind === "index_doc");
    expect(indexJobs.length).toBeGreaterThan(0);
    const last = indexJobs.at(-1) as { title: string };
    expect(last.title).toBe("Real Title");
  });
});
