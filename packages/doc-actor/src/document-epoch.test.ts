/**
 * The rollback fence. DOC_RESET reaches only sockets connected at the moment of
 * a restore; a tab that returns later replays pre-restore state in its
 * SYNC_STEP_2. The durable epoch refuses it. `WITHOUT the fence` runs the same
 * sequence with an acked epoch to show the fence is what makes the difference.
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { encodeBinary, encodeEpoch, decodeEpoch, decodeJson } from "@stuga/protocol/wire/frame";
import { Opcode, CloseCode } from "@stuga/protocol/wire/opcodes";
import {
  harness,
  makeActor,
  connect,
  type Harness,
  type MemorySocket,
  frameBuffer,
} from "../test/harness.js";

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
  const frame = encodeBinary(Opcode.UPDATE, Y.encodeStateAsUpdate(doc));
  await dobj.webSocketMessage(ws, frameBuffer(frame));
}

/** Echo the epoch the actor announced on connect (what a current client does). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function ackEpoch(dobj: any, ws: MemorySocket): Promise<number> {
  const payload = ws.firstPayload(Opcode.DOCUMENT_EPOCH);
  if (!payload) throw new Error("the actor never announced an epoch");
  const epoch = decodeEpoch(payload)!;
  const frame = encodeBinary(Opcode.DOCUMENT_EPOCH_ACK, encodeEpoch(epoch));
  await dobj.webSocketMessage(ws, frameBuffer(frame));
  return epoch;
}

/** The actor's current document text, read straight out of the head snapshot. */
async function headText(h: Harness): Promise<string> {
  const meta = (await h.state.storage.get<{ docId: string; seq: number }>("meta"))!;
  const bytes = h.snapshots.bytesOf(`${meta.docId}/${meta.seq}.bin`)!;
  const doc = new Y.Doc();
  Y.applyUpdate(doc, bytes, "hydrate");
  return doc.getXmlFragment("default").toString();
}

const DOC = "doc-epoch-test";
const CONNECT = { docId: DOC, alias: "alice", write: "1" };

describe("document epoch handshake", () => {
  it("announces the epoch BEFORE any document bytes", async () => {
    const h = harness();
    const ws = await connect(makeActor(h), h, CONNECT);
    const frames = ws.frames();
    const epochAt = frames.findIndex((f) => f.opcode === Opcode.DOCUMENT_EPOCH);
    const syncAt = frames.findIndex((f) => f.opcode === Opcode.SYNC_STEP_1);
    expect(epochAt).toBeGreaterThanOrEqual(0);
    expect(syncAt).toBeGreaterThanOrEqual(0);
    // Ordering IS the contract, and the client depends on it: it refuses to answer
    // a SYNC_STEP_1 until the generation is settled, so an epoch frame that arrived
    // second would leave every tab stuck at "connecting".
    expect(epochAt).toBeLessThan(syncAt);
    expect(decodeEpoch(frames[epochAt]!.payload)).toBe(0);
  });

  it("accepts writes on a never-restored doc even with no ACK", async () => {
    // At epoch 0 there is no superseded generation, so the fence does not engage.
    const h = harness();
    const dobj = makeActor(h);
    const ws = await connect(dobj, h, CONNECT);
    await sendUpdate(dobj, ws, clientDocWith("hello"));
    expect(ws.has(Opcode.UPDATE_ACK)).toBe(true);
    expect(ws.has(Opcode.WRITE_REJECTED)).toBe(false);
    expect(ws.closed).toBeNull();
  });

  it("refuses a write from a socket that never ACKed, once the doc has been restored", async () => {
    const h = harness();
    const dobj = makeActor(h);

    // v1: "one", flushed so there's a version to restore to.
    const a = await connect(dobj, h, CONNECT);
    await sendUpdate(dobj, a, clientDocWith("one"));
    await dobj.alarm(); // flush → seq 1
    const restorable = (await h.state.storage.get<{ seq: number }>("meta"))!.seq;

    // v2: "two" on top.
    await sendUpdate(dobj, a, clientDocWith("two"));
    await dobj.alarm();

    // Roll back to v1. Every connected socket is reset...
    await dobj.fetch(new Request(`http://actor/restore?docId=${DOC}&seq=${restorable}`));
    expect(a.closed?.code).toBe(CloseCode.DOC_RESET);

    // ...and the epoch advanced durably.
    expect((await h.state.storage.get<{ epoch?: number }>("meta"))!.epoch).toBe(1);

    // A socket that reconnects but does NOT ACK is refused.
    const stale = await connect(dobj, h, CONNECT);
    await sendUpdate(dobj, stale, clientDocWith("two"));
    const rejected = stale.firstPayload(Opcode.WRITE_REJECTED);
    expect(rejected).not.toBeNull();
    expect(decodeJson<{ kind: string }>(rejected!).kind).toBe("epoch");
    expect(stale.has(Opcode.UPDATE_ACK)).toBe(false);
    expect(stale.closed?.code).toBe(CloseCode.DOC_RESET);
  });

  it("refuses a stale reconnect after a restore, so rolled-back content stays gone", async () => {
    const h = harness();
    const dobj = makeActor(h);

    const a = await connect(dobj, h, CONNECT);
    await ackEpoch(dobj, a);
    const v1 = clientDocWith("one");
    await sendUpdate(dobj, a, v1);
    await dobj.alarm();
    const restorable = (await h.state.storage.get<{ seq: number }>("meta"))!.seq;

    // The tab that will go stale: it holds "one" + "two".
    const staleClient = new Y.Doc();
    Y.applyUpdate(staleClient, Y.encodeStateAsUpdate(v1));
    staleClient.transact(() => {
      const p = new Y.XmlElement("paragraph");
      p.insert(0, [new Y.XmlText("two")]);
      staleClient.getXmlFragment("default").insert(1, [p]);
    });
    await sendUpdate(dobj, a, staleClient);
    await dobj.alarm();
    expect(await headText(h)).toContain("two");

    // Roll back to v1 while that tab is NOT connected (it never sees DOC_RESET).
    await dobj.fetch(new Request(`http://actor/restore?docId=${DOC}&seq=${restorable}`));
    expect(await headText(h)).not.toContain("two");

    // It returns and replays its state, exactly as the real provider's handshake
    // does. Refused — so the rollback holds.
    const reconnected = await connect(dobj, h, CONNECT);
    await sendUpdate(dobj, reconnected, staleClient);
    await dobj.alarm();

    expect(await headText(h)).not.toContain("two");
    expect(await headText(h)).toContain("one");
  });

  it("WITHOUT the fence the same sequence DOES resurrect it (the fence is load-bearing)", async () => {
    // Same steps, but the returning client acks the current epoch: the ack alone
    // separates the two outcomes.
    const h = harness();
    const dobj = makeActor(h);

    const a = await connect(dobj, h, CONNECT);
    const v1 = clientDocWith("one");
    await sendUpdate(dobj, a, v1);
    await dobj.alarm();
    const restorable = (await h.state.storage.get<{ seq: number }>("meta"))!.seq;

    const staleClient = new Y.Doc();
    Y.applyUpdate(staleClient, Y.encodeStateAsUpdate(v1));
    staleClient.transact(() => {
      const p = new Y.XmlElement("paragraph");
      p.insert(0, [new Y.XmlText("two")]);
      staleClient.getXmlFragment("default").insert(1, [p]);
    });
    await sendUpdate(dobj, a, staleClient);
    await dobj.alarm();

    await dobj.fetch(new Request(`http://actor/restore?docId=${DOC}&seq=${restorable}`));
    expect(await headText(h)).not.toContain("two");

    const reconnected = await connect(dobj, h, CONNECT);
    await ackEpoch(dobj, reconnected); // <-- the only difference
    await sendUpdate(dobj, reconnected, staleClient);
    await dobj.alarm();

    // Accepted, so the stale content is back. This is what the fence prevents.
    expect(reconnected.has(Opcode.UPDATE_ACK)).toBe(true);
    expect(await headText(h)).toContain("two");
  });

  it("refuses an ACK carrying a stale epoch", async () => {
    const h = harness();
    const dobj = makeActor(h);
    const a = await connect(dobj, h, CONNECT);
    await sendUpdate(dobj, a, clientDocWith("one"));
    await dobj.alarm();
    const restorable = (await h.state.storage.get<{ seq: number }>("meta"))!.seq;
    await dobj.fetch(new Request(`http://actor/restore?docId=${DOC}&seq=${restorable}`));

    const ws = await connect(dobj, h, CONNECT);
    // Claim generation 0 when the doc is on 1 — i.e. "my state predates the restore".
    const frame = encodeBinary(Opcode.DOCUMENT_EPOCH_ACK, encodeEpoch(0));
    await dobj.webSocketMessage(ws, frameBuffer(frame));
    expect(decodeJson<{ kind: string }>(ws.firstPayload(Opcode.WRITE_REJECTED)!).kind).toBe("epoch");
    expect(ws.closed?.code).toBe(CloseCode.DOC_RESET);
  });

  it("refuses a malformed ACK payload rather than trusting it", async () => {
    const h = harness();
    const dobj = makeActor(h);
    const a = await connect(dobj, h, CONNECT);
    await sendUpdate(dobj, a, clientDocWith("one"));
    await dobj.alarm();
    const restorable = (await h.state.storage.get<{ seq: number }>("meta"))!.seq;
    await dobj.fetch(new Request(`http://actor/restore?docId=${DOC}&seq=${restorable}`));

    const ws = await connect(dobj, h, CONNECT);
    const frame = encodeBinary(Opcode.DOCUMENT_EPOCH_ACK, new Uint8Array([1, 0, 0])); // wrong width
    await dobj.webSocketMessage(ws, frameBuffer(frame));
    expect(ws.closed?.code).toBe(CloseCode.DOC_RESET);
    // And it did NOT become writable.
    await sendUpdate(dobj, ws, clientDocWith("sneak"));
    expect(ws.has(Opcode.UPDATE_ACK)).toBe(false);
  });

  it("an ACKed socket may write after a restore", async () => {
    const h = harness();
    const dobj = makeActor(h);
    const a = await connect(dobj, h, CONNECT);
    await sendUpdate(dobj, a, clientDocWith("one"));
    await dobj.alarm();
    const restorable = (await h.state.storage.get<{ seq: number }>("meta"))!.seq;
    await dobj.fetch(new Request(`http://actor/restore?docId=${DOC}&seq=${restorable}`));

    const ws = await connect(dobj, h, CONNECT);
    await ackEpoch(dobj, ws);
    await sendUpdate(dobj, ws, clientDocWith("fresh edit"));
    expect(ws.has(Opcode.UPDATE_ACK)).toBe(true);
    expect(ws.has(Opcode.WRITE_REJECTED)).toBe(false);
  });

  it("the epoch survives eviction (a fresh instance over the same storage)", async () => {
    const h = harness();
    const first = makeActor(h);
    const a = await connect(first, h, CONNECT);
    await sendUpdate(first, a, clientDocWith("one"));
    await first.alarm();
    const restorable = (await h.state.storage.get<{ seq: number }>("meta"))!.seq;
    await first.fetch(new Request(`http://actor/restore?docId=${DOC}&seq=${restorable}`));

    // A fresh instance: the returning stale tab usually meets one, so the epoch must come from storage.
    const second = makeActor(h);
    const ws = await connect(second, h, CONNECT);
    expect(decodeEpoch(ws.firstPayload(Opcode.DOCUMENT_EPOCH)!)).toBe(1);
    await sendUpdate(second, ws, clientDocWith("two"));
    expect(ws.has(Opcode.UPDATE_ACK)).toBe(false);
    expect(decodeJson<{ kind: string }>(ws.firstPayload(Opcode.WRITE_REJECTED)!).kind).toBe("epoch");
  });

  it("a flush does not clobber the stored epoch", async () => {
    // Every "meta" write carries the epoch; one read back as 0 would un-fence every client.
    const h = harness();
    const dobj = makeActor(h);
    const a = await connect(dobj, h, CONNECT);
    await sendUpdate(dobj, a, clientDocWith("one"));
    await dobj.alarm();
    const restorable = (await h.state.storage.get<{ seq: number }>("meta"))!.seq;
    await dobj.fetch(new Request(`http://actor/restore?docId=${DOC}&seq=${restorable}`));
    expect((await h.state.storage.get<{ epoch?: number }>("meta"))!.epoch).toBe(1);

    // A post-restore edit + flush rewrites meta.
    const ws = await connect(dobj, h, CONNECT);
    await ackEpoch(dobj, ws);
    await sendUpdate(dobj, ws, clientDocWith("after"));
    await dobj.alarm();

    expect((await h.state.storage.get<{ epoch?: number }>("meta"))!.epoch).toBe(1);
  });

  it("each restore opens a new generation", async () => {
    const h = harness();
    const dobj = makeActor(h);
    const a = await connect(dobj, h, CONNECT);
    await sendUpdate(dobj, a, clientDocWith("one"));
    await dobj.alarm();
    const target = (await h.state.storage.get<{ seq: number }>("meta"))!.seq;

    await dobj.fetch(new Request(`http://actor/restore?docId=${DOC}&seq=${target}`));
    await dobj.fetch(new Request(`http://actor/restore?docId=${DOC}&seq=${target}`));
    expect((await h.state.storage.get<{ epoch?: number }>("meta"))!.epoch).toBe(2);

    // A client that ACKed generation 1 is fenced again by generation 2.
    const ws = await connect(dobj, h, CONNECT);
    const frame = encodeBinary(Opcode.DOCUMENT_EPOCH_ACK, encodeEpoch(1));
    await dobj.webSocketMessage(ws, frameBuffer(frame));
    expect(ws.closed?.code).toBe(CloseCode.DOC_RESET);
  });
});
