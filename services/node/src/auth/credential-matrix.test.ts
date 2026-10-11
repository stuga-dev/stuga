/**
 * Every credential against both listeners (spec §2.4, §12): a person's access token, an OAuth token,
 * a socket ticket, a media ticket and a signed upload are each good only at the listener that issued
 * them, and a person's ones only while the session they name is on. Through the dispatcher, with
 * real tokens and tickets; @stuga/db is mocked, its sessions a set this file controls.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createVerifier, loadOrCreateSigningKey, mintConnectorToken, signAccessToken, type LocalKeys } from "@stuga/auth";
import { SocketPair, upgradeResponse } from "@stuga/runtime";

/** Whether the document actor completes upgrades, and what the node noted about the sockets it opened. */
let actorUpgrades = false;
const track = vi.fn();
const closeSessions = vi.fn();

/** Live sessions as `${sid}@${arrival}`. */
const live = new Set<string>();
/** OAuth access token hashes, by the listener that issued them. */
const grants = new Map<string, "local" | "remote">();

vi.mock("@stuga/db", async (orig) => ({
  ...(await orig<typeof import("@stuga/db")>()),
  getDirectoryRow: vi.fn(async () => ({ display_name: "Liv", username: "liv", email: null })),
  resolveHumanAuth: vi.fn(async (_sql: unknown, _alias: string, _p: string, _ws: string | null, session?: { sessionId: string; arrival: string }) => ({
    user: { display_name: "Liv", username: "liv", email: null },
    membership: { workspace_id: "ws1", role: "member" },
    groupIds: [],
    sessionLive: session ? live.has(`${session.sessionId}@${session.arrival}`) : null,
  })),
  isSessionLive: vi.fn(async (_sql: unknown, s: { sessionId: string; arrival: string }) => live.has(`${s.sessionId}@${s.arrival}`)),
  grantForAccessToken: vi.fn(async (_sql: unknown, hash: string, arrival: string) =>
    grants.get(hash) === arrival
      ? { grant_id: "grt_1", agent_id: "agent-1", name: "Claude", owner: "liv", workspace_scope: null, access: "propose" }
      : null,
  ),
  getDoc: vi.fn(async () => ({ doc_id: "d1", workspace_id: "ws1", doc_type: "prose", acl_principals: ["user:liv"], acl_writers: ["user:liv"] })),
}));

const { createApp } = await import("../http/dispatch.js");
const { mintWsTicket } = await import("./ws-ticket.js");
const { mintMediaTicket } = await import("../media/media-auth.js");
const { ARRIVAL_HEADER } = await import("../platform/http-server.js");
import type { NodeEnv } from "../env.js";

type Where = "local" | "remote";
const LAN = "http://livs-air.local:8787";
const REMOTE = "https://k7f3q2.stuga.test";
const SECRET = "internal-secret-for-tests";
const HASH = "a".repeat(64);

const dir = mkdtempSync(join(tmpdir(), "stuga-matrix-"));
let keys: LocalKeys;
let app: ReturnType<typeof createApp>;
beforeAll(async () => {
  keys = await loadOrCreateSigningKey(join(dir, "signing.jwk"));
  const auth = { issuer: LAN, audience: "stuga" };
  const env = {
    publicOrigin: LAN,
    extraOrigins: [],
    sql: Object.assign(async () => [], {}),
    verifier: createVerifier(auth, keys),
    rateLimit: { limit: async () => ({ success: true }) },
    trustProxyHeaders: false,
    settings: { current: () => ({ maxBodyBytes: 1 << 20, nodeLabel: "livs-air", nodeName: null }) },
    internalSecret: SECRET,
    mediaCookieSameSite: "Lax",
    media: { get: async () => ({ body: new Uint8Array([0x89, 0x50]), httpMetadata: { contentType: "image/png" } }) },
    snapshots: { head: async () => null },
    docs: { get: () => ({ fetch: async () => (actorUpgrades ? upgradeResponse(new SocketPair().client) : new Response("to the actor")) }) },
    sessionSockets: { track, closeSessions },
    jobs: { send: async () => {} },
    remote: { current: () => ({ enabled: true, id: "k7f3q2", hostname: "k7f3q2.stuga.test", origin: REMOTE }) },
  } as unknown as NodeEnv;
  app = createApp(env);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  live.clear();
  grants.clear();
  actorUpgrades = false;
  track.mockClear();
  closeSessions.mockClear();
});

const origin = (where: Where) => (where === "remote" ? REMOTE : LAN);
function at(where: Where, path: string, init: { method?: string; headers?: Record<string, string> } = {}): Request {
  return new Request(origin(where) + path, {
    method: init.method ?? "GET",
    headers: { ...(where === "remote" ? { [ARRIVAL_HEADER]: "remote" } : {}), ...init.headers },
  });
}
/** A person's access token, issued at `where` for session `sid`. */
const personToken = (where: Where, sid = "sess-1") =>
  signAccessToken(keys, { alias: "liv", sid, username: "liv", displayName: "Liv", issuer: LAN, audience: where === "remote" ? REMOTE : "stuga", ttlSeconds: 600 });
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const both: Where[] = ["local", "remote"];

describe("a person's access token", () => {
  it("works only at the listener that issued it, and only while its session is on", async () => {
    for (const issued of both) {
      live.add(`sess-1@${issued}`);
      const token = await personToken(issued);
      for (const presented of both) {
        const res = await app.handle(at(presented, "/api/media/ticket", { headers: bearer(token) }));
        expect(res.status, `issued ${issued}, presented ${presented}`).toBe(issued === presented ? 200 : 401);
      }
      // Signed out, revoked or past its end: refused at once, everywhere, with no new ticket.
      live.clear();
      for (const presented of both) {
        expect((await app.handle(at(presented, "/api/media/ticket", { headers: bearer(token) }))).status).toBe(401);
        expect((await app.handle(at(presented, "/api/ws/ticket?doc=d1", { headers: bearer(token) }))).status).toBe(401);
      }
    }
  });

  it("is refused on /mcp at the other listener too", async () => {
    live.add("sess-1@local");
    const token = await personToken("local");
    expect((await app.handle(at("local", "/mcp", { method: "POST", headers: { ...bearer(token), "content-type": "application/json" } }))).status).not.toBe(401);
    const remote = await app.handle(at("remote", "/mcp", { method: "POST", headers: { ...bearer(token), "content-type": "application/json" } }));
    expect(remote.status).toBe(401);
    expect(remote.headers.get("www-authenticate")).toContain(REMOTE);
  });
});

describe("an OAuth access token", () => {
  it("opens /mcp only at the listener the person consented at", async () => {
    for (const issued of both) {
      const access = mintConnectorToken("access");
      grants.set(access.hash, issued);
      for (const presented of both) {
        const res = await app.handle(at(presented, "/mcp", { method: "POST", headers: { ...bearer(access.token), "content-type": "application/json" } }));
        expect(res.status === 401, `issued ${issued}, presented ${presented}`).toBe(issued !== presented);
      }
    }
  });
});

describe("a socket ticket", () => {
  const ticket = (where: Where, sid = "sess-1") =>
    mintWsTicket(SECRET, { alias: "liv", workspaceId: "ws1", docId: "d1", canWrite: true, sid, arrival: where }).value;
  const upgrade = (where: Where, value: string) =>
    app.upgrade(at(where, `/ws/d1?ticket=${encodeURIComponent(value)}`, { headers: { upgrade: "websocket" } }));

  it("opens a socket only at the listener that minted it, and only while its session is on", async () => {
    for (const minted of both) {
      live.add(`sess-1@${minted}`);
      for (const presented of both) {
        const res = await upgrade(presented, ticket(minted));
        expect(res.status === 401, `minted ${minted}, presented ${presented}`).toBe(minted !== presented);
      }
      live.clear();
      // A socket closed when its session ends does not open again on the ticket in hand.
      expect((await upgrade(minted, ticket(minted))).status).toBe(401);
    }
  });

  it("notes the socket it opens under its session, so ending the session closes it", async () => {
    actorUpgrades = true;
    live.add("sess-7@remote");
    const res = await upgrade("remote", ticket("remote", "sess-7"));
    expect(res.status).toBe(101);
    expect(track).toHaveBeenCalledWith("sess-7", "liv", res, "remote", "ws1");
    expect(closeSessions).not.toHaveBeenCalled();
  });

  it("closes the socket it just opened when the session ended while it was opening", async () => {
    actorUpgrades = true;
    live.add("sess-7@remote");
    const { isSessionLive } = await import("@stuga/db");
    // Live when the ticket's context was built; revoked by the time the socket is tracked.
    vi.mocked(isSessionLive).mockResolvedValueOnce(false);
    const res = await upgrade("remote", ticket("remote", "sess-7"));
    expect(track).toHaveBeenCalledWith("sess-7", "liv", res, "remote", "ws1");
    expect(closeSessions).toHaveBeenCalledWith(["sess-7"]);
  });
});

describe("a media ticket", () => {
  const read = (where: Where, value: string) =>
    app.handle(at(where, `/api/docs/d1/media/${HASH}`, { headers: { cookie: `stuga_media=${value}; __Host-stuga_media=${value}` } }));
  const ticket = async (where: Where, sid: string | null = "sess-1") =>
    (await mintMediaTicket(SECRET, { alias: "liv", workspaceId: "ws1", sid, arrival: where })).value;

  it("reads media only at the listener that minted it", async () => {
    live.add("sess-1@local");
    live.add("sess-1@remote");
    for (const minted of both) {
      for (const presented of both) {
        expect((await read(presented, await ticket(minted))).status, `minted ${minted}, presented ${presented}`).toBe(minted === presented ? 200 : 401);
      }
    }
  });

  it("needs its session on at the remote address; on the LAN it lapses on its own", async () => {
    expect((await read("remote", await ticket("remote"))).status).toBe(401);
    expect((await read("local", await ticket("local"))).status).toBe(200);
    // An agent key's ticket names no session, and is good where it was minted.
    expect((await read("remote", await ticket("remote", null))).status).toBe(200);
  });
});

describe("a signed upload", () => {
  it("is taken only at the listener that staged it", async () => {
    const { createHmac } = await import("node:crypto");
    const upload = "upl_abc_000000000000000000";
    const sig = (where: Where) => createHmac("sha256", SECRET).update(`media-upload/${where}:d1:${upload}`).digest("hex");
    for (const staged of both) {
      for (const presented of both) {
        const res = await app.handle(at(presented, `/api/docs/d1/media/uploads/${upload}?sig=${sig(staged)}`, { method: "PUT" }));
        // Past the signature, an upload nobody staged is gone (410: the id's expiry has passed) or unknown (404).
        expect(res.status === 403, `staged ${staged}, presented ${presented}`).toBe(staged !== presented);
      }
    }
  });
});
