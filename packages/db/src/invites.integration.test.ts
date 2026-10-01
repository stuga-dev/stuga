/** Workspace invite links: which ones the Members page lists, and that a use is counted once however many arrive at once. */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createClient, closeClients } from "./client.js";
import { initSchema } from "./schema/migrate.js";
import { createLocalAccount, createProviderAccount } from "./identity.js";
import {
  insertWorkspaceInvite,
  isWorkspaceInviteRedeemable,
  workspaceInviteStatus,
  listWorkspaceInvites,
  provisionWorkspace,
  redeemWorkspaceInvite,
  revokeWorkspaceInvite,
} from "./workspaces.js";
import type { Sql } from "./client.js";

const URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!URL)("workspace invite links", () => {
  let sql: Sql;
  const WS = "ws-invites";

  beforeAll(async () => {
    sql = createClient(URL!);
    await initSchema(sql);
  });
  afterAll(async () => {
    await closeClients();
  });
  beforeEach(async () => {
    await sql`TRUNCATE workspaces, users CASCADE`;
    await provisionWorkspace(sql, { workspaceId: WS, name: "Invites", owner: "alice" });
  });

  function invite(tokenHash: string, limits: { expiresAt?: string | null; maxUses?: number | null } = {}) {
    return insertWorkspaceInvite(sql, {
      tokenHash,
      workspaceId: WS,
      role: "member",
      createdBy: "alice",
      expiresAt: limits.expiresAt ?? null,
      maxUses: limits.maxUses ?? null,
    });
  }

  it("lists only the links that could still admit someone, newest first", async () => {
    await invite("reusable");
    await invite("lapses-tomorrow", { expiresAt: new Date(Date.now() + 86_400_000).toISOString(), maxUses: 1 });
    await invite("lapsed", { expiresAt: new Date(Date.now() - 1_000).toISOString() });
    await invite("used-up", { maxUses: 1 });
    await invite("revoked");
    expect((await redeemWorkspaceInvite(sql, "used-up", "bob")).ok).toBe(true);
    expect(await revokeWorkspaceInvite(sql, "revoked", WS)).toBe(true);

    const listed = await listWorkspaceInvites(sql, WS);
    expect(listed.map((i) => i.token_hash)).toEqual(["lapses-tomorrow", "reusable"]);
    expect(listed.map((i) => i.token_hint)).toEqual([null, null]);
    for (const gone of ["lapsed", "used-up", "revoked"]) {
      expect(await isWorkspaceInviteRedeemable(sql, gone)).toBe(false);
    }
  });

  it("keeps the hint a link is listed by", async () => {
    await insertWorkspaceInvite(sql, {
      tokenHash: "hinted",
      tokenHint: "wLl1",
      workspaceId: WS,
      role: "guest",
      createdBy: "alice",
      expiresAt: null,
      maxUses: 1,
    });
    expect((await listWorkspaceInvites(sql, WS)).map((i) => i.token_hint)).toEqual(["wLl1"]);
  });

  it("a one-person link admits one person when several redeem it at once", async () => {
    await invite("once", { maxUses: 1 });
    const results = await Promise.all(["bob", "carol", "dave"].map((alias) => redeemWorkspaceInvite(sql, "once", alias)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const [row] = await sql<{ use_count: number }[]>`SELECT use_count FROM workspace_invites WHERE token_hash = 'once'`;
    expect(row!.use_count).toBe(1);
    expect(await listWorkspaceInvites(sql, WS)).toEqual([]);
  });

  it("admits with a link that has no limit or no expiry only on the node's own network, wherever it is spent", async () => {
    const soon = new Date(Date.now() + 86_400_000).toISOString();
    await invite("open");
    await invite("no-expiry", { maxUses: 5 });
    await invite("no-limit", { expiresAt: soon });
    await invite("bounded", { expiresAt: soon, maxUses: 5 });
    for (const hash of ["open", "no-expiry", "no-limit"]) {
      expect(await workspaceInviteStatus(sql, hash, "remote")).toBe("local_only");
      expect(await workspaceInviteStatus(sql, hash, "local")).toBe("ok");
      expect(await redeemWorkspaceInvite(sql, hash, "bob", "remote")).toEqual({ ok: false, reason: "local_only" });
    }
    expect(await workspaceInviteStatus(sql, "bounded", "remote")).toBe("ok");
    expect(await workspaceInviteStatus(sql, "gone", "remote")).toBe("invalid");
    // A refusal spends nothing.
    const [row] = await sql<{ use_count: number }[]>`SELECT use_count FROM workspace_invites WHERE token_hash = 'open'`;
    expect(row!.use_count).toBe(0);

    // Making an account: refused at the remote address, with nothing made; fine on the node's own network.
    await sql`INSERT INTO users (alias, username, display_name) VALUES ('owner', 'owner', 'Owner') ON CONFLICT DO NOTHING`;
    const remote = await createLocalAccount(sql, { alias: "u_mal", username: "mallory", passwordHash: "h", inviteHash: "open", arrival: "remote" });
    expect(remote).toEqual({ ok: false, reason: "invite_local_only" });
    expect(await sql`SELECT 1 FROM users WHERE alias = 'u_mal'`).toHaveLength(0);
    await sql`
      INSERT INTO node_settings (id, idp_issuer, idp_client_id) VALUES (TRUE, 'https://idp.test', 'stuga')
      ON CONFLICT (id) DO UPDATE SET idp_issuer = EXCLUDED.idp_issuer, idp_client_id = EXCLUDED.idp_client_id`;
    const provider = await createProviderAccount(sql, {
      alias: "u_eve",
      username: "eve",
      displayName: "Eve",
      email: null,
      oidcSub: "sub-eve",
      issuer: "https://idp.test",
      inviteHash: "open",
      arrival: "remote",
    });
    expect(provider).toEqual({ ok: false, reason: "invite_local_only" });
    const local = await createLocalAccount(sql, { alias: "u_bob", username: "bob", passwordHash: "h", inviteHash: "open", arrival: "local" });
    expect(local.ok).toBe(true);
    expect((await createLocalAccount(sql, { alias: "u_cy", username: "cy", passwordHash: "h", inviteHash: "bounded", arrival: "remote" })).ok).toBe(true);
  });
});
