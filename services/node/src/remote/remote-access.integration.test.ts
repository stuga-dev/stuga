/**
 * Remote access end to end, against a real CA: Postgres, Pebble with challtestsrv as the zone's DNS
 * (packaging/docker/test/compose.pebble.yml), and the fake remote-access service. The node's own
 * listener is reached straight through its socket, the way the connector hands a visitor over.
 * The flows run in order on one node, each from where the last left it.
 */
import { X509Certificate, createPrivateKey, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promises as dns } from "node:dns";
import type tls from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { closeClients, createClient, getRemoteAccess, initSchema, type NodeRemoteAccessRow, type Sql } from "@stuga/db";
import { createVerifier, loadOrCreateSigningKey, type AuthConfig } from "@stuga/auth";
import {
  createActorNamespace,
  SocketPair,
  upgradeResponse,
  type Actor,
  type ActorSocket,
  type ActorState,
  type HostedNamespace,
} from "@stuga/runtime";
import type { RemoteAccessStatus } from "@stuga/protocol/api/remote-access";
import type { NodeEnv } from "../env.js";
import { createApp, createRequestHandler } from "../http/dispatch.js";
import { withSecurityHeaders } from "../http/security-headers.js";
import { createServingGate, type ServingGate } from "../http/serving-gate.js";
import { createIdentityRouter, identityDb } from "../identity/index.js";
import { createHttpServer } from "../platform/http-server.js";
import { serveStatic } from "../platform/static.js";
import { dialRemote, remoteRequest } from "../testing/remote.js";
import { sessionConnection, withDatabase, type LockSql } from "../writer-lock.js";
import { ariCertId, pemBlocks } from "./acme/der.js";
import { httpsTransport, type AcmeTransport } from "./acme/transport.js";
import { certificatePath } from "./certificates.js";
import { fixedChallengeResolver } from "./dns-check.js";
import { BINDING_KEY_FILE, readBindingKey, type BindingKey } from "./keys.js";
import { judgeHandshake, type ProbeResult } from "./probe.js";
import { createRemoteAccess, type RemoteAccess } from "./service.js";
import { createServiceClient } from "./service-client.js";
import { startFakeRemoteService, type FakeRemoteService } from "./testing/fake-service.js";
import { pebbleEnv, pebbleRoot, setRenewalInfo, waitForPebble, type PebbleEnv } from "./testing/pebble.js";

const URL_ = process.env.TEST_DATABASE_URL;
const DB = `stuga_remote_${process.pid}`;
const pebble: PebbleEnv | null = pebbleEnv();
const PUBLIC_ORIGIN = "http://livs-air.local:8787";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 20_000, stepMs = 100): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(stepMs);
  }
}

/** Greets on connect and echoes text: a WebSocket to hold open across a certificate change. */
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

describe.skipIf(!URL_ || !pebble)("remote access, against Pebble and the fake service", () => {
  let maintenance: LockSql;
  let sql: Sql;
  let fake: FakeRemoteService;
  let root: string;
  let work: string;
  let dataDir: string;
  let remoteDir: string;
  let socketPath: string;
  let gate: ServingGate;
  let env: NodeEnv;
  let echo: HostedNamespace;
  let remote: RemoteAccess;
  /** Every POST the node sent the CA, with the status it got. */
  const posts: Array<{ url: string; body: string; status?: number }> = [];
  const orderPosts = () => posts.filter((p) => p.url.endsWith("/order-plz"));
  /** Orders the CA created: Pebble refuses 5% of nonces, and the client sends that order again. */
  const orders = () => orderPosts().filter((p) => p.status === 201).length;
  const orderPayloads = () =>
    orderPosts()
      .map((p) => JSON.parse(Buffer.from((JSON.parse(p.body) as { payload: string }).payload, "base64url").toString()) as { replaces?: string });
  let lan: { close(): Promise<void> };
  let lanPort = 0;

  /**
   * Pebble's renewal window for a 180-second certificate is its whole life, so its directory names
   * no renewal information until flow 15, and the others renew at two thirds.
   */
  let ari = false;
  /** Refuse the next order that names a certificate it replaces, as a CA may; `refusedAt` is its index in `orderPayloads()`. */
  let refuseReplaces = false;
  let refusedAt: number | null = null;
  const transport: AcmeTransport = {
    async request(url, init) {
      const post = init.method === "POST" ? { url, body: init.body ?? "", status: undefined as number | undefined } : null;
      if (post) posts.push(post);
      if (refuseReplaces && url.endsWith("/order-plz") && orderPayloads().at(-1)?.replaces) {
        refuseReplaces = false;
        refusedAt = orderPosts().length - 1;
        post!.status = 409;
        const problem = { type: "urn:ietf:params:acme:error:alreadyReplaced", detail: "already replaced" };
        return { status: 409, headers: new Headers({ "content-type": "application/problem+json" }), body: new Uint8Array(Buffer.from(JSON.stringify(problem))) };
      }
      const res = await httpsTransport({ ca: pebble!.ca }).request(url, init);
      if (post) post.status = res.status;
      if (ari || init.method !== "GET" || !url.endsWith("/dir") || res.status !== 200) return res;
      const { renewalInfo: _, ...directory } = JSON.parse(Buffer.from(res.body).toString("utf8")) as Record<string, unknown>;
      return { ...res, body: new Uint8Array(Buffer.from(JSON.stringify(directory))) };
    },
  };

  /** Straight to the socket, as the relay would come in. */
  const probe = async (hostname: string, spki: string): Promise<ProbeResult> => {
    let socket: tls.TLSSocket;
    try {
      socket = await dialRemote(socketPath, { servername: hostname });
    } catch (e) {
      return { ok: false, code: "connector_unreachable", message: (e as Error).message };
    }
    try {
      return judgeHandshake(socket, spki, hostname);
    } finally {
      socket.destroy();
    }
  };

  function newService(): RemoteAccess {
    const service = createRemoteAccess({
      sql,
      env,
      config: { service: fake.url, dir: remoteDir, dataDir },
      gate,
      readsOwnBody: () => false,
      maxBodyBytes: () => 1 << 20,
      frontDoor: async () => ({}),
      challengeResolver: fixedChallengeResolver([pebble!.dns]),
      acmeTransport: transport,
      probe,
      timing: { certTickMs: 1_000, serviceTickMs: 1_000, probeDelayMs: 300, probeAfterRebindMs: 300, probeEveryMs: 2_000, probeRetryMs: 1_000, refreshSpacingMs: 1_000 },
      onError: (e) => console.error("[remote test]", e),
    });
    env.remote = service.view;
    env.remoteAccess = service;
    return service;
  }

  const row = (): Promise<NodeRemoteAccessRow> => getRemoteAccess(sql);
  const state = async (): Promise<string> => {
    const s = await remote.status();
    return s.available ? s.state : "unavailable";
  };
  const statusOf = async () => (await remote.status()) as Extract<RemoteAccessStatus, { available: true }>;
  const hostname = () => remote.view.current().hostname!;
  const id = () => remote.view.current().id!;
  const dial = (opts: { source?: string; port?: number } = {}) => dialRemote(socketPath, { servername: hostname(), ca: root, ...opts });
  const waitOn = async () => {
    let last: unknown;
    try {
      await until("state on", async () => {
        last = await remote.status();
        return (last as { state?: string }).state === "on";
      }, 30_000);
    } catch (e) {
      throw new Error(`${(e as Error).message}; last ${JSON.stringify(last)}`);
    }
  };

  beforeAll(async () => {
    maintenance = sessionConnection(URL_!, "postgres");
    await maintenance`DROP DATABASE IF EXISTS ${maintenance(DB)} WITH (FORCE)`;
    await maintenance`CREATE DATABASE ${maintenance(DB)}`;
    sql = createClient(withDatabase(URL_!, DB));
    await initSchema(sql);
    await waitForPebble(pebble!);
    root = await pebbleRoot(pebble!);
    // Pebble picks a profile at random for an order that names none; its default is the 180-second one.
    fake = await startFakeRemoteService({ acmeDirectory: pebble!.directory, acmeProfile: "default", challtestsrv: pebble!.challtestsrv });
    work = mkdtempSync(join(tmpdir(), "stuga-ra-"));
    dataDir = join(work, "data");
    remoteDir = join(work, "remote");
    socketPath = join(remoteDir, "https.sock");

    const keys = await loadOrCreateSigningKey(join(work, "signing.jwk"));
    const auth: AuthConfig = {
      issuer: PUBLIC_ORIGIN,
      audience: "stuga",
      keyFile: join(work, "signing.jwk"),
      accessTokenTtlSeconds: 3600,
      refreshTokenTtlSeconds: 3600,
      refreshRotationGraceSeconds: 0,
    };
    env = {
      publicOrigin: PUBLIC_ORIGIN,
      extraOrigins: [],
      sql,
      jobs: { send: async () => {} },
      trustProxyHeaders: false,
      rateLimit: { limit: async () => ({ success: true }) },
    } as unknown as NodeEnv;
    echo = createActorNamespace(EchoActor, {}, { name: "echo", dir: join(work, "actors"), idleMs: Infinity, heartbeat: { request: "ping", response: "pong" }, storeVersion: 1 });
    const app = createApp(env);
    const identity = createIdentityRouter({
      auth,
      publicOrigin: PUBLIC_ORIGIN,
      db: identityDb(sql),
      keys,
      verifier: createVerifier(auth, keys),
      nodeName: () => null,
      nodeLabel: () => "livs-air",
      setupCode: () => null,
      remoteId: () => env.remote?.current().id ?? null,
    });
    writeFileSync(join(work, "index.html"), "<!doctype html><title>Stuga</title>");
    gate = createServingGate();
    gate.open({
      handler: createRequestHandler({ identity, app, spa: serveStatic(work) }),
      upgrade: (req) => (new URL(req.url).pathname === "/echo" ? echo.get("e1").fetch(req) : app.upgrade(req)),
    });
    const server = createHttpServer({
      handler: withSecurityHeaders(gate.handler),
      upgrade: withSecurityHeaders(gate.upgrade),
      publicOrigin: PUBLIC_ORIGIN,
      port: 0,
      maxBodyBytes: () => 1 << 20,
      onError: () => {},
    });
    lanPort = (await server.listen()).port;
    lan = server;
    remote = newService();
    await remote.start();
  }, 60_000);

  afterAll(async () => {
    await remote?.stop();
    await lan?.close();
    await echo?.close();
    await fake?.close();
    await closeClients();
    if (maintenance) {
      await maintenance`DROP DATABASE IF EXISTS ${maintenance(DB)} WITH (FORCE)`;
      await maintenance.end({ timeout: 5 });
    }
    if (work) rmSync(work, { recursive: true, force: true });
  });

  /** A request on the LAN listener. */
  function lanGet(path: string, headers: Record<string, string>): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: lanPort, path, headers: { host: "livs-air.local:8787", ...headers } }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode!));
      });
      req.on("error", reject);
      req.end();
    });
  }

  /** Wait for a scheduled renewal when the certificate is close to one, so a flow that counts orders has a quiet minute. */
  async function quietMinute(): Promise<void> {
    const r = await row();
    if (r.cert_renew_at && r.cert_renew_at.getTime() - Date.now() < 60_000) {
      const serial = r.cert_serial;
      await until("the scheduled renewal", async () => (await row()).cert_serial !== serial, 90_000, 250);
      await waitOn();
    }
  }

  it("1. turns on with an enrollment code: enroll, check-in, a certificate, a credential, the connector's files, the listener", async () => {
    const seen: string[] = [];
    let watching = true;
    const watcher = (async () => {
      while (watching) {
        const s = await state();
        if (seen.at(-1) !== s) seen.push(s);
        await sleep(50);
      }
    })();
    const code = fake.mintCode("enroll");
    const { status, via } = await remote.enable({ code, acceptCaTerms: true, by: "liv" });
    expect(via).toBe("enroll");
    expect(status).toMatchObject({ available: true, enabled: true, address: `https://${hostname()}` });
    await waitOn();
    watching = false;
    await watcher;
    // Off before the request, and nothing but starting on the way to on.
    expect(seen.filter((s) => s !== "off" && s !== "on")).toEqual(["starting"]);

    expect(fake.requests.map((r) => r.path).slice(0, 6)).toEqual([
      "/v1/enroll",
      "/v1/checkin",
      "/v1/acme/txt",
      "/v1/acme/txt/cleanup",
      "/v1/checkin",
      "/v1/relay-credential",
    ]);
    expect(fake.txtWrites).toHaveLength(1);
    const order = orderPayloads()[0];
    expect(order).toEqual({ identifiers: [{ type: "dns", value: hostname() }], profile: "default" });
    expect(statSync(remoteDir).mode & 0o777).toBe(0o750);
    for (const name of ["relay-1.toml", "relay-1.ca.pem", "relay-1.jwt"]) {
      expect(statSync(join(remoteDir, name)).mode & 0o777, name).toBe(0o640);
    }
    expect(readFileSync(join(remoteDir, "relay-1.toml"), "utf8")).toContain(`customDomains = ["${hostname()}"]`);
    expect(readFileSync(join(remoteDir, "relay-1.jwt"), "utf8")).toBe(`${fake.issuedCredentials.at(-1)!.credential}\n`);
    expect(statSync(socketPath).isSocket()).toBe(true);
    expect(statSync(socketPath).mode & 0o777).toBe(0o660);
    expect(statSync(certificatePath(dataDir)).mode & 0o777).toBe(0o600);
    expect(statSync(join(dataDir, "secrets", BINDING_KEY_FILE)).mode & 0o777).toBe(0o600);
    const s = await statusOf();
    // Pebble's terms are a data: URL, which the node does not keep: the page links to the CA's own.
    expect(s.ca_terms).toMatchObject({ accepted_by: "liv", url: null });
    expect(s.connector).toMatchObject({ config_path: join(remoteDir, "relay-1.toml"), reachable: true });
  }, 60_000);

  it("2. serves a visitor the PROXY header names, over its own certificate, with HSTS and its own Host only", async () => {
    const socket = await dial({ source: "203.0.113.7", port: 5555 });
    expect(socket.authorized).toBe(true);
    const leaf = new X509Certificate(readFileSync(certificatePath(dataDir), "utf8").split("-----END PRIVATE KEY-----\n")[1]!);
    expect(socket.getPeerX509Certificate()!.fingerprint256).toBe(leaf.fingerprint256);
    const ready = await remoteRequest(socket, { path: "/ready" });
    expect(ready.status).toBe(200);
    expect(ready.headers["strict-transport-security"]).toBe("max-age=31536000");
    const config = await remoteRequest(await dial(), { path: "/auth/config" });
    expect(JSON.parse(config.text)).toMatchObject({ node_label: id(), origin: `https://${hostname()}` });
    const wrongHost = await remoteRequest(await dial(), { path: "/ready", headers: { host: "livs-air.local" } });
    expect(wrongHost.status).toBe(421);
  });

  it("14. answers the maintenance page, with HSTS, while a backup has the node paused", async () => {
    gate.pause("maintenance");
    try {
      const res = await remoteRequest(await dial(), { path: "/", headers: { accept: "text/html" } });
      expect(res.status).toBe(503);
      expect(res.text).toContain("Stuga is making a backup.");
      expect(res.headers["strict-transport-security"]).toBe("max-age=31536000");
    } finally {
      gate.open();
    }
    expect((await remoteRequest(await dial(), { path: "/ready" })).status).toBe(200);
  });

  it("5. gets a new credential straight after a check-in names a time its current one predates", async () => {
    const before = fake.issuedCredentials.at(-1)!;
    await sleep(1_100);
    fake.deny(id(), { reason: "compromised", notBefore: before.iat + 1 });
    try {
      remote.kick();
      const next = await until("a newer credential", async () => {
        const last = fake.issuedCredentials.at(-1)!;
        return last.iat > before.iat ? last : null;
      });
      expect(next.iat).toBeGreaterThanOrEqual(before.iat + 1);
      expect(readFileSync(join(remoteDir, "relay-1.jwt"), "utf8")).toBe(`${next.credential}\n`);
    } finally {
      fake.undeny(id());
    }
    remote.kick();
    await waitOn();
  }, 30_000);

  it("12. gets a new certificate when the key on disk does not match it", async () => {
    await quietMinute();
    const serial = (await row()).cert_serial;
    const ordersBefore = orders();
    const text = readFileSync(certificatePath(dataDir), "utf8");
    const other = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    writeFileSync(certificatePath(dataDir), other + text.slice(text.indexOf("-----BEGIN CERTIFICATE-----")));
    remote.kick();
    await until("a new certificate", async () => (await row()).cert_serial !== serial, 30_000);
    expect(orders()).toBe(ordersBefore + 1);
    const pem = readFileSync(certificatePath(dataDir), "utf8");
    const leaf = new X509Certificate(pem.slice(pem.indexOf("-----BEGIN CERTIFICATE-----")));
    expect(leaf.checkPrivateKey(createPrivateKey(pem))).toBe(true);
    await waitOn();
  }, 60_000);

  it("6. renews only on its own evidence: not for a refusal, not for a new directory, once for reissue_before", async () => {
    await quietMinute();
    const ordersBefore = orders();
    const txtBefore = fake.txtWrites.length;
    const before = fake.issuedCredentials.at(-1)!;
    await sleep(1_100);

    // A refused certificate: degraded, retried in an hour, and no new order.
    fake.failNext("/v1/relay-credential", 422, { error: "cert_invalid", message: "The certificate is not this address's." });
    fake.deny(id(), { reason: "other", notBefore: before.iat + 1 });
    remote.kick();
    const refused = await until("the refusal", async () => {
      const s = await statusOf();
      return s.last_error?.service_code === "cert_invalid" ? s : null;
    });
    expect(refused.state).toBe("degraded");
    expect(refused.last_error!.code).toBe("service_refused");
    const retryIn = new Date(refused.last_error!.retry_at!).getTime() - Date.now();
    expect(retryIn).toBeGreaterThan(55 * 60_000);
    expect(retryIn).toBeLessThan(61 * 60_000);
    fake.undeny(id());
    await sleep(2_500);
    expect(orders()).toBe(ordersBefore);
    expect(fake.txtWrites.length).toBe(txtBefore);

    // A different CA directory: taken, and used at the next renewal, not now.
    const other = pebble!.directory.replace("127.0.0.1", "localhost");
    fake.setAcmeDirectory(other);
    remote.kick();
    await until("the new directory", async () => (await row()).acme_directory === other);
    await sleep(2_500);
    expect(orders()).toBe(ordersBefore);
    await waitOn();

    // reissue_before later than the certificate: one new certificate, from the new directory. An hour
    // ahead, it is also later than the new one, as a certificate Let's Encrypt backdates by an hour is.
    const serial = (await row()).cert_serial;
    await sleep(1_100);
    fake.setReissueBefore(Math.floor(Date.now() / 1000) + 3600);
    remote.kick();
    await until("the reissued certificate", async () => (await row()).cert_serial !== serial, 30_000);
    await sleep(3_000);
    remote.kick();
    await sleep(3_000);
    expect(orders()).toBe(ordersBefore + 1);
    expect(posts.some((p) => p.url.startsWith("https://localhost:14000/"))).toBe(true);
    expect((await row()).cert_directory).toBe(other);
    fake.setReissueBefore(null);
    await waitOn();
  }, 120_000);

  it("7. stops at a deny, checks in hourly, and comes back on its own once it is lifted", async () => {
    fake.deny(id(), { reason: "abuse" });
    remote.kick();
    const denied = await until("denied", async () => {
      const s = await statusOf();
      return s.state === "denied" ? s : null;
    });
    expect(denied.last_error).toMatchObject({ code: "denied", reason: "abuse", message: "Remote access is off for this address." });
    const next = (await row()).checkin_next_at!.getTime() - Date.now();
    expect(next).toBeGreaterThan(54 * 60_000);
    expect(next).toBeLessThan(66 * 60_000);
    fake.undeny(id());
    remote.kick();
    await waitOn();
  }, 30_000);

  it("8. keeps its key through refusals of it, says so after a day, and recovers when the service does", async () => {
    fake.failNext("*", 401, { error: "unknown_key", message: "This key is not known." }, Infinity);
    remote.kick();
    const failing = await until("the refusal", async () => {
      const s = await statusOf();
      return s.last_error?.service_code === "unknown_key" ? s : null;
    });
    expect(failing.state).toBe("degraded");
    expect(existsSync(join(dataDir, "secrets", BINDING_KEY_FILE))).toBe(true);
    expect((await row()).binding_failing_since).not.toBeNull();

    await sql`UPDATE node_remote_access SET binding_failing_since = now() - interval '25 hours'`;
    remote.kick();
    await until("binding_rejected", async () => (await statusOf()).last_error?.code === "binding_rejected");
    expect(await state()).toBe("error");
    expect(existsSync(join(dataDir, "secrets", BINDING_KEY_FILE))).toBe(true);

    fake.clearFailures();
    remote.kick();
    await waitOn();
    expect((await row()).binding_failing_since).toBeNull();
  }, 30_000);

  it("10. turns off: the socket and the connector's files go, the service hears nothing, and it turns on again without a code", async () => {
    const remoteOrigin = `https://${hostname()}`;
    expect(await lanGet("/api/models", { origin: remoteOrigin })).toBe(403);
    const status = await remote.disable("liv");
    expect(status).toMatchObject({ enabled: false, state: "off" });
    expect(existsSync(socketPath)).toBe(false);
    for (const name of ["relay-1.jwt", "relay-1.toml", "relay-1.ca.pem"]) expect(existsSync(join(remoteDir, name)), name).toBe(false);
    const heard = fake.requests.length;
    remote.kick();
    await sleep(3_000);
    expect(fake.requests.length).toBe(heard);
    expect(await lanGet("/api/models", { origin: remoteOrigin })).toBe(403);

    const before = id();
    const again = await remote.enable({ acceptCaTerms: true, by: "liv" });
    expect(again.via).toBe("resume");
    await waitOn();
    expect(id()).toBe(before);
    expect(existsSync(join(remoteDir, "relay-1.jwt"))).toBe(true);
    expect(await lanGet("/api/models", { origin: remoteOrigin })).toBe(403);
  }, 60_000);

  it("11. opens the listener with the certificate on disk at start, before any request to the service is answered", async () => {
    await remote.stop();
    expect(existsSync(socketPath)).toBe(false);
    fake.pause();
    const heard = fake.requests.length;
    try {
      remote = newService();
      await remote.start();
      const socket = await dial();
      expect(socket.authorized).toBe(true);
      expect((await remoteRequest(socket, { path: "/ready" })).status).toBe(200);
      // Held back unanswered all this while.
      expect(fake.requests.length).toBe(heard);
    } finally {
      fake.resume();
    }
    await waitOn();
  }, 60_000);

  it("13. gets its address back with a restore code after losing its key, and the old key stops working", async () => {
    const oldKey = (await readBindingKey(dataDir)) as BindingKey;
    const before = id();
    await remote.stop();
    rmSync(join(dataDir, "secrets", BINDING_KEY_FILE));
    remote = newService();
    await remote.start();
    const restored = await remote.enable({ code: fake.mintCode("rebind", before), acceptCaTerms: true, by: "liv" });
    expect(restored.via).toBe("rebind");
    expect(id()).toBe(before);
    await waitOn();
    const client = createServiceClient();
    await expect(client.checkin(fake.url, oldKey, before)).rejects.toMatchObject({ status: 401, code: "node_moved" });
    expect(fake.keysOf(before).filter((k) => !k.revoked)).toHaveLength(1);

    // A node with nothing at all, given a restore code: enroll says it is the other kind, and rebind takes it.
    await remote.stop();
    await sql`DELETE FROM node_remote_access`;
    rmSync(join(dataDir, "secrets", BINDING_KEY_FILE));
    remote = newService();
    await remote.start();
    const heard = fake.requests.length;
    const fresh = await remote.enable({ code: fake.mintCode("rebind", before), acceptCaTerms: true, by: "liv" });
    expect(fresh.via).toBe("rebind");
    expect(fake.requests.slice(heard, heard + 2).map((r) => [r.path, r.status])).toEqual([
      ["/v1/enroll", 409],
      ["/v1/rebind", 200],
    ]);
    expect(id()).toBe(before);
    await waitOn();
  }, 90_000);

  it("3. renews at two thirds of a 180-second life with a new key, without dropping what is open", async () => {
    await waitOn();
    const r = await row();
    const serial = r.cert_serial;
    // The CA counts the last second in: 180 seconds of validity end 179 seconds after the start.
    const lifetime = r.cert_not_after!.getTime() - r.cert_not_before!.getTime();
    expect(lifetime).toBeGreaterThanOrEqual(179_000);
    expect(lifetime).toBeLessThanOrEqual(180_000);
    const renewAfter = r.cert_renew_at!.getTime() - r.cert_not_before!.getTime();
    expect(renewAfter).toBeGreaterThanOrEqual((lifetime * 2) / 3 - lifetime / 20);
    expect(renewAfter).toBeLessThanOrEqual((lifetime * 2) / 3);
    const oldPem = readFileSync(certificatePath(dataDir), "utf8");

    const kept = await dial();
    const wsSocket = await dial();
    const ws = new WebSocket(`wss://${hostname()}/echo`, { createConnection: () => wsSocket });
    const frames: string[] = [];
    ws.on("message", (d) => frames.push(d.toString()));
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });

    // Requests every few seconds keep the connection past its keep-alive timeout, through the renewal.
    let renewed = false;
    while (!renewed) {
      expect(await rawGet(kept, "/ready")).toBe(200);
      await sleep(3_000);
      renewed = (await row()).cert_serial !== serial;
      if (Date.now() - r.cert_not_before!.getTime() > 175_000) throw new Error("no renewal before the certificate ran out");
    }
    expect(await rawGet(kept, "/ready")).toBe(200);
    ws.send("after");
    await until("the echo", async () => frames.includes("echo:after"), 5_000);
    ws.terminate();
    kept.destroy();

    const newPem = readFileSync(certificatePath(dataDir), "utf8");
    expect(createPrivateKey(newPem).export({ format: "jwk" }).d).not.toBe(createPrivateKey(oldPem).export({ format: "jwk" }).d);
    const fresh = await dial();
    const newLeaf = new X509Certificate(newPem.slice(newPem.indexOf("-----BEGIN CERTIFICATE-----")));
    expect(fresh.getPeerX509Certificate()!.fingerprint256).toBe(newLeaf.fingerprint256);
    fresh.destroy();
    expect(fake.txtRecords.size).toBe(0);
    const resolver = new dns.Resolver({ timeout: 2_000, tries: 1 });
    resolver.setServers([pebble!.dns]);
    const txt = await resolver.resolveTxt(`_acme-challenge.${hostname()}`).catch(() => []);
    expect(txt).toEqual([]);
  }, 200_000);

  it("4. refreshes a 60-second credential about 15 seconds in, replacing the token file whole", async () => {
    fake.setCredentialTtl(60);
    const before = fake.issuedCredentials.at(-1)!;
    await sleep(1_100);
    fake.deny(id(), { reason: "other", notBefore: before.iat + 1 });
    remote.kick();
    const short = await until("a 60-second credential", async () => {
      const last = fake.issuedCredentials.at(-1)!;
      return last.exp - last.iat === 60 ? last : null;
    });
    fake.undeny(id());
    const r = await until("its record", async () => {
      const x = await row();
      return x.credential_expires_at!.getTime() - x.credential_issued_at!.getTime() === 60_000 ? x : null;
    });
    // A quarter of the life, ±5%, in whole seconds: 15 s ± 0.75 s rounds to 14, 15 or 16.
    const refreshIn = r.credential_refresh_at!.getTime() - r.credential_issued_at!.getTime();
    expect(refreshIn).toBeGreaterThanOrEqual(14_000);
    expect(refreshIn).toBeLessThanOrEqual(16_000);

    // Every read sees one whole credential while the file is replaced.
    const token = join(remoteDir, "relay-1.jwt");
    const reads = new Set<string>();
    const next = await until(
      "the scheduled refresh",
      async () => {
        const text = readFileSync(token, "utf8");
        reads.add(text);
        const last = fake.issuedCredentials.at(-1)!;
        return last.iat > short.iat ? last : null;
      },
      25_000,
      5,
    );
    expect(next.iat - short.iat).toBeGreaterThanOrEqual(14);
    await until("the new token", async () => readFileSync(token, "utf8") === `${next.credential}\n`);
    for (const text of reads) expect(text).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\n$/);
    expect(statSync(token).mode & 0o777).toBe(0o640);
    fake.setCredentialTtl(86_400);
  }, 60_000);

  it("9. stops calling the service once it says to upgrade, and is back on after a restart once it stops saying so", async () => {
    fake.setMinProtocol(2);
    remote.kick();
    await until("upgrade_required", async () => (await statusOf()).last_error?.code === "upgrade_required");
    expect(await state()).toBe("error");
    const heard = fake.requests.length;
    remote.kick();
    await sleep(3_000);
    remote.kick();
    await sleep(1_000);
    expect(fake.requests.length).toBe(heard);

    // Stuga updated: a new process, whose first check-in clears the error.
    fake.setMinProtocol(1);
    await remote.stop();
    remote = newService();
    await remote.start();
    await waitOn();
  }, 60_000);

  it("15. renews in the CA's renewal window, at once when the window is over, naming the certificate it replaces", async () => {
    ari = true;
    // A new process, whose directory names the renewal information.
    await remote.stop();
    remote = newService();
    await remote.start();
    await waitOn();
    const r = await until("the renewal window", async () => {
      const x = await row();
      return x.cert_ari_window_start ? x : null;
    }, 30_000);
    expect(r.cert_ari_window_start!.getTime()).toBeGreaterThanOrEqual(r.cert_not_before!.getTime() - 1_000);
    expect(r.cert_ari_window_end!.getTime()).toBeLessThanOrEqual(r.cert_not_after!.getTime() + 1_000);
    expect(r.cert_renew_at!.getTime()).toBeGreaterThanOrEqual(r.cert_ari_window_start!.getTime());
    expect(r.cert_renew_at!.getTime()).toBeLessThanOrEqual(r.cert_ari_window_end!.getTime());
    // Pebble's Retry-After is six hours.
    expect(Math.abs(r.cert_ari_next_at!.getTime() - Date.now() - 6 * 3_600_000)).toBeLessThan(60_000);

    const leafNow = () => {
      const pem = pemBlocks(readFileSync(certificatePath(dataDir), "utf8"), "CERTIFICATE")[0]!;
      return { pem, certId: ariCertId(new X509Certificate(pem).raw)! };
    };
    const over = () => ({
      suggestedWindow: { start: new Date(Date.now() - 2 * 3_600_000).toISOString(), end: new Date(Date.now() - 3_600_000).toISOString() },
    });

    // Over, as for a revoked certificate: renewed at once.
    const first = leafNow();
    const before = (await row()).cert_serial;
    await setRenewalInfo(pebble!, first.pem, over());
    await sql`UPDATE node_remote_access SET cert_ari_next_at = NULL`;
    remote.kick();
    await until("the renewal", async () => (await row()).cert_serial !== before, 30_000);
    expect(orderPayloads().filter((p) => p.replaces === first.certId).length).toBeGreaterThanOrEqual(1);
    expect(await row()).toMatchObject({ cert_failures: 0, cert_account_url: expect.stringMatching(/^https:/) });
    await waitOn();

    // Refused with it: ordered again without, and no failure counted.
    const second = leafNow();
    const serial = (await row()).cert_serial;
    refuseReplaces = true;
    await setRenewalInfo(pebble!, second.pem, over());
    await sql`UPDATE node_remote_access SET cert_ari_next_at = NULL`;
    remote.kick();
    await until("the next renewal", async () => (await row()).cert_serial !== serial, 30_000);
    expect(refusedAt).not.toBeNull();
    expect(orderPayloads()[refusedAt!]!.replaces).toBeDefined();
    expect(orderPayloads()[refusedAt! + 1]).not.toHaveProperty("replaces");
    expect(await row()).toMatchObject({ cert_failures: 0, cert_retry_at: null });
    await waitOn();
  }, 120_000);

  /** One request on a connection kept open for the next: the status, once the whole answer is in. */
  function rawGet(socket: tls.TLSSocket, path: string): Promise<number> {
    return new Promise((resolve, reject) => {
      let buffered = Buffer.alloc(0);
      const onData = (chunk: Buffer) => {
        buffered = Buffer.concat([buffered, chunk]);
        const end = buffered.indexOf("\r\n\r\n");
        if (end < 0) return;
        const head = buffered.subarray(0, end).toString();
        const length = Number(/content-length: (\d+)/i.exec(head)?.[1] ?? 0);
        if (buffered.length < end + 4 + length) return;
        socket.off("data", onData);
        socket.off("close", onClose);
        resolve(Number(head.split(" ")[1]));
      };
      const onClose = () => reject(new Error("the kept connection closed"));
      socket.on("data", onData);
      socket.once("close", onClose);
      socket.write(`GET ${path} HTTP/1.1\r\nHost: ${hostname()}\r\nConnection: keep-alive\r\n\r\n`);
    });
  }
});
