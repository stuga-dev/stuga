import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createClient, closeClients } from "./client.js";
import { initSchema } from "./schema/migrate.js";
import { agentNames } from "./agents.js";
import {
  dropWorkspaceFromOwnerGrants,
  grantForAccessToken,
  insertOauthToken,
  listOauthGrants,
  purgeExpiredOauthTokens,
  revokeOauthGrant,
  revokeOauthTokenFamily,
  rotateRefreshToken,
  updateOauthGrant,
  upsertOauthGrant,
} from "./grants.js";
import type { Sql } from "./client.js";

const URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!URL)("OAuth grants and tokens", () => {
  let sql: Sql;
  const soon = () => new Date(Date.now() + 60_000);

  const grant = (over: Partial<Parameters<typeof upsertOauthGrant>[1]> = {}) =>
    upsertOauthGrant(sql, {
      grantId: "grt_1",
      clientId: "https://client.example.test/meta.json",
      name: "Example",
      clientHost: "client.example.test",
      owner: "alice",
      agentId: "agent-conn-1",
      workspaceScope: ["ws-a"],
      access: "propose",
      ...over,
    });

  beforeAll(async () => {
    sql = createClient(URL!);
    await initSchema(sql);
  });

  afterAll(async () => {
    await closeClients();
  });

  beforeEach(async () => {
    await sql`TRUNCATE oauth_tokens, oauth_grants CASCADE`;
    for (const alias of ["alice", "bob"]) {
      await sql`INSERT INTO users (alias, username) VALUES (${alias}, ${`grants-${alias}`}) ON CONFLICT (alias) DO NOTHING`;
    }
  });

  it("renews a person's live grant for the same client instead of making another", async () => {
    const first = await grant();
    const again = await grant({ grantId: "grt_2", agentId: "agent-conn-2", workspaceScope: null, access: "read" });
    expect(again.grant_id).toBe(first.grant_id);
    expect(again.agent_id).toBe("agent-conn-1");
    expect(again.workspace_scope).toBeNull();
    expect(again.access).toBe("read");
    // Another person, or the same person after revoking, gets a grant of their own.
    const bobs = await grant({ grantId: "grt_3", agentId: "agent-conn-3", owner: "bob" });
    expect(bobs.grant_id).toBe("grt_3");
    expect(await revokeOauthGrant(sql, "grt_1", "alice")).toBe(true);
    const fresh = await grant({ grantId: "grt_4", agentId: "agent-conn-4" });
    expect(fresh.grant_id).toBe("grt_4");
    expect((await listOauthGrants(sql, "alice")).map((g) => g.grant_id).sort()).toEqual(["grt_1", "grt_4"]);
  });

  it("answers an access token with its live grant until it expires or the grant is revoked", async () => {
    await grant();
    await insertOauthToken(sql, { tokenHash: "a1", grantId: "grt_1", kind: "access", familyId: "f1", familyStartedAt: new Date(), expiresAt: soon() });
    await insertOauthToken(sql, { tokenHash: "a2", grantId: "grt_1", kind: "access", familyId: "f1", familyStartedAt: new Date(), expiresAt: new Date(Date.now() - 1000) });
    await insertOauthToken(sql, { tokenHash: "r1", grantId: "grt_1", kind: "refresh", familyId: "f1", familyStartedAt: new Date(), expiresAt: soon() });
    expect((await grantForAccessToken(sql, "a1"))?.grant_id).toBe("grt_1");
    expect(await grantForAccessToken(sql, "a2")).toBeNull();
    // A refresh token is not an access token.
    expect(await grantForAccessToken(sql, "r1")).toBeNull();
    expect(await revokeOauthGrant(sql, "grt_1", "bob")).toBe(false);
    expect(await revokeOauthGrant(sql, "grt_1", "alice")).toBe(true);
    expect(await grantForAccessToken(sql, "a1")).toBeNull();
    const rows = await sql<{ count: string }[]>`SELECT count(*)::text AS count FROM oauth_tokens`;
    expect(rows[0]?.count).toBe("0");
  });

  const CLIENT = "https://client.example.test/meta.json";
  let minted = 0;
  /** The pair a rotation mints: hashes n-access and n-refresh, whatever the family began at. */
  const pair = () => {
    const n = ++minted;
    return () => [
      { tokenHash: `a-${n}`, kind: "access" as const, expiresAt: soon() },
      { tokenHash: `r-${n}`, kind: "refresh" as const, expiresAt: soon() },
    ];
  };
  const rotate = (tokenHash: string, over: { clientId?: string; graceSeconds?: number } = {}) =>
    rotateRefreshToken(sql, { tokenHash, clientId: over.clientId ?? CLIENT, graceSeconds: over.graceSeconds ?? 60, next: pair() });

  it("exchanges a refresh token for a new pair in its chain, and ends the chain when a spent one comes back after the grace", async () => {
    await grant();
    await insertOauthToken(sql, { tokenHash: "r1", grantId: "grt_1", kind: "refresh", familyId: "f1", familyStartedAt: new Date(), expiresAt: soon() });
    await insertOauthToken(sql, { tokenHash: "r-other", grantId: "grt_1", kind: "refresh", familyId: "f2", familyStartedAt: new Date(), expiresAt: soon() });

    expect(await rotate("r1", { clientId: "https://other.example.test/meta.json" })).toEqual({ kind: "invalid" });
    const first = minted + 1;
    expect(await rotate("r1")).toMatchObject({ kind: "rotated", grant: { grant_id: "grt_1", agent_id: "agent-conn-1" } });
    expect((await grantForAccessToken(sql, `a-${first}`))?.grant_id).toBe("grt_1");
    const [family] = await sql<{ family_id: string }[]>`SELECT family_id FROM oauth_tokens WHERE token_hash = ${`r-${first}`}`;
    expect(family?.family_id).toBe("f1");

    // No grace: the spent token is someone else's copy, and everything the chain issued goes with it.
    expect(await rotate("r1", { graceSeconds: 0 })).toEqual({ kind: "replayed" });
    expect(await grantForAccessToken(sql, `a-${first}`)).toBeNull();
    expect(await rotate(`r-${first}`)).toEqual({ kind: "invalid" });
    // Another sign-in's chain is untouched.
    expect((await rotate("r-other")).kind).toBe("rotated");
  });

  it("gives a refresh presented twice at once a sibling pair each, inside the grace, and loses neither", async () => {
    await grant();
    await insertOauthToken(sql, { tokenHash: "r1", grantId: "grt_1", kind: "refresh", familyId: "f1", familyStartedAt: new Date(), expiresAt: soon() });
    const before = minted;
    const results = await Promise.all([rotate("r1"), rotate("r1")]);
    expect(results.map((r) => r.kind)).toEqual(["rotated", "rotated"]);
    for (const n of [before + 1, before + 2]) expect((await grantForAccessToken(sql, `a-${n}`))?.grant_id).toBe("grt_1");
  });

  it("never lets a replay or a revoke miss the pair a racing exchange issues", async () => {
    await grant();
    await insertOauthToken(sql, { tokenHash: "r1", grantId: "grt_1", kind: "refresh", familyId: "f1", familyStartedAt: new Date(), expiresAt: soon() });
    const winner = minted + 1;
    await Promise.all([rotate("r1", { graceSeconds: 0 }), rotate("r1", { graceSeconds: 0 })]);
    // One exchange rotated and one replayed, in either order: the replay ended what the exchange issued.
    expect(await grantForAccessToken(sql, `a-${winner}`)).toBeNull();
    expect(await grantForAccessToken(sql, `a-${winner + 1}`)).toBeNull();

    await insertOauthToken(sql, { tokenHash: "r9", grantId: "grt_1", kind: "refresh", familyId: "f9", familyStartedAt: new Date(), expiresAt: soon() });
    const next = minted + 1;
    await Promise.all([rotate("r9"), revokeOauthTokenFamily(sql, "r9")]);
    const left = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM oauth_tokens WHERE family_id = 'f9' AND token_hash IN (${`a-${next}`}, ${`r-${next}`})`;
    // The revoke either ran first (nothing to rotate) or after (and took the new pair with it).
    expect(left[0]?.n).toBe(0);
  });

  it("revokes a token's family, expires tokens, and never spends one for a revoked grant", async () => {
    await grant();
    await insertOauthToken(sql, { tokenHash: "a1", grantId: "grt_1", kind: "access", familyId: "f1", familyStartedAt: new Date(), expiresAt: soon() });
    await insertOauthToken(sql, { tokenHash: "r1", grantId: "grt_1", kind: "refresh", familyId: "f1", familyStartedAt: new Date(), expiresAt: soon() });
    await revokeOauthTokenFamily(sql, "r1");
    expect(await grantForAccessToken(sql, "a1")).toBeNull();
    await revokeOauthTokenFamily(sql, "unknown");

    await insertOauthToken(sql, { tokenHash: "r3", grantId: "grt_1", kind: "refresh", familyId: "f3", familyStartedAt: new Date(), expiresAt: soon() });
    await insertOauthToken(sql, { tokenHash: "old", grantId: "grt_1", kind: "refresh", familyId: "f4", familyStartedAt: new Date(), expiresAt: new Date(Date.now() - 1000) });
    expect(await rotate("old")).toEqual({ kind: "invalid" });
    expect(await purgeExpiredOauthTokens(sql)).toBe(1);
    await sql`UPDATE oauth_grants SET revoked_at = now()`;
    expect(await rotate("r3")).toEqual({ kind: "invalid" });
  });

  it("stops a grant naming a workspace its person left, revokes one left naming none, and leaves 'now and later' alone", async () => {
    await grant({ workspaceScope: ["ws-a", "ws-b"] });
    await grant({ grantId: "grt_2", agentId: "agent-conn-2", clientId: "https://other.example.test/meta.json", workspaceScope: ["ws-a"] });
    await grant({ grantId: "grt_3", agentId: "agent-conn-3", clientId: "https://third.example.test/meta.json", workspaceScope: null });
    await insertOauthToken(sql, { tokenHash: "a2", grantId: "grt_2", kind: "access", familyId: "f2", familyStartedAt: new Date(), expiresAt: soon() });
    expect(await dropWorkspaceFromOwnerGrants(sql, "ws-a", "alice", "admin-1")).toBe(1);
    const byId = new Map((await listOauthGrants(sql, "alice")).map((g) => [g.grant_id, g]));
    expect(byId.get("grt_1")).toMatchObject({ workspace_scope: ["ws-b"], revoked_at: null });
    expect(byId.get("grt_2")).toMatchObject({ workspace_scope: [], revoked_by: "admin-1" });
    expect(byId.get("grt_3")).toMatchObject({ workspace_scope: null, revoked_at: null });
    expect(await grantForAccessToken(sql, "a2")).toBeNull();
  });

  it("renames a live grant, and names its agent in runs alongside keys", async () => {
    await grant();
    expect((await updateOauthGrant(sql, "grt_1", "alice", { name: "Work Claude" }))?.name).toBe("Work Claude");
    expect(await updateOauthGrant(sql, "grt_1", "bob", { name: "x" })).toBeNull();
    expect((await agentNames(sql, ["agent-conn-1"])).get("agent-conn-1")).toBe("Work Claude");
  });
});
