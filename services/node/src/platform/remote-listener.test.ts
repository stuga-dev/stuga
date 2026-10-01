import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { X509Certificate } from "node:crypto";
import type tls from "node:tls";
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
import { arrivalOf, servedOrigin } from "../http/arrival.js";
import { applyRemoteHeaders, withRemoteHeaders, withSecurityHeaders } from "../http/security-headers.js";
import { createServingGate } from "../http/serving-gate.js";
import { makeTestCert, type TestCert } from "../testing/cert.js";
import { RemoteDirError } from "../remote/files.js";
import { closed, connectRemote, dialRemote, proxyV2Header, remoteRequest } from "../testing/remote.js";
import { clientAddress, PEER_ADDRESS_HEADER, REQUEST_HOST_HEADER, type RequestHandler } from "./http-server.js";
import { createRemoteListener, type RemoteListener, type RemoteListenerOptions } from "./remote-listener.js";

const HOST = "k7f3q2.stuga.test";
const ORIGIN = `https://${HOST}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

interface Served {
  listener: RemoteListener;
  socketPath: string;
  cert: TestCert;
  /** A handshake that trusts this listener's certificate and checks its name. */
  dial(opts?: { source?: string; servername?: string; ca?: string }): Promise<tls.TLSSocket>;
  /** One request on a fresh connection. */
  get(path?: string, opts?: { headers?: Record<string, string>; source?: string; method?: string; body?: string }): ReturnType<typeof remoteRequest>;
}

async function serve(opts: Partial<RemoteListenerOptions> & { handler?: RequestHandler } = {}): Promise<Served> {
  const dir = mkdtempSync(join(tmpdir(), "stuga-remote-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const socketPath = join(dir, "https.sock");
  const cert = makeTestCert({ dnsNames: [HOST] });
  const handler = opts.handler ?? (async () => new Response("ok"));
  const listener = createRemoteListener({
    socketPath,
    hostname: HOST,
    maxBodyBytes: () => 64,
    readsOwnBody: () => false,
    decorate: applyRemoteHeaders,
    onError: () => {},
    ...opts,
    handler: withRemoteHeaders(withSecurityHeaders(handler)),
    upgrade: opts.upgrade ?? withRemoteHeaders(withSecurityHeaders(async () => new Response("no upgrade here", { status: 404 }))),
  });
  listener.setCertificate(cert);
  await listener.listen();
  cleanups.push(() => listener.close());
  const dial: Served["dial"] = async (d = {}) => {
    const socket = await dialRemote(socketPath, { servername: HOST, ca: cert.cert, ...d });
    cleanups.push(() => void socket.destroy());
    return socket;
  };
  return {
    listener,
    socketPath,
    cert,
    dial,
    get: async (path = "/", o = {}) =>
      remoteRequest(await dial(o.source ? { source: o.source } : {}), {
        path,
        ...(o.method ? { method: o.method } : {}),
        ...(o.body !== undefined ? { body: o.body } : {}),
        ...(o.headers ? { headers: o.headers } : {}),
      }),
  };
}

const fingerprint = (socket: tls.TLSSocket): string => socket.getPeerX509Certificate()!.fingerprint256;

describe("the remote listener", () => {
  it("terminates TLS for its hostname over the unix socket, with the node's own certificate", async () => {
    const { dial, cert } = await serve();
    const socket = await dial();
    expect(fingerprint(socket)).toBe(new X509Certificate(cert.cert).fingerprint256);
    expect(socket.alpnProtocol).toBe("http/1.1");
    const res = await remoteRequest(socket, { path: "/" });
    expect(res).toMatchObject({ status: 200, text: "ok" });
  });

  it("answers any spelling of its hostname: case, :443, a trailing dot", async () => {
    const { dial, get } = await serve();
    expect((await remoteRequest(await dial({ servername: "K7F3Q2.Stuga.Test" }), {})).status).toBe(200);
    for (const host of [`${HOST.toUpperCase()}:443`, `${HOST}.`, HOST]) expect((await get("/", { headers: { host } })).status).toBe(200);
  });

  it("fails the handshake for another name, or none", async () => {
    const { socketPath, cert } = await serve();
    await expect(dialRemote(socketPath, { servername: "other.stuga.test" })).rejects.toThrow();
    await expect(dialRemote(socketPath, { servername: "" })).rejects.toThrow();
    // The certificate is sound: the name is what failed.
    expect((await dialRemote(socketPath, { servername: HOST, ca: cert.cert })).authorized).toBe(true);
  });

  it("drops a connection whose PROXY header does not come in time, or is not one", async () => {
    const { socketPath } = await serve({ limits: { proxyHeaderMs: 200 } });
    const silent = await connectRemote(socketPath, null);
    const started = Date.now();
    await closed(silent);
    expect(Date.now() - started).toBeLessThan(5000);

    const v1 = await connectRemote(socketPath, Buffer.from("PROXY TCP4 203.0.113.7 192.0.2.1 5555 443\r\n"));
    await closed(v1);
    const local = proxyV2Header("203.0.113.7");
    local[12] = 0x20;
    await closed(await connectRemote(socketPath, local));
  });

  it("answers 421 to a Host that is not its own, for a request and an upgrade alike", async () => {
    const { get, dial } = await serve();
    const res = await get("/", { headers: { host: "livs-air.local:8787" } });
    expect(res.status).toBe(421);
    expect((await get("/", { headers: { host: `evil.${HOST}` } })).status).toBe(421);
    const socket = await dial();
    const answer = new Promise<string>((resolve) => {
      let text = "";
      socket.on("data", (d: Buffer) => (text += d.toString()));
      socket.once("close", () => resolve(text));
    });
    socket.write(
      "GET /ws/d1 HTTP/1.1\r\nHost: evil.example\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n" +
        "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
    );
    expect(await answer).toMatch(/^HTTP\/1\.1 421/);
  });

  it("stamps the PROXY source as the peer, and ignores what the visitor claims about itself", async () => {
    const { get } = await serve({
      handler: async (req) =>
        Response.json({
          url: req.url,
          arrival: arrivalOf(req),
          served: servedOrigin(req),
          peer: req.headers.get(PEER_ADDRESS_HEADER),
          address: clientAddress(req, true),
          host: req.headers.get(REQUEST_HOST_HEADER),
        }),
    });
    const res = await get("/api/x?y=1", {
      source: "198.51.100.23",
      headers: {
        "x-stuga-arrival": "local",
        "x-stuga-peer": "10.0.0.7",
        "x-forwarded-for": "10.0.0.8",
        "x-real-ip": "10.0.0.9",
        "x-stuga-host": "livs-air.local",
      },
    });
    expect(JSON.parse(res.text)).toEqual({
      url: `${ORIGIN}/api/x?y=1`,
      arrival: "remote",
      served: ORIGIN,
      peer: "198.51.100.23",
      address: "198.51.100.23",
      host: HOST,
    });
  });

  it("sends HSTS on every answer, a failure included", async () => {
    const { get } = await serve({
      handler: async (req) => {
        if (new URL(req.url).pathname === "/throw") throw new Error("nope");
        return new Response("missing", { status: 404 });
      },
    });
    const res = await get("/nope");
    expect(res.status).toBe(404);
    expect(res.headers["strict-transport-security"]).toBe("max-age=31536000");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    // Answers the listener makes itself, which never reach the handler's wrappers.
    const failed = await get("/throw");
    const misdirected = await get("/", { headers: { host: "livs-air.local:8787" } });
    const tooLarge = await get("/", { method: "POST", body: "x".repeat(65) });
    expect([failed.status, misdirected.status, tooLarge.status]).toEqual([500, 421, 413]);
    for (const answer of [failed, misdirected, tooLarge]) {
      expect(answer.headers["strict-transport-security"]).toBe("max-age=31536000");
      expect(answer.headers["x-content-type-options"]).toBe("nosniff");
    }
  });

  it("holds a body the listener reads to maxBodyBytes", async () => {
    const { get } = await serve({ handler: async (req) => new Response(String((await req.arrayBuffer()).byteLength)) });
    expect(await get("/", { method: "POST", body: "x".repeat(64) })).toMatchObject({ status: 200, text: "64" });
    expect((await get("/", { method: "POST", body: "x".repeat(65) })).status).toBe(413);
  });

  it("hands new handshakes a new certificate, and leaves open connections alone", async () => {
    const served = await serve();
    const before = await served.dial();
    const next = makeTestCert({ dnsNames: [HOST] });
    served.listener.setCertificate(next);
    const after = await served.dial({ ca: next.cert });
    expect(fingerprint(after)).toBe(new X509Certificate(next.cert).fingerprint256);
    expect(fingerprint(before)).toBe(new X509Certificate(served.cert.cert).fingerprint256);
    expect((await remoteRequest(before, {})).status).toBe(200);
    expect((await remoteRequest(after, {})).status).toBe(200);
  });

  it("drops the 33rd connection from one source before TLS, an IPv6 source counted by its /64", async () => {
    const { socketPath, dial } = await serve();
    for (let i = 0; i < 32; i++) await dial({ source: `2001:db8:5:17::${i + 1}` });
    await expect(dialRemote(socketPath, { servername: HOST, source: "2001:db8:5:17:ffff::1" })).rejects.toThrow();
    // Another /64, and an IPv4 source, are each their own.
    await dial({ source: "2001:db8:5:18::1" });
    await dial({ source: "203.0.113.7" });
  });

  it("frees a source's place when its connection closes", async () => {
    const { socketPath, dial } = await serve({ limits: { perSource: 2 } });
    const first = await dial();
    await dial();
    await expect(dialRemote(socketPath, { servername: HOST })).rejects.toThrow();
    first.destroy();
    // The listener hears of the close a moment later.
    const deadline = Date.now() + 2000;
    for (;;) {
      try {
        await dial();
        break;
      } catch (e) {
        if (Date.now() > deadline) throw e;
        await sleep(20);
      }
    }
  });

  it("drops connections past maxConnections as they arrive", async () => {
    const { socketPath, dial } = await serve({ limits: { maxConnections: 2 } });
    await dial({ source: "203.0.113.1" });
    await connectRemote(socketPath, null);
    const third = await connectRemote(socketPath, null);
    await closed(third);
  });

  it("drops a connection whose request headers are not in within headersMs", async () => {
    const { dial } = await serve({ limits: { headersMs: 500 } });
    const socket = await dial();
    const started = Date.now();
    socket.write(`GET / HTTP/1.1\r\nHost: ${HOST}\r\nx-slow: `);
    let answer = "";
    socket.on("data", (d: Buffer) => (answer += d.toString()));
    await closed(socket);
    // headersMs, plus up to the one-second sweep that finds it.
    expect(Date.now() - started).toBeLessThan(3000);
    expect(answer).toMatch(/^HTTP\/1\.1 408 Request Timeout\r\n/);
    expect(answer).toContain("strict-transport-security: max-age=31536000\r\n");
  });

  it("answers 408 to a body it reads itself that takes longer than bodyMs", async () => {
    const { dial } = await serve({ limits: { bodyMs: 300 }, handler: async (req) => new Response(await req.text()) });
    const socket = await dial();
    const answered = new Promise<string>((resolve) => {
      let text = "";
      socket.on("data", (d: Buffer) => (text += d.toString()));
      socket.once("close", () => resolve(text));
    });
    socket.write(`POST / HTTP/1.1\r\nHost: ${HOST}\r\ncontent-length: 10\r\n\r\nabc`);
    const text = await answered;
    expect(text).toMatch(/^HTTP\/1\.1 408/);
    expect(text).toMatch(/\r\nstrict-transport-security: max-age=31536000\r\n/);
  });

  describe("its front door", () => {
    /** Writes a request's head and `body`, and resolves with whatever comes back once the connection closes. */
    async function raw(dial: Served["dial"], head: string, body = "", source?: string): Promise<{ socket: tls.TLSSocket; answer: Promise<string> }> {
      const socket = await dial(source ? { source } : {});
      const answer = new Promise<string>((resolve) => {
        let text = "";
        socket.on("data", (d: Buffer) => (text += d.toString()));
        socket.once("close", () => resolve(text));
      });
      socket.write(`${head}\r\n\r\n${body}`);
      return { socket, answer };
    }

    it("refuses before reading a byte of the body, and closes the connection", async () => {
      let handled = 0;
      const seen: Request[] = [];
      const { dial } = await serve({
        maxBodyBytes: () => 64 << 20,
        handler: async () => {
          handled++;
          return new Response("ok");
        },
        frontDoor: async (head) => {
          seen.push(head);
          return new Response("sign in first", { status: 401 });
        },
      });
      // Ten megabytes promised, none sent: the answer comes anyway, at once.
      const started = Date.now();
      const { answer } = await raw(dial, `POST /api/docs HTTP/1.1\r\nHost: ${HOST}\r\ncontent-length: 10485760`);
      expect(await answer).toMatch(/^HTTP\/1\.1 401 /);
      expect(Date.now() - started).toBeLessThan(3000);
      expect(handled).toBe(0);
      // It saw the request as the handler would, but for the body.
      expect(arrivalOf(seen[0]!)).toBe("remote");
      expect(seen[0]!.headers.get(PEER_ADDRESS_HEADER)).toBe("203.0.113.7");
      expect(seen[0]!.body).toBeNull();
    });

    it("holds a body to the cap it sets, below the listener's own", async () => {
      const { get } = await serve({
        maxBodyBytes: () => 1 << 20,
        handler: async (req) => new Response(await req.text()),
        frontDoor: async () => ({ maxBytes: 16, anonymous: true }),
      });
      expect(await get("/auth/login", { method: "POST", body: "x".repeat(16) })).toMatchObject({ status: 200, text: "x".repeat(16) });
      expect((await get("/auth/login", { method: "POST", body: "x".repeat(17) })).status).toBe(413);
    });

    it("lets anonymous bodies take only so much at once, and says when to try again", async () => {
      let admitted = 0;
      const { dial, get } = await serve({
        maxBodyBytes: () => 1 << 20,
        handler: async (req) => new Response(await req.text()),
        frontDoor: async (head) => {
          admitted++;
          return head.headers.has("authorization") ? {} : { maxBytes: 16, anonymous: true };
        },
        limits: { anonymousBodyBudget: 8 },
      });
      // Two sign-ins hold their bodies back, reserving the 4 bytes each said it would send.
      const slow = [
        await raw(dial, `POST /auth/login HTTP/1.1\r\nHost: ${HOST}\r\nconnection: close\r\ncontent-length: 4`, "ab"),
        await raw(dial, `POST /auth/login HTTP/1.1\r\nHost: ${HOST}\r\nconnection: close\r\ncontent-length: 4`, "ab"),
      ];
      while (admitted < 2) await sleep(10);
      const busy = await get("/auth/login", { method: "POST", body: "abcd" });
      expect(busy.status).toBe(503);
      expect(busy.headers["retry-after"]).toBe("5");
      // A signed-in request is not counted against it.
      expect((await get("/api/docs", { method: "POST", body: "abcd", headers: { authorization: "Bearer t" } })).status).toBe(200);
      // Once a body is in, its place is free again.
      slow[0]!.socket.write("cd");
      expect(await slow[0]!.answer).toMatch(/^HTTP\/1\.1 200 /);
      expect((await get("/auth/login", { method: "POST", body: "abcd" })).status).toBe(200);
      slow[1]!.socket.destroy();
    });

    it("reserves what a body declares, not its cap, and refuses an anonymous body that declares no length", async () => {
      const { get, dial } = await serve({
        maxBodyBytes: () => 1 << 20,
        handler: async (req) => new Response(await req.text()),
        frontDoor: async () => ({ maxBytes: 16, anonymous: true }),
        limits: { anonymousBodyBudget: 16 },
      });
      // A slow one of 4 bytes leaves room for another under a 16-byte budget.
      const slow = await raw(dial, `POST /auth/login HTTP/1.1\r\nHost: ${HOST}\r\nconnection: close\r\ncontent-length: 4`, "ab");
      await sleep(50);
      expect((await get("/auth/login", { method: "POST", body: "abcd" })).status).toBe(200);
      slow.socket.destroy();
      const chunked = await raw(dial, `POST /auth/login HTTP/1.1\r\nHost: ${HOST}\r\ntransfer-encoding: chunked`, "4\r\nabcd\r\n0\r\n\r\n");
      expect(await chunked.answer).toMatch(/^HTTP\/1\.1 411 /);
    });

    it("lets one source hold only its share of the anonymous budget", async () => {
      let admitted = 0;
      const { dial, get } = await serve({
        maxBodyBytes: () => 1 << 20,
        handler: async (req) => new Response(await req.text()),
        frontDoor: async () => (admitted++, { maxBytes: 16, anonymous: true }),
        limits: { anonymousPerSource: 2 },
      });
      const held = [
        await raw(dial, `POST /auth/login HTTP/1.1\r\nHost: ${HOST}\r\nconnection: close\r\ncontent-length: 4`, "ab", "2001:db8:9:1::1"),
        await raw(dial, `POST /auth/login HTTP/1.1\r\nHost: ${HOST}\r\nconnection: close\r\ncontent-length: 4`, "ab", "2001:db8:9:1::2"),
      ];
      while (admitted < 2) await sleep(10);
      // The same /64 waits; anyone else does not.
      expect((await get("/auth/login", { method: "POST", body: "abcd", source: "2001:db8:9:1::3" })).status).toBe(503);
      expect((await get("/auth/login", { method: "POST", body: "abcd", source: "2001:db8:9:2::1" })).status).toBe(200);
      for (const h of held) h.socket.destroy();
    });

    it("gives an anonymous body less time than a signed-in one", async () => {
      const { dial } = await serve({
        maxBodyBytes: () => 1 << 20,
        handler: async (req) => new Response(await req.text()),
        frontDoor: async () => ({ maxBytes: 16, anonymous: true }),
        limits: { bodyMs: 60_000, anonymousBodyMs: 300 },
      });
      const started = Date.now();
      const { answer } = await raw(dial, `POST /auth/login HTTP/1.1\r\nHost: ${HOST}\r\ncontent-length: 10`, "abc");
      expect(await answer).toMatch(/^HTTP\/1\.1 408 /);
      expect(Date.now() - started).toBeLessThan(3000);
    });

    it("lets a bodyless request through as it is", async () => {
      const { get } = await serve({ frontDoor: async () => ({}) });
      expect(await get("/")).toMatchObject({ status: 200, text: "ok" });
    });
  });

  describe("a body its handler reads as a stream", () => {
    const upload = { readsOwnBody: (method: string) => method === "PUT", maxBodyBytes: () => 64 };
    const counting: RequestHandler = async (req) => {
      let n = 0;
      for await (const chunk of req.body as unknown as AsyncIterable<Uint8Array>) n += chunk.byteLength;
      return new Response(String(n), { headers: { "content-length": String(String(n).length) } });
    };

    it("may take longer than bodyMs while it keeps arriving", async () => {
      const { dial } = await serve({ ...upload, handler: counting, limits: { bodyMs: 200, bodyIdleMs: 1000 } });
      const socket = await dial();
      const pending = remoteRequestStreaming(socket, "PUT", async (write) => {
        for (let i = 0; i < 10; i++) {
          write("x".repeat(100));
          await sleep(100);
        }
      });
      expect(await pending).toMatchObject({ status: 200, text: "1000" });
    });

    it("is cut off once it pauses past bodyIdleMs", async () => {
      const { dial } = await serve({ ...upload, handler: counting, limits: { bodyMs: 200, bodyIdleMs: 300 } });
      const socket = await dial();
      const started = Date.now();
      const pending = remoteRequestStreaming(socket, "PUT", async (write) => {
        write("x".repeat(100));
        await sleep(1500);
        write("x".repeat(100));
      });
      await expect(pending).rejects.toThrow(/closed before an answer/);
      // Cut off during the pause, not at its end.
      expect(Date.now() - started).toBeLessThan(1200);
    });
  });

  it("finishes a request that takes 30 seconds to start answering: no socket idle timeout", async () => {
    const { get } = await serve({
      handler: async () => {
        await sleep(30_000);
        return new Response("late");
      },
    });
    expect(await get("/")).toMatchObject({ status: 200, text: "late" });
  }, 45_000);

  it("upgrades a WebSocket and carries frames both ways", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stuga-remote-actors-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const ns: HostedNamespace = createActorNamespace(EchoActor, {}, {
      name: "echo",
      dir,
      idleMs: Infinity,
      heartbeat: { request: "ping", response: "pong" },
      storeVersion: 1,
    });
    cleanups.push(() => ns.close());
    const { dial } = await serve({
      upgrade: withRemoteHeaders(async (req) => {
        expect(servedOrigin(req)).toBe(ORIGIN);
        return ns.get("d1").fetch(req);
      }),
    });
    const socket = await dial();
    const ws = new WebSocket(`${ORIGIN.replace("https", "wss")}/connect`, { createConnection: () => socket });
    cleanups.push(() => ws.terminate());
    const frames: string[] = [];
    ws.on("message", (data) => frames.push(data.toString()));
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    ws.send("one");
    const deadline = Date.now() + 2000;
    while (frames.length < 2 && Date.now() < deadline) await sleep(10);
    expect(frames).toEqual(["hello", "echo:one"]);
  });

  it("gives its socket the group asked for, where the connector is kept apart by one", async () => {
    const gid = process.getgroups!().find((g) => g !== process.getgid!()) ?? process.getgid!();
    const served = await serve({ gid });
    expect(statSync(served.socketPath).gid).toBe(gid);
    expect(statSync(served.socketPath).mode & 0o777).toBe(0o660);
  });

  it("removes its socket file on close, replaces a stale one, and will not take a path that is not a socket", async () => {
    const served = await serve();
    expect(statSync(served.socketPath).isSocket()).toBe(true);
    expect(statSync(served.socketPath).mode & 0o777).toBe(0o660);
    await served.listener.close();
    expect(existsSync(served.socketPath)).toBe(false);

    // A socket file a crashed run left behind.
    const again = createRemoteListener({
      socketPath: served.socketPath,
      hostname: HOST,
      handler: async () => new Response("again"),
      upgrade: async () => new Response(null, { status: 404 }),
      decorate: applyRemoteHeaders,
      maxBodyBytes: () => 64,
      readsOwnBody: () => false,
    });
    again.setCertificate(served.cert);
    await again.listen();
    cleanups.push(() => again.close());
    await again.close();
    // listen() once more after a close.
    await again.listen();
    expect((await remoteRequest(await dialRemote(served.socketPath, { servername: HOST }), {})).text).toBe("again");
    await again.close();

    writeFileSync(served.socketPath, "not a socket");
    await expect(again.listen()).rejects.toBeInstanceOf(RemoteDirError);
    expect(existsSync(served.socketPath)).toBe(true);
  });

  it("will not listen without a certificate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stuga-remote-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const bare = createRemoteListener({
      socketPath: join(dir, "https.sock"),
      hostname: HOST,
      handler: async () => new Response(null),
      upgrade: async () => new Response(null),
      decorate: applyRemoteHeaders,
      maxBodyBytes: () => 64,
      readsOwnBody: () => false,
    });
    await expect(bare.listen()).rejects.toThrow(/certificate/);
  });
});

describe("the remote listener behind the serving gate", () => {
  it("answers the maintenance page, with HSTS, while the node backs up", async () => {
    const gate = createServingGate();
    gate.open({ handler: async () => new Response("live"), upgrade: async () => new Response(null, { status: 404 }) });
    const { get } = await serve({ handler: gate.handler, upgrade: withRemoteHeaders(withSecurityHeaders(gate.upgrade)) });
    expect((await get("/")).text).toBe("live");
    gate.pause("maintenance");
    const res = await get("/", { headers: { accept: "text/html" } });
    expect(res.status).toBe(503);
    expect(res.text).toContain("Stuga is making a backup.");
    expect(res.headers["strict-transport-security"]).toBe("max-age=31536000");
  });

  it("lets a drain wait for a request at the remote address to finish", async () => {
    const gate = createServingGate();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let entered = false;
    gate.open({
      handler: async () => {
        entered = true;
        await held;
        return new Response("done");
      },
      upgrade: async () => new Response(null, { status: 404 }),
    });
    const { get } = await serve({ handler: gate.handler });
    const pending = get("/");
    while (!entered) await sleep(5);
    gate.pause("maintenance");
    expect(await gate.drain(100)).toBe(false);
    const drained = gate.drain(5000);
    release();
    expect(await drained).toBe(true);
    expect((await pending).text).toBe("done");
  });
});

/** A request whose body `send` writes over time, chunked; resolves with the answer. */
function remoteRequestStreaming(
  socket: tls.TLSSocket,
  method: string,
  send: (write: (text: string) => void) => Promise<void>,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    let raw = "";
    socket.on("data", (d: Buffer) => {
      raw += d.toString();
      const match = /^HTTP\/1\.1 (\d{3})[\s\S]*?\r\n\r\n([\s\S]*)$/.exec(raw);
      const length = /content-length: (\d+)/i.exec(raw);
      if (match && length && Buffer.byteLength(match[2]!) >= Number(length[1])) {
        resolve({ status: Number(match[1]), text: match[2]! });
      }
    });
    socket.once("close", () => reject(new Error("connection closed before an answer")));
    socket.write(`${method} /upload HTTP/1.1\r\nHost: ${HOST}\r\ntransfer-encoding: chunked\r\n\r\n`);
    const write = (text: string) => {
      if (!socket.destroyed) socket.write(`${Buffer.byteLength(text).toString(16)}\r\n${text}\r\n`);
    };
    void send(write).then(() => {
      if (!socket.destroyed) socket.write("0\r\n\r\n");
    });
  });
}

/** Greets on connect and echoes text. */
class EchoActor implements Actor {
  constructor(readonly state: ActorState) {}
  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("upgrade") !== "websocket") return new Response("nope", { status: 404 });
    const pair = new SocketPair();
    this.state.acceptWebSocket(pair.server, null);
    pair.server.send("hello");
    return upgradeResponse(pair.client);
  }
  async webSocketMessage(ws: ActorSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message === "string") ws.send(`echo:${message}`);
  }
}
