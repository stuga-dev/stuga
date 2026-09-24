/** Invite links: what a link may carry, the limits it is minted with, and the ledger rows its life leaves behind. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "@stuga/auth";

vi.mock("@stuga/db", () => ({
  getMemberRole: vi.fn(async () => "owner"),
  insertWorkspaceInvite: vi.fn(async () => {}),
  listWorkspaceInvites: vi.fn(async () => []),
  redeemWorkspaceInvite: vi.fn(),
  revokeWorkspaceInvite: vi.fn(async () => true),
}));

const db = await import("@stuga/db");
const { createInvite, redeemInvite, revokeInvite } = await import("./invites.js");
import type { AccountCtx, Ctx } from "../auth/context.js";

const mockRole = db.getMemberRole as unknown as ReturnType<typeof vi.fn>;
const mockInsert = db.insertWorkspaceInvite as unknown as ReturnType<typeof vi.fn>;
const mockRedeem = db.redeemWorkspaceInvite as unknown as ReturnType<typeof vi.fn>;
const mockRevoke = db.revokeWorkspaceInvite as unknown as ReturnType<typeof vi.fn>;

const send = vi.fn(async () => {});

function ctx(): Ctx {
  return {
    sql: {},
    alias: "u_owner",
    displayName: "Owner",
    email: null,
    isAgent: false,
    surface: "web",
    requestId: "req-1",
    env: { publicOrigin: "http://node.test:8787", jobs: { send } },
    principals: ["user:u_owner"],
    workspaceId: "ws1",
    role: "owner",
  } as unknown as Ctx;
}

async function create(body: unknown): Promise<Response> {
  const path = "/api/workspaces/ws1/invites";
  const req = new Request(`http://node.test:8787${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return createInvite({ ctx: ctx(), req, url: new URL(req.url), match: [path, "ws1"] });
}

/** The audit messages sent so far, by action. */
function audited(action: string) {
  return send.mock.calls.map((call) => (call as unknown[])[0] as Record<string, unknown>).filter((m) => m.action === action);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRole.mockResolvedValue("owner");
  mockRevoke.mockResolvedValue(true);
});

describe("POST /api/workspaces/:id/invites", () => {
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
      detail: { role: "member", max_uses: 1, expires_at: body.expires_at },
    });
    expect(JSON.stringify(row)).not.toContain(body.token);
  });

  it("omitting both limits mints a reusable link that does not lapse", async () => {
    const res = await create({ role: "guest" });
    expect(res.status).toBe(201);
    expect(mockInsert.mock.calls[0]![1]).toMatchObject({ role: "guest", expiresAt: null, maxUses: null });
  });

  it("refuses a malformed limit rather than minting a link that never lapses", async () => {
    for (const bad of [{ expires_in_days: "7" }, { expires_in_days: 0 }, { max_uses: 0 }, { max_uses: 1.5 }, { max_uses: "1" }]) {
      expect((await create({ role: "member", ...bad })).status).toBe(400);
    }
    expect(mockInsert).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("an admin link admits exactly one person", async () => {
    expect((await create({ role: "admin" })).status).toBe(400);
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
      expect.objectContaining({ workspaceId: "ws1", targetKind: "invite", targetId: hash.slice(0, 12) }),
    ]);
    mockRevoke.mockResolvedValue(false);
    expect((await call()).status).toBe(404);
    expect(audited("invite.revoke")).toHaveLength(1);
  });

  it("records a join in the workspace the link belongs to, with the role it kept", async () => {
    mockRedeem.mockResolvedValue({ ok: true, workspaceId: "ws9", role: "guest" });
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
        detail: { role: "guest" },
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
});
