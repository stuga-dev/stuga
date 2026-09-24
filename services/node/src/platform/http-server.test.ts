import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  createActorNamespace,
  SocketPair,
  upgradeResponse,
  type Actor,
  type ActorSocket,
  type ActorState,
  type HostedNamespace,
} from "@stuga/runtime";
import { clientAddress, createHttpServer, type HttpServer, PEER_ADDRESS_HEADER, REQUEST_HOST_HEADER } from "./http-server.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Wait until `check` holds, for at most `ms`: what it waits for arrives asynchronously, later on a slow machine. */
const until = async (check: () => boolean, ms = 2000): Promise<void> => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await sleep(10);
};
const PUBLIC = "https://node.example";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function serve(opts: Partial<Parameters<typeof createHttpServer>[0]> & { handler: (req: Request) => Promise<Response> }) {
  const server: HttpServer = createHttpServer({
    upgrade: async () => new Response("no upgrade here", { status: 404 }),
    publicOrigin: PUBLIC,
    port: 0,
    maxBodyBytes: () => 64,
    onError: () => {},
    ...opts,
  });
  const { port } = await server.listen();
  cleanups.push(() => server.close());
  return { server, port, base: `http://127.0.0.1:${port}` };
}

/** A raw request so headers the Fetch client would normalise (Host) reach the wire as written. */
function raw(
  port: number,
  options: http.RequestOptions & { body?: Buffer | string; chunked?: boolean; onChunk?: (text: string) => void },
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  firstChunkAt: number;
  endAt: number;
  chunkCount: number;
}> {
  const { onChunk, ...requestOptions } = options;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, ...requestOptions }, (res) => {
      const chunks: Buffer[] = [];
      let firstChunkAt = 0;
      res.on("data", (c: Buffer) => {
        firstChunkAt ||= Date.now();
        chunks.push(c);
        onChunk?.(c.toString());
      });
      res.on("end", () =>
        resolve({
          status: res.statusCode!,
          headers: res.headers,
          text: Buffer.concat(chunks).toString(),
          firstChunkAt,
          endAt: Date.now(),
          chunkCount: chunks.length,
        }),
      );
      res.on("error", reject);
    });
    req.on("error", reject);
    if (options.body !== undefined) {
      if (options.chunked) {
        req.write(options.body);
        req.end();
      } else req.end(options.body);
    } else req.end();
  });
}

describe("clientAddress", () => {
  const request = (headers: Record<string, string>) => new Request("https://node.example/auth/login", { headers });

  it("is the stamped peer unless the operator trusts a proxy", () => {
    const req = request({ [PEER_ADDRESS_HEADER]: "10.0.0.7", "x-forwarded-for": "203.0.113.9", "x-real-ip": "203.0.113.9" });
    expect(clientAddress(req, false)).toBe("10.0.0.7");
    expect(clientAddress(request({}), false)).toBe("unknown");
  });

  it("behind a trusted proxy, is the last X-Forwarded-For entry, which the proxy appended", () => {
    expect(clientAddress(request({ "x-forwarded-for": "198.51.100.77, 203.0.113.9", [PEER_ADDRESS_HEADER]: "10.0.0.7" }), true)).toBe(
      "203.0.113.9",
    );
    expect(clientAddress(request({ "x-forwarded-for": "203.0.113.9 ,  " }), true)).toBe("203.0.113.9");
  });

  it("falls back to X-Real-IP, then the peer, when no proxy header names an address", () => {
    expect(clientAddress(request({ "x-real-ip": "203.0.113.9", [PEER_ADDRESS_HEADER]: "10.0.0.7" }), true)).toBe("203.0.113.9");
    expect(clientAddress(request({ "x-forwarded-for": " , ", [PEER_ADDRESS_HEADER]: "10.0.0.7" }), true)).toBe("10.0.0.7");
  });
});

describe("createHttpServer", () => {
  it("stamps the address the connection came from, and refuses to relay a claimed one", async () => {
    const { port } = await serve({
      handler: async (req) => Response.json({ peer: req.headers.get(PEER_ADDRESS_HEADER) }),
    });
    const res = await raw(port, { path: "/", headers: { [PEER_ADDRESS_HEADER]: "203.0.113.9" } });
    const { peer } = JSON.parse(res.text) as { peer: string };
    expect(peer).not.toBe("203.0.113.9");
    expect(peer).toMatch(/^(::ffff:)?127\.0\.0\.1$|^::1$/);
  });

  it("stamps the Host the client sent, and refuses to relay a claimed one", async () => {
    const { port } = await serve({
      handler: async (req) => Response.json({ host: req.headers.get(REQUEST_HOST_HEADER) }),
    });
    const res = await raw(port, { path: "/", headers: { host: "192.168.1.50:8787", [REQUEST_HOST_HEADER]: "forged.example" } });
    expect(JSON.parse(res.text)).toEqual({ host: "192.168.1.50:8787" });
  });

  it("rebuilds the URL on the public origin, never the Host header", async () => {
    const { port } = await serve({
      handler: async (req) =>
        Response.json({ url: req.url, host: req.headers.get("host"), method: req.method, body: await req.text() }),
    });
    const res = await raw(port, { method: "POST", path: "/api/docs?x=1&y=%20", headers: { host: "evil.example", "content-type": "text/plain" }, body: "hi" });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toEqual({ url: `${PUBLIC}/api/docs?x=1&y=%20`, host: "evil.example", method: "POST", body: "hi" });
  });

  it("answers 413 past maxBodyBytes, declared or streamed", async () => {
    let calls = 0;
    const { port } = await serve({
      handler: async () => {
        calls += 1;
        return new Response("ok");
      },
    });
    const big = Buffer.alloc(65, 120);
    expect((await raw(port, { method: "POST", path: "/", body: big })).status).toBe(413);
    expect((await raw(port, { method: "POST", path: "/", body: big, chunked: true, headers: { "transfer-encoding": "chunked" } })).status).toBe(413);
    expect((await raw(port, { method: "POST", path: "/", body: Buffer.alloc(64, 120) })).status).toBe(200);
    expect(calls).toBe(1);
  });

  it("streams response bodies as they are produced", async () => {
    const encoder = new TextEncoder();
    let sawFirst!: () => void;
    const firstReachedClient = new Promise<void>((resolve) => {
      sawFirst = resolve;
    });

    const { port } = await serve({
      handler: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async start(controller) {
              controller.enqueue(encoder.encode("event: a\ndata: 1\n\n"));
              // Waiting on the client, not a sleep: a buffering server then hangs instead of passing by luck.
              await firstReachedClient;
              controller.enqueue(encoder.encode("event: b\ndata: 2\n\n"));
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    });

    const res = await raw(port, {
      path: "/events",
      onChunk: (text) => {
        if (text.includes("data: 1")) sawFirst();
      },
    });
    expect(res.headers["content-type"]).toBe("text/event-stream");
    expect(res.text).toBe("event: a\ndata: 1\n\nevent: b\ndata: 2\n\n");
    // The second chunk is written only after the first arrived, so a buffered response cannot pass.
    expect(res.chunkCount).toBeGreaterThanOrEqual(2);
  });

  it("cancels the body when the client disconnects, writes every set-cookie, and 500s a throwing handler", async () => {
    let cancelled = false;
    const { port, base } = await serve({
      handler: async (req) => {
        const path = new URL(req.url).pathname;
        if (path === "/throw") throw new Error("nope");
        if (path === "/cookies") {
          const h = new Headers();
          h.append("set-cookie", "a=1; Path=/");
          h.append("set-cookie", "b=2; Path=/");
          return new Response("c", { headers: h });
        }
        return new Response(
          new ReadableStream({
            pull: async () => {
              await sleep(20);
            },
            cancel: () => {
              cancelled = true;
            },
          }),
        );
      },
    });
    expect((await raw(port, { path: "/throw" })).status).toBe(500);
    expect((await raw(port, { path: "/cookies" })).headers["set-cookie"]).toEqual(["a=1; Path=/", "b=2; Path=/"]);
    const controller = new AbortController();
    const pending = fetch(`${base}/stream`, { signal: controller.signal }).then((r) => r.body?.getReader().read());
    await sleep(50);
    controller.abort();
    await pending.catch(() => {});
    await until(() => cancelled);
    expect(cancelled).toBe(true);
  });
});

/** Echoes text, reverses binary, answers "ping" without waking up, closes on request. */
class EchoActor implements Actor {
  static closes: Array<{ code: number; reason: string }> = [];
  static messages: string[] = [];
  constructor(readonly state: ActorState) {}
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/connect" && req.headers.get("upgrade") === "websocket") {
      const pair = new SocketPair();
      this.state.acceptWebSocket(pair.server, null);
      pair.server.send(`hello ${url.searchParams.get("alias")}`);
      pair.server.send(new Uint8Array([0, 1]));
      return upgradeResponse(pair.client);
    }
    if (url.pathname === "/close-all") {
      for (const ws of this.state.getWebSockets()) ws.close(4001, "server says bye");
      return new Response("ok");
    }
    return new Response("nope", { status: 404 });
  }
  async webSocketMessage(ws: ActorSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message === "string") {
      EchoActor.messages.push(message);
      ws.send(`echo:${message}`);
    } else ws.send(new Uint8Array(message).reverse());
  }
  async webSocketClose(_ws: ActorSocket, code: number, reason: string): Promise<void> {
    EchoActor.closes.push({ code, reason });
  }
}

/** A client whose frames are queued from the moment it opens, so a frame that
 *  rides in the same segment as the 101 is not lost before the test reads it. */
interface Client {
  ws: WebSocket;
  next(): Promise<string | Buffer>;
}

function connect(url: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const frames: Array<string | Buffer> = [];
    const waiters: Array<(f: string | Buffer) => void> = [];
    ws.on("message", (data, isBinary) => {
      const frame = isBinary ? (data as Buffer) : data.toString();
      const waiter = waiters.shift();
      if (waiter) waiter(frame);
      else frames.push(frame);
    });
    ws.once("open", () =>
      resolve({
        ws,
        next: () => {
          const queued = frames.shift();
          return queued !== undefined ? Promise.resolve(queued) : new Promise((r) => waiters.push(r));
        },
      }),
    );
    ws.once("error", reject);
  });
}

describe("websocket upgrade", () => {
  it("completes the handshake and bridges frames to the actor both ways", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stuga-http-actors-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const ns: HostedNamespace = createActorNamespace(EchoActor, {}, {
      name: "echo",
      dir,
      idleMs: Infinity,
      heartbeat: { request: "ping", response: "pong" },
      storeVersion: 1,
    });
    cleanups.push(() => ns.close());
    EchoActor.closes = [];
    EchoActor.messages = [];

    const { port, base } = await serve({
      handler: async () => new Response("plain"),
      upgrade: async (req) => {
        const url = new URL(req.url);
        expect(url.origin).toBe(PUBLIC);
        if (url.pathname === "/denied") return new Response("forbidden", { status: 403 });
        return ns.get(url.searchParams.get("doc") ?? "d").fetch(req);
      },
    });

    // A refused upgrade comes back as a normal HTTP error and the socket is dropped.
    await expect(connect(`ws://127.0.0.1:${port}/denied`)).rejects.toThrow(/403/);

    const { ws, next } = await connect(`ws://127.0.0.1:${port}/connect?doc=d1&alias=liv`);
    cleanups.push(() => ws.terminate());
    expect(await next()).toBe("hello liv"); // sent before the transport existed
    expect(await next()).toEqual(Buffer.from([0, 1]));

    ws.send("ping");
    expect(await next()).toBe("pong");
    ws.send("one");
    expect(await next()).toBe("echo:one");
    ws.send(new Uint8Array([1, 2, 3]));
    expect(await next()).toEqual(Buffer.from([3, 2, 1]));
    expect(EchoActor.messages).toEqual(["one"]); // the ping never reached the actor

    // Server-initiated close reaches the client with the actor's code.
    const closed = new Promise<{ code: number; reason: string }>((resolve) =>
      ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() })),
    );
    expect(await (await fetch(`${base}/close-all`)).text()).toBe("plain"); // plain requests are unaffected by the upgrade path
    const res = await ns.get("d1").fetch("http://actor/close-all");
    expect(res.status).toBe(200);
    expect(await closed).toEqual({ code: 4001, reason: "server says bye" });
    await until(() => EchoActor.closes.length > 0); // the actor hears of the close through its own queue
    expect(EchoActor.closes).toEqual([{ code: 4001, reason: "server says bye" }]);

    // Client-initiated close reaches the actor.
    const second = await connect(`ws://127.0.0.1:${port}/connect?doc=d1&alias=b`);
    await second.next();
    await second.next();
    second.ws.close(4002, "client done");
    await until(() => EchoActor.closes.length > 1);
    expect(EchoActor.closes[1]).toEqual({ code: 4002, reason: "client done" });
  });
});
