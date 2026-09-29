import { describe, expect, it } from "vitest";
import type { NodeRemoteAccessRow, StoredRemoteError } from "@stuga/db";
import { ServiceError } from "./service-client.js";
import type { ConnectorStatus } from "@stuga/protocol/api/remote-access";
import type { ConnectorReport } from "./connector.js";
import { bindingBackoff, clearedBy, generalBackoff, remoteState, remoteStatus, serviceFailure, shownError } from "./state.js";

const NOW = new Date("2026-10-02T12:00:00.000Z");
const MIN = 60_000;
const later = (ms: number) => new Date(NOW.getTime() + ms);
const earlier = (ms: number) => new Date(NOW.getTime() - ms);
const err = (code: string): StoredRemoteError => ({ code, message: "m", at: NOW.toISOString() });

function row(over: Partial<NodeRemoteAccessRow> = {}): NodeRemoteAccessRow {
  return {
    enabled: true,
    enabled_by: "liv",
    enabled_at: earlier(MIN),
    remote_id: "k7f3q2",
    hostname: "k7f3q2.mystuga.com",
    api_url: "https://api.stuga.dev",
    binding_thumbprint: "epnrdAhv6ihfu57nfrZyWa5dBDocHkmhCzeYSLAcgtE",
    bound_at: earlier(MIN),
    binding_failing_since: null,
    relays: [{ name: "relay-1", addr: "relay-1.mystuga.com", port: 7000, server_name: "relay-1.mystuga.com", ca_pem: "pem" }],
    acme_directory: "https://acme-v02.api.letsencrypt.org/directory",
    acme_profile: null,
    acme_reissue_before: null,
    acme_account_directory: null,
    acme_account_url: null,
    ca_terms_accepted_by: "liv",
    ca_terms_accepted_at: earlier(MIN),
    ca_terms_url: "https://letsencrypt.org/documents/LE-SA-v1.8-July-06-2026.pdf",
    cert_serial: "04f1",
    cert_directory: null,
    cert_not_before: earlier(MIN),
    cert_not_after: later(89 * 24 * 60 * MIN),
    cert_renew_at: later(59 * 24 * 60 * MIN),
    cert_reissue_before: null,
    cert_failures: 0,
    cert_retry_at: null,
    cert_account_url: null,
    cert_ari_next_at: null,
    cert_ari_window_start: null,
    cert_ari_window_end: null,
    cert_alerted_serial: null,
    checkin_at: earlier(MIN),
    checkin_next_at: later(6 * 60 * MIN),
    credential_ttl: 86_400,
    credential_not_before: null,
    credential_issued_at: earlier(MIN),
    credential_expires_at: later(24 * 60 * MIN),
    credential_refresh_at: later(6 * 60 * MIN),
    credential_failures: 0,
    credential_retry_at: null,
    probe_at: earlier(MIN / 2),
    probe_ok_at: earlier(MIN / 2),
    probe_failures: 0,
    connector_config_sha256: null,
    connector_config_changed_at: earlier(MIN),
    last_error: null,
    updated_at: NOW,
    ...over,
  };
}

describe("the state the Settings page shows", () => {
  it.each<[string, Partial<NodeRemoteAccessRow>, string]>([
    ["off, whatever else holds", { enabled: false, last_error: err("binding_rejected") }, "off"],
    ["error: the key is rejected", { last_error: err("binding_rejected") }, "error"],
    ["error: an upgrade is needed", { last_error: err("upgrade_required") }, "error"],
    ["error: the CA needs an administrator", { last_error: err("acme_action_required") }, "error"],
    ["error: the shared directory", { last_error: err("remote_dir_unusable") }, "error"],
    ["error: the socket path", { last_error: err("socket_path_too_long") }, "error"],
    ["denied", { last_error: err("denied") }, "denied"],
    ["denied: retired", { last_error: err("retired") }, "denied"],
    ["on: certificate, credential and the last self-check all good", {}, "on"],
    ["degraded: any other error", { last_error: err("service_unreachable") }, "degraded"],
    ["degraded: a failed self-check", { last_error: err("connector_unreachable"), probe_ok_at: earlier(MIN) }, "degraded"],
    ["starting: no certificate yet", { cert_not_after: null }, "starting"],
    ["degraded: the certificate ran out", { cert_not_after: earlier(1) }, "degraded"],
    ["starting: no credential yet", { credential_expires_at: null }, "starting"],
    ["starting: no self-check yet", { probe_at: null, probe_ok_at: null }, "starting"],
    ["starting: the last self-check failed and said nothing", { probe_ok_at: earlier(MIN) }, "starting"],
  ])("%s", (_name, over, expected) => {
    expect(remoteState(row(over), NOW)).toBe(expected);
  });
});

describe("the status body", () => {
  it("names the address, the certificate, the credential, the connector and who accepted the CA's terms", () => {
    const status = remoteStatus(row(), { dir: "/Users/liv/.stuga-remote", now: NOW });
    expect(status).toEqual({
      available: true,
      enabled: true,
      state: "on",
      address: "https://k7f3q2.mystuga.com",
      certificate: { expires_at: row().cert_not_after!.toISOString(), renew_at: row().cert_renew_at!.toISOString() },
      credential: { expires_at: row().credential_expires_at!.toISOString() },
      connector: {
        managed: false,
        status: null,
        config_path: "/Users/liv/.stuga-remote/relay-1.toml",
        config_changed_at: row().connector_config_changed_at!.toISOString(),
        reachable: true,
        checked_at: row().probe_at!.toISOString(),
      },
      ca_terms: { accepted_by: "liv", accepted_at: row().ca_terms_accepted_at!.toISOString(), url: row().ca_terms_url },
      last_error: null,
    });
  });

  it("has nothing but off before the node is ever bound", () => {
    const blank = row({
      enabled: false,
      remote_id: null,
      hostname: null,
      relays: [],
      cert_not_after: null,
      credential_expires_at: null,
      probe_at: null,
      probe_ok_at: null,
      ca_terms_accepted_at: null,
    });
    expect(remoteStatus(blank, { dir: "/d", now: NOW })).toMatchObject({
      state: "off",
      address: null,
      certificate: null,
      credential: null,
      connector: null,
      ca_terms: null,
    });
  });

  it("hands the packaging's status over, and no command to run, where it runs the connector", () => {
    const status = remoteStatus(row(), { dir: "/d", now: NOW, connector: report("running") });
    expect(status).toMatchObject({ state: "on", last_error: null });
    if (!status.available) throw new Error("unavailable");
    expect(status.connector).toMatchObject({ managed: true, status: report("running").status, config_path: null, reachable: true });

    // Reported before the node has any settings of its own for it.
    const before = row({ relays: [], probe_at: null, probe_ok_at: null });
    expect(remoteStatus(before, { dir: "/d", now: NOW, connector: report("stopped") })).toMatchObject({
      connector: { managed: true, status: { state: "stopped" }, config_path: null },
    });
    expect(remoteStatus(before, { dir: "/d", now: NOW, connector: report(null) })).toMatchObject({ connector: null });
  });

  it("shows the error the state says rather than the one kept", () => {
    expect(remoteStatus(row({ last_error: err("connector_unreachable") }), { dir: "/d", now: NOW, connector: report("refused") })).toMatchObject({
      state: "error",
      last_error: { code: "connector_refused" },
    });
  });

  it("keeps the address while off", () => {
    expect(remoteStatus(row({ enabled: false }), { dir: "/d", now: NOW })).toMatchObject({ state: "off", address: "https://k7f3q2.mystuga.com" });
  });
});

const SHA = "a".repeat(64);
const report = (state: ConnectorStatus["state"] | null, over: Partial<ConnectorReport> = {}): ConnectorReport => ({
  status: state ? { state, message: `helper: ${state}`, at: earlier(MIN).toISOString(), connector_sha: SHA, config_sha: SHA } : null,
  stale: false,
  retryAt: null,
  behindSince: null,
  ...over,
});

describe("what the state itself says, never kept", () => {
  it("says an expired certificate is degraded, from when it expired, and nothing once a new one is here", () => {
    expect(shownError(row({ cert_not_after: earlier(MIN) }), NOW)).toEqual({
      code: "certificate_expired",
      message: "The certificate expired.",
      at: earlier(MIN).toISOString(),
    });
    expect(shownError(row(), NOW)).toBeNull();
    expect(remoteState(row({ cert_not_after: earlier(MIN) }), NOW)).toBe("degraded");
  });

  it("says a refused connector is an error, with the packaging's reason", () => {
    const r = row();
    expect(shownError(r, NOW, report("refused"))).toEqual({ code: "connector_refused", message: "helper: refused", at: earlier(MIN).toISOString() });
    expect(remoteState(r, NOW, report("refused"))).toBe("error");
  });

  it("says a failed connector is degraded, with the packaging's reason and when the node asks again", () => {
    const retryAt = later(5 * MIN);
    expect(shownError(row(), NOW, report("failed", { retryAt }))).toEqual({
      code: "connector_failed",
      message: "helper: failed",
      at: earlier(MIN).toISOString(),
      retry_at: retryAt.toISOString(),
    });
    expect(remoteState(row(), NOW, report("failed", { retryAt }))).toBe("degraded");
  });

  it("says an installation without the connector is an error, with no retry", () => {
    expect(shownError(row(), NOW, report("unavailable"))).toEqual({
      code: "connector_unavailable",
      message: "helper: unavailable",
      at: earlier(MIN).toISOString(),
    });
    expect(remoteState(row(), NOW, report("unavailable"))).toBe("error");
    expect(remoteState(row(), NOW, report("unavailable", { stale: true }))).toBe("on");
  });

  it("says a connector not running what it was asked to, after asking again, is degraded", () => {
    const retryAt = later(4 * MIN);
    const since = earlier(2 * MIN);
    for (const state of [null, "stopped", "installing"] as const) {
      expect(shownError(row(), NOW, report(state, { retryAt, behindSince: since }))).toEqual({
        code: "connector_failed",
        message: "The connector isn't running.",
        at: since.toISOString(),
        retry_at: retryAt.toISOString(),
      });
    }
    expect(remoteState(row(), NOW, report("stopped", { stale: true, retryAt, behindSince: since }))).toBe("degraded");
    // The packaging's own reason says more.
    expect(shownError(row(), NOW, report("failed", { retryAt, behindSince: since }))?.message).toBe("helper: failed");
  });

  it("gives the reason renewal is stuck, and when it tries again, over the expiry itself", () => {
    const retryAt = later(30 * MIN);
    const stuck = { ...err("acme_rate_limited"), retry_at: retryAt.toISOString() };
    const r = row({ cert_not_after: earlier(MIN), last_error: stuck });
    expect(shownError(r, NOW, report("stopped"))).toEqual(stuck);
    expect(remoteState(r, NOW, report("stopped"))).toBe("degraded");
    // A kept error of another kind says less than the expiry.
    expect(shownError(row({ cert_not_after: earlier(MIN), last_error: err("service_unreachable") }), NOW)?.code).toBe("certificate_expired");
  });

  it("takes no answer to an earlier request as one to this", () => {
    expect(shownError(row(), NOW, report("refused", { stale: true }))).toBeNull();
    expect(shownError(row(), NOW, report("failed", { stale: true }))).toBeNull();
    expect(remoteState(row(), NOW, report("refused", { stale: true }))).toBe("on");
  });

  it("puts an error kept for an administrator first, then refused, missing, expired, failed, then the one kept", () => {
    const expired = { cert_not_after: earlier(MIN) };
    const kept = (code: string, over: Partial<NodeRemoteAccessRow> = {}) => row({ last_error: err(code), ...over });
    expect(shownError(kept("acme_action_required", expired), NOW, report("refused"))?.code).toBe("acme_action_required");
    expect(shownError(kept("denied", expired), NOW, report("refused"))?.code).toBe("denied");
    expect(shownError(kept("connector_unreachable", expired), NOW, report("refused"))?.code).toBe("connector_refused");
    expect(shownError(kept("connector_unreachable", expired), NOW, report("unavailable"))?.code).toBe("connector_unavailable");
    expect(shownError(kept("connector_unreachable", expired), NOW, report("failed"))?.code).toBe("certificate_expired");
    expect(shownError(kept("connector_unreachable"), NOW, report("failed"))?.code).toBe("connector_failed");
    expect(shownError(kept("connector_unreachable"), NOW, report("running"))?.code).toBe("connector_unreachable");
    expect(shownError(kept("service_unreachable"), NOW, report("installing"))?.code).toBe("service_unreachable");
  });

  it("says nothing of it while off", () => {
    expect(shownError(row({ enabled: false, cert_not_after: earlier(MIN) }), NOW, report("refused"))).toBeNull();
  });
});

describe("clearing the error", () => {
  it("takes a success of the kind of work that raised it", () => {
    expect(clearedBy("service", err("service_unreachable"))).toBe(true);
    expect(clearedBy("service", err("denied"))).toBe(true);
    expect(clearedBy("service", err("binding_rejected"))).toBe(true);
    expect(clearedBy("service", err("connector_unreachable"))).toBe(false);
    expect(clearedBy("probe", err("connector_unreachable"))).toBe(true);
    expect(clearedBy("probe", err("service_refused"))).toBe(false);
    expect(clearedBy("issuance", err("dns_not_visible"))).toBe(true);
    // An issuance talks to the service as well.
    expect(clearedBy("issuance", err("service_unreachable"))).toBe(true);
    expect(clearedBy("issuance", err("wrong_certificate"))).toBe(false);
    // The budget holds issuance back until retry_at: only an issuance lifts it, not a check-in.
    expect(clearedBy("issuance", err("issuance_budget"))).toBe(true);
    expect(clearedBy("service", err("issuance_budget"))).toBe(false);
    // Nothing reaches the service after it in this process, so the first success is a newer Stuga's.
    expect(clearedBy("service", err("upgrade_required"))).toBe(true);
    expect(clearedBy("dir", err("remote_dir_unusable"))).toBe(true);
    expect(clearedBy("service", null)).toBe(false);
  });
});

describe("backoff", () => {
  it("steps network failures through 1, 5, 15, 60 minutes, then every 3 hours, ±10%", () => {
    const steps = [1, 5, 15, 60, 180, 180, 180];
    steps.forEach((minutes, i) => {
      expect(generalBackoff(i + 1, () => 0.5)).toBe(minutes * MIN);
      expect(generalBackoff(i + 1, () => 0)).toBe(Math.round(minutes * MIN * 0.9));
      expect(generalBackoff(i + 1, () => 1)).toBe(Math.round(minutes * MIN * 1.1));
    });
  });

  it("steps a refused key through 15 minutes, an hour, then every 6 hours", () => {
    expect([1, 2, 3, 4, 10].map(bindingBackoff)).toEqual([15 * MIN, 60 * MIN, 360 * MIN, 360 * MIN, 360 * MIN]);
  });
});

describe("what each answer from the service means (the protocol's error table)", () => {
  const ctx = (over: { failures?: number; since?: Date | null } = {}) => ({
    now: NOW,
    failures: over.failures ?? 1,
    bindingFailingSince: over.since ?? null,
    rand: () => 0.5,
  });
  const fail = (status: number, code: string, detail = {}) => new ServiceError(status, code, `the service said ${code}`, detail);
  const inMs = (d: Date | null) => (d ? d.getTime() - NOW.getTime() : null);

  it("400 bad_request: refused, an hour, then from the top", () => {
    const f = serviceFailure(fail(400, "bad_request"), ctx());
    expect(f.lastError).toMatchObject({ code: "service_refused", service_code: "bad_request" });
    expect(inMs(f.retryAt)).toBe(60 * MIN);
  });

  it.each(["unknown_key", "bad_signature"])("401 %s: the key stays, backs off, and is reported rejected only after a day", (code) => {
    const first = serviceFailure(fail(401, code), ctx());
    expect(first.bindingRefused).toBe(true);
    expect(first.lastError).toMatchObject({ code: "service_refused", service_code: code });
    expect(inMs(first.retryAt)).toBe(15 * MIN);
    const hours = serviceFailure(fail(401, code), ctx({ failures: 3, since: earlier(23 * 60 * MIN) }));
    expect(hours.lastError.code).toBe("service_refused");
    expect(inMs(hours.retryAt)).toBe(6 * 60 * MIN);
    const day = serviceFailure(fail(401, code), ctx({ failures: 5, since: earlier(24 * 60 * MIN) }));
    expect(day.lastError).toMatchObject({ code: "binding_rejected", service_code: code });
    expect(inMs(day.retryAt)).toBe(6 * 60 * MIN);
  });

  it("403 node_denied: denied, with the service's reason and message, and an hourly check-in", () => {
    const f = serviceFailure(fail(403, "node_denied", { reason: "abuse" }), ctx());
    expect(f.denied).toBe(true);
    expect(f.lastError).toMatchObject({ code: "denied", reason: "abuse", message: "the service said node_denied" });
    expect(inMs(f.retryAt)).toBe(60 * MIN);
    const range = [0, 1].map((r) => inMs(serviceFailure(fail(403, "node_denied"), { ...ctx(), rand: () => r }).retryAt));
    expect(range).toEqual([54 * MIN, 66 * MIN]);
  });

  it("403 node_retired: the same, as retired", () => {
    const f = serviceFailure(fail(403, "node_retired"), ctx());
    expect(f.denied).toBe(true);
    expect(f.lastError.code).toBe("retired");
  });

  it.each(["cert_invalid", "pop_invalid"])("422 %s: refused, an hour, and nothing else", (code) => {
    const f = serviceFailure(fail(422, code), ctx());
    expect(f).toMatchObject({ lastError: { code: "service_refused", service_code: code } });
    expect(f.denied ?? f.bindingRefused ?? f.upgradeRequired).toBeUndefined();
    expect(inMs(f.retryAt)).toBe(60 * MIN);
  });

  it("426 upgrade_required: stops calling for good", () => {
    const f = serviceFailure(fail(426, "upgrade_required", { minProtocol: 2 }), ctx());
    expect(f).toMatchObject({ upgradeRequired: true, retryAt: null, lastError: { code: "upgrade_required" } });
  });

  it("429 rate_limited: waits for Retry-After", () => {
    const f = serviceFailure(fail(429, "rate_limited", { retryAfter: 600 }), ctx());
    expect(f.lastError).toMatchObject({ code: "service_refused", service_code: "rate_limited" });
    expect(inMs(f.retryAt)).toBe(600_000);
  });

  it("429 issuance_budget: waits for Retry-After, as issuance_budget", () => {
    const f = serviceFailure(fail(429, "issuance_budget", { retryAfter: 86_400 }), ctx());
    expect(f.lastError.code).toBe("issuance_budget");
    expect(inMs(f.retryAt)).toBe(86_400_000);
  });

  it.each([
    [502, "dns_failed"],
    [503, "unavailable"],
    [503, "network"],
    [500, "whatever_new"],
  ])("%s %s: unreachable, with the general backoff", (status, code) => {
    const f = serviceFailure(fail(status, code), ctx({ failures: 2 }));
    expect(f.lastError.code).toBe("service_unreachable");
    expect(inMs(f.retryAt)).toBe(5 * MIN);
  });

  it("503 dns_busy: waits for Retry-After", () => {
    const f = serviceFailure(fail(503, "dns_busy", { retryAfter: 600 }), ctx());
    expect(f.lastError.code).toBe("service_unreachable");
    expect(inMs(f.retryAt)).toBe(600_000);
  });

  it("an unknown 4xx is taken as a 400", () => {
    const f = serviceFailure(fail(418, "teapot"), ctx());
    expect(f.lastError).toMatchObject({ code: "service_refused", service_code: "teapot" });
    expect(inMs(f.retryAt)).toBe(60 * MIN);
  });
});
