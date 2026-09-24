import { describe, expect, it } from "vitest";
import type { Actor, ActorSocket, ActorState } from "../interfaces.js";
import { SocketPair, upgradeResponse } from "../sockets.js";
import { MemoryActorState, MemoryBlobStore, MemoryJobQueue, MemorySocket, closeSocket, connectActor } from "./index.js";

describe("MemoryActorState storage", () => {
  it("clones values on the way in and out", async () => {
    const { storage } = new MemoryActorState();
    const pending = new Uint8Array([1, 2, 3]);
    const value = { pending, meta: { seq: 1 } };
    await storage.put("v", value);
    value.meta.seq = 99;
    pending[0] = 42;
    const stored = await storage.get<typeof value>("v");
    expect(stored).toEqual({ pending: new Uint8Array([1, 2, 3]), meta: { seq: 1 } });
    expect(stored!.pending).toBeInstanceOf(Uint8Array);
    stored!.meta.seq = 5;
    expect((await storage.get<typeof value>("v"))!.meta.seq).toBe(1);
    expect(await storage.get("nope")).toBeUndefined();
    expect(await storage.delete("v")).toBe(true);
    expect(await storage.delete("v")).toBe(false);
  });

  it("records the alarm and clears it with deleteAll, together with SQL tables", async () => {
    const { storage } = new MemoryActorState();
    await storage.setAlarm(123);
    expect(await storage.getAlarm()).toBe(123);
    expect(storage.alarm).toBe(123);
    storage.sql.exec("CREATE TABLE t (a)");
    storage.sql.exec("INSERT INTO t VALUES (?)", 1);
    await storage.put("k", 1);
    await storage.deleteAll();
    expect(await storage.getAlarm()).toBeNull();
    expect(await storage.get("k")).toBeUndefined();
    expect(storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray()).toEqual([]);
  });

  it("refuses boolean and undefined bindings and keeps Uint8Array blobs", () => {
    const { storage } = new MemoryActorState();
    storage.sql.exec("CREATE TABLE t (a, b)");
    expect(() => storage.sql.exec("INSERT INTO t VALUES (?, ?)", true, 1)).toThrow(TypeError);
    expect(() => storage.sql.exec("INSERT INTO t VALUES (?, ?)", 1, undefined)).toThrow(TypeError);
    storage.sql.exec("INSERT INTO t VALUES (?, ?)", null, new Uint8Array([9, 8]));
    const cursor = storage.sql.exec("SELECT a, b FROM t");
    expect(cursor.columnNames).toEqual(["a", "b"]);
    const row = cursor.one();
    expect(row.a).toBeNull();
    expect(row.b).toEqual(new Uint8Array([9, 8]));
    expect([...storage.sql.exec("SELECT a FROM t")]).toHaveLength(1);
    expect(() => storage.sql.exec("SELECT a FROM t WHERE 0").one()).toThrow(/expected exactly 1/);
    expect(() => storage.sql.exec("SELECT * FROM missing")).toThrow();
  });

  it("nests transactionSync through savepoints", () => {
    const { storage } = new MemoryActorState();
    storage.sql.exec("CREATE TABLE t (a)");
    storage.transactionSync(() => {
      storage.sql.exec("INSERT INTO t VALUES (1)");
      expect(() =>
        storage.transactionSync(() => {
          storage.sql.exec("INSERT INTO t VALUES (2)");
          throw new Error("inner");
        }),
      ).toThrow("inner");
      storage.sql.exec("INSERT INTO t VALUES (3)");
    });
    expect(storage.sql.exec("SELECT a FROM t ORDER BY a").toArray().map((r) => r.a)).toEqual([1, 3]);
    expect(() =>
      storage.transactionSync(() => {
        storage.sql.exec("INSERT INTO t VALUES (4)");
        throw new Error("outer");
      }),
    ).toThrow("outer");
    expect(storage.sql.exec("SELECT count(*) AS n FROM t").one().n).toBe(2);
  });
});

interface Meta {
  alias: string | null;
}

class ConnectActor implements Actor<Meta> {
  readonly closes: Array<{ alias: string | null; code: number }> = [];
  constructor(readonly state: ActorState<Meta>) {}
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname !== "/connect" || req.headers.get("upgrade") !== "websocket") return new Response("no", { status: 400 });
    if (url.searchParams.get("alias") === "banned") return new Response("forbidden", { status: 403 });
    const pair = new SocketPair<Meta>();
    this.state.acceptWebSocket(pair.server, { alias: url.searchParams.get("alias") });
    pair.server.send(new Uint8Array([7, 1, 2]));
    pair.server.send(new Uint8Array([3, 9]));
    pair.server.send("text");
    return upgradeResponse(pair.client);
  }
  webSocketClose(ws: ActorSocket<Meta>, code: number): void {
    this.closes.push({ alias: ws.meta.alias, code });
  }
}

describe("sockets", () => {
  it("connectActor returns the socket the actor accepted, with its outbox readable", async () => {
    const state = new MemoryActorState<Meta>();
    const actor = new ConnectActor(state);
    const ws = await connectActor(actor, state, { alias: "liv" });
    expect(ws).toBeInstanceOf(MemorySocket);
    expect(ws.meta).toEqual({ alias: "liv" });
    expect(ws.frames()).toEqual([
      { opcode: 7, payload: new Uint8Array([1, 2]) },
      { opcode: 3, payload: new Uint8Array([9]) },
    ]);
    expect(ws.firstPayload(3)).toEqual(new Uint8Array([9]));
    expect(ws.firstPayload(4)).toBeNull();
    expect(ws.has(7)).toBe(true);
    expect(ws.sentStrings).toEqual(["text"]);

    const second = await connectActor(actor, state, { alias: "sam" });
    expect(second).not.toBe(ws);
    expect(state.getWebSockets()).toEqual([ws, second]);

    ws.close(1000, "bye");
    ws.close(1011, "ignored");
    expect(ws.closed).toEqual({ code: 1000, reason: "bye" });
    expect(state.getWebSockets()).toEqual([second]);
    expect(() => ws.send("x")).toThrow(/closed/);

    await expect(connectActor(actor, state, { alias: "banned" })).rejects.toThrow(/403/);
  });

  it("closeSocket delivers the close code the actor closed with, or the peer's", async () => {
    const state = new MemoryActorState<Meta>();
    const actor = new ConnectActor(state);
    const a = await connectActor(actor, state, { alias: "a" });
    const b = await connectActor(actor, state, { alias: "b" });
    a.close(4404, "gone");
    await closeSocket(actor, a, 1000);
    await closeSocket(actor, b, 1001);
    expect(actor.closes).toEqual([
      { alias: "a", code: 4404 },
      { alias: "b", code: 1001 },
    ]);
    expect(state.getWebSockets()).toEqual([]);
  });
});

describe("MemoryBlobStore and MemoryJobQueue", () => {
  it("stores bytes and text, lists with prefix and paging", async () => {
    const blobs = new MemoryBlobStore();
    await blobs.put("s/1", new Uint8Array([1]));
    await blobs.put("s/2", "two", { httpMetadata: { contentType: "text/plain" } });
    await blobs.put("t/1", new Uint8Array([3]).buffer);
    expect(new Uint8Array(await (await blobs.get("s/1"))!.arrayBuffer())).toEqual(new Uint8Array([1]));
    expect(await (await blobs.get("s/2"))!.text()).toBe("two");
    expect(blobs.textOf("s/2")).toBe("two");
    expect((await blobs.head("s/2"))!.httpMetadata).toEqual({ contentType: "text/plain" });
    expect(await blobs.get("missing")).toBeNull();
    const page1 = await blobs.list({ prefix: "s/", limit: 1 });
    expect(page1.objects.map((o) => o.key)).toEqual(["s/1"]);
    expect(page1.truncated).toBe(true);
    const page2 = await blobs.list({ prefix: "s/", limit: 1, cursor: page1.cursor });
    expect(page2.objects.map((o) => o.key)).toEqual(["s/2"]);
    expect(page2.truncated).toBe(false);
    await blobs.delete(["s/1", "t/1"]);
    expect(blobs.keys()).toEqual(["s/2"]);

    const jobs = new MemoryJobQueue<{ kind: string }>();
    await jobs.send({ kind: "index" });
    expect(jobs.sent).toEqual([{ kind: "index" }]);
  });
});
