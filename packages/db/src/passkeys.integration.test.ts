/** Passkeys in Postgres (./passkeys.ts), the sign-ins they make, and what migration 0002 holds them to. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeClients, createClient, type Sql } from "./client.js";
import { initSchema } from "./schema/migrate.js";
import { createRefreshSession, createRefreshSessionIf, isSessionLive, rotateRefreshSession, sessionLiveUntil, siblingRefreshSession, type NewRefreshSession } from "./identity.js";
import {
  dismissPasskeyOffer,
  findPasskey,
  hasPasskeyAt,
  insertPasskey,
  listPasskeys,
  passkeyDescriptors,
  passkeyOfferDue,
  recordPasskeyUse,
  removePasskey,
  renamePasskey,
  type NewPasskey,
} from "./passkeys.js";
import { revokeEverything, revokeEverythingCounts } from "./account-security.js";
import { failUnfinishedDeliveries, insertNotification, recordNotificationDelivery } from "./notifications.js";
import { seedUser } from "./testing/fixtures.js";

const URL = process.env.TEST_DATABASE_URL;
const HOST = "k7f3q2.mystuga.com";

const passkey = (over: Partial<NewPasskey> = {}): NewPasskey => ({
  credentialId: "cred-1",
  alias: "u_bo",
  rpId: HOST,
  publicKey: new Uint8Array([1, 2, 3, 4]),
  algorithm: -7,
  signCount: 0,
  transports: ["internal", "hybrid"],
  backupEligible: true,
  synced: true,
  name: "iCloud Keychain",
  ...over,
});

const session = (over: Partial<NewRefreshSession> & { id: string }): NewRefreshSession => ({
  sessionId: over.id,
  alias: "u_bo",
  tokenHash: `hash-${over.id}`,
  expiresAt: new Date(Date.now() + 3_600_000),
  arrival: "remote",
  signedInWith: "passkey",
  passkeyId: "cred-1",
  absoluteExpiresAt: new Date(Date.now() + 86_400_000),
  ...over,
});

describe.skipIf(!URL)("passkeys", () => {
  let sql: Sql;

  beforeAll(async () => {
    sql = createClient(URL!);
    await initSchema(sql);
  });
  afterAll(async () => {
    await closeClients();
  });
  beforeEach(async () => {
    await sql`TRUNCATE users, local_accounts, refresh_sessions, passkeys, known_devices, notifications CASCADE`;
    await seedUser(sql, "u_bo", "Bo", null, "bo");
    await seedUser(sql, "u_liv", "Liv", null, "liv");
  });

  it("keeps a public key, its counter, transports and flags, per host, and never replaces one", async () => {
    expect(await insertPasskey(sql, passkey())).toBe("added");
    expect(await insertPasskey(sql, passkey({ alias: "u_liv", name: "Other" }))).toBe("exists");
    const found = await findPasskey(sql, "cred-1", HOST);
    expect(found).toMatchObject({ alias: "u_bo", algorithm: -7, sign_count: 0, transports: ["internal", "hybrid"], backup_eligible: true, synced: true });
    expect([...found!.public_key]).toEqual([1, 2, 3, 4]);
    // Only at the host it was made at.
    expect(await findPasskey(sql, "cred-1", "other.mystuga.com")).toBeNull();
    expect(await passkeyDescriptors(sql, "u_bo", HOST)).toEqual([{ id: "cred-1", transports: ["internal", "hybrid"] }]);
    expect(await passkeyDescriptors(sql, "u_bo", "other.mystuga.com")).toEqual([]);
    expect(await hasPasskeyAt(sql, "u_bo", HOST)).toBe(true);
    expect(await hasPasskeyAt(sql, "u_liv", HOST)).toBe(false);
    expect(await insertPasskey(sql, passkey({ credentialId: "cred-empty", transports: [] }))).toBe("added");
  });

  it("holds what the table must: an algorithm on the list, a name, BS only with BE", async () => {
    await expect(insertPasskey(sql, passkey({ algorithm: -35 as never }))).rejects.toThrow();
    await expect(insertPasskey(sql, passkey({ credentialId: "c2", name: "" }))).rejects.toThrow();
    await expect(insertPasskey(sql, passkey({ credentialId: "c3", backupEligible: false, synced: true }))).rejects.toThrow();
    await expect(insertPasskey(sql, passkey({ credentialId: "x".repeat(1401) }))).rejects.toThrow();
  });

  it("records a use, renames, and lists without the key", async () => {
    await insertPasskey(sql, passkey());
    expect(await recordPasskeyUse(sql, { credentialId: "cred-1", signCount: 7, synced: false })).toBe(true);
    expect(await recordPasskeyUse(sql, { credentialId: "nope", signCount: 1, synced: false })).toBe(false);
    expect(await renamePasskey(sql, "u_bo", "cred-1", "Bo's phone")).toBe(true);
    expect(await renamePasskey(sql, "u_liv", "cred-1", "Mine now")).toBe(false);
    const [row] = await listPasskeys(sql, "u_bo");
    expect(row).toMatchObject({ credential_id: "cred-1", name: "Bo's phone", synced: false, backup_eligible: true });
    expect(row!.last_used_at).not.toBeNull();
    expect(row).not.toHaveProperty("public_key");
    expect((await findPasskey(sql, "cred-1", HOST))!.sign_count).toBe(7);
  });

  it("keeps its counter rising: a lower or equal one counts no sign-in, and 0 stays 0", async () => {
    await insertPasskey(sql, passkey());
    expect(await recordPasskeyUse(sql, { credentialId: "cred-1", signCount: 0, synced: true })).toBe(true);
    expect(await recordPasskeyUse(sql, { credentialId: "cred-1", signCount: 12, synced: true })).toBe(true);
    // Checked against the same stored counter as the one above, and landing after it.
    expect(await recordPasskeyUse(sql, { credentialId: "cred-1", signCount: 11, synced: true })).toBe(false);
    expect(await recordPasskeyUse(sql, { credentialId: "cred-1", signCount: 12, synced: true })).toBe(false);
    expect(await recordPasskeyUse(sql, { credentialId: "cred-1", signCount: 0, synced: true })).toBe(false);
    expect((await findPasskey(sql, "cred-1", HOST))!.sign_count).toBe(12);
  });

  it("is added only while the sign-in that asked is on, ordered against a Revoke everything", async () => {
    await createRefreshSession(sql, session({ id: "w1", signedInWith: "password", passkeyId: null }));
    const asking = { session: { sessionId: "w1", alias: "u_bo", arrival: "remote" as const } };
    // A Revoke everything holding the lock: the add waits for it, then finds the sign-in ended.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const revoking = sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${"sign-ins:u_bo"}))`;
      await held;
      await tx`UPDATE refresh_sessions SET revoked_at = now() WHERE alias = 'u_bo'`;
    });
    await new Promise((r) => setTimeout(r, 50));
    const adding = insertPasskey(sql, passkey(), asking);
    await new Promise((r) => setTimeout(r, 50));
    release();
    await revoking;
    expect(await adding).toBe("ended");
    expect(await findPasskey(sql, "cred-1", HOST)).toBeNull();
    // On a live sign-in it is added.
    await createRefreshSession(sql, session({ id: "w2", signedInWith: "password", passkeyId: null }));
    expect(await insertPasskey(sql, passkey(), { session: { sessionId: "w2", alias: "u_bo", arrival: "remote" } })).toBe("added");
  });

  it("signs in a session that carries it, at the remote address only, and only while it is the account's", async () => {
    await insertPasskey(sql, passkey());
    const row = await createRefreshSessionIf(sql, session({ id: "p1" }), { passkey: "cred-1" });
    expect(row).toMatchObject({ signed_in_with: "passkey", passkey_id: "cred-1" });
    // Not someone else's passkey.
    expect(await createRefreshSessionIf(sql, session({ id: "p2", alias: "u_liv" }), { passkey: "cred-1" })).toBeNull();
    // The table refuses a passkey sign-in without its passkey, a passkey on another kind, and one on the node's network.
    await expect(createRefreshSession(sql, session({ id: "p3", passkeyId: null }))).rejects.toThrow();
    await expect(createRefreshSession(sql, session({ id: "p4", signedInWith: "password" }))).rejects.toThrow();
    await expect(createRefreshSession(sql, session({ id: "p5", arrival: "local", absoluteExpiresAt: null }))).rejects.toThrow();
  });

  it("carries the passkey through a renewal and a duplicate renewal's sibling", async () => {
    await insertPasskey(sql, passkey());
    await createRefreshSession(sql, session({ id: "p1" }));
    const next = await rotateRefreshSession(sql, { tokenHash: "hash-p1", id: "p1b", nextTokenHash: "hash-p1b", expiresAt: new Date(Date.now() + 3_600_000), arrival: "remote" });
    expect(next).toMatchObject({ passkey_id: "cred-1", signed_in_with: "passkey" });
    const sibling = await siblingRefreshSession(sql, { of: "hash-p1b", id: "p1c", tokenHash: "hash-p1c" });
    expect(sibling).toMatchObject({ passkey_id: "cred-1" });
  });

  it("ends, when removed, every sign-in it made and none other, which it names", async () => {
    await insertPasskey(sql, passkey());
    await insertPasskey(sql, passkey({ credentialId: "cred-2", name: "Security key", backupEligible: false, synced: false }));
    await createRefreshSession(sql, session({ id: "p1" }));
    await createRefreshSession(sql, session({ id: "p2", passkeyId: "cred-2" }));
    await createRefreshSession(sql, session({ id: "w1", signedInWith: "password", passkeyId: null }));
    const removed = await removePasskey(sql, "u_bo", "cred-1");
    expect(removed).toEqual({ name: "iCloud Keychain", synced: true, backup_eligible: true, sessionIds: ["p1"] });
    expect(await isSessionLive(sql, { sessionId: "p1", alias: "u_bo", arrival: "remote" })).toBe(false);
    expect(await isSessionLive(sql, { sessionId: "p2", alias: "u_bo", arrival: "remote" })).toBe(true);
    expect(await isSessionLive(sql, { sessionId: "w1", alias: "u_bo", arrival: "remote" })).toBe(true);
    // Only one's own.
    expect(await removePasskey(sql, "u_liv", "cred-2")).toBeNull();
    // An account removed takes its passkeys with it.
    await sql`DELETE FROM users WHERE alias = 'u_bo'`;
    expect(await findPasskey(sql, "cred-2", HOST)).toBeNull();
  });

  it("goes with everything else on Revoke everything, counted first", async () => {
    await insertPasskey(sql, passkey());
    await createRefreshSession(sql, session({ id: "p1" }));
    expect((await revokeEverythingCounts(sql, "u_bo"))!.passkeys).toBe(1);
    const revoked = await revokeEverything(sql, { alias: "u_bo", by: "u_bo", passwordHash: "new" });
    expect(revoked).toMatchObject({ passkeys: 1, sessionIds: ["p1"] });
    expect(await listPasskeys(sql, "u_bo")).toEqual([]);
  });

  it("is offered once: until dismissed, and not to someone with one at this host", async () => {
    expect(await passkeyOfferDue(sql, "u_bo", HOST)).toBe(true);
    await insertPasskey(sql, passkey());
    expect(await passkeyOfferDue(sql, "u_bo", HOST)).toBe(false);
    expect(await passkeyOfferDue(sql, "u_bo", "new.mystuga.com")).toBe(true);
    await dismissPasskeyOffer(sql, "u_bo");
    expect(await passkeyOfferDue(sql, "u_bo", "new.mystuga.com")).toBe(false);
    expect(await passkeyOfferDue(sql, "nobody", HOST)).toBe(false);
  });
});

describe.skipIf(!URL)("a sign-in's end, and a notification's delivery", () => {
  let sql: Sql;
  beforeAll(async () => {
    sql = createClient(URL!);
    await initSchema(sql);
  });
  afterAll(async () => {
    await closeClients();
  });
  beforeEach(async () => {
    await sql`TRUNCATE users, refresh_sessions, notifications CASCADE`;
    await seedUser(sql, "u_bo", "Bo", null, "bo");
  });

  it("reads until when a sign-in is on: the later end of its live rows, never past its fixed end", async () => {
    const fixed = new Date(Date.now() + 2 * 3_600_000);
    await createRefreshSession(sql, session({ id: "a", sessionId: "s", signedInWith: "password", passkeyId: null, expiresAt: new Date(Date.now() + 3_600_000), absoluteExpiresAt: fixed }));
    await createRefreshSession(sql, session({ id: "b", sessionId: "s", signedInWith: "password", passkeyId: null, expiresAt: new Date(Date.now() + 5 * 3_600_000), absoluteExpiresAt: fixed }));
    expect((await sessionLiveUntil(sql, { sessionId: "s", alias: "u_bo", arrival: "remote" }))!.getTime()).toBe(fixed.getTime());
    await createRefreshSession(sql, session({ id: "l", sessionId: "local", arrival: "local", signedInWith: "password", passkeyId: null, absoluteExpiresAt: null }));
    expect(await sessionLiveUntil(sql, { sessionId: "local", alias: "u_bo", arrival: "local" })).toBeInstanceOf(Date);
    await sql`UPDATE refresh_sessions SET revoked_at = now() WHERE session_id = 's'`;
    expect(await sessionLiveUntil(sql, { sessionId: "s", alias: "u_bo", arrival: "remote" })).toBeNull();
  });

  it("keeps the channel a delivery was queued for, then the attempt's outcome, an error no longer than 300", async () => {
    const row = {
      id: "n1",
      workspace_id: null,
      recipient_alias: "u_bo",
      event_type: "ACCOUNT_NEW_SIGN_IN",
      resource_id: null,
      resource_title: "t",
      resource_url: "u",
      actor_alias: null,
      payload: {},
    };
    await insertNotification(sql, { ...row, delivery_channel: "email" });
    await insertNotification(sql, { ...row, id: "n2" });
    const read = async (id: string) =>
      (await sql<{ delivery_channel: string | null; delivered_at: Date | null; delivery_error: string | null }[]>`
        SELECT delivery_channel, delivered_at, delivery_error FROM notifications WHERE id = ${id}`)[0];
    expect(await read("n1")).toEqual({ delivery_channel: "email", delivered_at: null, delivery_error: null });
    expect(await read("n2")).toEqual({ delivery_channel: null, delivered_at: null, delivery_error: null });
    await recordNotificationDelivery(sql, "n1", { error: "x".repeat(400) });
    expect((await read("n1"))!.delivery_error).toHaveLength(300);
    await recordNotificationDelivery(sql, "n1", { delivered: true });
    expect(await read("n1")).toMatchObject({ delivery_error: null });
    expect((await read("n1"))!.delivered_at).not.toBeNull();
    // A later failure never covers a delivery that landed.
    await recordNotificationDelivery(sql, "n1", { error: "late" });
    expect((await read("n1"))!.delivery_error).toBeNull();
    await expect(insertNotification(sql, { ...row, id: "n3", delivery_channel: "pigeon" })).rejects.toThrow();
    // Shown in Stuga only is said as such; null is a row from before this was kept.
    await insertNotification(sql, { ...row, id: "n4", delivery_channel: "none" });
    expect((await read("n4"))!.delivery_channel).toBe("none");
  });

  it("marks a send a restart cut short as not sent, and leaves every other row alone", async () => {
    const row = (id: string, event_type: string, delivery_channel: string | null) => ({
      id,
      workspace_id: null,
      recipient_alias: "u_bo",
      event_type,
      resource_id: null,
      resource_title: "t",
      resource_url: "u",
      actor_alias: null,
      payload: {},
      delivery_channel,
    });
    await insertNotification(sql, row("cut", "NODE_NOTIFY_CHANNEL_CHANGED", "slack"));
    await insertNotification(sql, row("sent", "NODE_NOTIFY_CHANNEL_CHANGED", "slack"));
    await recordNotificationDelivery(sql, "sent", { delivered: true });
    await insertNotification(sql, row("only", "NODE_NOTIFY_CHANNEL_CHANGED", "none"));
    await insertNotification(sql, row("queued", "ACCOUNT_NEW_SIGN_IN", "slack"));
    expect(await failUnfinishedDeliveries(sql, "NODE_NOTIFY_CHANNEL_CHANGED", "the node restarted before it was sent")).toBe(1);
    const errors = await sql<{ id: string; delivery_error: string | null }[]>`SELECT id, delivery_error FROM notifications ORDER BY id`;
    expect(errors).toEqual([
      { id: "cut", delivery_error: "the node restarted before it was sent" },
      { id: "only", delivery_error: null },
      { id: "queued", delivery_error: null },
      { id: "sent", delivery_error: null },
    ]);
  });
});
