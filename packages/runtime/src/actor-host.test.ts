import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  createActorNamespace,
  encodeActorName,
  decodeActorName,
  type ActorHostOptions,
  type HostedNamespace,
} from "./actor-host.js";
import type { Actor, ActorSocket, ActorState } from "./interfaces.js";
import { SocketPair, attachSocket, isUpgradeResponse, serverSocketOf, upgradeResponse } from "./sockets.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Poll until `cond` holds or `ms` elapses, so a slow runner fails on the deadline, not the schedule. */
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) return;
    await sleep(10);
  }
}

interface Env {
  log: string[];
}

/** A small actor exercising every host feature through its fetch surface. */
class TestActor implements Actor {
  closes = 0;
  constructor(
    readonly state: ActorState<{ alias: string }>,
    readonly env: Env,
  ) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const { storage } = this.state;
    switch (url.pathname) {
      case "/slow": {
        this.env.log.push("fetch:start");
        await sleep(30);
        this.env.log.push("fetch:end");
        return new Response("ok");
      }
      case "/count": {
        const n = ((await storage.get<number>("n")) ?? 0) + 1;
        await sleep(2);
        await storage.put("n", n);
        return new Response(String(n));
      }
      case "/set-alarm": {
        await storage.setAlarm(Date.now() + Number(url.searchParams.get("in") ?? "0"));
        return new Response("armed");
      }
      case "/get-alarm":
        return Response.json({ alarm: await storage.getAlarm() });
      case "/put": {
        const bytes = new Uint8Array(await req.arrayBuffer());
        await storage.put(url.searchParams.get("key")!, { bytes, nested: { list: [1, 2, 3] } });
        return new Response("stored");
      }
      case "/get": {
        const v = await storage.get<{ bytes: Uint8Array; nested: unknown } | number>(url.searchParams.get("key")!);
        if (v === undefined) return new Response("missing", { status: 404 });
        if (typeof v === "number") return new Response(String(v));
        return Response.json({ isBytes: v.bytes instanceof Uint8Array, bytes: [...v.bytes], nested: v.nested });
      }
      case "/sql": {
        storage.sql.exec("CREATE TABLE IF NOT EXISTS rows (id INTEGER PRIMARY KEY, name TEXT)");
        storage.transactionSync(() => {
          storage.sql.exec("INSERT INTO rows (name) VALUES (?)", url.searchParams.get("name") ?? "x");
        });
        const { n } = storage.sql.exec("SELECT count(*) AS n FROM rows").one();
        return new Response(String(n));
      }
      case "/tables": {
        const names = storage.sql
          .exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\'")
          .toArray()
          .map((r) => r.name);
        return Response.json(names);
      }
      case "/delete-all":
        await storage.deleteAll();
        return new Response("wiped");
      case "/connect": {
        if (req.headers.get("upgrade") !== "websocket") return new Response("expected upgrade", { status: 426 });
        const pair = new SocketPair<{ alias: string }>();
        this.state.acceptWebSocket(pair.server, { alias: url.searchParams.get("alias") ?? "anon" });
        pair.server.send("welcome");
        return upgradeResponse(pair.client);
      }
      case "/sockets":
        return Response.json({
          all: this.state.getWebSockets().length,
          aliases: this.state.getWebSockets().map((ws) => ws.meta.alias),
          closes: this.closes,
        });
      case "/close-all": {
        for (const ws of this.state.getWebSockets()) ws.close(4000, "bye");
        return new Response("closed");
      }
      default:
        return new Response("not found", { status: 404 });
    }
  }

  async webSocketMessage(ws: ActorSocket, message: string | ArrayBuffer): Promise<void> {
    if (message === "slow") {
      // Holds the lock for a while, so a frame queued behind it lands late.
      this.env.log.push("message:slow:start");
      await sleep(30);
      this.env.log.push("message:slow:end");
      return;
    }
    if (typeof message === "string") {
      this.env.log.push(`message:${message}`);
      ws.send(`echo:${message}`);
    } else {
      ws.send(new Uint8Array(message).reverse());
    }
  }

  interceptWebSocketMessage(_ws: ActorSocket, message: string | ArrayBuffer): boolean {
    if (message !== "cancel") return false;
    this.env.log.push("intercept:cancel");
    return true;
  }

  async webSocketClose(_ws: unknown, code: number): Promise<void> {
    this.closes += 1;
    this.env.log.push(`close:${code}`);
  }

  async alarm(): Promise<void> {
    this.env.log.push("alarm:start");
    await sleep(10);
    const fired = ((await this.state.storage.get<number>("alarmFired")) ?? 0) + 1;
    await this.state.storage.put("alarmFired", fired);
    this.env.log.push("alarm:end");
  }
}

const dirs: string[] = [];
const namespaces: HostedNamespace[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "stuga-actors-"));
  dirs.push(dir);
  return dir;
}

const HEARTBEAT = { request: "ping", response: "pong" };

function host(dir: string, env: Env, idleMs = Infinity, more: Partial<ActorHostOptions> = {}): HostedNamespace {
  const ns = createActorNamespace(TestActor, env, {
    name: "test",
    dir,
    idleMs,
    heartbeat: HEARTBEAT,
    storeVersion: 1,
    ...more,
  });
  namespaces.push(ns);
  return ns;
}

/** The stamp in an actor's file, read behind the host's back. */
function stampOf(dir: string, actor: string): number {
  const db = new DatabaseSync(join(dir, `${encodeActorName(actor)}.sqlite`));
  try {
    return (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  } finally {
    db.close();
  }
}

afterEach(async () => {
  await Promise.all(namespaces.splice(0).map((ns) => ns.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("mutex", () => {
  it("serializes interleaved fetch and alarm on one actor", async () => {
    const env: Env = { log: [] };
    const ns = host(tempDir(), env);
    const doc = ns.get("doc-1");
    const slow = doc.fetch("http://actor/slow");
    await doc.fetch("http://actor/set-alarm?in=0"); // queued behind /slow, fires as soon as the lock is free
    const second = doc.fetch("http://actor/slow");
    await Promise.all([slow, second]);
    await sleep(80);
    // Every start is followed by its own end before anything else starts.
    for (let i = 0; i < env.log.length; i += 2) {
      expect(env.log[i]).toMatch(/:start$/);
      expect(env.log[i + 1]).toBe(env.log[i]!.replace(":start", ":end"));
    }
    expect(env.log).toContain("alarm:start");
    expect(env.log.filter((l) => l === "fetch:start")).toHaveLength(2);
  });

  it("makes read-modify-write across an await safe", async () => {
    const ns = host(tempDir(), { log: [] });
    const doc = ns.get("counter");
    const results = await Promise.all(Array.from({ length: 25 }, () => doc.fetch("http://actor/count").then((r) => r.text())));
    expect(results.map(Number).sort((a, b) => a - b)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    expect(await (await doc.fetch("http://actor/get?key=n")).text()).toBe("25");
  });

  it("runs different actors concurrently", async () => {
    const env: Env = { log: [] };
    const ns = host(tempDir(), env);
    await Promise.all([ns.get("a").fetch("http://actor/slow"), ns.get("b").fetch("http://actor/slow")]);
    // Asserted on the interleaving, not on wall-clock time.
    expect(env.log).toEqual(["fetch:start", "fetch:start", "fetch:end", "fetch:end"]);
  });
});

describe("storage", () => {
  it("round-trips Uint8Array and nested values through the kv store", async () => {
    const ns = host(tempDir(), { log: [] });
    const doc = ns.get("kv");
    await doc.fetch("http://actor/put?key=pending", { method: "POST", body: new Uint8Array([1, 2, 255]) });
    const out = await (await doc.fetch("http://actor/get?key=pending")).json();
    expect(out).toEqual({ isBytes: true, bytes: [1, 2, 255], nested: { list: [1, 2, 3] } });
  });

  it("persists across a host restart, and deleteAll drops SQL tables too", async () => {
    const dir = tempDir();
    const ns1 = host(dir, { log: [] });
    await ns1.get("d").fetch("http://actor/sql?name=a");
    expect(await (await ns1.get("d").fetch("http://actor/sql?name=b")).text()).toBe("2");
    await ns1.get("d").fetch("http://actor/put?key=k", { method: "POST", body: new Uint8Array([7]) });
    await ns1.close();

    const ns2 = host(dir, { log: [] });
    expect(await (await ns2.get("d").fetch("http://actor/sql?name=c")).text()).toBe("3");
    expect(((await (await ns2.get("d").fetch("http://actor/get?key=k")).json()) as { bytes: number[] }).bytes).toEqual([7]);
    expect(await (await ns2.get("d").fetch("http://actor/tables")).json()).toEqual(["rows"]);

    await ns2.get("d").fetch("http://actor/delete-all");
    expect(await (await ns2.get("d").fetch("http://actor/tables")).json()).toEqual([]);
    expect((await ns2.get("d").fetch("http://actor/get?key=k")).status).toBe(404);
    expect(await (await ns2.get("d").fetch("http://actor/sql?name=z")).text()).toBe("1");
  });

  it("names files unambiguously for any actor name", () => {
    for (const name of ["doc_1", "a/b", "über", "..", "x y", "%41"]) {
      expect(decodeActorName(encodeActorName(name))).toBe(name);
      expect(encodeActorName(name)).toMatch(/^[A-Za-z0-9_%-]*$/);
    }
    expect(encodeActorName("%41")).not.toBe(encodeActorName("A"));
  });
});

describe("alarms", () => {
  it("fires once, is consumed before the handler runs, and clears afterwards", async () => {
    const env: Env = { log: [] };
    const ns = host(tempDir(), env);
    const doc = ns.get("alarm");
    await doc.fetch("http://actor/set-alarm?in=20");
    expect(((await (await doc.fetch("http://actor/get-alarm")).json()) as { alarm: number | null }).alarm).not.toBeNull();
    await sleep(120);
    expect(await (await doc.fetch("http://actor/get?key=alarmFired")).text()).toBe("1");
    expect(((await (await doc.fetch("http://actor/get-alarm")).json()) as { alarm: number | null }).alarm).toBeNull();
  });

  it("survives a host restart", async () => {
    const dir = tempDir();
    const ns1 = host(dir, { log: [] });
    await ns1.get("doc-x/y").fetch("http://actor/set-alarm?in=150");
    await ns1.close();
    expect(readdirSync(dir).some((f) => f.endsWith(".sqlite"))).toBe(true);

    const env: Env = { log: [] };
    const ns2 = host(dir, env);
    expect(ns2.resident()).toEqual([]); // armed cold; not opened until due
    await until(() => env.log.length >= 2);
    expect(env.log).toEqual(["alarm:start", "alarm:end"]);
    expect(ns2.resident()).toEqual(["doc-x/y"]);
    expect(await (await ns2.get("doc-x/y").fetch("http://actor/get?key=alarmFired")).text()).toBe("1");
  });

  it("survives idle eviction", async () => {
    const env: Env = { log: [] };
    const ns = host(tempDir(), env, 5);
    await ns.get("e").fetch("http://actor/set-alarm?in=120");
    await sleep(10);
    await ns.evictIdle();
    expect(ns.resident()).toEqual([]);
    await until(() => env.log.length >= 2);
    expect(env.log).toEqual(["alarm:start", "alarm:end"]);
  });
});

describe("pause and resume", () => {
  it("closes every actor, drops its sockets for a reconnect, and opens none until resumed", async () => {
    const env: Env = { log: [] };
    const ns = host(tempDir(), env);
    const doc = ns.get("d1");
    expect(await (await doc.fetch("http://actor/count")).text()).toBe("1");
    const res = await doc.fetch("http://actor/connect?alias=a", { headers: { upgrade: "websocket" } });
    const server = serverSocketOf(res);

    await ns.pause();
    expect(ns.resident()).toEqual([]);
    expect(server.closed).toEqual({ code: 1012, reason: "service restart" });
    await expect(doc.fetch("http://actor/count")).rejects.toThrow(/paused/);

    ns.resume();
    // The store was closed whole, so nothing it held is lost.
    expect(await (await doc.fetch("http://actor/count")).text()).toBe("2");
  });

  it("waits for an actor's work in flight before its store closes", async () => {
    const env: Env = { log: [] };
    const ns = host(tempDir(), env);
    const slow = ns.get("d1").fetch("http://actor/slow");
    await until(() => env.log.includes("fetch:start"));
    await ns.pause();
    expect(env.log).toContain("fetch:end");
    expect(await (await slow).text()).toBe("ok");
    ns.resume();
  });

  it("holds alarms while paused, a resident actor's and an evicted one's, and fires them on resume", async () => {
    const env: Env = { log: [] };
    const dir = tempDir();
    const ns = host(dir, env);
    await ns.get("resident").fetch("http://actor/set-alarm?in=150");
    await ns.get("cold").fetch("http://actor/set-alarm?in=150");
    await ns.evictIdle(0);
    expect(ns.resident()).toEqual([]);
    await ns.get("resident").fetch("http://actor/get-alarm");

    await ns.pause();
    await sleep(300);
    expect(env.log.filter((l) => l === "alarm:end")).toHaveLength(0);

    ns.resume();
    await until(() => env.log.filter((l) => l === "alarm:end").length === 2);
    expect(env.log.filter((l) => l === "alarm:end")).toHaveLength(2);
    expect([...ns.resident()].sort()).toEqual(["cold", "resident"]);
  });
});

describe("eviction", () => {
  it("closes idle actors and reopens them from disk on the next request", async () => {
    const ns = host(tempDir(), { log: [] }, 5);
    await ns.get("idle").fetch("http://actor/put?key=k", { method: "POST", body: new Uint8Array([9]) });
    expect(ns.resident()).toEqual(["idle"]);
    await sleep(10);
    await ns.evictIdle();
    expect(ns.resident()).toEqual([]);
    expect(((await (await ns.get("idle").fetch("http://actor/get?key=k")).json()) as { bytes: number[] }).bytes).toEqual([9]);
  });

  it("keeps actors with open sockets resident", async () => {
    const ns = host(tempDir(), { log: [] }, 5);
    const res = await ns.get("live").fetch("http://actor/connect", { headers: { upgrade: "websocket" } });
    expect(isUpgradeResponse(res)).toBe(true);
    await sleep(10);
    await ns.evictIdle();
    expect(ns.resident()).toEqual(["live"]);
    serverSocketOf(res).close();
    await ns.evictIdle();
    expect(ns.resident()).toEqual([]);
  });
});

describe("interceptWebSocketMessage", () => {
  it("sees a frame before the lock, and a consumed frame never reaches the queue", async () => {
    const env: Env = { log: [] };
    const ns = host(tempDir(), env);
    const res = await ns.get("ws").fetch("http://actor/connect", { headers: { upgrade: "websocket" } });
    const server = serverSocketOf(res);
    const owner = server.owner!;

    const slow = owner.deliverMessage(server, "slow");
    await until(() => env.log.includes("message:slow:start"));
    // Intercepted, it runs while `slow` still holds the lock.
    await owner.deliverMessage(server, "cancel");
    expect(env.log).toEqual(["message:slow:start", "intercept:cancel"]);
    await slow;
    expect(env.log).toEqual(["message:slow:start", "intercept:cancel", "message:slow:end"]);

    // A declined frame takes the ordinary queued path.
    await owner.deliverMessage(server, "hello");
    expect(env.log.at(-1)).toBe("message:hello");
    expect(server.sentStrings).toEqual(["welcome", "echo:hello"]);
  });
});

describe("sockets", () => {
  it("accepts a socket with its session meta, and drops it once closed", async () => {
    const env: Env = { log: [] };
    const ns = host(tempDir(), env);
    const doc = ns.get("ws");
    const res = await doc.fetch("http://actor/connect?alias=liv", { headers: { upgrade: "websocket" } });
    expect(res.status).toBe(101);
    expect(isUpgradeResponse(res)).toBe(true);
    const server = serverSocketOf(res);
    expect(server.sentStrings).toEqual(["welcome"]);
    expect(server.meta).toEqual({ alias: "liv" });

    let counts = (await (await doc.fetch("http://actor/sockets")).json()) as { all: number; aliases: string[] };
    expect(counts).toMatchObject({ all: 1, aliases: ["liv"] });

    server.close(1000, "done");
    server.close(1000, "again"); // a second close is tolerated
    expect(server.closed).toEqual({ code: 1000, reason: "done" });
    expect(() => server.send("late")).toThrow();
    counts = (await (await doc.fetch("http://actor/sockets")).json()) as { all: number; aliases: string[] };
    expect(counts.all).toBe(0);
  });

  it("answers the namespace heartbeat on the socket without entering the actor", async () => {
    const env: Env = { log: [] };
    const ns = host(tempDir(), env);
    const res = await ns.get("hb").fetch("http://actor/connect", { headers: { upgrade: "websocket" } });
    const server = serverSocketOf(res);
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const sent: unknown[] = [];
    const fakeWs = {
      OPEN: 1,
      readyState: 1,
      send: (d: unknown) => sent.push(d),
      close: () => {},
      terminate: () => {},
      on: (event: string, fn: (...args: unknown[]) => void) => listeners.set(event, fn),
    };
    attachSocket(server, fakeWs as never);
    expect(sent).toEqual(["welcome"]);

    listeners.get("message")!(Buffer.from("ping"), false);
    expect(sent).toEqual(["welcome", "pong"]);
    listeners.get("message")!(Buffer.from("hello"), false);
    await until(() => env.log.includes("message:hello"));
    expect(env.log).toEqual(["message:hello"]);
  });

  it("refuses a socket that did not come from a SocketPair", async () => {
    let caught: unknown = null;
    class Bad implements Actor {
      constructor(readonly state: ActorState) {}
      async fetch(): Promise<Response> {
        try {
          this.state.acceptWebSocket({ send() {}, close() {}, meta: null }, null);
        } catch (e) {
          caught = e;
        }
        return new Response("x");
      }
    }
    const ns = createActorNamespace(Bad, {}, {
      name: "bad",
      dir: tempDir(),
      idleMs: Infinity,
      heartbeat: HEARTBEAT,
      storeVersion: 1,
    });
    namespaces.push(ns);
    await ns.get("b").fetch("http://actor/");
    expect(caught).toBeInstanceOf(TypeError);
  });
});

describe("store version", () => {
  it("stamps a new store with the namespace's version, and the stamp outlives deleteAll", async () => {
    const dir = tempDir();
    const ns = host(dir, { log: [] }, Infinity, { storeVersion: 3 });
    await ns.get("a").fetch("http://actor/count");
    expect(stampOf(dir, "a")).toBe(3);

    await ns.get("a").fetch("http://actor/delete-all");
    expect(stampOf(dir, "a")).toBe(3);
  });

  it("reopens a store it stamped", async () => {
    const dir = tempDir();
    const first = host(dir, { log: [] });
    expect(await (await first.get("a").fetch("http://actor/count")).text()).toBe("1");
    await first.close();

    const second = host(dir, { log: [] });
    expect(await (await second.get("a").fetch("http://actor/count")).text()).toBe("2");
  });

  it("refuses a store a newer build stamped, leaves it as it found it, and refuses again on the next request", async () => {
    const dir = tempDir();
    const newer = host(dir, { log: [] }, Infinity, { storeVersion: 2 });
    await newer.get("a").fetch("http://actor/count");
    await newer.close();

    const older = host(dir, { log: [] });
    // A rejection, not a throw: callers that only chain .catch() must still see it.
    const refused = older.get("a").fetch("http://actor/count");
    await expect(refused).rejects.toThrow(/store of test\/a is at version 2, but this build of Stuga only knows version 1/);
    await expect(older.get("a").fetch("http://actor/count")).rejects.toThrow(/NEWER version/);
    expect(older.resident()).toEqual([]);
    expect(stampOf(dir, "a")).toBe(2);

    // The refusal is one store's: its neighbours open.
    expect((await older.get("b").fetch("http://actor/count")).status).toBe(200);
    await older.close();

    const back = host(dir, { log: [] }, Infinity, { storeVersion: 2 });
    expect(await (await back.get("a").fetch("http://actor/count")).text()).toBe("2");
  });

  it("refuses an older store rather than restamping it, since no step brings one forward yet", async () => {
    const dir = tempDir();
    const v1 = host(dir, { log: [] });
    await v1.get("a").fetch("http://actor/count");
    await v1.close();

    const v2 = host(dir, { log: [] }, Infinity, { storeVersion: 2 });
    await expect(v2.get("a").fetch("http://actor/count")).rejects.toThrow(/no step that brings it to 2/);
    expect(stampOf(dir, "a")).toBe(1);
  });

  it("reports a pending alarm on a store it refuses instead of throwing out of the timer", async () => {
    const dir = tempDir();
    const newer = host(dir, { log: [] }, Infinity, { storeVersion: 2 });
    await newer.get("a").fetch("http://actor/set-alarm?in=30");
    await newer.close();

    const failures: Array<{ message: string; entry: string }> = [];
    const env: Env = { log: [] };
    host(dir, env, Infinity, {
      onError: (error, ctx) => failures.push({ message: String(error), entry: ctx.entry }),
    });
    await until(() => failures.length > 0);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.entry).toBe("alarm");
    expect(failures[0]?.message).toMatch(/only knows version 1/);
    expect(env.log).toEqual([]);
  });

  it("takes only a whole number from 1", () => {
    for (const storeVersion of [0, -1, 1.5, Number.NaN]) {
      expect(() =>
        createActorNamespace(TestActor, { log: [] }, { name: "test", dir: tempDir(), heartbeat: HEARTBEAT, storeVersion }),
      ).toThrow(/storeVersion must be a whole number from 1/);
    }
  });
});
