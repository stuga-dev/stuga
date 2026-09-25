/**
 * Past its threshold the store leaves the flush to an alarm due now, which the host runs under the
 * actor's lock once the handler is done, so no flush outlives the handler that asked for it. The
 * harness records alarms without firing them, which is what lets these tests see the gap.
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { DOC_FLUSH_INTERVAL_MS, snapshotKey } from "@stuga/protocol/domain/limits";
import { encodeBinary } from "@stuga/protocol/wire/frame";
import { Opcode } from "@stuga/protocol/wire/opcodes";
import type { DocActor } from "./doc-actor.js";
import { PENDING_SNAPSHOT_BYTES } from "./store/doc-store.js";
import { connect, frameBuffer, harness, makeActor, type MemorySocket } from "../test/harness.js";

const DOC = "doc-threshold";
const FLUSH_THRESHOLD = 100; // mirrors the store's constant

/** A client typing: one update for the paragraph, then one per character, `n` in all. */
function typing(n: number): Uint8Array[] {
  const doc = new Y.Doc();
  const updates: Uint8Array[] = [];
  doc.on("update", (u: Uint8Array) => updates.push(u));
  const text = new Y.XmlText();
  doc.transact(() => {
    const p = new Y.XmlElement("paragraph");
    p.insert(0, [text]);
    doc.getXmlFragment("default").insert(0, [p]);
  });
  for (let i = 1; i < n; i++) text.insert(text.length, "x");
  return updates;
}

/** One paragraph of `chars` characters in a single update: a large paste. */
function paste(chars: number): Uint8Array {
  const doc = new Y.Doc();
  doc.transact(() => {
    const p = new Y.XmlElement("paragraph");
    p.insert(0, [new Y.XmlText("x".repeat(chars))]);
    doc.getXmlFragment("default").insert(0, [p]);
  });
  return Y.encodeStateAsUpdate(doc);
}

async function send(dobj: DocActor, ws: MemorySocket, update: Uint8Array): Promise<void> {
  await dobj.webSocketMessage(ws, frameBuffer(encodeBinary(Opcode.UPDATE, update)));
}

/** Long enough for a flush started without awaiting it to have landed. */
const settle = () => new Promise((r) => setTimeout(r, 10));

describe("the flush threshold", () => {
  it("sets an alarm due now, writes nothing until it fires, and firing it flushes", async () => {
    const h = harness();
    const dobj = makeActor(h);
    const ws = await connect(dobj, h, { docId: DOC, alias: "liv" });
    const updates = typing(FLUSH_THRESHOLD);

    const start = Date.now();
    for (const u of updates.slice(0, -1)) await send(dobj, ws, u);
    // Below the threshold only the ordinary backstop is armed.
    expect(h.state.storage.alarm).toBeGreaterThanOrEqual(start + DOC_FLUSH_INTERVAL_MS);

    const before = Date.now();
    await send(dobj, ws, updates.at(-1)!);
    expect(h.state.storage.alarm).toBeGreaterThanOrEqual(before);
    expect(h.state.storage.alarm).toBeLessThanOrEqual(Date.now());
    await settle();
    expect(h.snapshots.keys()).toEqual([]);
    expect(h.queued).toEqual([]);

    await dobj.alarm();
    expect(h.snapshots.keys()).toEqual([snapshotKey(DOC, 1)]);
    expect(h.queued).toMatchObject([{ kind: "index_doc", docId: DOC, snapshotSeq: 1, reason: "timer" }]);
    expect(h.state.storage.map.has("pending")).toBe(false);
    expect(h.state.storage.alarm).toBeNull();
  });

  it("persists a large paste's pending log at once, and leaves its snapshot to the alarm", async () => {
    const h = harness();
    const dobj = makeActor(h);
    const ws = await connect(dobj, h, { docId: DOC, alias: "liv" });

    const before = Date.now();
    await send(dobj, ws, paste(PENDING_SNAPSHOT_BYTES + 1));
    // One update alone is not mirrored; a large one is.
    expect((h.state.storage.map.get("pending") as Uint8Array).byteLength).toBeGreaterThan(PENDING_SNAPSHOT_BYTES);
    expect(h.state.storage.alarm).toBeGreaterThanOrEqual(before);
    expect(h.state.storage.alarm).toBeLessThanOrEqual(Date.now());
    await settle();
    expect(h.snapshots.keys()).toEqual([]);

    await dobj.alarm();
    expect(h.snapshots.keys()).toEqual([snapshotKey(DOC, 1)]);
    expect(h.state.storage.map.has("pending")).toBe(false);
  });

  it("still snapshots a large headless write before the request answers", async () => {
    const h = harness();
    const dobj = makeActor(h);
    const res = await dobj.fetch(
      new Request(`http://actor/apply-edits?docId=${DOC}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ str_edits: [{ old_string: "", new_string: "x".repeat(PENDING_SNAPSHOT_BYTES + 1) }], agent: "tester" }),
      }),
    );

    expect(await res.json()).toEqual({ applied: true, seq: 1 });
    expect(h.snapshots.keys()).toEqual([snapshotKey(DOC, 1)]);
    expect(h.queued).toMatchObject([{ kind: "index_doc", snapshotSeq: 1, reason: "headless-large" }]);
    expect(h.state.storage.alarm).toBeNull();
  });
});
