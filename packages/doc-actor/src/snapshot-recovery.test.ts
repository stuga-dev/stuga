/**
 * Recovering a document whose head snapshot is gone. The actor refuses to flush
 * over a missing head; /recover rebuilds it, and only when the head really is
 * unreadable.
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { encodeBinary, encodeEpoch, decodeEpoch } from "@stuga/protocol/wire/frame";
import { Opcode } from "@stuga/protocol/wire/opcodes";
import { snapshotKey } from "@stuga/protocol/domain/limits";
import { harness, connect, makeActor, frameBuffer, type Harness, type MemorySocket } from "../test/harness.js";

const DOC = "doc-recovery-test";
const CONNECT = { docId: DOC, alias: "alice", write: "1" };

/** A client-side Y.Doc holding one paragraph of the given text. */
function clientDocWith(text: string): Y.Doc {
  const doc = new Y.Doc();
  doc.transact(() => {
    const p = new Y.XmlElement("paragraph");
    p.insert(0, [new Y.XmlText(text)]);
    doc.getXmlFragment("default").insert(0, [p]);
  });
  return doc;
}

/** Deliver a client's full state to the actor as an UPDATE frame. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function sendUpdate(dobj: any, ws: MemorySocket, doc: Y.Doc): Promise<void> {
  await dobj.webSocketMessage(ws, frameBuffer(encodeBinary(Opcode.UPDATE, Y.encodeStateAsUpdate(doc))));
}

/** Echo the epoch the actor announced — required once a generation has opened. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function ackEpoch(dobj: any, ws: MemorySocket): Promise<void> {
  const epoch = decodeEpoch(ws.firstPayload(Opcode.DOCUMENT_EPOCH)!)!;
  await dobj.webSocketMessage(ws, frameBuffer(encodeBinary(Opcode.DOCUMENT_EPOCH_ACK, encodeEpoch(epoch))));
}

async function meta(h: Harness): Promise<{ docId: string; seq: number; epoch?: number }> {
  return (await h.state.storage.get<{ docId: string; seq: number; epoch?: number }>("meta"))!;
}

/** The text inside the snapshot stored at `seq`. */
function snapshotText(h: Harness, seq: number): string {
  const bytes = h.snapshots.bytesOf(snapshotKey(DOC, seq));
  if (!bytes) throw new Error(`no snapshot at seq ${seq}`);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, bytes, "assert");
  return doc.getXmlFragment("default").toString();
}

/** The node's call: the document's indexed text rides the body. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function recover(dobj: any, fallbackMarkdown: string): Promise<Response> {
  return dobj.fetch(
    new Request(`http://actor/recover?docId=${DOC}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fallback_markdown: fallbackMarkdown }),
    }),
  );
}

describe("recovering a missing head snapshot", () => {
  it("rebuilds from the snapshot below the missing head and makes the document writable again", async () => {
    const h = harness();
    const first = makeActor(h);
    const a = await connect(first, h, CONNECT);
    await sendUpdate(first, a, clientDocWith("first draft"));
    await first.alarm(); // seq 1
    await sendUpdate(first, a, clientDocWith("second draft"));
    await first.alarm(); // seq 2
    expect((await meta(h)).seq).toBe(2);

    // The head object disappears; the actor is evicted and comes back to it.
    await h.snapshots.delete(snapshotKey(DOC, 2));
    const second = makeActor(h);
    const b = await connect(second, h, CONNECT);

    // Refusing to flush over a head it could not read is the behaviour recovery
    // is built on top of, not something it removes.
    await sendUpdate(second, b, clientDocWith("typed while broken"));
    await second.alarm();
    expect((await meta(h)).seq).toBe(2);

    const res = await recover(second, "");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ recovered: true, seq: 3, from: { kind: "snapshot", seq: 1 } });
    expect(snapshotText(h, 3)).toContain("first draft");

    // A new rollback generation, so the tab still holding the blank document
    // cannot merge it back over the rebuild.
    expect((await meta(h)).epoch).toBe(1);

    const indexed = h.queued.filter((m) => m.kind === "index_doc" && m.snapshotSeq === 3);
    expect(indexed).toHaveLength(1);
    expect((indexed[0] as { authors?: string[] }).authors).toEqual(["system:recovered"]);

    // The refusal is gone: ordinary editing reaches the head again.
    const c = await connect(second, h, CONNECT);
    await ackEpoch(second, c);
    await sendUpdate(second, c, clientDocWith("after recovery"));
    await second.alarm();
    expect((await meta(h)).seq).toBe(4);
  });

  it("falls back to the indexed text when nothing survives below the head", async () => {
    const h = harness();
    const first = makeActor(h);
    const a = await connect(first, h, CONNECT);
    await sendUpdate(first, a, clientDocWith("only draft"));
    await first.alarm(); // seq 1 — the document's only snapshot
    await h.snapshots.delete(snapshotKey(DOC, 1));

    const second = makeActor(h);
    await connect(second, h, CONNECT);
    const res = await recover(second, "# Rescued\n\nthe indexed body");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ recovered: true, seq: 2, from: { kind: "search_text" } });
    expect(snapshotText(h, 2)).toContain("the indexed body");
  });

  it("leaves the head alone when there is nothing honest to write", async () => {
    const h = harness();
    const first = makeActor(h);
    const a = await connect(first, h, CONNECT);
    await sendUpdate(first, a, clientDocWith("only draft"));
    await first.alarm(); // seq 1
    await h.snapshots.delete(snapshotKey(DOC, 1));

    const second = makeActor(h);
    await connect(second, h, CONNECT);
    const res = await recover(second, "   "); // a document that was never indexed
    expect(res.status).toBe(404);
    expect((await meta(h)).seq).toBe(1);
    expect(h.snapshots.bytesOf(snapshotKey(DOC, 2))).toBeUndefined();
    expect((await meta(h)).epoch ?? 0).toBe(0);
  });

  it("refuses a document whose head is readable", async () => {
    const h = harness();
    const actor = makeActor(h);
    const a = await connect(actor, h, CONNECT);
    await sendUpdate(actor, a, clientDocWith("healthy"));
    await actor.alarm(); // seq 1, and the object is right there

    const res = await recover(actor, "# not this document");
    expect(res.status).toBe(409);
    expect((await meta(h)).seq).toBe(1);
    expect((await meta(h)).epoch ?? 0).toBe(0);
    expect(snapshotText(h, 1)).toContain("healthy");
  });

  it("keeps the edits taken while the head was unreadable", async () => {
    const h = harness();
    const first = makeActor(h);
    const a = await connect(first, h, CONNECT);
    await sendUpdate(first, a, clientDocWith("first draft"));
    await first.alarm(); // seq 1
    await sendUpdate(first, a, clientDocWith("second draft"));
    await first.alarm(); // seq 2
    await h.snapshots.delete(snapshotKey(DOC, 2));

    const second = makeActor(h);
    const b = await connect(second, h, CONNECT);
    await sendUpdate(second, b, clientDocWith("typed while broken"));

    const res = await recover(second, "");
    const body = (await res.json()) as { stranded: string | null };
    expect(body.stranded).toBeTruthy();
    const bytes = h.snapshots.bytesOf(body.stranded!);
    expect(bytes).toBeDefined();
    const held = new Y.Doc();
    Y.applyUpdate(held, bytes!, "assert");
    expect(held.getXmlFragment("default").toString()).toContain("typed while broken");
  });
});
