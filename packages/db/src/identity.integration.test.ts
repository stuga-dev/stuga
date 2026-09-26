import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createClient, closeClients } from "./client.js";
import { initSchema } from "./schema/migrate.js";
import { createDoc, listDocs, setDocAcl } from "./docs.js";
import {
  addLocalPassword,
  countAccounts,
  countAccountsWithoutPassword,
  createLocalAccount,
  createPasswordReset,
  createProviderAccount,
  createRefreshSession,
  endRefreshSession,
  findAccountByAlias,
  findAccountBySub,
  findAccountByUsername,
  findRefreshSession,
  getAnyUserAliasByHandle,
  getSignInMethods,
  getUserAliasByHandle,
  getUsers,
  isNodeAdminAlias,
  linkIdentity,
  listNodeAdmins,
  purgeRefreshSessions,
  redeemPasswordReset,
  revokeRefreshSession,
  revokeRefreshSessions,
  rotateRefreshSession,
  searchAccounts,
  searchUsers,
  setDisplayName,
  setUserEmail,
  takenUsernames,
  unlinkIdentity,
  updateLocalPassword,
} from "./identity.js";
import { getNodeSettings, getSearchLanguages } from "./node.js";
import { createOidcFlow } from "./oidc.js";
import { provisionWorkspace, addWorkspaceMember, insertWorkspaceInvite } from "./workspaces.js";
import { seedUser } from "./testing/fixtures.js";
import type { Sql } from "./client.js";

const URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!URL)("user directory resolution", () => {
  let sql: Sql;
  const WS = "ws-test";

  /** Directory lookups see only workspace members. */
  async function member(alias: string, displayName: string, email: string | null, username?: string): Promise<void> {
    await seedUser(sql, alias, displayName, email, username);
    await addWorkspaceMember(sql, WS, alias);
  }

  beforeAll(async () => {
    sql = createClient(URL!);
    await initSchema(sql);
  });

  afterAll(async () => {
    await closeClients();
  });

  beforeEach(async () => {
    await sql`TRUNCATE workspaces, docs, users, workspace_members CASCADE`;
    await provisionWorkspace(sql, { workspaceId: WS, name: "Test", owner: "ws-owner" });
  });

  it("resolves an email to its durable alias (case-insensitive)", async () => {
    await member("sub-uuid-123", "Alice Example", "alice@corp.com");
    expect(await getUserAliasByHandle(sql, "alice@corp.com", WS)).toBe("sub-uuid-123");
    expect(await getUserAliasByHandle(sql, "ALICE@CORP.COM", WS)).toBe("sub-uuid-123");
    expect(await getUserAliasByHandle(sql, "nobody@corp.com", WS)).toBeNull();
  });

  it("resolves a username first, with or without @, whatever its case", async () => {
    await member("sub-ada", "Ada Lovelace", null, "ada");
    // Another person's email and display name both read "ada": the unique username still wins.
    await member("sub-other", "ada", "ada", "someone");
    expect(await getUserAliasByHandle(sql, "ada", WS)).toBe("sub-ada");
    expect(await getUserAliasByHandle(sql, "@ADA", WS)).toBe("sub-ada");
    expect(await getUserAliasByHandle(sql, "  Ada ", WS)).toBe("sub-ada");
  });

  it("refuses to guess when an unverified email names two people", async () => {
    await member("sub-1", "One", "shared@corp.com", "one");
    await member("sub-2", "Two", "shared@corp.com", "two");
    expect(await getUserAliasByHandle(sql, "shared@corp.com", WS)).toBeNull();
  });

  it("reaches beyond the workspace only for adding members", async () => {
    await seedUser(sql, "sub-outsider", "Outsider", null, "outsider");
    expect(await getUserAliasByHandle(sql, "outsider", WS)).toBeNull();
    expect(await getAnyUserAliasByHandle(sql, "outsider")).toBe("sub-outsider");
  });

  it("searchUsers matches by username, email or display name, case-insensitively", async () => {
    await member("sub-u", "Someone", null, "zed.k");
    expect((await searchUsers(sql, "@ZED", WS)).map((u) => u.alias)).toEqual(["sub-u"]);
    await member("sub-a", "Alice Example", "alice@corp.com");
    await member("sub-b", "Bob Builder", "bob@corp.com");
    const byName = await searchUsers(sql, "ali", WS);
    expect(byName.map((u) => u.alias)).toEqual(["sub-a"]);
    const byEmail = await searchUsers(sql, "BOB@", WS);
    expect(byEmail.map((u) => u.alias)).toEqual(["sub-b"]);
    expect(await searchUsers(sql, "", WS)).toEqual([]);
  });

  it("searchUsers matches LIKE metacharacters literally", async () => {
    await member("sub-snake", "Snake", "first_last@corp.com");
    await member("sub-camel", "Camel", "firstXlast@corp.com");
    expect((await searchUsers(sql, "first_last", WS)).map((u) => u.alias)).toEqual(["sub-snake"]);
    expect(await searchUsers(sql, "100%", WS)).toEqual([]);
  });

  it("searchAccounts finds people outside the workspace, usernames that start with the query first", async () => {
    await member("sub-in", "Anna Inside", null, "anna.in");
    await seedUser(sql, "sub-out", "Hannah Outside", "hannah@corp.com", "hannah");
    await seedUser(sql, "sub-ann", "Zoe", null, "ann.z");
    await seedUser(sql, "sub-name", "Annika By-Name", null);
    const outside = { outsideWorkspace: WS };
    const found = await searchAccounts(sql, "an", outside);
    expect(found.map((u) => u.alias)).toEqual(["sub-ann", "sub-name", "sub-out"]);
    expect(Object.keys(found[0]!).sort()).toEqual(["alias", "display_name", "username"]);
    expect((await searchAccounts(sql, "@H", outside)).map((u) => u.alias)).toEqual(["sub-out"]);
    // An email matches whole, never part of it.
    expect(await searchAccounts(sql, "hannah@", outside)).toEqual([]);
    expect((await searchAccounts(sql, "HANNAH@corp.com", outside)).map((u) => u.alias)).toEqual(["sub-out"]);
    expect(await searchAccounts(sql, " ", outside)).toEqual([]);
    // Without a workspace it is the whole node, members included.
    expect((await searchAccounts(sql, "an")).map((u) => u.alias)).toEqual(["sub-in", "sub-ann", "sub-name", "sub-out"]);
  });

  it("resolves an email stored in display_name (identity with no email claim, exact match only)", async () => {
    await member("sub-acc", "bob@corp.com", null);
    expect(await getUserAliasByHandle(sql, "bob@corp.com", WS)).toBe("sub-acc");
    expect(await getUserAliasByHandle(sql, "BOB@CORP.COM", WS)).toBe("sub-acc");
    await member("sub-name", "Bob Roberts", null);
    expect(await getUserAliasByHandle(sql, "Bob", WS)).toBeNull();
    await member("sub-email", "someone else", "shared@corp.com");
    await member("sub-dn", "shared@corp.com", null);
    expect(await getUserAliasByHandle(sql, "shared@corp.com", WS)).toBe("sub-email");
  });

  it("refuses to guess when a display name matches two people", async () => {
    await member("sub-dana-1", "Dana Smith", null);
    await member("sub-dana-2", "Dana Smith", null);
    expect(await getUserAliasByHandle(sql, "Dana Smith", WS)).toBeNull();

    await member("sub-dana-real", "Dana Smith", "dana.smith@corp.com");
    expect(await getUserAliasByHandle(sql, "dana.smith@corp.com", WS)).toBe("sub-dana-real");
    expect(await getUserAliasByHandle(sql, "Dana Smith", WS)).toBeNull();
  });

  it("getUserAliasByHandle does not match an alias", async () => {
    await member("9f3c1d2e-aaaa-bbbb", "Member", "member@corp.com");
    expect(await getUserAliasByHandle(sql, "9f3c1d2e-aaaa-bbbb", WS)).toBeNull();
  });

  it("a doc shared to the resolved alias is visible to that user", async () => {
    await member("owner-sub", "Owner", "owner@corp.com");
    await member("recipient-sub", "Recipient", "recipient@corp.com");
    await createDoc(sql, { workspaceId: WS, docId: "d1", owner: "user:owner-sub", title: "Shared", aclPrincipals: ["user:owner-sub"] });

    await setDocAcl(sql, "d1", ["user:owner-sub", "user:recipient@corp.com"], ["user:owner-sub"], false, [], { p: ["user:recipient@corp.com"], w: [], c: [] });
    const recipientPrincipals = ["user:recipient-sub", "org:all"];
    let visible = await listDocs(sql, recipientPrincipals, WS, {});
    expect(visible.find((d) => d.doc_id === "d1")).toBeUndefined();

    const alias = await getUserAliasByHandle(sql, "recipient@corp.com", WS);
    expect(alias).toBe("recipient-sub");
    await setDocAcl(sql, "d1", ["user:owner-sub", `user:${alias}`], ["user:owner-sub"], false, [], { p: [`user:${alias}`], w: [], c: [] });
    visible = await listDocs(sql, recipientPrincipals, WS, {});
    expect(visible.find((d) => d.doc_id === "d1")).toBeDefined();
  });
});

describe.skipIf(!URL)("app-owned display name", () => {
  let sql: Sql;

  beforeAll(async () => {
    sql = createClient(URL!);
    await initSchema(sql);
  });

  afterAll(async () => {
    await closeClients();
  });

  beforeEach(async () => {
    await sql`TRUNCATE users, workspaces, workspace_members CASCADE`;
    await seedUser(sql, "alice", "Alice", null, "alice");
    await provisionWorkspace(sql, { workspaceId: "ws-a", name: "A", owner: "alice" });
  });

  it("keeps the name and the email the person set", async () => {
    await setDisplayName(sql, "alice", "  Ada ");
    await setUserEmail(sql, "alice", "profile@example.test");
    const [row] = await getUsers(sql, ["alice"], "ws-a");
    expect(row).toMatchObject({ display_name: "Ada", email: "profile@example.test" });
  });

  it("is findable by the name colleagues actually see", async () => {
    await setDisplayName(sql, "alice", "Ada");
    expect((await searchUsers(sql, "Ada", "ws-a")).map((u) => u.display_name)).toEqual(["Ada"]);
  });

  it("never shows other people how an account signs in", async () => {
    await sql`UPDATE users SET oidc_sub = 'provider-subject' WHERE alias = 'alice'`;
    const [row] = await getUsers(sql, ["alice"], "ws-a");
    expect(Object.keys(row!).sort()).toEqual(["alias", "display_name", "email", "updated_at", "username"]);
    const [found] = await searchUsers(sql, "alice", "ws-a");
    expect(found).not.toHaveProperty("oidc_sub");
  });
});

/**
 * The node's owner, its first account, and a workspace whose invites later
 * accounts are made with. `many` is an invite with uses to spare.
 */
/** The identity provider the node trusts, which vouches for every subject below unless a test says otherwise. */
const ISSUER = "https://id.example";

async function trustIssuer(sql: Sql, issuer: string | null): Promise<void> {
  await sql`
    INSERT INTO node_settings (id, idp_issuer, idp_client_id) VALUES (TRUE, ${issuer}, ${issuer ? "stuga" : null})
    ON CONFLICT (id) DO UPDATE SET idp_issuer = EXCLUDED.idp_issuer, idp_client_id = EXCLUDED.idp_client_id`;
}

async function claimNode(sql: Sql): Promise<void> {
  await trustIssuer(sql, ISSUER);
  const owner = await createLocalAccount(sql, { alias: "u0", username: "owner", passwordHash: "h", mayClaim: true });
  expect(owner).toMatchObject({ ok: true, admin: true });
  await provisionWorkspace(sql, { workspaceId: "ws", name: "W", owner: "u0" });
  await insertWorkspaceInvite(sql, { tokenHash: "many", workspaceId: "ws", role: "member", createdBy: "u0", expiresAt: null, maxUses: 100 });
}

describe.skipIf(!URL)("local accounts", () => {
  let sql: Sql;

  beforeAll(async () => {
    sql = createClient(URL!);
    await initSchema(sql);
  });
  afterAll(async () => {
    await closeClients();
  });
  beforeEach(async () => {
    await sql`TRUNCATE users, local_accounts, node_admins, workspaces, workspace_members CASCADE`;
  });

  it("stores setup's choice not to look for newer versions with the first account, and takes it from nobody after", async () => {
    await sql`DELETE FROM node_settings`;
    const first = await createLocalAccount(sql, { alias: "u1", username: "ada", passwordHash: "h", mayClaim: true, updateCheck: false });
    expect(first).toMatchObject({ ok: true, admin: true });
    expect(await getNodeSettings(sql)).toMatchObject({ update_check: false, updated_by: "u1" });

    await sql`UPDATE node_settings SET update_check = TRUE`;
    await provisionWorkspace(sql, { workspaceId: "ws", name: "W", owner: "u1" });
    await insertWorkspaceInvite(sql, { tokenHash: "many", workspaceId: "ws", role: "member", createdBy: "u1", expiresAt: null, maxUses: 100 });
    const later = await createLocalAccount(sql, { alias: "u2", username: "bob", passwordHash: "h", inviteHash: "many", updateCheck: false });
    expect(later).toMatchObject({ ok: true, admin: false });
    expect(await getNodeSettings(sql)).toMatchObject({ update_check: true });
  });

  it("stores setup's search languages with the first account, and takes them from nobody after", async () => {
    await sql`DELETE FROM node_settings`;
    await createLocalAccount(sql, { alias: "u1", username: "ada", passwordHash: "h", mayClaim: true, searchLanguages: ["ko"] });
    expect(await getSearchLanguages(sql)).toEqual(["ko"]);

    await provisionWorkspace(sql, { workspaceId: "ws", name: "W", owner: "u1" });
    await insertWorkspaceInvite(sql, { tokenHash: "many", workspaceId: "ws", role: "member", createdBy: "u1", expiresAt: null, maxUses: 100 });
    await createLocalAccount(sql, { alias: "u2", username: "bob", passwordHash: "h", inviteHash: "many", searchLanguages: [] });
    expect(await getSearchLanguages(sql)).toEqual(["ko"]);
  });

  it("stores setup's choice of no search languages as a choice", async () => {
    await sql`DELETE FROM node_settings`;
    await createLocalAccount(sql, { alias: "u1", username: "ada", passwordHash: "h", mayClaim: true, searchLanguages: [] });
    expect(await getSearchLanguages(sql)).toEqual([]);
  });

  it("writes no settings row for a first account that leaves the look for newer versions on", async () => {
    await sql`DELETE FROM node_settings`;
    await createLocalAccount(sql, { alias: "u1", username: "ada", passwordHash: "h", mayClaim: true, updateCheck: true });
    expect(await getNodeSettings(sql)).toBeNull();
  });

  it("makes the first account the node's administrator, with its directory row, in one go", async () => {
    expect(await countAccounts(sql)).toBe(0);
    const acct = await createLocalAccount(sql, { alias: "u1", username: "ada", passwordHash: "hash-1", displayName: "Ada", mayClaim: true });
    expect(acct).toEqual({
      ok: true,
      account: { alias: "u1", username: "ada", password_hash: "hash-1", oidc_sub: null },
      joined: null,
      admin: true,
    });
    expect(await countAccounts(sql)).toBe(1);

    expect(await isNodeAdminAlias(sql, "u1")).toBe(true);
    expect((await listNodeAdmins(sql))[0]).toMatchObject({ alias: "u1", username: "ada", granted_by: null });

    await provisionWorkspace(sql, { workspaceId: "ws", name: "W", owner: "u1" });
    const [user] = await getUsers(sql, ["u1"], "ws");
    expect(user).toMatchObject({ alias: "u1", username: "ada", display_name: "Ada", email: null });
  });

  it("of several concurrent first registrations on an empty node, exactly one becomes its administrator and the rest need an invite", async () => {
    const results = await Promise.all(
      ["ada", "bob", "carol", "dave", "erin", "fay"].map((username, i) =>
        createLocalAccount(sql, { alias: `u${i}`, username, passwordHash: "h", mayClaim: true }),
      ),
    );
    const made = results.filter((r) => r.ok);
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ admin: true, joined: null });
    expect(results.filter((r) => !r.ok)).toEqual(Array(5).fill({ ok: false, reason: "invite_required" }));
    expect(await countAccounts(sql)).toBe(1);
    const admins = await sql<{ alias: string }[]>`SELECT alias FROM node_admins`;
    expect(admins.map((a) => a.alias)).toEqual([made[0]!.ok ? made[0]!.account.alias : ""]);
  });

  it("makes the first account only for a caller that checked the setup code, whatever else raced", async () => {
    const results = await Promise.all([
      createLocalAccount(sql, { alias: "u1", username: "eve", passwordHash: "h" }),
      createLocalAccount(sql, { alias: "u2", username: "mallory", passwordHash: "h", inviteHash: "left-over" }),
    ]);
    expect(results).toEqual([
      { ok: false, reason: "setup_code_required" },
      { ok: false, reason: "setup_code_required" },
    ]);
    expect(await countAccounts(sql)).toBe(0);
    expect(await sql`SELECT 1 FROM node_admins`).toHaveLength(0);
  });

  it("makes a later account only with an invite, and never an administrator", async () => {
    await claimNode(sql);
    expect(await createLocalAccount(sql, { alias: "u1", username: "bob", passwordHash: "h" })).toEqual({
      ok: false,
      reason: "invite_required",
    });
    const bob = await createLocalAccount(sql, { alias: "u1", username: "bob", passwordHash: "h", inviteHash: "many" });
    expect(bob).toMatchObject({ ok: true, admin: false, joined: { workspaceId: "ws", role: "member" } });
    expect(await isNodeAdminAlias(sql, "u1")).toBe(false);
  });

  it("looks up by username case-insensitively and refuses a duplicate", async () => {
    await claimNode(sql);
    await createLocalAccount(sql, { alias: "u1", username: "ada", passwordHash: "h", inviteHash: "many" });
    expect((await findAccountByUsername(sql, "  @ADA "))?.alias).toBe("u1");
    expect(await findAccountByUsername(sql, "nobody")).toBeNull();

    expect(await createLocalAccount(sql, { alias: "u2", username: "ada", passwordHash: "h", inviteHash: "many" })).toEqual({
      ok: false,
      reason: "username_taken",
    });
    expect(await countAccounts(sql)).toBe(2);
    const rows = await sql<{ alias: string }[]>`SELECT alias FROM users ORDER BY alias`;
    expect(rows.map((r) => r.alias)).toEqual(["u0", "u1"]);
  });

  it("lets exactly one of several concurrent claims on a username through", async () => {
    await claimNode(sql);
    const results = await Promise.all(
      ["u1", "u2", "u3"].map((alias) => createLocalAccount(sql, { alias, username: "race", passwordHash: "h", inviteHash: "many" })),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual(Array(2).fill({ ok: false, reason: "username_taken" }));
    expect(await countAccounts(sql)).toBe(2);
  });

  it("spends the invite with the account, so a single-use one makes one account however many race", async () => {
    await claimNode(sql);
    await insertWorkspaceInvite(sql, { tokenHash: "once", workspaceId: "ws", role: "member", createdBy: "u0", expiresAt: null, maxUses: 1 });
    const results = await Promise.all([
      createLocalAccount(sql, { alias: "u1", username: "bob", passwordHash: "h", inviteHash: "once" }),
      createLocalAccount(sql, { alias: "u2", username: "carol", passwordHash: "h", inviteHash: "once" }),
      createProviderAccount(sql, {
        alias: "u3",
        username: "dave",
        displayName: "Dave",
        email: null,
        oidcSub: "sub-3",
        issuer: ISSUER,
        inviteHash: "once",
      }),
    ]);
    const made = results.filter((r) => r.ok);
    expect(made).toHaveLength(1);
    expect(made[0]!.joined).toEqual({ workspaceId: "ws", role: "member" });
    expect(results.filter((r) => !r.ok)).toEqual([
      { ok: false, reason: "invite_invalid" },
      { ok: false, reason: "invite_invalid" },
    ]);
    // Nothing of a refused account is left behind: no directory row, no password, no membership.
    expect(await countAccounts(sql)).toBe(2);
    expect(await sql`SELECT alias FROM local_accounts WHERE alias NOT IN ('u0', ${made[0]!.account.alias})`).toHaveLength(0);
    expect(await sql`SELECT alias FROM workspace_members WHERE workspace_id = 'ws'`).toHaveLength(2);
    const [invite] = await sql<{ use_count: number }[]>`SELECT use_count FROM workspace_invites WHERE token_hash = 'once'`;
    expect(invite!.use_count).toBe(1);
  });

  it("makes nothing with an invite that was never minted", async () => {
    await claimNode(sql);
    expect(await createLocalAccount(sql, { alias: "u1", username: "bob", passwordHash: "h", inviteHash: "never" })).toEqual({
      ok: false,
      reason: "invite_invalid",
    });
    expect(await countAccounts(sql)).toBe(1);
  });

  it("refuses a username the schema's rule does not allow", async () => {
    await expect(createLocalAccount(sql, { alias: "u1", username: "Not Valid", passwordHash: "h", mayClaim: true })).rejects.toThrow(
      /users_username_check/,
    );
    expect(await countAccounts(sql)).toBe(0);
    expect(await sql`SELECT 1 FROM node_admins`).toHaveLength(0);
  });

  it("updates the password hash only for an account that exists", async () => {
    await createLocalAccount(sql, { alias: "u1", username: "a1", passwordHash: "old", mayClaim: true });
    expect(await updateLocalPassword(sql, "u1", "new")).toBe(true);
    expect((await findAccountByUsername(sql, "a1"))?.password_hash).toBe("new");
    expect(await updateLocalPassword(sql, "ghost", "new")).toBe(false);
  });
});

describe.skipIf(!URL)("accounts through the identity provider", () => {
  let sql: Sql;
  const future = () => new Date(Date.now() + 60 * 60 * 1000);

  beforeAll(async () => {
    sql = createClient(URL!);
    await initSchema(sql);
  });
  afterAll(async () => {
    await closeClients();
  });
  beforeEach(async () => {
    await sql`TRUNCATE users, local_accounts, node_admins, password_resets, oidc_flows, oidc_tickets, workspaces, workspace_members CASCADE`;
    await claimNode(sql);
  });

  const provider = (alias: string, username: string, sub: string) =>
    createProviderAccount(sql, { alias, username, displayName: username, email: null, oidcSub: sub, issuer: ISSUER, inviteHash: "many" });
  const local = (alias: string, username: string) => createLocalAccount(sql, { alias, username, passwordHash: "h", inviteHash: "many" });

  it("creates an account with a subject and no password, never an administrator", async () => {
    const made = await provider("u1", "ada", "sub-1");
    expect(made).toEqual({
      ok: true,
      account: { alias: "u1", username: "ada", password_hash: null, oidc_sub: "sub-1" },
      joined: { workspaceId: "ws", role: "member" },
      admin: false,
    });
    expect(await countAccounts(sql)).toBe(2);
    expect(await findAccountBySub(sql, "sub-1")).toMatchObject({ alias: "u1", password_hash: null });
    expect(await findAccountByAlias(sql, "u1")).toMatchObject({ username: "ada", password_hash: null });
    expect(await getSignInMethods(sql, "u1")).toEqual({ hasPassword: false, providerLinked: true });
    expect(await isNodeAdminAlias(sql, "u1")).toBe(false);
    expect(await getSignInMethods(sql, "ghost")).toBeNull();
  });

  it("never claims an empty node, and needs an invite on a claimed one", async () => {
    expect(
      await createProviderAccount(sql, { alias: "u1", username: "ada", displayName: "Ada", email: null, oidcSub: "sub-1", issuer: ISSUER }),
    ).toEqual({
      ok: false,
      reason: "invite_required",
    });
    await sql`TRUNCATE users, local_accounts, node_admins, workspaces, workspace_members CASCADE`;
    expect(await provider("u1", "ada", "sub-1")).toEqual({ ok: false, reason: "setup_required" });
    expect(await countAccounts(sql)).toBe(0);
  });

  it("links one subject to one account", async () => {
    await provider("u1", "ada", "sub-1");
    expect(await provider("u2", "bob", "sub-1")).toEqual({ ok: false, reason: "already_linked" });
    expect(await provider("u2", "ada", "sub-2")).toEqual({ ok: false, reason: "username_taken" });
    await local("u3", "carol");
    await expect(sql`UPDATE users SET oidc_sub = 'sub-1' WHERE alias = 'u3'`).rejects.toThrow(/users_oidc_sub_key/);
  });

  it("lets exactly one of two concurrent first visits for a subject through", async () => {
    const results = await Promise.all([provider("u1", "ada", "sub-race"), provider("u2", "bob", "sub-race")]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toEqual({ ok: false, reason: "already_linked" });
  });

  it("links an existing account, and tells every refusal apart", async () => {
    await local("u1", "ada");
    await local("u2", "bob");
    expect(await linkIdentity(sql, "u1", "sub-1", ISSUER)).toBe("linked");
    expect(await linkIdentity(sql, "u1", "sub-1", ISSUER)).toBe("already_linked");
    expect(await linkIdentity(sql, "u2", "sub-1", ISSUER)).toBe("taken");
    expect(await linkIdentity(sql, "u1", "sub-2", ISSUER)).toBe("other_sub");
    expect(await linkIdentity(sql, "ghost", "sub-3", ISSUER)).toBe("no_account");
    expect((await findAccountByUsername(sql, "ada"))?.oidc_sub).toBe("sub-1");
  });

  it("links a subject, or makes an account for one, only while the issuer that vouched for it is the node's", async () => {
    await local("u1", "ada");
    const late = (issuer: string) =>
      createProviderAccount(sql, { alias: "u2", username: "bob", displayName: "Bob", email: null, oidcSub: "sub-2", issuer, inviteHash: "many" });
    // An exact comparison, as the settings save's: another spelling is another issuer.
    for (const issuer of ["https://other.example", `${ISSUER}/`]) {
      expect(await linkIdentity(sql, "u1", "sub-1", issuer)).toBe("provider_changed");
      expect(await late(issuer)).toEqual({ ok: false, reason: "provider_changed" });
    }
    await trustIssuer(sql, null);
    expect(await linkIdentity(sql, "u1", "sub-1", ISSUER)).toBe("provider_changed");
    expect(await late(ISSUER)).toEqual({ ok: false, reason: "provider_changed" });
    await sql`DELETE FROM node_settings`;
    expect(await linkIdentity(sql, "u1", "sub-1", ISSUER)).toBe("provider_changed");
    expect(await late(ISSUER)).toEqual({ ok: false, reason: "provider_changed" });
    expect((await findAccountByAlias(sql, "u1"))?.oidc_sub).toBeNull();
    expect(await findAccountBySub(sql, "sub-2")).toBeNull();
  });

  it("holds a link in flight while the issuer changes, then refuses it: no subject outlives its issuer", async () => {
    await local("u1", "ada");
    let link: Promise<unknown> | undefined;
    let account: Promise<unknown> | undefined;
    await sql.begin(async (tx) => {
      // A settings save that changes the issuer, caught between its write and its commit.
      await tx`UPDATE node_settings SET idp_issuer = 'https://new.example' WHERE id = TRUE`;
      link = linkIdentity(sql, "u1", "sub-old", ISSUER);
      account = createProviderAccount(sql, {
        alias: "u2",
        username: "bob",
        displayName: "Bob",
        email: null,
        oidcSub: "sub-old-2",
        issuer: ISSUER,
        inviteHash: "many",
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    expect(await link).toBe("provider_changed");
    expect(await account).toEqual({ ok: false, reason: "provider_changed" });
    expect(await sql`SELECT alias FROM users WHERE oidc_sub IS NOT NULL`).toHaveLength(0);
  });

  it("unlinks only an account that keeps a password", async () => {
    await provider("u1", "ada", "sub-1");
    expect(await unlinkIdentity(sql, "u1")).toBe("no_password");
    expect(await countAccountsWithoutPassword(sql)).toBe(1);
    expect(await addLocalPassword(sql, "u1", "first")).toBe(true);
    expect(await countAccountsWithoutPassword(sql)).toBe(0);
    expect(await unlinkIdentity(sql, "u1")).toBe("unlinked");
    expect(await unlinkIdentity(sql, "u1")).toBe("not_linked");
    expect(await getSignInMethods(sql, "u1")).toEqual({ hasPassword: true, providerLinked: false });
  });

  it("adds a first password once, never over an existing one", async () => {
    await provider("u1", "ada", "sub-1");
    expect(await updateLocalPassword(sql, "u1", "x")).toBe(false);
    expect(await addLocalPassword(sql, "u1", "first")).toBe(true);
    expect(await addLocalPassword(sql, "u1", "second")).toBe(false);
    expect((await findAccountByAlias(sql, "u1"))?.password_hash).toBe("first");
    expect(await addLocalPassword(sql, "ghost", "x")).toBe(false);
  });

  it("gives a password-less account its first password through a reset link", async () => {
    await provider("u1", "ada", "sub-1");
    await createPasswordReset(sql, { tokenHash: "r1", alias: "u1", expiresAt: future(), createdBy: "console" });
    expect(await redeemPasswordReset(sql, "r1", "reset-hash")).toBe("u1");
    expect((await findAccountByAlias(sql, "u1"))?.password_hash).toBe("reset-hash");
    expect(await redeemPasswordReset(sql, "r1", "again")).toBeNull();
  });

  it("keeps a password-less account's refresh sessions working: it exists as long as its row does", async () => {
    await provider("u1", "ada", "sub-1");
    await createRefreshSession(sql, { id: "s1", alias: "u1", tokenHash: "t1", expiresAt: future() });
    const next = await rotateRefreshSession(sql, { tokenHash: "t1", id: "s2", nextTokenHash: "t2", expiresAt: future() });
    expect(next?.alias).toBe("u1");
    expect(await findAccountByAlias(sql, next!.alias)).not.toBeNull();
  });

  it("answers which of a batch of usernames are taken in one query", async () => {
    await provider("u1", "ada", "sub-1");
    await local("u2", "ada-2");
    expect(await takenUsernames(sql, ["ada", "ada-2", "ada-3"])).toEqual(new Set(["ada", "ada-2"]));
    expect(await takenUsernames(sql, [])).toEqual(new Set());
  });
});

describe.skipIf(!URL)("refresh sessions", () => {
  let sql: Sql;
  const future = () => new Date(Date.now() + 60 * 60 * 1000);

  beforeAll(async () => {
    sql = createClient(URL!);
    await initSchema(sql);
  });
  afterAll(async () => {
    await closeClients();
  });
  beforeEach(async () => {
    await sql`TRUNCATE refresh_sessions`;
  });

  it("rotates atomically: the old token is revoked and its successor issued for the same alias", async () => {
    await createRefreshSession(sql, { id: "s1", alias: "alice", tokenHash: "t1", expiresAt: future() });

    const next = await rotateRefreshSession(sql, { tokenHash: "t1", id: "s2", nextTokenHash: "t2", expiresAt: future() });
    expect(next).toMatchObject({ id: "s2", alias: "alice", token_hash: "t2", revoked_at: null });

    const old = await findRefreshSession(sql, "t1");
    expect(old?.revoked_at).not.toBeNull();
    expect(old?.replaced_by).toBe("t2");
    expect(await rotateRefreshSession(sql, { tokenHash: "t1", id: "s3", nextTokenHash: "t3", expiresAt: future() })).toBeNull();
    expect(await findRefreshSession(sql, "t3")).toBeNull();
    expect(await findRefreshSession(sql, "unknown")).toBeNull();
  });

  it("only one of two concurrent rotations of the same token wins", async () => {
    await createRefreshSession(sql, { id: "s1", alias: "alice", tokenHash: "t1", expiresAt: future() });
    const results = await Promise.all([
      rotateRefreshSession(sql, { tokenHash: "t1", id: "rot-a", nextTokenHash: "n1", expiresAt: future() }),
      rotateRefreshSession(sql, { tokenHash: "t1", id: "rot-b", nextTokenHash: "n2", expiresAt: future() }),
    ]);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });

  it("does not rotate an expired session", async () => {
    await createRefreshSession(sql, { id: "s1", alias: "alice", tokenHash: "t1", expiresAt: new Date(Date.now() - 1000) });
    expect(await rotateRefreshSession(sql, { tokenHash: "t1", id: "s2", nextTokenHash: "t2", expiresAt: future() })).toBeNull();
  });

  it("revokes one session, or every session an alias holds", async () => {
    await createRefreshSession(sql, { id: "a1", alias: "alice", tokenHash: "ta1", expiresAt: future() });
    await createRefreshSession(sql, { id: "a2", alias: "alice", tokenHash: "ta2", expiresAt: future() });
    await createRefreshSession(sql, { id: "b1", alias: "bob", tokenHash: "tb1", expiresAt: future() });

    expect(await revokeRefreshSession(sql, "ta1")).toBe(true);
    expect(await revokeRefreshSession(sql, "ta1")).toBe(false);
    expect((await findRefreshSession(sql, "ta1"))?.replaced_by).toBeNull();
    expect(await revokeRefreshSessions(sql, "alice")).toBe(1);
    expect((await findRefreshSession(sql, "tb1"))?.revoked_at).toBeNull();
  });

  it("signs out: revokes the session and drops the provider links its account never finished, and nobody else's", async () => {
    await sql`TRUNCATE users, oidc_flows CASCADE`;
    await seedUser(sql, "alice", "Alice");
    await seedUser(sql, "bob", "Bob");
    const flow = (state: string, linkAlias: string | null) =>
      createOidcFlow(sql, {
        state,
        bindingHash: "b",
        nonce: "n",
        codeVerifier: "v",
        redirectUri: "http://localhost:8787/auth/oidc/callback",
        prompt: null,
        linkAlias,
        returnTo: "/",
        expiresAt: future(),
      });
    await flow("alice-link", "alice");
    await flow("bob-link", "bob");
    await flow("sign-in", null);
    await createRefreshSession(sql, { id: "a1", alias: "alice", tokenHash: "ta1", expiresAt: future() });

    expect(await endRefreshSession(sql, "ta1")).toBe("alice");
    expect((await findRefreshSession(sql, "ta1"))?.revoked_at).not.toBeNull();
    const left = await sql<{ state: string }[]>`SELECT state FROM oidc_flows ORDER BY state`;
    expect(left.map((r) => r.state)).toEqual(["bob-link", "sign-in"]);
    // A token already revoked still names its account; an unknown one names nobody.
    await flow("alice-again", "alice");
    expect(await endRefreshSession(sql, "ta1")).toBe("alice");
    expect(await sql`SELECT 1 FROM oidc_flows WHERE link_alias = 'alice'`).toHaveLength(0);
    expect(await endRefreshSession(sql, "unknown")).toBeNull();
  });

  it("purges sessions that can never be presented again, keeping recent revocations as replay evidence", async () => {
    await createRefreshSession(sql, { id: "live", alias: "alice", tokenHash: "t-live", expiresAt: future() });
    await createRefreshSession(sql, { id: "just-revoked", alias: "alice", tokenHash: "t-jr", expiresAt: future() });
    await revokeRefreshSession(sql, "t-jr");
    await createRefreshSession(sql, { id: "old-revoked", alias: "alice", tokenHash: "t-or", expiresAt: future() });
    await sql`UPDATE refresh_sessions SET revoked_at = now() - interval '30 days' WHERE id = 'old-revoked'`;
    await createRefreshSession(sql, { id: "long-expired", alias: "alice", tokenHash: "t-le", expiresAt: new Date(Date.now() - 30 * 86400_000) });

    expect(await purgeRefreshSessions(sql, 7)).toBe(2);
    const left = await sql<{ id: string }[]>`SELECT id FROM refresh_sessions ORDER BY id`;
    expect(left.map((r) => r.id)).toEqual(["just-revoked", "live"]);
  });
});
