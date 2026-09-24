/**
 * /revoke re-applies a changed ACL to open sockets: who is closed, who is
 * re-tiered, and which of a socket's principals still speak for it.
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { WriteRejectedPayload } from "@stuga/protocol/wire/doc-socket";
import { encodeBinary, decodeJson } from "@stuga/protocol/wire/frame";
import { Opcode, CloseCode } from "@stuga/protocol/wire/opcodes";
import { DocActor } from "./doc-actor.js";
import { harness, connect, makeActor, frameBuffer, type MemorySocket } from "../test/harness.js";

const DOC = "doc-acl-tier";

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
async function sendUpdate(actor: DocActor, ws: MemorySocket, text: string): Promise<void> {
  const frame = encodeBinary(Opcode.UPDATE, Y.encodeStateAsUpdate(clientDocWith(text)));
  await actor.webSocketMessage(ws, frameBuffer(frame));
}

/** How many frames of one opcode the socket has been sent. */
function count(ws: MemorySocket, opcode: number): number {
  return ws.frames().filter((f) => f.opcode === opcode).length;
}

/** The kind of every WRITE_REJECTED frame in the socket's outbox, in order. */
function rejections(ws: MemorySocket): string[] {
  return ws
    .frames()
    .filter((f) => f.opcode === Opcode.WRITE_REJECTED)
    .map((f) => decodeJson<WriteRejectedPayload>(f.payload).kind);
}

/**
 * Hand the actor an ACL exactly as the node does after materializing one.
 * `writers === null` is a request that lost its writer set.
 */
function applyAcl(actor: DocActor, readers: string[], writers: string[] | null): Promise<Response> {
  const u = new URL("http://actor/revoke");
  u.searchParams.set("docId", DOC);
  for (const p of readers) u.searchParams.append("principal", p);
  if (writers) {
    u.searchParams.set("writersStated", "1");
    for (const w of writers) u.searchParams.append("writer", w);
  }
  return actor.fetch(new Request(u.toString()));
}

describe("an ACL applied to open sockets", () => {
  it("refuses a writer demoted to reader on the socket they already hold", async () => {
    const h = harness();
    const actor = makeActor(h);
    const alice = await connect(actor, h, {
      docId: DOC,
      alias: "alice",
      write: "1",
      principal: ["user:alice", "org:ws1"],
    });

    await sendUpdate(actor, alice, "before");
    expect(count(alice, Opcode.UPDATE_ACK)).toBe(1);

    // Still a reader, so the socket stays open and only its tier changes.
    await applyAcl(actor, ["user:owner", "user:alice"], ["user:owner"]);
    expect(alice.closed).toBeNull();

    await sendUpdate(actor, alice, "after");
    expect(count(alice, Opcode.UPDATE_ACK)).toBe(1); // no second receipt
    expect(rejections(alice).at(-1)).toBe("acl");
  });

  it("tells the demoted editor at once, not at their next keystroke", async () => {
    const h = harness();
    const actor = makeActor(h);
    const alice = await connect(actor, h, { docId: DOC, alias: "alice", write: "1", principal: ["user:alice"] });

    await applyAcl(actor, ["user:owner", "user:alice"], ["user:owner"]);

    // The client flips the editor read-only on an "acl" rejection.
    expect(rejections(alice)).toEqual(["acl"]);
  });

  it("leaves a writer who is still a writer alone", async () => {
    const h = harness();
    const actor = makeActor(h);
    const alice = await connect(actor, h, { docId: DOC, alias: "alice", write: "1", principal: ["user:alice"] });

    await sendUpdate(actor, alice, "before");
    await applyAcl(actor, ["user:owner", "user:alice", "user:bob"], ["user:owner", "user:alice"]);

    expect(rejections(alice)).toEqual([]);
    await sendUpdate(actor, alice, "after");
    expect(count(alice, Opcode.UPDATE_ACK)).toBe(2);
  });

  it("keeps a workspace-wide writer writing: the org principal is never expanded", async () => {
    const h = harness();
    const actor = makeActor(h);
    // The `workspace_edit` default grants org:<workspace> as a writer, and
    // materializing an ACL leaves that principal un-expanded — so alice is a
    // writer while `user:alice` appears nowhere in the writer set.
    const alice = await connect(actor, h, {
      docId: DOC,
      alias: "alice",
      write: "1",
      principal: ["user:alice", "org:ws1"],
    });

    await applyAcl(actor, ["user:owner", "user:alice", "org:ws1"], ["user:owner", "org:ws1"]);

    expect(rejections(alice)).toEqual([]);
    await sendUpdate(actor, alice, "after");
    expect(count(alice, Opcode.UPDATE_ACK)).toBe(1);
  });

  it("keeps a writer the new ACL still names through a group", async () => {
    const h = harness();
    const actor = makeActor(h);
    const alice = await connect(actor, h, {
      docId: DOC,
      alias: "alice",
      write: "1",
      principal: ["user:alice", "group:eng"],
    });

    // group:eng is what names Alice as a writer; an unchanged ACL must not demote her.
    await applyAcl(actor, ["user:owner", "group:eng"], ["user:owner", "group:eng"]);

    await sendUpdate(actor, alice, "after");
    expect(count(alice, Opcode.UPDATE_ACK)).toBe(1);
    expect(rejections(alice)).toEqual([]);
  });

  it("demotes a group writer when the group leaves the writer set", async () => {
    const h = harness();
    const actor = makeActor(h);
    const alice = await connect(actor, h, {
      docId: DOC,
      alias: "alice",
      write: "1",
      principal: ["user:alice", "group:eng"],
    });

    // group:eng keeps read access and loses write. Nothing else names Alice, so
    // the tier her socket was born with has to go.
    await applyAcl(actor, ["user:owner", "group:eng"], ["user:owner"]);

    await sendUpdate(actor, alice, "after");
    expect(count(alice, Opcode.UPDATE_ACK)).toBe(0);
    expect(rejections(alice).at(-1)).toBe("acl");
  });

  it("lets a promoted reader write without reconnecting", async () => {
    const h = harness();
    const actor = makeActor(h);
    const bob = await connect(actor, h, { docId: DOC, alias: "bob", write: "0", principal: ["user:bob"] });

    await sendUpdate(actor, bob, "denied");
    expect(count(bob, Opcode.UPDATE_ACK)).toBe(0);

    await applyAcl(actor, ["user:owner", "user:bob"], ["user:owner", "user:bob"]);

    await sendUpdate(actor, bob, "allowed");
    expect(count(bob, Opcode.UPDATE_ACK)).toBe(1);
  });

  it("refuses an ACL that states no writer set, changing no session", async () => {
    const h = harness();
    const actor = makeActor(h);
    const alice = await connect(actor, h, { docId: DOC, alias: "alice", write: "1", principal: ["user:alice"] });

    const res = await applyAcl(actor, ["user:owner"], null);

    expect(res.status).toBe(400);
    expect(alice.closed).toBeFalsy();
    expect(rejections(alice)).toEqual([]);
    await sendUpdate(actor, alice, "after");
    expect(count(alice, Opcode.UPDATE_ACK)).toBe(1);
  });

  it("demotes every session when the stated writer set is empty", async () => {
    const h = harness();
    const actor = makeActor(h);
    const alice = await connect(actor, h, { docId: DOC, alias: "alice", write: "1", principal: ["user:alice"] });

    await applyAcl(actor, ["user:owner", "user:alice"], []);

    expect(rejections(alice)).toEqual(["acl"]);
    await sendUpdate(actor, alice, "after");
    expect(count(alice, Opcode.UPDATE_ACK)).toBe(0);
  });

  it("still closes a socket whose holder lost read access", async () => {
    const h = harness();
    const actor = makeActor(h);
    const carol = await connect(actor, h, { docId: DOC, alias: "carol", write: "1", principal: ["user:carol"] });

    await applyAcl(actor, ["user:owner"], ["user:owner"]);

    expect(carol.closed?.code).toBe(CloseCode.ACCESS_REVOKED);
  });
});
