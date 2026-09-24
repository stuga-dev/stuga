/**
 * The durability report. UPDATE_ACK means received, so an actor whose storage is
 * failing keeps acking; PERSIST_DEGRADED says so. `stays silent on the healthy
 * path` is the control.
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { encodeBinary, decodeJson } from "@stuga/protocol/wire/frame";
import { Opcode, type PersistDegradedPayload } from "@stuga/protocol/wire/opcodes";
import { harness, makeActor, connect, type Harness, type MemorySocket, frameBuffer } from "../test/harness.js";

const DOC = "doc-persist-test";
const CONNECT = { docId: DOC, alias: "alice", write: "1" };

/** A client-side Y.Doc holding one paragraph. */
function clientDocWith(text: string): Y.Doc {
  const doc = new Y.Doc();
  doc.transact(() => {
    const p = new Y.XmlElement("paragraph");
    p.insert(0, [new Y.XmlText(text)]);
    doc.getXmlFragment("default").insert(0, [p]);
  });
  return doc;
}

/** Deliver an edit, leaving the actor dirty with a flush owed. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function edit(dobj: any, ws: MemorySocket, text: string): Promise<void> {
  await dobj.webSocketMessage(ws, frameBuffer(encodeBinary(Opcode.UPDATE, Y.encodeStateAsUpdate(clientDocWith(text)))));
}

/** Complete the sync handshake from the client's side, as a real tab does. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handshake(dobj: any, ws: MemorySocket): Promise<void> {
  const frame = encodeBinary(Opcode.SYNC_STEP_1, Y.encodeStateVector(new Y.Doc()));
  await dobj.webSocketMessage(ws, frameBuffer(frame));
}

/** Every durability verdict this socket was sent, oldest first. */
function reports(ws: MemorySocket): boolean[] {
  return ws
    .frames()
    .filter((f) => f.opcode === Opcode.PERSIST_DEGRADED)
    .map((f) => decodeJson<PersistDegradedPayload>(f.payload).degraded);
}

/** Make every snapshot write fail, the way an unreachable database does. */
function breakStorage(h: Harness): void {
  h.snapshots.put = () => Promise.reject(new Error("No space left on device"));
}

describe("the actor's durability report", () => {
  it("tells the client when a flush fails, having already acked the edit", async () => {
    const h = harness();
    const dobj = makeActor(h);
    const ws = await connect(dobj, h, CONNECT);
    await edit(dobj, ws, "hello");

    // The ack went out before any of this — that is the whole problem.
    expect(ws.has(Opcode.UPDATE_ACK)).toBe(true);

    breakStorage(h);
    await dobj.alarm();

    expect(reports(ws)).toEqual([true]);
  });

  it("withdraws the report once a flush finally lands", async () => {
    const h = harness();
    const dobj = makeActor(h);
    const ws = await connect(dobj, h, CONNECT);
    await edit(dobj, ws, "hello");

    const put = h.snapshots.put.bind(h.snapshots);
    breakStorage(h);
    await dobj.alarm();
    h.snapshots.put = put;
    await dobj.alarm();

    expect(reports(ws)).toEqual([true, false]);
  });

  it("does not repeat itself while the outage continues", async () => {
    // The backstop retries every 30s. A report per retry would carry no new
    // information and would let the client restart its escalation clock forever.
    const h = harness();
    const dobj = makeActor(h);
    const ws = await connect(dobj, h, CONNECT);
    await edit(dobj, ws, "hello");

    breakStorage(h);
    await dobj.alarm();
    await dobj.alarm();
    await dobj.alarm();

    expect(reports(ws)).toEqual([true]);
  });

  it("tells a socket that arrives mid-outage, which missed the broadcast", async () => {
    // The report is edge-triggered, so a tab that connects (or reconnects) after
    // the transition would otherwise complete a clean handshake and paint itself
    // green over a server that cannot store a byte.
    const h = harness();
    const dobj = makeActor(h);
    const first = await connect(dobj, h, CONNECT);
    await edit(dobj, first, "hello");
    breakStorage(h);
    await dobj.alarm();

    const late = await connect(dobj, h, { ...CONNECT, alias: "bob" });
    await handshake(dobj, late);

    expect(reports(late)).toEqual([true]);
  });

  it("stays silent on the healthy path", async () => {
    const h = harness();
    const dobj = makeActor(h);
    const ws = await connect(dobj, h, CONNECT);
    await edit(dobj, ws, "hello");
    await dobj.alarm();
    await handshake(dobj, ws);

    expect(reports(ws)).toEqual([]);
  });
});
