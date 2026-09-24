import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createClient, closeClients } from "./client.js";
import { initSchema } from "./schema/migrate.js";
import {
  getNodeAiSettings,
  getNodeSettings,
  getNodeState,
  lastNodeBoot,
  recordBackupAttempt,
  recordNodeBoot,
  recordUpdateCheck,
  resetNodeSettings,
  saveNodeSettings,
  upsertNodeAiSettings,
} from "./node.js";
import { createOidcFlow, createOidcTicket } from "./oidc.js";
import { seedUser } from "./testing/fixtures.js";
import type { Sql } from "./client.js";

const URL = process.env.TEST_DATABASE_URL;

const ROW = {
  chatEnabled: null,
  embedEnabled: true,
  chatDefaultModel: null,
  chatEndpoints: [],
  embedProvider: "openai",
  embedBaseUrl: "https://api.openai.test/v1",
  embedModel: "text-embedding-3-small",
  embedApiKeyFp: null,
  searchMaxDistance: null,
  retrievalMaxDistance: null,
  updatedBy: "admin-1",
};

describe.skipIf(!URL)("node_ai_settings", () => {
  let sql: Sql;

  beforeAll(async () => {
    sql = createClient(URL!);
    await initSchema(sql);
  });
  afterAll(async () => {
    await closeClients();
  });
  beforeEach(async () => {
    await sql`DELETE FROM node_ai_settings`;
  });

  it("stores the semantic cutoffs as numbers, and null as not set", async () => {
    await upsertNodeAiSettings(sql, ROW);
    expect(await getNodeAiSettings(sql)).toMatchObject({ search_max_distance: null, retrieval_max_distance: null });

    await upsertNodeAiSettings(sql, { ...ROW, searchMaxDistance: 0.75, retrievalMaxDistance: 2 });
    expect(await getNodeAiSettings(sql)).toMatchObject({ search_max_distance: 0.75, retrieval_max_distance: 2 });
  });

  it.each([0, -0.1, 2.01])("refuses a cutoff of %s", async (value) => {
    await expect(upsertNodeAiSettings(sql, { ...ROW, searchMaxDistance: value })).rejects.toThrow(/check constraint/);
    await expect(upsertNodeAiSettings(sql, { ...ROW, retrievalMaxDistance: value })).rejects.toThrow(/check constraint/);
    expect(await getNodeAiSettings(sql)).toBeNull();
  });
});

describe.skipIf(!URL)("node_settings", () => {
  let sql: Sql;
  const base = {
    nodeName: null,
    maxUploadBytes: null,
    auditRetentionDays: null,
    databaseOpsKeep: null,
    aiUsageRetentionDays: null,
    askThreadRetentionDays: null,
    notifySink: null,
    notifyWebhookLabel: null,
    smtpLabel: null,
    emailFrom: null,
    brandAccentColor: null,
    updateCheck: null,
    backupAuto: null,
    backupHour: null,
    timeZone: null,
    identityProvider: null,
    updatedBy: "admin-1",
  };
  const provider = (issuer: string, label: string | null = null) => ({ issuer, clientId: "stuga", clientSecretLabel: null, label, scopes: null });
  const inAnHour = () => new Date(Date.now() + 60 * 60 * 1000);

  beforeAll(async () => {
    sql = createClient(URL!);
    await initSchema(sql);
  });
  afterAll(async () => {
    await closeClients();
  });
  beforeEach(async () => {
    await sql`DELETE FROM node_settings`;
    await sql`TRUNCATE users, oidc_flows, oidc_tickets CASCADE`;
  });

  /** Two linked accounts, a link in flight and a first visit waiting: everything a change of issuer must take. */
  async function linkedUnder(): Promise<void> {
    await seedUser(sql, "u1", "Ada");
    await seedUser(sql, "u2", "Grace");
    await seedUser(sql, "u3", "Linus");
    await sql`UPDATE users SET oidc_sub = 'sub-' || alias WHERE alias IN ('u1', 'u2')`;
    await createOidcFlow(sql, {
      state: "s1",
      bindingHash: "b",
      nonce: "n",
      codeVerifier: "v",
      redirectUri: "http://localhost:8787/auth/oidc/callback",
      prompt: null,
      linkAlias: "u3",
      returnTo: "/",
      expiresAt: inAnHour(),
    });
    await createOidcTicket(sql, {
      ticketHash: "t1",
      kind: "first_visit",
      bindingHash: "b",
      sub: "sub-x",
      issuer: "https://id.example",
      returnTo: "/",
      expiresAt: inAnHour(),
    });
  }

  const subjects = async () =>
    (await sql<{ alias: string; oidc_sub: string | null }[]>`SELECT alias, oidc_sub FROM users ORDER BY alias`).map((r) => r.oidc_sub);
  const inFlight = async () => (await sql`SELECT 1 FROM oidc_flows`).length + (await sql`SELECT 1 FROM oidc_tickets`).length;

  it("stores the node's name, and refuses a blank or an overlong one", async () => {
    await saveNodeSettings(sql, { ...base, nodeName: "Liv's Mac" });
    expect(await getNodeSettings(sql)).toMatchObject({ node_name: "Liv's Mac" });
    await expect(saveNodeSettings(sql, { ...base, nodeName: "   " })).rejects.toThrow(/check constraint/);
    await expect(saveNodeSettings(sql, { ...base, nodeName: "x".repeat(81) })).rejects.toThrow(/check constraint/);
    expect(await getNodeSettings(sql)).toMatchObject({ node_name: "Liv's Mac" });
  });

  it("stores the look for newer versions as off, on, or not chosen", async () => {
    await saveNodeSettings(sql, base);
    expect(await getNodeSettings(sql)).toMatchObject({ update_check: null });
    await saveNodeSettings(sql, { ...base, updateCheck: false });
    expect(await getNodeSettings(sql)).toMatchObject({ update_check: false });
    await saveNodeSettings(sql, { ...base, updateCheck: true });
    expect(await getNodeSettings(sql)).toMatchObject({ update_check: true });
  });

  it("stores the daily backup's switch and hour and the node's time zone, and refuses an hour past 23", async () => {
    await saveNodeSettings(sql, base);
    expect(await getNodeSettings(sql)).toMatchObject({ backup_auto: null, backup_hour: null, time_zone: null });
    await saveNodeSettings(sql, { ...base, backupAuto: false, backupHour: 22, timeZone: "Asia/Shanghai" });
    expect(await getNodeSettings(sql)).toMatchObject({ backup_auto: false, backup_hour: 22, time_zone: "Asia/Shanghai" });
    await expect(saveNodeSettings(sql, { ...base, backupHour: 24 })).rejects.toThrow(/backup_hour/);
  });

  it("stores the identity provider's columns together and clears them together", async () => {
    const identityProvider = { issuer: "https://id.example", clientId: "stuga", clientSecretLabel: "ab12cd34", label: "Okta", scopes: null };
    await saveNodeSettings(sql, { ...base, identityProvider });
    expect(await getNodeSettings(sql)).toMatchObject({
      idp_issuer: "https://id.example",
      idp_client_id: "stuga",
      idp_client_secret_label: "ab12cd34",
      idp_label: "Okta",
      idp_scopes: null,
    });
    await saveNodeSettings(sql, { ...base, identityProvider: null });
    expect(await getNodeSettings(sql)).toMatchObject({ idp_issuer: null, idp_client_id: null, idp_client_secret_label: null });
  });

  it("refuses an issuer without a client id", async () => {
    await expect(sql`INSERT INTO node_settings (id, idp_issuer) VALUES (TRUE, 'https://id.example')`).rejects.toThrow(
      /node_settings_check/,
    );
  });

  it("saving a provider where there was none clears every subject", async () => {
    // Subjects left over from an issuer that is gone, say a restore: none may survive into the new one's.
    await linkedUnder();
    expect(await saveNodeSettings(sql, { ...base, identityProvider: provider("https://new.example") })).toEqual({ unlinkedAccounts: 2 });
    expect(await subjects()).toEqual([null, null, null]);
    expect(await inFlight()).toBe(0);
  });

  it("clears every subject when the issuer changes or goes, compared exactly, and keeps them while it stays", async () => {
    await saveNodeSettings(sql, { ...base, identityProvider: provider("https://id.example") });
    await linkedUnder();
    expect(await saveNodeSettings(sql, { ...base, nodeName: "Renamed", identityProvider: provider("https://id.example", "Okta") })).toEqual({
      unlinkedAccounts: 0,
    });
    expect(await subjects()).toEqual(["sub-u1", "sub-u2", null]);
    expect(await inFlight()).toBe(2);

    expect(await saveNodeSettings(sql, { ...base, identityProvider: provider("https://id.example/") })).toEqual({ unlinkedAccounts: 2 });
    expect(await subjects()).toEqual([null, null, null]);
    expect(await inFlight()).toBe(0);

    await sql`UPDATE users SET oidc_sub = 'sub-again' WHERE alias = 'u1'`;
    expect(await saveNodeSettings(sql, { ...base, identityProvider: null })).toEqual({ unlinkedAccounts: 1 });
    expect(await subjects()).toEqual([null, null, null]);
  });

  it("the settings write and the subject clearing commit or roll back together", async () => {
    await saveNodeSettings(sql, { ...base, nodeName: "Before", identityProvider: provider("https://old.example") });
    await linkedUnder();
    // The clearing fails: the row keeps the old issuer and its name, and every subject stays with it.
    await sql.unsafe(`CREATE FUNCTION test_refuse_unlink() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'unlinking refused'; END $$`);
    await sql.unsafe(`CREATE TRIGGER test_refuse_unlink BEFORE UPDATE OF oidc_sub ON users FOR EACH ROW EXECUTE FUNCTION test_refuse_unlink()`);
    try {
      await expect(
        saveNodeSettings(sql, { ...base, nodeName: "After", identityProvider: provider("https://new.example") }),
      ).rejects.toThrow(/unlinking refused/);
    } finally {
      await sql.unsafe(`DROP TRIGGER test_refuse_unlink ON users`);
      await sql.unsafe(`DROP FUNCTION test_refuse_unlink()`);
    }
    expect(await getNodeSettings(sql)).toMatchObject({ node_name: "Before", idp_issuer: "https://old.example" });
    expect(await subjects()).toEqual(["sub-u1", "sub-u2", null]);
    expect(await inFlight()).toBe(2);

    // The write fails: nothing is cleared either.
    await expect(saveNodeSettings(sql, { ...base, nodeName: "   ", identityProvider: provider("https://new.example") })).rejects.toThrow(
      /check constraint/,
    );
    expect(await subjects()).toEqual(["sub-u1", "sub-u2", null]);
  });

  it("resets the row, the provider and every subject together, and says which provider it was", async () => {
    await saveNodeSettings(sql, { ...base, nodeName: "Liv's Mac", identityProvider: provider("https://id.example", "Okta") });
    await linkedUnder();
    expect(await resetNodeSettings(sql)).toEqual({
      identityProvider: { issuer: "https://id.example", clientId: "stuga", label: "Okta", scopes: null },
      unlinkedAccounts: 2,
    });
    expect(await getNodeSettings(sql)).toBeNull();
    expect(await subjects()).toEqual([null, null, null]);
    expect(await inFlight()).toBe(0);
    // With nothing saved, a reset still clears a subject left behind.
    await sql`UPDATE users SET oidc_sub = 'stray' WHERE alias = 'u1'`;
    expect(await resetNodeSettings(sql)).toEqual({ identityProvider: null, unlinkedAccounts: 1 });
  });
});


describe.skipIf(!URL)("what the node learned about newer versions", () => {
  let sql: Sql;
  const FEED = { format: 1, releases: [{ version: "1.10.0", date: "2026-12-01", security: true }] };

  beforeAll(async () => {
    sql = createClient(URL!);
    await initSchema(sql);
  });
  afterAll(async () => {
    await closeClients();
  });
  beforeEach(async () => {
    await sql`DELETE FROM node_state`;
    await recordNodeBoot(sql, "9.9.9-test");
  });

  it("names the version that last booted, and nothing on a database no node booted on", async () => {
    expect(await lastNodeBoot(sql)).toMatchObject({ version: "9.9.9-test" });
    expect((await lastNodeBoot(sql))!.at).toBeInstanceOf(Date);
    await sql`DELETE FROM node_state`;
    expect(await lastNodeBoot(sql)).toBeNull();
  });

  it("records a scheduled backup's try, and why it failed", async () => {
    await recordNodeBoot(sql, "1.0.0");
    const at = new Date("2026-09-23T03:00:00Z");
    await recordBackupAttempt(sql, { at, error: "not enough disk" });
    expect(await getNodeState(sql)).toMatchObject({ backup_attempted_at: at, backup_error: "not enough disk" });
    await recordBackupAttempt(sql, { at, error: null });
    expect(await getNodeState(sql)).toMatchObject({ backup_error: null });
  });

  it("is nothing on a node that has never looked", async () => {
    expect(await getNodeState(sql)).toMatchObject({ update_checked_at: null, update_feed: null, update_check_error: null });
  });

  it("keeps what a good look listed through a look that failed, and forgets the failure at the next good one", async () => {
    await recordUpdateCheck(sql, { feed: FEED });
    const good = await getNodeState(sql);
    expect(good).toMatchObject({ update_feed: FEED, update_check_error: null });
    expect(good!.update_checked_at).toBeInstanceOf(Date);

    await recordUpdateCheck(sql, { error: "could not reach github.com" });
    expect(await getNodeState(sql)).toMatchObject({ update_feed: FEED, update_check_error: "could not reach github.com" });

    await recordUpdateCheck(sql, { feed: { format: 1, releases: [] } });
    expect(await getNodeState(sql)).toMatchObject({ update_feed: { format: 1, releases: [] }, update_check_error: null });
  });

  it("outlives the next boot, which stamps only the version", async () => {
    await recordUpdateCheck(sql, { feed: FEED });
    await recordNodeBoot(sql, "9.9.9-next");
    expect(await getNodeState(sql)).toMatchObject({ app_version: "9.9.9-next", update_feed: FEED });
  });
});
