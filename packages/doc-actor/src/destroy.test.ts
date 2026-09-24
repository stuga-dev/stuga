/** /destroy: deleting a document leaves no actor state behind, and nothing can write it back. */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { encodeBinary } from "@stuga/protocol/wire/frame";
import { Opcode } from "@stuga/protocol/wire/opcodes";
import { DocActor } from "./doc-actor.js";
import { harness, makeActor, connect, disconnect, frameBuffer } from "../test/harness.js";

/** An update that inserts one paragraph, as a client would send it. */
function updateWith(text: string): Uint8Array {
  const doc = new Y.Doc();
  doc.transact(() => {
    const p = new Y.XmlElement("paragraph");
    p.insert(0, [new Y.XmlText(text)]);
    doc.getXmlFragment("default").insert(0, [p]);
  });
  return Y.encodeStateAsUpdate(doc);
}

async function destroy(doc: DocActor, docId: string): Promise<Response> {
  return doc.fetch(new Request(`http://actor/destroy?docId=${docId}`, { method: "POST" }));
}

describe("/destroy", () => {
  it("wipes durable storage", async () => {
    const h = harness();
    const doc = makeActor(h);
    const ws = await connect(doc, h, { docId: "d1", alias: "u1" });
    await doc.webSocketMessage(ws, frameBuffer(encodeBinary(Opcode.UPDATE, updateWith("secret"))));
    // Flush first, so the wipe has something durable to remove.
    await doc.alarm();
    expect(h.state.storage.map.size).toBeGreaterThan(0);

    const res = await destroy(doc, "d1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ destroyed: true });
    expect(h.state.storage.map.size).toBe(0);
    expect(await h.state.storage.getAlarm()).toBeNull();
  });

  it("closes every open socket with 4404", async () => {
    const h = harness();
    const doc = makeActor(h);
    const a = await connect(doc, h, { docId: "d1", alias: "u1" });
    const b = await connect(doc, h, { docId: "d1", alias: "u2" });

    await destroy(doc, "d1");
    expect(a.closed).toMatchObject({ code: 4404, reason: "document deleted" });
    expect(b.closed).toMatchObject({ code: 4404, reason: "document deleted" });
    expect(h.state.getWebSockets()).toEqual([]);
  });

  it("drops the unflushed log", async () => {
    const h = harness();
    const doc = makeActor(h);
    const ws = await connect(doc, h, { docId: "d1", alias: "u1" });
    await doc.webSocketMessage(ws, frameBuffer(encodeBinary(Opcode.UPDATE, updateWith("secret"))));
    await destroy(doc, "d1");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((doc as any).store.pending).toBeNull();
    expect(h.state.storage.map.size).toBe(0);
  });

  it("does not let the close callbacks of the sockets it closed flush the document back", async () => {
    const h = harness();
    const doc = makeActor(h);
    const a = await connect(doc, h, { docId: "d1", alias: "u1" });
    const b = await connect(doc, h, { docId: "d1", alias: "u2" });
    // Dirty, unflushed edits: exactly what a close would otherwise persist.
    await doc.webSocketMessage(a, frameBuffer(encodeBinary(Opcode.UPDATE, updateWith("secret"))));
    const snapshotsBefore = h.snapshots.keys();

    await destroy(doc, "d1");
    // The host delivers each close after /destroy returns.
    await disconnect(doc, a);
    await disconnect(doc, b);

    expect(h.state.storage.map.size).toBe(0);
    expect(await h.state.storage.getAlarm()).toBeNull();
    expect(h.snapshots.keys()).toEqual(snapshotsBefore);
    expect(h.queued.filter((m) => m.kind === "index_doc")).toEqual([]);
  });

  it("is inert afterwards: late frames, errors, alarms and requests write nothing", async () => {
    const h = harness();
    const doc = makeActor(h);
    const ws = await connect(doc, h, { docId: "d1", alias: "u1" });
    await destroy(doc, "d1");

    await doc.webSocketMessage(ws, frameBuffer(encodeBinary(Opcode.UPDATE, updateWith("late"))));
    await doc.webSocketError();
    await doc.alarm();
    const apply = await doc.fetch(
      new Request("http://actor/apply-edits?docId=d1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ str_edits: [{ old_string: "", new_string: "late import" }] }),
      }),
    );

    expect(apply.status).toBe(410);
    expect(h.state.storage.map.size).toBe(0);
    expect(await h.state.storage.getAlarm()).toBeNull();
    expect(h.snapshots.keys()).toEqual([]);
    expect(h.queued).toEqual([]);
    expect(await (await destroy(doc, "d1")).json()).toEqual({ destroyed: true });
  });
});
