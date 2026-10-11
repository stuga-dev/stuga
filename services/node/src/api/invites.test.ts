/** Invite links: what a link may carry, the limits it is minted with, and the ledger rows its life leaves behind. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "@stuga/auth";

vi.mock("@stuga/db", () => ({
  getMemberRole: vi.fn(async () => "owner"),
  insertWorkspaceInvite: vi.fn(async () => {}),
  listWorkspaceInvites: vi.fn(async () => []),
  redeemWorkspaceInvite: vi.fn(),
  revokeWorkspaceInvite: vi.fn(async () => ({ role: "member", token_hint: "Ab12", note: null })),
}));

const db = await import("@stuga/db");
const { createInvite, redeemInvite, revokeInvite } = await import("./invites.js");
import type { AccountCtx, Ctx } from "../auth/context.js";
import { personCtx } from "../testing/ctx.js";

const mockRole = db.getMemberRole as unknown as ReturnType<typeof vi.fn>;
const mockInsert = db.insertWorkspaceInvite as unknown as ReturnType<typeof vi.fn>;
const mockRedeem = db.redeemWorkspaceInvite as unknown as ReturnType<typeof vi.fn>;
const mockRevoke = db.revokeWorkspaceInvite as unknown as ReturnType<typeof vi.fn>;

const send = vi.fn(async () => {});

function ctx(over: { servedOrigin?: string; arrival?: "local" | "remote" } = {}): Ctx {
  return personCtx({
    ...over,
    alias: "u_owner",
    displayName: "Owner",
    surface: "web",
    requestId: "req-1",
    principals: ["user:u_owner"],
    role: "owner",
    env: { publicOrigin: "http://node.test:8787", jobs: { send } },
  });
}

async function create(body: unknown, servedOrigin?: string): Promise<Response> {
  const path = "/api/workspaces/ws1/invites";
  const req = new Request(`http://node.test:8787${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const remote = servedOrigin === REMOTE;
  return createInvite({
    ctx: ctx(servedOrigin ? { servedOrigin, arrival: remote ? "remote" : "local" } : {}),
    req,
    url: new URL(req.url),
    match: [path, "ws1"],
  });
}
const REMOTE = "https://k7f3q2.stuga.test";

/** The audit messages sent so far, by action. */
function audited(action: string) {
  return send.mock.calls.map((call) => (call as unknown[])[0] as Record<string, unknown>).filter((m) => m.action === action);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRole.mockResolvedValue("owner");
  mockRevoke.mockResolvedValue({ role: "member", token_hint: "Ab12", note: null });
});

describe("POST /api/workspaces/:id/invites", () => {
  it("hands the link out on the origin it was asked at", async () => {
    const res = await create({ role: "member" }, "https://k7f3q2.stuga.test");
    const body = (await res.json()) as { token: string; join_url: string };
    expect(body.join_url).toBe(`https://k7f3q2.stuga.test/join/${body.token}`);
  });

  it("mints a one-person link that lapses, and records it by a reference that is not the token", async () => {
    const before = Date.now();
    const res = await create({ role: "member", max_uses: 1, expires_in_days: 7 });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { token: string; join_url: string; expires_at: string; max_uses: number };
    expect(body.join_url).toBe(`http://node.test:8787/join/${body.token}`);
    expect(body.max_uses).toBe(1);
    const lapses = Date.parse(body.expires_at) - before;
    expect(lapses).toBeGreaterThanOrEqual(7 * 86400_000);
    expect(lapses).toBeLessThan(7 * 86400_000 + 60_000);

    const stored = mockInsert.mock.calls[0]![1];
    expect(stored).toMatchObject({ workspaceId: "ws1", role: "member", maxUses: 1, createdBy: "u_owner" });
    expect(stored.tokenHash).toBe(sha256Hex(body.token));

    const [row] = audited("invite.create");
    expect(row).toMatchObject({
      kind: "audit",
      workspaceId: "ws1",
      actor: "u_owner",
      source: "web",
      targetKind: "invite",
      targetId: sha256Hex(body.token).slice(0, 12),
      targetLabel: null,
      detail: { role: "member", hint: body.token.slice(-4), max_uses: 1, expires_at: body.expires_at },
    });
    expect(JSON.stringify(row)).not.toContain(body.token);
  });

  it("keeps who a link is for, trimmed, and names the ledger row by it", async () => {
    const res = await create({ role: "guest", note: "  Sofia  " });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { note: string }).note).toBe("Sofia");
    expect(mockInsert.mock.calls[0]![1]).toMatchObject({ note: "Sofia" });
    expect(audited("invite.create")[0]).toMatchObject({ targetLabel: "Sofia" });

    expect((await create({ role: "guest", note: "   " })).status).toBe(201);
    expect(mockInsert.mock.calls[1]![1]).toMatchObject({ note: null });
    expect((await create({ role: "guest", note: 7 })).status).toBe(400);
  });

  it("omitting both limits mints what the dialog offers: one person, seven days", async () => {
    const res = await create({ role: "guest" });
    expect(res.status).toBe(201);
    const row = mockInsert.mock.calls[0]![1] as { role: string; expiresAt: string; maxUses: number };
    expect(row).toMatchObject({ role: "guest", maxUses: 1 });
    expect(Date.parse(row.expiresAt) - Date.now()).toBeGreaterThan(6.9 * 86400_000);
  });

  it("mints a link with no limit or no expiry only when asked by null, and only on the node's own network", async () => {
    expect((await create({ role: "member", max_uses: null, expires_in_days: null })).status).toBe(201);
    expect(mockInsert.mock.calls[0]![1]).toMatchObject({ expiresAt: null, maxUses: null });
    mockInsert.mockClear();
    for (const open of [{ max_uses: null }, { expires_in_days: null }]) {
      const res = await create({ role: "member", ...open }, REMOTE);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("invite_local_only");
    }
    expect(mockInsert).not.toHaveBeenCalled();
    // At the remote address a link with both limits is fine.
    expect((await create({ role: "member" }, REMOTE)).status).toBe(201);
  });

  it("points where its maker asks: the node's own network or the remote address, which must be on", async () => {
    const remote = { current: () => ({ enabled: true, id: "k7f3q2", hostname: "k7f3q2.stuga.test", origin: REMOTE }) };
    const make = (body: unknown, over: { arrival?: "local" | "remote"; servedOrigin?: string; remote?: unknown } = {}) => {
      const path = "/api/workspaces/ws1/invites";
      const req = new Request(`http://node.test:8787${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const c = personCtx({
        alias: "u_owner",
        role: "owner",
        arrival: over.arrival ?? "local",
        servedOrigin: over.servedOrigin ?? "http://node.test:8787",
        env: { publicOrigin: "http://node.test:8787", jobs: { send }, remote: over.remote },
      });
      return createInvite({ ctx: c, req, url: new URL(req.url), match: [path, "ws1"] });
    };
    const anywhere = (await (await make({ role: "member", address: "remote" }, { remote })).json()) as { join_url: string; address: string };
    expect(anywhere).toMatchObject({ address: "remote", join_url: expect.stringMatching(/^https:\/\/k7f3q2\.stuga\.test\/join\//) });
    const here = (await (await make({ role: "member", address: "local" }, { arrival: "remote", servedOrigin: REMOTE, remote })).json()) as {
      join_url: string;
      address: string;
    };
    expect(here).toMatchObject({ address: "local", join_url: expect.stringMatching(/^http:\/\/node\.test:8787\/join\//) });
    // A link with no limit is for the node's own network, wherever it is made.
    expect((await make({ role: "member", max_uses: null, address: "local" }, { arrival: "remote", servedOrigin: REMOTE, remote })).status).toBe(201);
    const open = await make({ role: "member", max_uses: null, address: "remote" }, { remote });
    expect(open.status).toBe(400);
    expect((await open.json()).error).toBe("invite_local_only");
    // The remote address only while it is on.
    const off = await make({ role: "member", address: "remote" });
    expect(off.status).toBe(409);
    expect((await off.json()).error).toBe("remote_off");
    expect((await make({ role: "member", address: "elsewhere" })).status).toBe(400);
  });

  it("refuses a malformed limit rather than minting a link that never lapses", async () => {
    for (const bad of [{ expires_in_days: "7" }, { expires_in_days: 0 }, { max_uses: 0 }, { max_uses: 1.5 }, { max_uses: "1" }]) {
      expect((await create({ role: "member", ...bad })).status).toBe(400);
    }
    expect(mockInsert).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("an admin link admits exactly one person", async () => {
    expect((await create({ role: "admin", max_uses: null })).status).toBe(400);
    expect((await create({ role: "admin", max_uses: 2 })).status).toBe(400);
    expect(mockInsert).not.toHaveBeenCalled();
    expect((await create({ role: "admin", max_uses: 1, expires_in_days: 1 })).status).toBe(201);
  });

  it("only an owner mints an admin link, and nobody mints ownership", async () => {
    mockRole.mockResolvedValue("admin");
    expect((await create({ role: "admin", max_uses: 1 })).status).toBe(403);
    expect((await create({ role: "owner", max_uses: 1 })).status).toBe(400);
    mockRole.mockResolvedValue("member");
    expect((await create({ role: "member" })).status).toBe(403);
    expect(mockInsert).not.toHaveBeenCalled();
  });
});

describe("revoking and redeeming", () => {
  it("records a revoke only when a live link was revoked", async () => {
    const hash = sha256Hex("inv_abc");
    const path = `/api/workspaces/ws1/invites/${hash}`;
    const call = () => {
      const req = new Request(`http://node.test:8787${path}`, { method: "DELETE" });
      return revokeInvite({ ctx: ctx(), req, url: new URL(req.url), match: [path, "ws1", hash] });
    };
    expect((await call()).status).toBe(200);
    expect(audited("invite.revoke")).toEqual([
      expect.objectContaining({
        workspaceId: "ws1",
        targetKind: "invite",
        targetId: hash.slice(0, 12),
        targetLabel: null,
        detail: { role: "member", hint: "Ab12" },
      }),
    ]);
    mockRevoke.mockResolvedValue(null);
    expect((await call()).status).toBe(404);
    expect(audited("invite.revoke")).toHaveLength(1);
  });

  it("records a join in the workspace the link belongs to, with the role it kept", async () => {
    mockRedeem.mockResolvedValue({ ok: true, workspaceId: "ws9", role: "guest", invite: { role: "member", token_hint: "Zz9_", note: "Gus" } });
    const req = new Request("http://node.test:8787/api/invites/redeem", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "inv_xyz" }),
    });
    const account = ctx() as unknown as AccountCtx;
    const res = await redeemInvite({ ctx: account, req, url: new URL(req.url), match: ["/api/invites/redeem"] });
    expect(res.status).toBe(200);
    expect(audited("invite.redeem")).toEqual([
      expect.objectContaining({
        workspaceId: "ws9",
        actor: "u_owner",
        targetKind: "invite",
        targetId: sha256Hex("inv_xyz").slice(0, 12),
        targetLabel: "Gus",
        detail: { role: "guest", hint: "Zz9_" },
      }),
    ]);
  });

  it("a refused redemption records nothing", async () => {
    mockRedeem.mockResolvedValue({ ok: false, reason: "invalid" });
    const req = new Request("http://node.test:8787/api/invites/redeem", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "inv_gone" }),
    });
    const res = await redeemInvite({ ctx: ctx() as unknown as AccountCtx, req, url: new URL(req.url), match: ["/api/invites/redeem"] });
    expect(res.status).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses a link with no limit or no expiry at the remote address, saying why", async () => {
    mockRedeem.mockResolvedValue({ ok: false, reason: "local_only" });
    const req = new Request("https://k7f3q2.stuga.test/api/invites/redeem", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "inv_open" }),
    });
    const remote = personCtx({ alias: "u_owner", arrival: "remote" }) as unknown as AccountCtx;
    const res = await redeemInvite({ ctx: remote, req, url: new URL(req.url), match: ["/api/invites/redeem"] });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("invite_local_only");
    expect(mockRedeem).toHaveBeenCalledWith(expect.anything(), sha256Hex("inv_open"), "u_owner", "remote");
    expect(send).not.toHaveBeenCalled();
  });
});
