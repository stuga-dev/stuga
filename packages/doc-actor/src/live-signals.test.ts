/**
 * What the node asks the actor to tell every open page about the document
 * apart from its text: the comments changed, someone renamed it, someone
 * restored a version. Each is a word to re-read or a name to show, never a
 * permission.
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { decodeJson, encodeBinary } from "@stuga/protocol/wire/frame";
import { CloseCode, Opcode, type DocResetPayload, type TitleChangedPayload } from "@stuga/protocol/wire/opcodes";
import { connect, frameBuffer, harness, makeActor } from "../test/harness.js";

const DOC = "live-signals";

function paragraph(text: string): Uint8Array {
  const doc = new Y.Doc();
  doc.transact(() => {
    const p = new Y.XmlElement("paragraph");
    p.insert(0, [new Y.XmlText(text)]);
    doc.getXmlFragment("default").insert(0, [p]);
  });
  return Y.encodeStateAsUpdate(doc);
}

describe("signals to open pages", () => {
  it("tells every socket, the author's included, that the comments changed", async () => {
    const h = harness();
    const actor = makeActor(h);
    const liv = await connect(actor, h, { docId: DOC, alias: "liv" });
    const bo = await connect(actor, h, { docId: DOC, alias: "bo", write: "0" });

    const res = await actor.fetch(new Request(`http://actor/comments-changed?docId=${DOC}`));

    expect(res.status).toBe(204);
    for (const ws of [liv, bo]) expect(ws.has(Opcode.COMMENTS_CHANGED)).toBe(true);
  });

  it("passes a rename on with who made it", async () => {
    const h = harness();
    const actor = makeActor(h);
    const bo = await connect(actor, h, { docId: DOC, alias: "bo" });

    const u = new URL("http://actor/title-changed");
    u.searchParams.set("docId", DOC);
    u.searchParams.set("title", "Oven rota");
    u.searchParams.set("by", "Liv");
    await actor.fetch(new Request(u.toString()));

    const payload = bo.firstPayload(Opcode.TITLE_CHANGED);
    expect(payload).not.toBeNull();
    expect(decodeJson<TitleChangedPayload>(payload!)).toEqual({ title: "Oven rota", by: "Liv" });
  });

  it("says who restored which version when it resets the open pages", async () => {
    const h = harness();
    const actor = makeActor(h);
    const liv = await connect(actor, h, { docId: DOC, alias: "liv" });
    await actor.webSocketMessage(liv, frameBuffer(encodeBinary(Opcode.UPDATE, paragraph("one"))));
    await actor.alarm();
    const restorable = (await h.state.storage.get<{ seq: number }>("meta"))!.seq;
    await actor.webSocketMessage(liv, frameBuffer(encodeBinary(Opcode.UPDATE, paragraph("two"))));
    await actor.alarm();

    const u = new URL("http://actor/restore");
    u.searchParams.set("docId", DOC);
    u.searchParams.set("seq", String(restorable));
    u.searchParams.set("by", "Liv");
    u.searchParams.set("at", "2026-10-09T11:52:00.000Z");
    expect((await actor.fetch(new Request(u.toString()))).status).toBe(200);

    expect(liv.closed?.code).toBe(CloseCode.DOC_RESET);
    const reset = liv.firstPayload(Opcode.DOC_RESET);
    expect(decodeJson<DocResetPayload>(reset!)).toEqual({
      restored: { by: "Liv", at: "2026-10-09T11:52:00.000Z", seq: restorable },
    });
  });

  it("resets with no payload when no person is named", async () => {
    const h = harness();
    const actor = makeActor(h);
    const liv = await connect(actor, h, { docId: DOC, alias: "liv" });
    await actor.webSocketMessage(liv, frameBuffer(encodeBinary(Opcode.UPDATE, paragraph("one"))));
    await actor.alarm();
    const restorable = (await h.state.storage.get<{ seq: number }>("meta"))!.seq;

    await actor.fetch(new Request(`http://actor/restore?docId=${DOC}&seq=${restorable}`));

    expect(liv.firstPayload(Opcode.DOC_RESET)?.byteLength).toBe(0);
  });
});
