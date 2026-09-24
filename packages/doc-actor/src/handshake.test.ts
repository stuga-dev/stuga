/**
 * Opening a document: what `/connect` requires, and how the client's half of
 * the sync handshake is judged. A handshake with nothing new is not an attempt
 * to write: a view-only or locked open is told so, but never audited.
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { WriteRejectedPayload } from "@stuga/protocol/wire/doc-socket";
import { decodeJson, encodeBinary } from "@stuga/protocol/wire/frame";
import { Opcode } from "@stuga/protocol/wire/opcodes";
import { connectActor } from "@stuga/runtime/testing";
import type { DocActor } from "./doc-actor.js";
import { addsNothing } from "./sync/gates.js";
import { connect, frameBuffer, harness, makeActor, type Harness, type MemorySocket } from "../test/harness.js";

const DOC = "doc-handshake";

function edit(actor: DocActor, oldString: string, newString: string): Promise<Response> {
  return actor.fetch(
    new Request(`http://actor/apply-edits?docId=${DOC}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ str_edits: [{ old_string: oldString, new_string: newString }], agent: "seed" }),
    }),
  );
}

const seed = (actor: DocActor, markdown: string) => edit(actor, "", markdown);

/** What a client that already holds the server's state answers SYNC_STEP_1 with. */
function emptyStep2(actor: DocActor): Uint8Array {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const server = (actor as any).store.doc as Y.Doc;
  const client = new Y.Doc();
  Y.applyUpdate(client, Y.encodeStateAsUpdate(server));
  return Y.encodeStateAsUpdate(client, Y.encodeStateVector(server));
}

/** A SYNC_STEP_2 carrying a paragraph the server does not have. */
function divergentStep2(text: string): Uint8Array {
  const client = new Y.Doc();
  const p = new Y.XmlElement("paragraph");
  p.insert(0, [new Y.XmlText(text)]);
  client.getXmlFragment("default").insert(0, [p]);
  return Y.encodeStateAsUpdate(client);
}

function sendStep2(actor: DocActor, ws: MemorySocket, update: Uint8Array): Promise<void> {
  return actor.webSocketMessage(ws, frameBuffer(encodeBinary(Opcode.SYNC_STEP_2, update)));
}

const rejections = (ws: MemorySocket) =>
  ws
    .frames()
    .filter((f) => f.opcode === Opcode.WRITE_REJECTED)
    .map((f) => decodeJson<WriteRejectedPayload>(f.payload).kind);
const audits = (h: Harness) => h.queued.filter((m) => m.kind === "audit");
const acks = (ws: MemorySocket) => ws.frames().filter((f) => f.opcode === Opcode.UPDATE_ACK).length;

describe("/connect", () => {
  const params = { docId: DOC, alias: "alice", write: "1", principal: ["user:alice"], workspaceId: "ws1" };

  it.each([
    ["the write tier", { write: undefined }],
    ["an unknown write tier", { write: "yes" }],
    ["the principals", { principal: undefined }],
    ["the workspace", { workspaceId: undefined }],
    ["the alias", { alias: undefined }],
  ])("refuses a connect without %s", async (_what, change) => {
    const h = harness();
    const actor = makeActor(h);
    const sent = Object.fromEntries(
      Object.entries({ ...params, ...change }).filter(([, v]) => v !== undefined),
    ) as Record<string, string | string[]>;
    await expect(connectActor(actor, h.state, sent)).rejects.toThrow(/400/);
    expect(h.state.getWebSockets()).toEqual([]);
  });

  it("refuses a request that does not name the document", async () => {
    const h = harness();
    const res = await makeActor(h).fetch(new Request("http://actor/markdown"));
    expect(res.status).toBe(400);
  });
});

describe("addsNothing", () => {
  it("is true for an up-to-date replica's handshake, deletions included, and false for anything new", () => {
    const server = new Y.Doc();
    const text = server.getText("t");
    text.insert(0, "hello world");
    text.delete(0, 3);
    const replica = new Y.Doc();
    Y.applyUpdate(replica, Y.encodeStateAsUpdate(server));
    const handshake = Y.encodeStateAsUpdate(replica, Y.encodeStateVector(server));
    // The handshake is not byte-empty: it carries the replica's delete set.
    expect(Y.decodeUpdate(handshake).ds.clients.size).toBe(1);
    expect(addsNothing(server, handshake)).toBe(true);

    const deleting = new Y.Doc();
    Y.applyUpdate(deleting, Y.encodeStateAsUpdate(server));
    deleting.getText("t").delete(0, 2);
    expect(addsNothing(server, Y.encodeStateAsUpdate(deleting, Y.encodeStateVector(server)))).toBe(false);

    replica.getText("t").insert(0, "x");
    expect(addsNothing(server, Y.encodeStateAsUpdate(replica, Y.encodeStateVector(server)))).toBe(false);
  });

  it("is false for an update it cannot decode", () => {
    expect(addsNothing(new Y.Doc(), new Uint8Array([9, 9, 9, 9, 9]))).toBe(false);
  });
});

describe("the client's SYNC_STEP_2", () => {
  it("tells a view-only open it is view-only, without acknowledging or auditing it", async () => {
    const h = harness();
    const actor = makeActor(h);
    await seed(actor, "# Plan\n\nBody.\n");
    const viewer = await connect(actor, h, { docId: DOC, alias: "bob", write: "0" });

    await sendStep2(actor, viewer, emptyStep2(actor));

    expect(rejections(viewer)).toEqual(["acl"]);
    expect(acks(viewer)).toBe(0);
    expect(audits(h)).toEqual([]);
  });

  it("tells a writer's open of a locked document it is locked, without acknowledging or auditing it", async () => {
    const h = harness();
    const actor = makeActor(h);
    await seed(actor, "# Plan\n\nBody.\n");
    await actor.fetch(new Request(`http://actor/set-locked?docId=${DOC}&locked=1`));
    const writer = await connect(actor, h, { docId: DOC, alias: "alice" });

    await sendStep2(actor, writer, emptyStep2(actor));

    expect(rejections(writer)).toEqual(["locked"]);
    expect(acks(writer)).toBe(0);
    expect(audits(h)).toEqual([]);
  });

  it("acknowledges a writer's up-to-date open of a document with deletions without re-broadcasting it", async () => {
    const h = harness();
    const actor = makeActor(h);
    await seed(actor, "# Plan\n\nBody.\n");
    await edit(actor, "Body.", "Text.");
    const writer = await connect(actor, h, { docId: DOC, alias: "alice" });
    const peer = await connect(actor, h, { docId: DOC, alias: "carol" });
    const handshake = emptyStep2(actor);
    expect(Y.decodeUpdate(handshake).ds.clients.size).toBeGreaterThan(0);

    await sendStep2(actor, writer, handshake);

    expect(rejections(writer)).toEqual([]);
    expect(acks(writer)).toBe(1);
    expect(peer.has(Opcode.UPDATE)).toBe(false);
  });

  it("refuses and audits a view-only session's divergent state without applying it", async () => {
    const h = harness();
    const actor = makeActor(h);
    await seed(actor, "# Plan\n\nBody.\n");
    const viewer = await connect(actor, h, { docId: DOC, alias: "bob", write: "0" });
    const peer = await connect(actor, h, { docId: DOC, alias: "alice" });

    await sendStep2(actor, viewer, divergentStep2("forged by a viewer"));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((actor as any).store.markdown()).not.toContain("forged by a viewer");
    expect(peer.has(Opcode.UPDATE)).toBe(false);
    expect(rejections(viewer)).toEqual(["acl"]);
    expect(acks(viewer)).toBe(0);
    expect(audits(h)).toHaveLength(1);
  });

  it("refuses and audits offline edits a writer brings to a locked document", async () => {
    const h = harness();
    const actor = makeActor(h);
    await seed(actor, "# Plan\n\nBody.\n");
    await actor.fetch(new Request(`http://actor/set-locked?docId=${DOC}&locked=1`));
    const writer = await connect(actor, h, { docId: DOC, alias: "alice" });

    await sendStep2(actor, writer, divergentStep2("offline while locked"));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((actor as any).store.markdown()).not.toContain("offline while locked");
    expect(rejections(writer)).toEqual(["locked"]);
    expect(acks(writer)).toBe(0);
    expect(audits(h)).toHaveLength(1);
  });

  it("acknowledges an agent's empty handshake but still refuses its content", async () => {
    const h = harness();
    const actor = makeActor(h);
    await seed(actor, "# Plan\n\nBody.\n");
    const agent = await connect(actor, h, { docId: DOC, alias: "alice", agent: "claude", agentAuth: "1" });

    await sendStep2(actor, agent, emptyStep2(actor));
    expect(rejections(agent)).toEqual([]);
    expect(acks(agent)).toBe(1);

    await sendStep2(actor, agent, divergentStep2("raw agent write"));
    expect(rejections(agent)).toEqual(["approval_required"]);
  });

  it("applies and broadcasts a writer's divergent state", async () => {
    const h = harness();
    const actor = makeActor(h);
    await seed(actor, "# Plan\n\nBody.\n");
    const writer = await connect(actor, h, { docId: DOC, alias: "alice" });
    const peer = await connect(actor, h, { docId: DOC, alias: "carol" });

    await sendStep2(actor, writer, divergentStep2("offline paragraph"));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((actor as any).store.markdown()).toContain("offline paragraph");
    expect(acks(writer)).toBe(1);
    expect(peer.has(Opcode.UPDATE)).toBe(true);
  });
});
