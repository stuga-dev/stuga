/**
 * The node's whole front door behind each listener: what the remote address says to a stranger,
 * and what the LAN says to everyone, which the remote address must not change.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AuthError, createVerifier, loadOrCreateSigningKey, type AuthConfig, type LocalKeys } from "@stuga/auth";

vi.mock("@stuga/db", async (orig) => ({
  ...(await orig<typeof import("@stuga/db")>()),
  getDirectoryRow: vi.fn(async () => ({ display_name: "Liv", username: "liv", email: null })),
  resolveHumanAuth: vi.fn(async () => ({
    user: { display_name: "Liv", username: "liv", email: null },
    membership: { workspace_id: "ws1", role: "member" },
    groupIds: [],
    sessionLive: true,
  })),
  isSessionLive: vi.fn(async () => true),
}));

const { createApp, createRequestHandler, readsOwnBody } = await import("./dispatch.js");
const { createIdentityRouter } = await import("../identity/routes.js");
const { memoryDb } = await import("../identity/testing/memory-db.js");
const { behindGate, createServingGate } = await import("./serving-gate.js");
const { createFrontDoor } = await import("./front-door.js");
const { applyRemoteHeaders, withRemoteHeaders, withSecurityHeaders } = await import("./security-headers.js");
const { createHttpServer } = await import("../platform/http-server.js");
const { createRemoteListener } = await import("../platform/remote-listener.js");
const { serveStatic } = await import("../platform/static.js");
const { mintMediaTicket } = await import("../media/media-auth.js");
const { makeTestCert } = await import("../testing/cert.js");
const { dialRemote, remoteRequest } = await import("../testing/remote.js");
import type { NodeEnv, RemoteAccessView } from "../env.js";

const LAN_NAME = "livs-air";
const LAN_IP = "192.168.1.50";
const PUBLIC_ORIGIN = `http://${LAN_NAME}.local:8787`;
const EXTRA_ORIGIN = `http://${LAN_IP}:8787`;
const REMOTE_HOST = "k7f3q2.stuga.test";
const REMOTE_ORIGIN = `https://${REMOTE_HOST}`;
const SECRET = "internal-secret-for-tests";
const HASH = "a".repeat(64);

const dir = mkdtempSync(join(tmpdir(), "stuga-surface-"));
let keys: LocalKeys;
beforeAll(async () => {
  keys = await loadOrCreateSigningKey(join(dir, "signing.jwk"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>Stuga</title>");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

const bound = (enabled: boolean): RemoteAccessView => ({
  current: () => ({ enabled, id: "k7f3q2", hostname: REMOTE_HOST, origin: REMOTE_ORIGIN }),
});

/** A node at PUBLIC_ORIGIN with nothing in its database but what each route here reads. */
function nodeAt(publicOrigin: string, remote?: RemoteAccessView) {
  const env = {
    publicOrigin,
    extraOrigins: [EXTRA_ORIGIN],
    // /ready asks the database; nothing else here does.
    sql: Object.assign(async () => [], {}),
    verifier: {
      verify: async (token: string) => {
        if (token !== "session-jwt") throw new AuthError("bad token");
        return { alias: "liv", sid: "sess-1", claims: {} };
      },
    },
    rateLimit: { limit: async () => ({ success: true }) },
    trustProxyHeaders: false,
    settings: { current: () => ({ nodeLabel: LAN_NAME, nodeName: null, maxBodyBytes: 1 << 20 }) },
    nodeId: "ktbbpahhzxoldakw",
    stdioEntry: "/opt/stuga/mcp.js",
    internalSecret: SECRET,
    mediaCookieSameSite: "Lax",
    media: { get: async () => ({ body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), httpMetadata: { contentType: "image/png" } }) },
    jobs: { send: async () => {} },
    ...(remote ? { remote } : {}),
  } as unknown as NodeEnv;
  const auth: AuthConfig = {
    issuer: publicOrigin,
    audience: "stuga",
    keyFile: join(dir, "signing.jwk"),
    accessTokenTtlSeconds: 3600,
    refreshTokenTtlSeconds: 3600,
    refreshRotationGraceSeconds: 0,
  };
  const app = createApp(env);
  const identity = createIdentityRouter({
    auth,
    publicOrigin,
    extraOrigins: [EXTRA_ORIGIN],
    db: memoryDb().db,
    keys,
    verifier: createVerifier(auth, keys),
    nodeName: () => null,
    nodeLabel: () => LAN_NAME,
    setupCode: () => "ABCDE12345",
    remoteId: () => remote?.current().id ?? null,
    remoteOrigin: () => (remote?.current().enabled ? remote.current().origin : null),
  });
  const gate = createServingGate();
  gate.open({ handler: createRequestHandler({ identity, app, spa: serveStatic(dir) }), upgrade: (req) => app.upgrade(req) });
  return { env, gate };
}

interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
}

/** The LAN listener, on a free port. */
async function lan(publicOrigin: string, remote?: RemoteAccessView) {
  const { gate } = nodeAt(publicOrigin, remote);
  const server = createHttpServer({
    handler: withSecurityHeaders(gate.handler),
    upgrade: withSecurityHeaders(gate.upgrade),
    publicOrigin,
    port: 0,
    maxBodyBytes: () => 1 << 20,
    readsOwnBody,
    onError: () => {},
  });
  const { port } = await server.listen();
  cleanups.push(() => server.close());
  return (path: string, headers: Record<string, string> = {}, method = "GET"): Promise<Answer> =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path, method, headers: { host: `${LAN_NAME}.local:8787`, ...headers } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, text: Buffer.concat(chunks).toString() }));
      });
      req.on("error", reject);
      req.end();
    });
}

/** The remote listener for REMOTE_HOST, over a socket in a fresh directory, behind its front door. */
async function remoteListener(publicOrigin: string) {
  const { gate, env } = nodeAt(publicOrigin, bound(true));
  const socketDir = mkdtempSync(join(tmpdir(), "stuga-surface-sock-"));
  cleanups.push(() => rmSync(socketDir, { recursive: true, force: true }));
  const socketPath = join(socketDir, "https.sock");
  const listener = createRemoteListener({
    socketPath,
    hostname: REMOTE_HOST,
    handler: withRemoteHeaders(withSecurityHeaders(gate.handler)),
    upgrade: withRemoteHeaders(withSecurityHeaders(gate.upgrade)),
    decorate: applyRemoteHeaders,
    maxBodyBytes: () => 1 << 20,
    readsOwnBody,
    frontDoor: behindGate(gate, createFrontDoor({ env })),
    onError: () => {},
  });
  listener.setCertificate(makeTestCert({ dnsNames: [REMOTE_HOST] }));
  await listener.listen();
  cleanups.push(() => listener.close());
  return async (path: string, headers: Record<string, string> = {}, method = "GET", body?: string): Promise<Answer> => {
    const res = await remoteRequest(await dialRemote(socketPath, { servername: REMOTE_HOST }), {
      path,
      method,
      headers: body === undefined ? headers : { ...headers, "content-length": String(Buffer.byteLength(body)) },
      ...(body === undefined ? {} : { body }),
    });
    return { status: res.status, headers: res.headers, text: res.text };
  };
}

describe("the remote address, to a visitor who has not signed in", () => {
  it("never names the LAN: not PUBLIC_ORIGIN's host, not an EXTRA_ORIGINS address, in a body or a header", async () => {
    const get = await remoteListener(PUBLIC_ORIGIN);
    const html = { accept: "text/html" };
    const asked: Array<[string, Record<string, string>, string?]> = [
      ["/auth/config", {}],
      ["/.well-known/openid-configuration", {}],
      ["/.well-known/jwks.json", {}],
      ["/.well-known/oauth-authorization-server", {}],
      ["/.well-known/oauth-protected-resource/mcp", {}],
      ["/mcp", { "content-type": "application/json" }, "POST"],
      ["/mcp", {}],
      ["/api/agent-install/codex", {}],
      ["/ready", {}],
      ["/", html],
      ["/no/such/page", html],
      ["/api/no-such-route", {}],
      ["/auth/no-such-route", {}],
    ];
    for (const [path, headers, method] of asked) {
      const res = await get(path, headers, method);
      const seen = `${JSON.stringify(res.headers)}\n${res.text}`;
      expect(seen, `${method ?? "GET"} ${path}`).not.toContain(LAN_NAME);
      expect(seen, `${method ?? "GET"} ${path}`).not.toContain(LAN_IP);
      expect(res.headers["strict-transport-security"], path).toBe("max-age=31536000");
    }
    // And what it does say is about the remote address.
    expect(JSON.parse((await get("/auth/config")).text)).toMatchObject({ origin: REMOTE_ORIGIN, node_label: "k7f3q2" });
    expect((await get("/mcp", { "content-type": "application/json" }, "POST")).headers["www-authenticate"]).toContain(REMOTE_ORIGIN);
    expect((await get("/api/agent-install/codex")).text).toContain(`${REMOTE_ORIGIN}/mcp`);
    expect((await get("/.well-known/openid-configuration")).status).toBe(404);
    // Nor what only the LAN answers.
    for (const path of ["/.well-known/jwks.json", "/ready"]) expect((await get(path)).status, path).toBe(404);
    // A passkey sign-in's challenge names this address alone, as the relying party.
    const passkey = await get("/auth/passkey/options", { "content-type": "application/json" }, "POST", JSON.stringify({ purpose: "sign-in" }));
    expect(passkey.status).toBe(200);
    expect(`${JSON.stringify(passkey.headers)}\n${passkey.text}`).not.toContain(LAN_NAME);
    expect(JSON.parse(passkey.text).publicKey).toMatchObject({ rpId: REMOTE_HOST, userVerification: "required" });
    expect(JSON.parse((await get("/auth/config")).text).passkey).toBe(true);
    // What needs a credential says only that, without reading on.
    expect((await get("/api/models")).status).toBe(401);
    expect((await get("/auth/passkey/add", { "content-type": "application/json" }, "POST", "{}")).status).toBe(401);
    expect((await get("/api/no-such-route", {}, "POST")).status).toBe(401);
  });
});

/**
 * What the LAN answers, pinned: the remote address must not move it. Against the node before remote
 * access, three things differ and nothing else: the media cookie's name on https, the media CORP,
 * and agent setup's `remote`.
 */
describe("the LAN's answers", () => {
  const ORIGIN = "https://livs-air.local:8787";
  const bearer = { authorization: "Bearer session-jwt" };

  /** Only what does not vary from run to run: no dates, request ids, or this machine's paths. */
  function steady(res: Answer): { status: number; headers: Record<string, unknown>; body: unknown } {
    const headers: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(res.headers)) {
      if (["date", "connection", "keep-alive", "transfer-encoding", "x-request-id"].includes(name)) continue;
      headers[name] = name === "set-cookie" ? (value as string[]).map((c) => c.replace(/=[^;]+;/, "=…;")) : value;
    }
    let body: unknown = res.text;
    try {
      body = JSON.parse(res.text);
    } catch {
      // Not JSON: kept as text.
    }
    if (body && typeof body === "object" && "stdio" in body) {
      const setup = body as { stdio: { command: string }; bundle: { available: boolean } };
      setup.stdio.command = "<node>";
      setup.bundle.available = false;
    }
    if (body && typeof body === "object" && "expires_at" in body) (body as { expires_at: unknown }).expires_at = "<expiry>";
    return { status: res.status, headers, body };
  }

  async function answers(remote?: RemoteAccessView) {
    const get = await lan(ORIGIN, remote);
    const ticket = await mintMediaTicket(SECRET, { alias: "liv", workspaceId: "ws1", sid: "sess-1", arrival: "local" });
    // Under both names: the node before remote access read the plain one on https too.
    const cookie = { cookie: `stuga_media=${ticket.value}; __Host-stuga_media=${ticket.value}` };
    return {
      config: steady(await get("/auth/config")),
      discovery: steady(await get("/.well-known/openid-configuration")),
      authorizationServer: steady(await get("/.well-known/oauth-authorization-server")),
      protectedResource: steady(await get("/.well-known/oauth-protected-resource/mcp")),
      agentSetup: steady(await get("/api/agent-setup", bearer)),
      mediaTicket: steady(await get("/api/media/ticket", bearer)),
      media: steady(await get(`/api/docs/d1/media/${HASH}`, cookie)),
    };
  }

  const security = {
    "content-security-policy": "frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  };
  const identityJson = { "cache-control": "no-store", "content-type": "application/json; charset=utf-8", ...security };
  const appJson = { "content-type": "application/json", vary: "Origin", ...security };

  const EXPECTED = {
    config: {
      status: 200,
      headers: identityJson,
      body: {
        provider: null,
        unclaimed: true,
        node_name: null,
        node_label: LAN_NAME,
        origin: ORIGIN,
        branding: { accent_color: null },
      },
    },
    discovery: {
      status: 200,
      headers: identityJson,
      body: { issuer: ORIGIN, jwks_uri: `${ORIGIN}/.well-known/jwks.json`, token_endpoint: null },
    },
    authorizationServer: {
      status: 200,
      headers: appJson,
      body: {
        issuer: ORIGIN,
        authorization_endpoint: `${ORIGIN}/oauth/authorize`,
        token_endpoint: `${ORIGIN}/oauth/token`,
        registration_endpoint: `${ORIGIN}/oauth/register`,
        revocation_endpoint: `${ORIGIN}/oauth/revoke`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        revocation_endpoint_auth_methods_supported: ["none"],
        scopes_supported: ["mcp"],
        client_id_metadata_document_supported: false,
        authorization_response_iss_parameter_supported: true,
      },
    },
    protectedResource: {
      status: 200,
      headers: appJson,
      body: { resource: `${ORIGIN}/mcp`, authorization_servers: [ORIGIN], bearer_methods_supported: ["header"], scopes_supported: ["mcp"] },
    },
    agentSetup: {
      status: 200,
      headers: { ...appJson, "x-stuga-user": "liv", "x-stuga-name": "Liv" },
      body: {
        url: ORIGIN,
        mcp_url: `${ORIGIN}/mcp`,
        node: { id: "ktbbpahhzxoldakw", name: LAN_NAME },
        reachable: false,
        // New: the remote address, null while it is off.
        remote: null,
        loopback: false,
        secure: true,
        bundle: { available: false },
        stdio: { command: "<node>", entry: "/opt/stuga/mcp.js" },
      },
    },
    mediaTicket: {
      status: 200,
      headers: {
        ...appJson,
        "cache-control": "no-store",
        // Was stuga_media on https too.
        "set-cookie": ["__Host-stuga_media=…; Path=/; HttpOnly; Max-Age=7200; SameSite=Lax; Secure"],
      },
      body: { expires_at: "<expiry>", workspace_id: "ws1" },
    },
    media: {
      status: 200,
      headers: {
        "cache-control": "private, max-age=31536000, immutable",
        "content-type": "image/png",
        "content-security-policy": "default-src 'none'; sandbox",
        // Was same-site.
        "cross-origin-resource-policy": "same-origin",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
        vary: "Origin",
      },
      // The first byte, 0x89, is not UTF-8.
      body: "\ufffdPNG",
    },
  };

  it("are what they were before remote access, but for the three changes it brought", async () => {
    expect(await answers()).toEqual(EXPECTED);
  });

  it("stay the same once the node has a remote address, on or off, but for agent setup and sign-in's config naming it while on", async () => {
    expect(await answers(bound(false))).toEqual(EXPECTED);
    const on = await answers(bound(true));
    expect(on).toEqual({
      ...EXPECTED,
      // Where a password of 15 characters or more also signs in, for the forms that set one.
      config: { ...EXPECTED.config, body: { ...EXPECTED.config.body, remote_origin: REMOTE_ORIGIN } },
      agentSetup: { ...EXPECTED.agentSetup, body: { ...EXPECTED.agentSetup.body, remote: { url: REMOTE_ORIGIN, mcp_url: `${REMOTE_ORIGIN}/mcp` } } },
    });
  });
});
