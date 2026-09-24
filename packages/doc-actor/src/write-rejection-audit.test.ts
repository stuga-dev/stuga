/**
 * Which refused writes reach the audit ledger, and what the row says. Only
 * permission decisions (view-only, locked, agent raw write) are recorded, never
 * backpressure or fencing, and never the broadcast that tells every socket a lock
 * or ACL moved. Rows are deduped per (alias, kind) per window, name the document
 * by id only, and a broken queue never stops the refusal itself.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { WriteRejectedPayload } from "@stuga/protocol/wire/doc-socket";
import { encodeBinary, encodeJson, encodeEpoch, decodeJson } from "@stuga/protocol/wire/frame";
import { Opcode } from "@stuga/protocol/wire/opcodes";
import type { IndexMessage } from "@stuga/protocol/internal/jobs";
import { DocActor } from "./doc-actor.js";
import { harness, connect, makeActor, frameBuffer, WORKSPACE, type Harness, type MemorySocket } from "../test/harness.js";

const DOC = "doc-refusal-audit";
const DEDUP_MS = 60_000; // mirrors the actor's constant
const DEDUP_KEYS = 256; // mirrors the actor's cap on remembered windows

type AuditMessage = Extract<IndexMessage, { kind: "audit" }>;

const audits = (h: Harness): AuditMessage[] =>
  h.queued.filter((m): m is AuditMessage => m.kind === "audit");

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
function sendUpdate(actor: DocActor, ws: MemorySocket, text: string): Promise<void> {
  return actor.webSocketMessage(ws, frameBuffer(encodeBinary(Opcode.UPDATE, Y.encodeStateAsUpdate(clientDocWith(text)))));
}

/** The kind of every WRITE_REJECTED frame in the socket's outbox, in order. */
function rejections(ws: MemorySocket): string[] {
  return ws
    .frames()
    .filter((f) => f.opcode === Opcode.WRITE_REJECTED)
    .map((f) => decodeJson<WriteRejectedPayload>(f.payload).kind);
}

/** Give the document a body, and with it the title a row's label is derived from. */
function seed(actor: DocActor, markdown: string): Promise<Response> {
  return actor.fetch(
    new Request(`http://actor/apply-edits?docId=${DOC}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ str_edits: [{ old_string: "", new_string: markdown }], agent: "seed" }),
    }),
  );
}

/** Lock the document, which broadcasts the new read-only state to every socket. */
function lock(actor: DocActor): Promise<Response> {
  return actor.fetch(new Request(`http://actor/set-locked?docId=${DOC}&locked=1`));
}

/** Hand the actor a materialized ACL exactly as the node does after writing one. */
function applyAcl(actor: DocActor, readers: string[], writers: string[]): Promise<Response> {
  const u = new URL("http://actor/revoke");
  u.searchParams.set("docId", DOC);
  for (const p of readers) u.searchParams.append("principal", p);
  u.searchParams.set("writersStated", "1");
  for (const w of writers) u.searchParams.append("writer", w);
  return actor.fetch(new Request(u.toString()));
}

/** One co-author turn, as the panel sends it. */
function askAi(actor: DocActor, ws: MemorySocket): Promise<void> {
  const frame = encodeJson(Opcode.AI_REQUEST, {
    prompt: "rewrite the intro",
    selected_text: null,
    model: "auto",
    history: [],
    collection_id: null,
  });
  return actor.webSocketMessage(ws, frameBuffer(frame));
}

/** Let an already-scheduled rejection handler run. */
const settle = (): Promise<void> => Promise.resolve();

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the ledger of refused writes", () => {
  it("records a view-only holder's refused write, naming the document by id", async () => {
    const h = harness();
    const actor = makeActor(h);
    await seed(actor, "# Quarterly plan\n\nBody.\n");
    const bob = await connect(actor, h, {
      docId: DOC,
      alias: "bob",
      write: "0",
      principal: ["user:bob"],
      workspaceId: "ws1",
    });

    await sendUpdate(actor, bob, "not mine to write");

    expect(rejections(bob)).toEqual(["acl"]);
    const rows = audits(h);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "audit",
      workspaceId: "ws1",
      actor: "bob",
      actorKind: "human",
      source: "ws",
      action: "doc.write_rejected",
      status: "denied",
      targetKind: "doc",
      targetId: DOC,
    });
    // Stamped by the actor at the refusal, not by the worker at the insert.
    expect(rows[0]!.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(rows[0]!.detail).toMatchObject({ kind: "acl" });
    // The id, and no name for it. The actor holds no stored title, so the only
    // label it could put here is a line of the document's own body.
    expect(rows[0]!.targetLabel).toBeUndefined();
  });

  it("says the same thing about a document it has read as about one it has not", async () => {
    const full = harness();
    const fullActor = makeActor(full);
    await seed(fullActor, "# Acquisition of Northwind\n\nPrice and close date.\n");
    const fullBob = await connect(fullActor, full, { docId: DOC, alias: "bob", write: "0", workspaceId: "ws1" });
    await sendUpdate(fullActor, fullBob, "not mine to write");

    const empty = harness();
    const emptyActor = makeActor(empty);
    const emptyBob = await connect(emptyActor, empty, { docId: DOC, alias: "bob", write: "0", workspaceId: "ws1" });
    await sendUpdate(emptyActor, emptyBob, "not mine to write");

    // Every workspace owner and admin can read and export the ledger; opening the
    // document takes a place on its ACL. A row that varied with the body would
    // carry the second population's text to the first, so the two rows are the
    // same row — and no field of either holds a word of the document.
    expect(audits(full)).toHaveLength(1);
    expect(audits(empty)).toHaveLength(1);
    // The clock is the one field allowed to differ: each row is stamped at its
    // own refusal, and the two refusals were not simultaneous.
    const { at: _fullAt, ...fullRow } = audits(full)[0]!;
    const { at: _emptyAt, ...emptyRow } = audits(empty)[0]!;
    expect(fullRow).toEqual(emptyRow);
    expect(JSON.stringify(audits(full)[0])).not.toContain("Northwind");
  });

  it("writes one row while a client hammers the same refusal", async () => {
    const h = harness();
    const actor = makeActor(h);
    const bob = await connect(actor, h, { docId: DOC, alias: "bob", write: "0", workspaceId: "ws1" });

    for (let i = 0; i < 25; i++) await sendUpdate(actor, bob, `attempt ${i}`);

    // Every frame is still refused to the client; only the ledger is deduped.
    expect(rejections(bob)).toHaveLength(25);
    expect(audits(h)).toHaveLength(1);
  });

  it("records the refusal again once the window has passed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const h = harness();
    const actor = makeActor(h);
    const bob = await connect(actor, h, { docId: DOC, alias: "bob", write: "0", workspaceId: "ws1" });

    await sendUpdate(actor, bob, "first");
    vi.setSystemTime(Date.now() + DEDUP_MS - 1);
    await sendUpdate(actor, bob, "still inside");
    expect(audits(h)).toHaveLength(1);

    vi.setSystemTime(Date.now() + 2);
    await sendUpdate(actor, bob, "past the window");
    expect(audits(h)).toHaveLength(2);
  });

  it("gives each refusal kind its own window", async () => {
    const h = harness();
    const actor = makeActor(h);
    const bob = await connect(actor, h, { docId: DOC, alias: "bob", write: "0", workspaceId: "ws1" });

    await sendUpdate(actor, bob, "denied as a reader");
    await lock(actor);
    await sendUpdate(actor, bob, "denied by the lock now");

    // One window per kind: the second refusal is a different decision about the
    // same person, and a ledger that showed only the first would say the document
    // was never locked against them.
    expect(audits(h).map((r) => r.detail?.kind)).toEqual(["acl", "locked"]);
  });

  it("records nothing for the broadcast that a document just locked", async () => {
    const h = harness();
    const actor = makeActor(h);
    const alice = await connect(actor, h, { docId: DOC, alias: "alice", write: "1", workspaceId: "ws1" });

    await lock(actor);

    // Every open socket is told, the locking tab's included. Nobody tried to
    // write, so nobody was denied anything.
    expect(rejections(alice)).toEqual(["locked"]);
    expect(audits(h)).toEqual([]);

    // The keystroke that actually meets the lock is the refusal, and it records.
    await sendUpdate(actor, alice, "typing anyway");
    expect(audits(h)).toHaveLength(1);
    expect(audits(h)[0]!.detail).toMatchObject({ kind: "locked" });
  });

  it("records nothing for the broadcast that access was re-tiered, and spends no window on it", async () => {
    const h = harness();
    const actor = makeActor(h);
    // Deliberately tenant-less, and the assertions below carry that through: an
    // empty ledger alone would also be what a recorder that quietly dropped every
    // untenanted refusal produced, and then this test would be green for a reason
    // with nothing to do with broadcasts.
    const alice = await connect(actor, h, { docId: DOC, alias: "alice", write: "1", principal: ["user:alice"] });

    await applyAcl(actor, ["user:owner", "user:alice"], ["user:owner"]);

    // The demotion is already audited by the node as the ACL change that caused
    // it; the socket notice is how the editor flips read-only, not a second
    // decision about alice.
    expect(rejections(alice)).toEqual(["acl"]);
    expect(audits(h)).toEqual([]);

    // Same socket, same kind, one keystroke later. This is the frame alice
    // actually sent, so it records — which is what makes the silence above the
    // broadcast and nothing else, and shows the broadcast did not spend alice's
    // window on a decision nobody made.
    await sendUpdate(actor, alice, "typing anyway");

    expect(rejections(alice)).toEqual(["acl", "acl"]);
    const rows = audits(h);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: "alice", workspaceId: WORKSPACE, targetId: DOC });
    expect(rows[0]!.detail).toMatchObject({ kind: "acl" });
  });

  it("gives each principal their own window", async () => {
    const h = harness();
    const actor = makeActor(h);
    const bob = await connect(actor, h, { docId: DOC, alias: "bob", write: "0", workspaceId: "ws1" });
    const carol = await connect(actor, h, { docId: DOC, alias: "carol", write: "0", workspaceId: "ws1" });

    await sendUpdate(actor, bob, "bob's try");
    await sendUpdate(actor, carol, "carol's try");

    expect(audits(h).map((r) => r.actor)).toEqual(["bob", "carol"]);
  });

  it("expires one principal's window without disturbing a younger one", async () => {
    vi.useFakeTimers();
    const t0 = Date.parse("2026-01-01T00:00:00Z");
    vi.setSystemTime(t0);
    const h = harness();
    const actor = makeActor(h);
    const bob = await connect(actor, h, { docId: DOC, alias: "bob", write: "0", workspaceId: "ws1" });
    const carol = await connect(actor, h, { docId: DOC, alias: "carol", write: "0", workspaceId: "ws1" });

    await sendUpdate(actor, bob, "bob first");
    vi.setSystemTime(t0 + 30_000);
    await sendUpdate(actor, carol, "carol first");
    expect(audits(h)).toHaveLength(2);

    // Past bob's window, halfway through carol's. The sweep runs oldest-first and
    // stops at the first entry still alive, so it takes bob's and leaves carol's:
    // a sweep that emptied the map whenever its head expired would pass every
    // single-principal test above and hand carol a duplicate row here.
    vi.setSystemTime(t0 + 61_000);
    await sendUpdate(actor, bob, "bob again");
    expect(audits(h)).toHaveLength(3);
    await sendUpdate(actor, carol, "carol again");
    expect(audits(h)).toHaveLength(3);

    expect(audits(h).map((r) => r.actor)).toEqual(["bob", "carol", "bob"]);
  });

  it("bounds the windows it remembers, dropping the oldest to make room", async () => {
    const h = harness();
    const actor = makeActor(h);
    // One more principal than the map holds, all refused inside one window: the
    // first is evicted to admit the last. Nothing here waits for a clock — the cap
    // is what a document refusing a crowd runs into, and without it the map grows
    // for as long as the actor lives.
    const sockets: MemorySocket[] = [];
    for (let i = 0; i <= DEDUP_KEYS; i++) {
      const ws = await connect(actor, h, { docId: DOC, alias: `user-${i}`, write: "0", workspaceId: "ws1" });
      sockets.push(ws);
      await sendUpdate(actor, ws, "not mine to write");
    }
    expect(audits(h)).toHaveLength(DEDUP_KEYS + 1);

    // The evicted principal's next refusal records again — the cost of the cap,
    // and the direction it fails in: a duplicate row, never a missing one.
    await sendUpdate(actor, sockets[0]!, "still not mine");
    expect(audits(h)).toHaveLength(DEDUP_KEYS + 2);

    // The newest principal still holds theirs, so the map dropped the oldest
    // rather than the map.
    await sendUpdate(actor, sockets[DEDUP_KEYS]!, "still not mine");
    expect(audits(h)).toHaveLength(DEDUP_KEYS + 2);
  });

  it("attributes the agent gate to an agent", async () => {
    const h = harness();
    const actor = makeActor(h);
    const agent = await connect(actor, h, {
      docId: DOC,
      alias: "key-7",
      agent: "Claude (Connector)",
      agentAuth: "1",
      write: "1",
      workspaceId: "ws1",
    });

    await sendUpdate(actor, agent, "raw yjs from an agent");

    expect(rejections(agent)).toEqual(["approval_required"]);
    const rows = audits(h);
    expect(rows).toHaveLength(1);
    // `agentAuth` is the server's assertion; the label rides along in detail and
    // decides nothing.
    expect(rows[0]).toMatchObject({ actor: "key-7", actorKind: "agent", status: "denied" });
    expect(rows[0]!.detail).toMatchObject({ kind: "approval_required", agent: "Claude (Connector)" });
  });

  it("names the human an agent's key was minted by", async () => {
    const h = harness();
    const actor = makeActor(h);
    const agent = await connect(actor, h, {
      docId: DOC,
      alias: "key-7",
      agent: "Claude (Connector)",
      agentAuth: "1",
      onBehalfOf: "liv",
      write: "1",
      workspaceId: "ws1",
    });

    await sendUpdate(actor, agent, "raw yjs from an agent");

    // The review gate is where the ledger is asked who authorised the attempt,
    // so the row carries both halves: the key that tried, and the person it acts
    // for.
    expect(rejections(agent)).toEqual(["approval_required"]);
    expect(audits(h)[0]).toMatchObject({ actor: "key-7", actorKind: "agent", onBehalfOf: "liv" });
  });

  it("names nobody for a person acting for themselves", async () => {
    const h = harness();
    const actor = makeActor(h);
    const bob = await connect(actor, h, { docId: DOC, alias: "bob", write: "0", workspaceId: "ws1" });

    await sendUpdate(actor, bob, "not mine to write");

    // A human socket carries no delegate, and an invented one would read as an
    // authority nobody granted.
    expect(audits(h)[0]!.onBehalfOf).toBeUndefined();
  });

  it("records nothing for a socket fenced by the rollback generation", async () => {
    const h = harness();
    const actor = makeActor(h);
    const bob = await connect(actor, h, { docId: DOC, alias: "bob", write: "1", workspaceId: "ws1" });

    // An epoch ACK for a generation this document has never had. The refusal is
    // about the socket's DATA being stale, not about what bob may do.
    await actor.webSocketMessage(bob, frameBuffer(encodeBinary(Opcode.DOCUMENT_EPOCH_ACK, encodeEpoch(7))));

    expect(rejections(bob)).toEqual(["epoch"]);
    expect(audits(h)).toEqual([]);
  });

  it("records nothing when a client is merely too fast", async () => {
    const h = harness();
    const actor = makeActor(h);
    const bob = await connect(actor, h, { docId: DOC, alias: "bob", write: "1", workspaceId: "ws1" });

    // MAX_AI_PER_WINDOW turns are spent (AI is off in the harness, so each ends
    // in a refusal to the client rather than a model call), and the next one
    // trips the per-connection budget.
    for (let i = 0; i < 11; i++) await askAi(actor, bob);

    expect(rejections(bob)).toEqual(["rate-limit"]);
    expect(audits(h)).toEqual([]);
  });

  it("refuses the write when the ledger is unreachable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = harness();
    const actor = new DocActor(h.state, {
      ...h.env,
      jobs: { send: () => Promise.reject(new Error("queue down")) },
    });
    const bob = await connect(actor, h, { docId: DOC, alias: "bob", write: "0", workspaceId: "ws1" });

    await sendUpdate(actor, bob, "hello");
    await settle();

    expect(rejections(bob)).toEqual(["acl"]);
    expect(bob.closed).toBeNull();
    // A ledger gap is loud: silence here would hide every lost refusal.
    expect(warn).toHaveBeenCalled();
  });

  it("refuses the write when the queue throws on the spot", async () => {
    const h = harness();
    const actor = new DocActor(h.state, {
      ...h.env,
      jobs: {
        send: () => {
          throw new Error("queue down");
        },
      },
    });
    const bob = await connect(actor, h, { docId: DOC, alias: "bob", write: "0", workspaceId: "ws1" });

    await sendUpdate(actor, bob, "hello");

    expect(rejections(bob)).toEqual(["acl"]);
    expect(bob.closed).toBeNull();
  });
});
