import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeClients, createClient, type Sql } from "./client.js";
import {
  getRemoteAccess,
  recordRemoteAccount,
  recordRemoteCert,
  recordRemoteCertAri,
  recordRemoteCertFailure,
  recordRemoteCheckin,
  recordRemoteConnectorConfig,
  recordRemoteCredential,
  recordRemoteCredentialFailure,
  recordRemoteProbe,
  saveRemoteBinding,
  setRemoteBindingFailing,
  setRemoteCertAlerted,
  setRemoteCertAriNext,
  setRemoteCheckinNext,
  setRemoteEnabled,
  setRemoteError,
} from "./remote-access.js";
import { initSchema } from "./schema/migrate.js";
import type { NodeRemoteAccessRow } from "./types.js";

const URL = process.env.TEST_DATABASE_URL;

const T0 = new Date("2026-10-02T00:13:10.000Z");
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

const BINDING = {
  remoteId: "k7f3q2",
  hostname: "k7f3q2.remote.stuga.test",
  apiUrl: "https://api.stuga.test",
  thumbprint: "epnrdAhv6ihfu57nfrZyWa5dBDocHkmhCzeYSLAcgtE",
  boundAt: T0,
};

const RELAY = { name: "relay-1", addr: "relay-1.remote.stuga.test", port: 7000, server_name: "relay-1.remote.stuga.test", ca_pem: "pem" };

const CHECKIN = {
  at: at(1),
  nextAt: at(21_600),
  apiUrl: "https://api2.stuga.test",
  hostname: "k7f3q2.remote.stuga.test",
  relays: [RELAY],
  acmeDirectory: "https://ca.stuga.test/directory",
  acmeProfile: null,
  acmeReissueBefore: null,
  credentialTtl: 86_400,
  credentialNotBefore: null,
};

/** The columns that differ between two reads of the row, `updated_at` aside. */
function changed(before: NodeRemoteAccessRow, after: NodeRemoteAccessRow): string[] {
  return (Object.keys(after) as Array<keyof NodeRemoteAccessRow>)
    .filter((k) => k !== "updated_at" && JSON.stringify(before[k]) !== JSON.stringify(after[k]))
    .sort();
}

describe.skipIf(!URL)("node_remote_access", () => {
  let sql: Sql;

  beforeAll(async () => {
    sql = createClient(URL!);
    await initSchema(sql);
  });
  afterAll(async () => {
    await closeClients();
  });
  beforeEach(async () => {
    await sql`DELETE FROM node_remote_access`;
  });

  it("reads every column's default before anything is written", async () => {
    const row = await getRemoteAccess(sql);
    expect(row).toMatchObject({ enabled: false, remote_id: null, relays: [], cert_failures: 0, last_error: null, updated_at: null });
  });

  it("writes only each function's own columns", async () => {
    await saveRemoteBinding(sql, BINDING);
    await setRemoteBindingFailing(sql, at(-60));
    const steps: Array<[string, () => Promise<void>, string[]]> = [
      [
        "saveRemoteBinding",
        () => saveRemoteBinding(sql, { ...BINDING, remoteId: "m9d4tz", hostname: "m9d4tz.remote.stuga.test", boundAt: at(2) }),
        ["binding_failing_since", "bound_at", "hostname", "remote_id"],
      ],
      [
        "setRemoteEnabled on",
        () => setRemoteEnabled(sql, { enabled: true, by: "liv", at: at(3), caTermsAcceptedBy: "liv", caTermsAcceptedAt: at(3) }),
        ["ca_terms_accepted_at", "ca_terms_accepted_by", "enabled", "enabled_at", "enabled_by"],
      ],
      ["setRemoteEnabled off", () => setRemoteEnabled(sql, { enabled: false }), ["enabled"]],
      ["setRemoteBindingFailing", () => setRemoteBindingFailing(sql, at(4)), ["binding_failing_since"]],
      [
        "recordRemoteCheckin",
        () => recordRemoteCheckin(sql, { ...CHECKIN, hostname: "m9d4tz.remote.stuga.test" }),
        [
          "acme_directory",
          "api_url",
          "binding_failing_since",
          "checkin_at",
          "checkin_next_at",
          "credential_ttl",
          "relays",
        ],
      ],
      ["setRemoteCheckinNext", () => setRemoteCheckinNext(sql, at(3600)), ["checkin_next_at"]],
      [
        "recordRemoteAccount",
        () => recordRemoteAccount(sql, { directory: "https://ca.stuga.test/directory", url: "https://ca.stuga.test/acct/1", termsUrl: "https://ca.stuga.test/terms" }),
        ["acme_account_directory", "acme_account_url", "ca_terms_url"],
      ],
      ["recordRemoteCertFailure", () => recordRemoteCertFailure(sql, { failures: 2, retryAt: at(300) }), ["cert_failures", "cert_retry_at"]],
      [
        "recordRemoteCertAri",
        () => recordRemoteCertAri(sql, { windowStart: at(100), windowEnd: at(140), renewAt: at(120), nextAt: at(21_600) }),
        ["cert_ari_next_at", "cert_ari_window_end", "cert_ari_window_start", "cert_renew_at"],
      ],
      ["setRemoteCertAriNext", () => setRemoteCertAriNext(sql, at(3600)), ["cert_ari_next_at"]],
      ["setRemoteCertAlerted", () => setRemoteCertAlerted(sql, "04f0"), ["cert_alerted_serial"]],
      [
        "recordRemoteCert",
        () =>
          recordRemoteCert(sql, {
            serial: "04f1",
            directory: "https://ca.stuga.test/directory",
            notBefore: at(0),
            notAfter: at(180),
            renewAt: at(117),
            reissueBefore: at(-60),
            accountUrl: "https://ca.stuga.test/acct/1",
          }),
        [
          "cert_account_url",
          "cert_ari_next_at",
          "cert_ari_window_end",
          "cert_ari_window_start",
          "cert_directory",
          "cert_failures",
          "cert_not_after",
          "cert_not_before",
          "cert_reissue_before",
          "cert_renew_at",
          "cert_retry_at",
          "cert_serial",
        ],
      ],
      [
        "recordRemoteCredentialFailure",
        () => recordRemoteCredentialFailure(sql, { failures: 1, retryAt: at(60) }),
        ["credential_failures", "credential_retry_at"],
      ],
      [
        "recordRemoteCredential",
        () => recordRemoteCredential(sql, { issuedAt: at(5), expiresAt: at(605), refreshAt: at(155) }),
        ["credential_expires_at", "credential_failures", "credential_issued_at", "credential_refresh_at", "credential_retry_at"],
      ],
      ["recordRemoteProbe failed", () => recordRemoteProbe(sql, { at: at(6), ok: false }), ["probe_at", "probe_failures"]],
      ["recordRemoteProbe ok", () => recordRemoteProbe(sql, { at: at(7), ok: true }), ["probe_at", "probe_failures", "probe_ok_at"]],
      [
        "recordRemoteConnectorConfig",
        () => recordRemoteConnectorConfig(sql, { sha256: "a".repeat(64), changedAt: at(8) }),
        ["connector_config_changed_at", "connector_config_sha256"],
      ],
      [
        "setRemoteError",
        () => setRemoteError(sql, { code: "service_unreachable", message: "Couldn't reach the remote access service.", at: at(9).toISOString() }),
        ["last_error"],
      ],
    ];
    for (const [name, step, columns] of steps) {
      const before = await getRemoteAccess(sql);
      await step();
      const after = await getRemoteAccess(sql);
      expect(changed(before, after), name).toEqual(columns);
      expect(after.updated_at!.getTime(), name).toBeGreaterThanOrEqual(before.updated_at!.getTime());
    }
  });

  it("keeps the start of a run of refusals, and a success ends it", async () => {
    await setRemoteBindingFailing(sql, at(0));
    await setRemoteBindingFailing(sql, at(600));
    expect((await getRemoteAccess(sql)).binding_failing_since).toEqual(at(0));
    await recordRemoteCheckin(sql, CHECKIN);
    expect((await getRemoteAccess(sql)).binding_failing_since).toBeNull();
  });

  it("counts failed self-checks in a row, and a success starts the count again", async () => {
    await recordRemoteProbe(sql, { at: at(0), ok: false });
    await recordRemoteProbe(sql, { at: at(1), ok: false });
    expect(await getRemoteAccess(sql)).toMatchObject({ probe_failures: 2, probe_ok_at: null });
    await recordRemoteProbe(sql, { at: at(2), ok: true });
    expect(await getRemoteAccess(sql)).toMatchObject({ probe_failures: 0, probe_ok_at: at(2), probe_at: at(2) });
  });

  it("stores the relays and the error as JSON, and clears the error with null", async () => {
    await recordRemoteCheckin(sql, CHECKIN);
    const error = { code: "denied", message: "Remote access is off for this address.", at: at(0).toISOString(), reason: "abuse" };
    await setRemoteError(sql, error);
    const row = await getRemoteAccess(sql);
    expect(row.relays).toEqual([RELAY]);
    expect(row.last_error).toEqual(error);
    await setRemoteError(sql, null);
    expect((await getRemoteAccess(sql)).last_error).toBeNull();
  });

  it("will not turn on without a binding and an accepted subscriber agreement", async () => {
    const on = { enabled: true as const, by: "liv", at: T0, caTermsAcceptedBy: "liv", caTermsAcceptedAt: T0 };
    await expect(setRemoteEnabled(sql, on)).rejects.toThrow(/check constraint/);
    await saveRemoteBinding(sql, BINDING);
    await setRemoteEnabled(sql, on);
    expect((await getRemoteAccess(sql)).enabled).toBe(true);
    await expect(sql`UPDATE node_remote_access SET ca_terms_accepted_at = NULL`).rejects.toThrow(/check constraint/);
  });

  it.each([
    ["an id with a vowel", { remoteId: "k7f3a2" }],
    ["an id too short", { remoteId: "k7f3q" }],
    ["an upper-case hostname", { hostname: "K7F3Q2.remote.stuga.test" }],
    ["a hostname with a trailing dot", { hostname: "k7f3q2.remote.stuga.test." }],
    ["a hostname that is not under an id", { hostname: "www.remote.stuga.test" }],
    ["plain HTTP to a remote service", { apiUrl: "http://api.stuga.test" }],
    ["a service URL with a path", { apiUrl: "https://api.stuga.test/v1" }],
    ["a thumbprint of the wrong length", { thumbprint: "abc" }],
  ])("refuses %s", async (_name, bad) => {
    await expect(saveRemoteBinding(sql, { ...BINDING, ...bad })).rejects.toThrow(/check constraint/);
  });

  it("takes plain HTTP to a service on loopback, for tests", async () => {
    await saveRemoteBinding(sql, { ...BINDING, apiUrl: "http://127.0.0.1:18080" });
    await saveRemoteBinding(sql, { ...BINDING, apiUrl: "http://localhost:18080" });
    expect((await getRemoteAccess(sql)).api_url).toBe("http://localhost:18080");
  });
});
