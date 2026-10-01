import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createClient, closeClients } from "./client.js";
import { initSchema } from "./schema/migrate.js";
import { createDoc } from "./docs.js";
import { createOidcFlow } from "./oidc.js";
import {
  addLocalPassword,
  createRefreshSession,
  createRefreshSessionIf,
  endRefreshSession,
  findAccountByAlias,
  isSessionLive,
  linkIdentity,
  replaceLocalPassword,
  revokeRefreshSessions,
  rotateRefreshSession,
  sessionConfirmedAt,
  type NewRefreshSession,
} from "./identity.js";
import {
  confirmSession,
  isKnownDevice,
  purgeKnownDevices,
  rememberDevice,
  revokeEverything,
  revokeEverythingCounts,
} from "./account-security.js";
import { seedUser, seedWorkspaces } from "./testing/fixtures.js";
import type { Sql } from "./client.js";

const URL = process.env.TEST_DATABASE_URL;
const WS = "ws-sec";

const session = (over: Partial<NewRefreshSession> & { id: string; alias: string }): NewRefreshSession => ({
  sessionId: over.id,
  tokenHash: `hash-${over.id}`,
  expiresAt: new Date(Date.now() + 3_600_000),
  arrival: "local",
  signedInWith: "password",
  absoluteExpiresAt: null,
  ...over,
});

describe.skipIf(!URL)("account security", () => {
  let sql: Sql;

  beforeAll(async () => {
    sql = createClient(URL!);
    await initSchema(sql);
  });
  afterAll(async () => {
    await closeClients();
  });
  beforeEach(async () => {
    await sql`TRUNCATE users, local_accounts, refresh_sessions, known_devices, password_resets, oidc_flows, oidc_tickets,
              api_keys, oauth_grants, oauth_tokens, oauth_codes, workspace_invites, share_links, docs, workspaces CASCADE`;
    await seedWorkspaces(sql, WS);
    await seedUser(sql, "u_bo", "Bo", null, "bo");
    await seedUser(sql, "u_liv", "Liv", null, "liv");
    await sql`INSERT INTO local_accounts (alias, password_hash) VALUES ('u_bo', 'old-hash'), ('u_liv', 'liv-hash')`;
  });

  describe("confirming a sign-in", () => {
    it("moves confirmed_at on every live row of that sign-in, and nothing else", async () => {
      const ends = new Date(Date.now() + 86_400_000);
      await createRefreshSession(sql, session({ id: "r1", sessionId: "s1", alias: "u_bo", arrival: "remote", absoluteExpiresAt: ends }));
      await createRefreshSession(sql, session({ id: "r2", sessionId: "s1", alias: "u_bo", arrival: "remote", absoluteExpiresAt: ends }));
      await createRefreshSession(sql, session({ id: "r3", sessionId: "s2", alias: "u_bo", arrival: "remote", absoluteExpiresAt: ends }));
      await sql`UPDATE refresh_sessions SET confirmed_at = now() - interval '1 hour', signed_in_at = now() - interval '1 hour'`;

      expect(await confirmSession(sql, { sessionId: "s1", alias: "u_bo", arrival: "remote" })).toBe(true);
      const rows = await sql<{ id: string; confirmed_at: Date; signed_in_at: Date; absolute_expires_at: Date }[]>`
        SELECT id, confirmed_at, signed_in_at, absolute_expires_at FROM refresh_sessions ORDER BY id`;
      for (const row of rows) expect(row.absolute_expires_at.getTime()).toBe(ends.getTime());
      expect(rows.map((r) => Date.now() - r.confirmed_at.getTime() < 60_000)).toEqual([true, true, false]);
      expect(rows.every((r) => Date.now() - r.signed_in_at.getTime() > 59 * 60_000)).toBe(true);
      expect((await sessionConfirmedAt(sql, { sessionId: "s1", alias: "u_bo", arrival: "remote" }))!.getTime()).toBeGreaterThan(Date.now() - 60_000);
    });

    it("is refused for a sign-in that ended, another person's, or one at the other listener", async () => {
      await createRefreshSession(sql, session({ id: "r1", alias: "u_bo" }));
      expect(await confirmSession(sql, { sessionId: "r1", alias: "u_liv", arrival: "local" })).toBe(false);
      expect(await confirmSession(sql, { sessionId: "r1", alias: "u_bo", arrival: "remote" })).toBe(false);
      await sql`UPDATE refresh_sessions SET revoked_at = now()`;
      expect(await confirmSession(sql, { sessionId: "r1", alias: "u_bo", arrival: "local" })).toBe(false);
    });
  });

  describe("a confirmation through the identity provider", () => {
    const flow = (over: Partial<Parameters<typeof createOidcFlow>[1]>) =>
      createOidcFlow(sql, {
        state: `st-${Math.random()}`, bindingHash: "b", nonce: "n", codeVerifier: "v", redirectUri: "http://x.test/cb",
        prompt: "login", linkAlias: "u_bo", returnTo: "/", expiresAt: new Date(Date.now() + 600_000), ...over,
      });

    it("asks the provider to sign the person in again, for one of their sign-ins", async () => {
      await flow({ confirmSession: "s1" });
      expect(await sql`SELECT prompt, link_alias, confirm_session FROM oidc_flows`).toEqual([
        { prompt: "login", link_alias: "u_bo", confirm_session: "s1" },
      ]);
    });

    it("never stands for anyone's but a linked account's, with prompt login", async () => {
      await expect(flow({ confirmSession: "s1", linkAlias: null })).rejects.toThrow(/oidc_flows_confirm_check/);
      await expect(flow({ confirmSession: "s1", prompt: "select_account" })).rejects.toThrow(/oidc_flows_confirm_check/);
      await expect(flow({ prompt: "consent" as never })).rejects.toThrow(/oidc_flows_prompt_check/);
    });
  });

  describe("known devices", () => {
    it("are new once per account and listener, then only seen again", async () => {
      const key = { alias: "u_bo", arrival: "remote" as const, tokenHash: "d1" };
      expect(await isKnownDevice(sql, key)).toBe(false);
      expect(await rememberDevice(sql, { ...key, label: "Safari on iPhone", firstFrom: "203.0.113.7" })).toBe(true);
      expect(await rememberDevice(sql, { ...key, label: "Safari on iPhone", firstFrom: "198.51.100.1" })).toBe(false);
      expect(await isKnownDevice(sql, key)).toBe(true);
      expect(await isKnownDevice(sql, { ...key, arrival: "local" })).toBe(false);
      expect(await isKnownDevice(sql, { ...key, alias: "u_liv" })).toBe(false);
      const [row] = await sql<{ first_from: string; label: string }[]>`SELECT first_from, label FROM known_devices`;
      expect(row).toEqual({ first_from: "203.0.113.7", label: "Safari on iPhone" });
    });

    it("are forgotten 400 days after they were last seen, and with their account", async () => {
      await rememberDevice(sql, { alias: "u_bo", arrival: "local", tokenHash: "old", label: "Old", firstFrom: null });
      await rememberDevice(sql, { alias: "u_bo", arrival: "local", tokenHash: "new", label: "New", firstFrom: null });
      await rememberDevice(sql, { alias: "u_liv", arrival: "local", tokenHash: "liv", label: "Liv's", firstFrom: null });
      await sql`UPDATE known_devices SET last_seen_at = now() - interval '401 days' WHERE token_hash = 'old'`;
      expect(await purgeKnownDevices(sql)).toBe(1);
      await sql`DELETE FROM users WHERE alias = 'u_liv'`;
      expect((await sql`SELECT token_hash FROM known_devices`).map((r) => r.token_hash)).toEqual(["new"]);
    });
  });

  describe("Revoke everything", () => {
    /** Bo, with every way in there is, and Liv with some of her own that must stay. */
    async function seedEverything(): Promise<void> {
      await sql`UPDATE users SET oidc_sub = 'idp-bo' WHERE alias = 'u_bo'`;
      await createRefreshSession(sql, session({ id: "lan-1", alias: "u_bo" }));
      await createRefreshSession(sql, session({ id: "rem-1", alias: "u_bo", arrival: "remote", absoluteExpiresAt: new Date(Date.now() + 86_400_000) }));
      await createRefreshSession(sql, session({ id: "rem-2", sessionId: "rem-1", alias: "u_bo", arrival: "remote", absoluteExpiresAt: new Date(Date.now() + 86_400_000) }));
      await createRefreshSession(sql, session({ id: "liv-1", alias: "u_liv" }));
      await rememberDevice(sql, { alias: "u_bo", arrival: "remote", tokenHash: "d1", label: "Phone", firstFrom: null });
      await rememberDevice(sql, { alias: "u_liv", arrival: "remote", tokenHash: "d2", label: "Laptop", firstFrom: null });
      await sql`INSERT INTO password_resets (token_hash, alias, expires_at, created_by) VALUES
        ('reset-unused', 'u_bo', now() + interval '1 day', 'u_liv'),
        ('reset-used', 'u_bo', now() + interval '1 day', 'u_liv')`;
      await sql`UPDATE password_resets SET used_at = now() WHERE token_hash = 'reset-used'`;
      await createOidcFlow(sql, {
        state: "st", bindingHash: "b", nonce: "n", codeVerifier: "v", redirectUri: "http://x.test/cb",
        prompt: null, linkAlias: "u_bo", returnTo: "/", expiresAt: new Date(Date.now() + 600_000),
      });
      await sql`INSERT INTO api_keys (key_id, secret_hash, agent_id, owner, workspace_id, name) VALUES
        ('k1', 'h', 'agent-1', 'u_bo', ${WS}, 'Scout'), ('k2', 'h', 'agent-2', 'u_bo', ${WS}, 'Old'),
        ('k3', 'h', 'agent-3', 'u_liv', ${WS}, 'Liv''s')`;
      await sql`UPDATE api_keys SET revoked_at = now(), revoked_by = 'u_bo' WHERE key_id = 'k2'`;
      await sql`INSERT INTO oauth_grants (grant_id, client_id, owner, agent_id) VALUES
        ('g1', 'c1', 'u_bo', 'agent-g1'), ('g2', 'c1', 'u_liv', 'agent-g2')`;
      await sql`INSERT INTO oauth_tokens (token_hash, grant_id, kind, family_id, family_started_at, expires_at, arrival) VALUES
        ('t1', 'g1', 'access', 'f1', now(), now() + interval '1 hour', 'remote'),
        ('t2', 'g2', 'access', 'f2', now(), now() + interval '1 hour', 'local')`;
      await sql`INSERT INTO oauth_codes (code_hash, client_id, user_alias, access, redirect_uri, code_challenge, expires_at, arrival) VALUES
        ('code-bo', 'c1', 'u_bo', 'read', 'http://x.test/cb', 'ch', now() + interval '1 minute', 'local'),
        ('code-liv', 'c1', 'u_liv', 'read', 'http://x.test/cb', 'ch', now() + interval '1 minute', 'local')`;
      await sql`INSERT INTO workspace_invites (token_hash, workspace_id, created_by, expires_at, max_uses, use_count) VALUES
        ('inv-live', ${WS}, 'u_bo', now() + interval '7 days', 1, 0),
        ('inv-used', ${WS}, 'u_bo', null, 1, 1),
        ('inv-liv', ${WS}, 'u_liv', null, null, 0)`;
      await createDoc(sql, { workspaceId: WS, docId: "doc-1", owner: "user:u_bo", title: "Plan", aclPrincipals: ["user:u_bo"] });
      await sql`INSERT INTO share_links (token_hash, doc_id, workspace_id, created_by, expires_at) VALUES
        ('share-live', 'doc-1', ${WS}, 'u_bo', null),
        ('share-expired', 'doc-1', ${WS}, 'u_bo', now() - interval '1 day'),
        ('share-liv', 'doc-1', ${WS}, 'u_liv', null)`;
    }

    it("counts what it would take, then takes exactly that, in one go", async () => {
      await seedEverything();
      const counts = await revokeEverythingCounts(sql, "u_bo");
      expect(counts).toEqual({ sessions: 2, provider: true, apps: 1, api_keys: 1, invites: 1, share_links: 1 });

      const done = await revokeEverything(sql, { alias: "u_bo", by: "u_bo", passwordHash: "new-hash" });
      expect(done).toMatchObject({ ...counts, devices: 1, password_links: 1 });
      expect(new Set(done!.sessionIds)).toEqual(new Set(["lan-1", "rem-1"]));

      expect(await sql`SELECT id FROM refresh_sessions WHERE revoked_at IS NULL ORDER BY id`).toEqual([{ id: "liv-1" }]);
      expect((await findAccountByAlias(sql, "u_bo"))).toMatchObject({ oidc_sub: null, password_hash: "new-hash" });
      expect(await sql`SELECT token_hash FROM known_devices`).toEqual([{ token_hash: "d2" }]);
      expect(await sql`SELECT token_hash FROM password_resets`).toEqual([{ token_hash: "reset-used" }]);
      expect(await sql`SELECT state FROM oidc_flows`).toEqual([]);
      expect(await sql`SELECT key_id FROM api_keys WHERE revoked_at IS NULL`).toEqual([{ key_id: "k3" }]);
      expect(await sql`SELECT revoked_by FROM api_keys WHERE key_id = 'k1'`).toEqual([{ revoked_by: "u_bo" }]);
      expect(await sql`SELECT grant_id FROM oauth_grants WHERE revoked_at IS NULL`).toEqual([{ grant_id: "g2" }]);
      expect(await sql`SELECT token_hash FROM oauth_tokens`).toEqual([{ token_hash: "t2" }]);
      expect(await sql`SELECT code_hash FROM oauth_codes`).toEqual([{ code_hash: "code-liv" }]);
      expect(await sql`SELECT token_hash FROM workspace_invites WHERE revoked_at IS NULL ORDER BY token_hash`).toEqual([
        { token_hash: "inv-liv" },
        { token_hash: "inv-used" },
      ]);
      expect(await sql`SELECT token_hash FROM share_links WHERE revoked_at IS NULL ORDER BY token_hash`).toEqual([
        { token_hash: "share-expired" },
        { token_hash: "share-liv" },
      ]);
      // Nothing is left to take.
      expect(await revokeEverythingCounts(sql, "u_bo")).toEqual({ sessions: 0, provider: false, apps: 0, api_keys: 0, invites: 0, share_links: 0 });
    });

    it("for an administrator to do, removes the password instead of setting one", async () => {
      await seedEverything();
      await revokeEverything(sql, { alias: "u_bo", by: "u_liv", passwordHash: null });
      expect(await findAccountByAlias(sql, "u_bo")).toMatchObject({ password_hash: null, oidc_sub: null });
      expect(await sql`SELECT revoked_by FROM oauth_grants WHERE grant_id = 'g1'`).toEqual([{ revoked_by: "u_liv" }]);
    });

    it("gives the account a password it had none of, and is null for no account", async () => {
      await sql`DELETE FROM local_accounts WHERE alias = 'u_bo'`;
      await revokeEverything(sql, { alias: "u_bo", by: "u_bo", passwordHash: "first-hash" });
      expect((await findAccountByAlias(sql, "u_bo"))!.password_hash).toBe("first-hash");
      expect(await revokeEverything(sql, { alias: "u_nobody", by: "u_nobody", passwordHash: "h" })).toBeNull();
      expect(await revokeEverythingCounts(sql, "u_nobody")).toBeNull();
    });
  });

  describe("a sign-in and what ends it, at the same moment", () => {
    /** Waits until `n` queries of this test are blocked on a lock, so the order below is the one asserted. */
    async function blocked(n: number): Promise<void> {
      for (let i = 0; i < 200; i++) {
        const [row] = await sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
        if (row!.n >= n) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`never saw ${n} blocked queries`);
    }
    const liveRows = async (alias: string) =>
      sql<{ id: string }[]>`SELECT id FROM refresh_sessions WHERE alias = ${alias} AND revoked_at IS NULL AND expires_at > now()`;

    it("never leaves a renewal's successor live behind a revocation that started while it was in flight", async () => {
      await createRefreshSession(sql, session({ id: "p1", alias: "u_bo" }));
      // Stall the renewal on its parent's row, then revoke while it waits.
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const holding = sql.begin(async (tx) => {
        await tx`SELECT 1 FROM refresh_sessions WHERE id = 'p1' FOR UPDATE`;
        await gate;
      });
      await new Promise((r) => setTimeout(r, 50));
      const renewal = rotateRefreshSession(sql, { tokenHash: "hash-p1", id: "c1", nextTokenHash: "hash-c1", expiresAt: new Date(Date.now() + 3_600_000), arrival: "local" });
      await blocked(1);
      const revocation = revokeRefreshSessions(sql, "u_bo");
      await blocked(2);
      release();
      await holding;
      const [renewed] = await Promise.all([renewal, revocation]);
      // The renewal went first and wrote its successor; the revocation, waiting behind it, ended that too.
      expect(renewed?.id).toBe("c1");
      expect(await liveRows("u_bo")).toEqual([]);
      expect(await isSessionLive(sql, { sessionId: "p1", alias: "u_bo", arrival: "local" })).toBe(false);
    });

    it("writes a sign-in only while the password checked is still the account's", async () => {
      expect(await createRefreshSessionIf(sql, session({ id: "n1", alias: "u_bo" }), { password: "stale-hash" })).toBeNull();
      expect(await createRefreshSessionIf(sql, session({ id: "n2", alias: "u_bo" }), { password: "old-hash" })).toMatchObject({ id: "n2" });
      expect((await liveRows("u_bo")).map((r) => r.id)).toEqual(["n2"]);
    });

    it("replaces a password, and ends every sign-in, only while what was checked still holds", async () => {
      await createRefreshSession(sql, session({ id: "a1", alias: "u_bo" }));
      const asked = { session: { sessionId: "a1", alias: "u_bo", arrival: "local" as const } };
      expect(await replaceLocalPassword(sql, { alias: "u_bo", passwordHash: "x", requires: { password: "stale-hash" } })).toBe(false);
      expect((await findAccountByAlias(sql, "u_bo"))!.password_hash).toBe("old-hash");
      expect(await replaceLocalPassword(sql, { alias: "u_bo", passwordHash: "new-hash", requires: asked })).toBe(true);
      expect((await findAccountByAlias(sql, "u_bo"))!.password_hash).toBe("new-hash");
      expect(await liveRows("u_bo")).toEqual([]);
      // The sign-in that asked has ended: nothing more on its say-so.
      expect(await replaceLocalPassword(sql, { alias: "u_bo", passwordHash: "again", requires: asked })).toBe(false);
      await sql`DELETE FROM local_accounts WHERE alias = 'u_bo'`;
      expect(await addLocalPassword(sql, "u_bo", "first", asked)).toBe(false);
      expect(await addLocalPassword(sql, "u_bo", "first")).toBe(true);
    });

    it("refuses your own Revoke everything once an administrator's has ended the sign-in that asked", async () => {
      await createRefreshSession(sql, session({ id: "a1", alias: "u_bo", arrival: "remote", absoluteExpiresAt: new Date(Date.now() + 86_400_000) }));
      const asked = { session: { sessionId: "a1", alias: "u_bo", arrival: "remote" as const } };
      expect(await revokeEverything(sql, { alias: "u_bo", by: "u_liv", passwordHash: null })).not.toBeNull();
      expect(await revokeEverything(sql, { alias: "u_bo", by: "u_bo", passwordHash: "attacker-hash", requires: asked })).toBeNull();
      expect(await findAccountByAlias(sql, "u_bo")).toMatchObject({ password_hash: null });
    });

    it("links a provider identity only while the password checked is still the account's", async () => {
      await sql`
        INSERT INTO node_settings (id, idp_issuer, idp_client_id) VALUES (TRUE, 'https://idp.test', 'stuga')
        ON CONFLICT (id) DO UPDATE SET idp_issuer = EXCLUDED.idp_issuer, idp_client_id = EXCLUDED.idp_client_id`;
      expect(await linkIdentity(sql, "u_bo", "sub-1", "https://idp.test", { password: "stale-hash" })).toBe("changed");
      expect((await findAccountByAlias(sql, "u_bo"))!.oidc_sub).toBeNull();
      expect(await linkIdentity(sql, "u_bo", "sub-1", "https://idp.test", { password: "old-hash" })).toBe("linked");
    });

    it("signs a sign-in out only at the listener that issued it", async () => {
      await createRefreshSession(sql, session({ id: "l1", alias: "u_bo" }));
      expect(await endRefreshSession(sql, "hash-l1", "remote")).toBeNull();
      expect(await isSessionLive(sql, { sessionId: "l1", alias: "u_bo", arrival: "local" })).toBe(true);
      expect(await endRefreshSession(sql, "hash-l1", "local")).toEqual({ alias: "u_bo", sessionId: "l1" });
      expect(await isSessionLive(sql, { sessionId: "l1", alias: "u_bo", arrival: "local" })).toBe(false);
    });
  });
});
