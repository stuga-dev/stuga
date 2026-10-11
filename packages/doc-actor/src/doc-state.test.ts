/**
 * DOC_STATE: what a socket may do now, sent after every handshake and to every
 * socket when the lock, the trash or its write tier moves, so an unlock, a
 * restore or a promotion reaches pages already open. It is a level, never a
 * refusal, so nothing it says reaches the audit ledger.
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { WriteRejectedPayload } from "@stuga/protocol/wire/doc-socket";
import { decodeJson, encodeBinary } from "@stuga/protocol/wire/frame";
import { Opcode, type DocStatePayload } from "@stuga/protocol/wire/opcodes";
import { DocActor } from "./doc-actor.js";
import { connect, frameBuffer, harness, makeActor, type Harness, type MemorySocket } from "../test/harness.js";

const DOC = "doc-state";

function states(ws: MemorySocket): DocStatePayload[] {
  return ws
    .frames()
    .filter((f) => f.opcode === Opcode.DOC_STATE)
    .map((f) => decodeJson<DocStatePayload>(f.payload));
}

function rejections(ws: MemorySocket): string[] {
  return ws
    .frames()
    .filter((f) => f.opcode === Opcode.WRITE_REJECTED)
    .map((f) => decodeJson<WriteRejectedPayload>(f.payload).kind);
}

const audits = (h: Harness) => h.queued.filter((m) => m.kind === "audit");

function sendUpdate(actor: DocActor, ws: MemorySocket, text: string): Promise<void> {
  const doc = new Y.Doc();
  doc.transact(() => {
    const p = new Y.XmlElement("paragraph");
    p.insert(0, [new Y.XmlText(text)]);
    doc.getXmlFragment("default").insert(0, [p]);
  });
  return actor.webSocketMessage(ws, frameBuffer(encodeBinary(Opcode.UPDATE, Y.encodeStateAsUpdate(doc))));
}

const acks = (ws: MemorySocket) => ws.frames().filter((f) => f.opcode === Opcode.UPDATE_ACK).length;

function setLocked(actor: DocActor, locked: boolean): Promise<Response> {
  return actor.fetch(new Request(`http://actor/set-locked?docId=${DOC}&locked=${locked ? "1" : "0"}`));
}

function setTrashed(actor: DocActor, trashed: boolean): Promise<Response> {
  return actor.fetch(new Request(`http://actor/set-trashed?docId=${DOC}&trashed=${trashed ? "1" : "0"}`));
}

function applyAcl(actor: DocActor, readers: string[], writers: string[]): Promise<Response> {
  const u = new URL("http://actor/revoke");
  u.searchParams.set("docId", DOC);
  for (const p of readers) u.searchParams.append("principal", p);
  u.searchParams.set("writersStated", "1");
  for (const w of writers) u.searchParams.append("writer", w);
  return actor.fetch(new Request(u.toString()));
}

describe("the state an open page is told", () => {
  it("follows every handshake, so a reconnect catches up", async () => {
    const h = harness();
    const actor = makeActor(h);
    const liv = await connect(actor, h, { docId: DOC, alias: "liv", write: "0" });
    await actor.webSocketMessage(liv, frameBuffer(encodeBinary(Opcode.SYNC_STEP_1, Y.encodeStateVector(new Y.Doc()))));
    expect(states(liv)).toEqual([{ locked: false, trashed: false, can_write: false }]);
  });

  it("reaches every socket on unlock as on lock, and an unlock is never audited", async () => {
    const h = harness();
    const actor = makeActor(h);
    const liv = await connect(actor, h, { docId: DOC, alias: "liv" });
    const bo = await connect(actor, h, { docId: DOC, alias: "bo" });

    await setLocked(actor, true);
    await setLocked(actor, false);

    for (const ws of [liv, bo]) {
      expect(states(ws).map((s) => s.locked)).toEqual([true, false]);
      // The lock's own notice is still sent once; the unlock sends no refusal at all.
      expect(rejections(ws)).toEqual(["locked"]);
    }
    expect(audits(h)).toEqual([]);
    await sendUpdate(actor, liv, "after the unlock");
    expect(acks(liv)).toBe(1);
  });

  it("tells a socket promoted to editor that it may write, and lets it", async () => {
    const h = harness();
    const actor = makeActor(h);
    const liv = await connect(actor, h, { docId: DOC, alias: "liv", write: "0" });

    await applyAcl(actor, ["user:owner", "user:liv"], ["user:owner", "user:liv"]);

    expect(states(liv)).toEqual([{ locked: false, trashed: false, can_write: true }]);
    expect(rejections(liv)).toEqual([]);
    await sendUpdate(actor, liv, "now an editor");
    expect(acks(liv)).toBe(1);
  });

  it("tells a demoted socket both ways it may no longer write", async () => {
    const h = harness();
    const actor = makeActor(h);
    const liv = await connect(actor, h, { docId: DOC, alias: "liv" });

    await applyAcl(actor, ["user:owner", "user:liv"], ["user:owner"]);

    expect(rejections(liv)).toEqual(["acl"]);
    expect(states(liv).at(-1)?.can_write).toBe(false);
  });
});

describe("a document in the trash", () => {
  it("refuses writes from every open socket and says why, without auditing them", async () => {
    const h = harness();
    const actor = makeActor(h);
    const liv = await connect(actor, h, { docId: DOC, alias: "liv" });

    await setTrashed(actor, true);
    expect(states(liv).at(-1)).toEqual({ locked: false, trashed: true, can_write: true });

    await sendUpdate(actor, liv, "written after the trash");
    expect(acks(liv)).toBe(0);
    expect(rejections(liv)).toEqual(["trashed"]);
    expect(audits(h)).toEqual([]);
    const md = (await (await actor.fetch(new Request(`http://actor/markdown?docId=${DOC}`))).json()) as { markdown: string };
    expect(md.markdown).not.toContain("written after the trash");
  });

  it("takes writes again once restored, and every open page hears it", async () => {
    const h = harness();
    const actor = makeActor(h);
    const liv = await connect(actor, h, { docId: DOC, alias: "liv" });

    await setTrashed(actor, true);
    await setTrashed(actor, false);

    expect(states(liv).map((s) => s.trashed)).toEqual([true, false]);
    await sendUpdate(actor, liv, "back from the trash");
    expect(acks(liv)).toBe(1);
  });

  it("is learned from each connect, as the node read the row then", async () => {
    const h = harness();
    const actor = makeActor(h);
    const liv = await connect(actor, h, { docId: DOC, alias: "liv" });
    await connect(actor, h, { docId: DOC, alias: "bo", trashed: "1" });
    await sendUpdate(actor, liv, "into the trash");
    expect(rejections(liv)).toEqual(["trashed"]);

    await connect(actor, h, { docId: DOC, alias: "kai" });
    await sendUpdate(actor, liv, "restored meanwhile");
    expect(acks(liv)).toBe(1);
  });
});
