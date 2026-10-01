/**
 * A person's passkeys from the account API (./passkeys.ts): listed, renamed, removed (which ends the
 * sign-ins they made and closes their sockets), and the offer dismissed. The queries are tested
 * against Postgres in packages/db passkeys.integration.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@stuga/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@stuga/db")>()),
  listPasskeys: vi.fn(async () => [
    {
      credential_id: "cred-1",
      rp_id: "k7f3q2.stuga.test",
      name: "iCloud Keychain",
      synced: true,
      backup_eligible: true,
      created_at: "2026-09-30T10:00:00.000Z",
      last_used_at: null,
    },
    {
      credential_id: "cred-0",
      rp_id: "old1.stuga.test",
      name: "Security key",
      synced: false,
      backup_eligible: false,
      created_at: "2026-09-01T10:00:00.000Z",
      last_used_at: "2026-09-02T10:00:00.000Z",
    },
  ]),
  renamePasskey: vi.fn(async (_sql: unknown, _alias: string, id: string) => id === "cred-1"),
  removePasskey: vi.fn(async (_sql: unknown, _alias: string, id: string) =>
    id === "cred-1" ? { name: "iCloud Keychain", synced: true, backup_eligible: true, sessionIds: ["sess-1", "sess-9"] } : null,
  ),
  dismissPasskeyOffer: vi.fn(async () => {}),
}));

vi.mock("../audit/record.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../audit/record.js")>()),
  recordAudit: vi.fn(),
}));

const alerts = { passkeyRemoved: vi.fn(async () => {}) };
vi.mock("../identity/alerts.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../identity/alerts.js")>()),
  alertsFor: () => alerts,
}));

const db = await import("@stuga/db");
const { recordAudit } = await import("../audit/record.js");
const { dismissOwnPasskeyOffer, listOwnPasskeys, removeOwnPasskey, renameOwnPasskey } = await import("./passkeys.js");
const { getLinkAddresses } = await import("./link-addresses.js");
import type { AccountCtx } from "../auth/context.js";
import { personCtx } from "../testing/ctx.js";

const closeSessions = vi.fn();
const remote = { current: () => ({ enabled: true, id: "k7f3q2", hostname: "k7f3q2.stuga.test", origin: "https://k7f3q2.stuga.test" }) };
const ctx = (): AccountCtx =>
  personCtx({ alias: "u_bo", sid: "sess-1", env: { sessionSockets: { closeSessions }, remote } }) as unknown as AccountCtx;

function call(method: string, path: string, body?: unknown, match: string[] = [path]) {
  const req = new Request(`https://stuga.test${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  return { ctx: ctx(), req, url: new URL(req.url), match };
}

beforeEach(() => vi.clearAllMocks());

describe("the account's passkeys", () => {
  it("are listed with whether each is synced, never a key, and those for an address the node no longer has marked", async () => {
    const res = await listOwnPasskeys(call("GET", "/api/me/passkeys"));
    expect(await res.json()).toEqual({
      passkeys: [
        { id: "cred-1", name: "iCloud Keychain", synced: true, created_at: "2026-09-30T10:00:00.000Z", last_used_at: null },
        {
          id: "cred-0",
          name: "Security key",
          synced: false,
          created_at: "2026-09-01T10:00:00.000Z",
          last_used_at: "2026-09-02T10:00:00.000Z",
          elsewhere: true,
        },
      ],
    });
  });

  it("are renamed with a name of 1 to 64 printable characters", async () => {
    const ok = await renameOwnPasskey(call("PATCH", "/api/me/passkeys/cred-1", { name: "  Work laptop " }, ["", "cred-1"]));
    expect(await ok.json()).toEqual({ id: "cred-1", name: "Work laptop" });
    expect(db.renamePasskey).toHaveBeenCalledWith(expect.anything(), "u_bo", "cred-1", "Work laptop");
    for (const name of ["", "   ", "x".repeat(65), "a\u0007b", 5]) {
      expect((await renameOwnPasskey(call("PATCH", "/api/me/passkeys/cred-1", { name }, ["", "cred-1"]))).status).toBe(400);
    }
    expect((await renameOwnPasskey(call("PATCH", "/api/me/passkeys/cred-x", { name: "Mine" }, ["", "cred-x"]))).status).toBe(404);
  });

  it("are removed with the sign-ins they made, whose sockets close; the person is told, and whether it was this sign-in", async () => {
    const res = await removeOwnPasskey(call("DELETE", "/api/me/passkeys/cred-1", undefined, ["", "cred-1"]));
    expect(await res.json()).toEqual({ removed: true, signed_out: true });
    expect(closeSessions).toHaveBeenCalledWith(["sess-1", "sess-9"]);
    expect(alerts.passkeyRemoved).toHaveBeenCalledWith({ alias: "u_bo", name: "iCloud Keychain" });
    expect((recordAudit as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toMatchObject({
      action: "node.passkey.remove",
      detail: { name: "iCloud Keychain", synced: true, sessions: 2 },
    });
    const missing = await removeOwnPasskey(call("DELETE", "/api/me/passkeys/cred-x", undefined, ["", "cred-x"]));
    expect(missing.status).toBe(404);
    expect(closeSessions).toHaveBeenCalledTimes(1);
  });

  it("are not offered again once the person says Not now", async () => {
    const res = await dismissOwnPasskeyOffer(call("POST", "/api/me/passkey-offer/dismiss"));
    expect(res.status).toBe(204);
    expect(db.dismissPasskeyOffer).toHaveBeenCalledWith(expect.anything(), "u_bo");
  });
});

describe("GET /api/link-addresses", () => {
  it("says what a link can point at", async () => {
    const res = await getLinkAddresses(call("GET", "/api/link-addresses"));
    expect(await res.json()).toEqual({ remote: true, local: "network", default: "local" });
  });
});
