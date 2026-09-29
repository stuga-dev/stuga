/**
 * Turning remote access on and off against the fake service, with the database row in memory:
 * the binding key's order of writes, and what each refusal becomes; and the service loop on a
 * certificate made here. The loops run end to end, with a real CA, in remote-access.integration.test.ts.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const memory = vi.hoisted(() => {
  const blank = () => ({
    enabled: false,
    enabled_by: null,
    enabled_at: null,
    remote_id: null,
    hostname: null,
    api_url: null,
    binding_thumbprint: null,
    bound_at: null,
    binding_failing_since: null,
    relays: [],
    acme_directory: null,
    acme_profile: null,
    acme_reissue_before: null,
    acme_account_directory: null,
    acme_account_url: null,
    ca_terms_accepted_by: null,
    ca_terms_accepted_at: null,
    ca_terms_url: null,
    cert_serial: null,
    cert_directory: null,
    cert_not_before: null,
    cert_not_after: null,
    cert_renew_at: null,
    cert_reissue_before: null,
    cert_failures: 0,
    cert_retry_at: null,
    cert_account_url: null,
    cert_ari_next_at: null,
    cert_ari_window_start: null,
    cert_ari_window_end: null,
    cert_alerted_serial: null,
    checkin_at: null,
    checkin_next_at: null,
    credential_ttl: null,
    credential_not_before: null,
    credential_issued_at: null,
    credential_expires_at: null,
    credential_refresh_at: null,
    credential_failures: 0,
    credential_retry_at: null,
    probe_at: null,
    probe_ok_at: null,
    probe_failures: 0,
    connector_config_sha256: null,
    connector_config_changed_at: null,
    last_error: null,
    updated_at: null,
  });
  let row: Record<string, unknown> = blank();
  return {
    row: () => row,
    reset: () => {
      row = blank();
    },
    set: (patch: Record<string, unknown>) => {
      row = { ...row, ...patch };
    },
  };
});

vi.mock("@stuga/db", async (importOriginal) => {
  type Db = typeof import("@stuga/db");
  return {
    ...(await importOriginal<Db>()),
    getRemoteAccess: async () => ({ ...memory.row() }),
    saveRemoteBinding: async (_sql: unknown, b: Parameters<Db["saveRemoteBinding"]>[1]) =>
      memory.set({ remote_id: b.remoteId, hostname: b.hostname, api_url: b.apiUrl, binding_thumbprint: b.thumbprint, bound_at: b.boundAt, binding_failing_since: null }),
    setRemoteEnabled: async (_sql: unknown, e: { enabled: boolean; by?: string; at?: Date; caTermsAcceptedBy?: string; caTermsAcceptedAt?: Date }) =>
      memory.set(
        e.enabled
          ? { enabled: true, enabled_by: e.by, enabled_at: e.at, ca_terms_accepted_by: e.caTermsAcceptedBy, ca_terms_accepted_at: e.caTermsAcceptedAt }
          : { enabled: false },
      ),
    setRemoteError: async (_sql: unknown, err: unknown) => memory.set({ last_error: err }),
    recordRemoteCheckin: async (_sql: unknown, c: Parameters<Db["recordRemoteCheckin"]>[1]) =>
      memory.set({
        checkin_at: c.at,
        checkin_next_at: c.nextAt,
        api_url: c.apiUrl,
        hostname: c.hostname,
        relays: c.relays,
        acme_directory: c.acmeDirectory,
        acme_profile: c.acmeProfile,
        acme_reissue_before: c.acmeReissueBefore,
        credential_ttl: c.credentialTtl,
        credential_not_before: c.credentialNotBefore,
        binding_failing_since: null,
      }),
    setRemoteCheckinNext: async (_sql: unknown, nextAt: Date) => memory.set({ checkin_next_at: nextAt }),
    recordRemoteAccount: async (_sql: unknown, a: Parameters<Db["recordRemoteAccount"]>[1]) =>
      memory.set({ acme_account_directory: a.directory, acme_account_url: a.url, ca_terms_url: a.termsUrl }),
    recordRemoteCert: async (_sql: unknown, c: Parameters<Db["recordRemoteCert"]>[1]) =>
      memory.set({
        cert_serial: c.serial,
        cert_directory: c.directory,
        cert_not_before: c.notBefore,
        cert_not_after: c.notAfter,
        cert_renew_at: c.renewAt,
        cert_reissue_before: c.reissueBefore,
        cert_account_url: c.accountUrl,
        cert_failures: 0,
        cert_retry_at: null,
        cert_ari_next_at: null,
        cert_ari_window_start: null,
        cert_ari_window_end: null,
      }),
    recordRemoteCertAri: async (_sql: unknown, a: Parameters<Db["recordRemoteCertAri"]>[1]) =>
      memory.set({ cert_ari_window_start: a.windowStart, cert_ari_window_end: a.windowEnd, cert_renew_at: a.renewAt, cert_ari_next_at: a.nextAt }),
    setRemoteCertAriNext: async (_sql: unknown, nextAt: Date) => memory.set({ cert_ari_next_at: nextAt }),
    setRemoteCertAlerted: async (_sql: unknown, serial: string | null) => memory.set({ cert_alerted_serial: serial }),
    recordRemoteCertFailure: async (_sql: unknown, f: { failures: number; retryAt: Date | null }) =>
      memory.set({ cert_failures: f.failures, cert_retry_at: f.retryAt }),
    recordRemoteCredential: async (_sql: unknown, c: Parameters<Db["recordRemoteCredential"]>[1]) =>
      memory.set({
        credential_issued_at: c.issuedAt,
        credential_expires_at: c.expiresAt,
        credential_refresh_at: c.refreshAt,
        credential_failures: 0,
        credential_retry_at: null,
      }),
    recordRemoteCredentialFailure: async (_sql: unknown, f: { failures: number; retryAt: Date | null }) =>
      memory.set({ credential_failures: f.failures, credential_retry_at: f.retryAt }),
    recordRemoteProbe: async (_sql: unknown, p: { at: Date; ok: boolean }) =>
      memory.set(p.ok ? { probe_at: p.at, probe_ok_at: p.at, probe_failures: 0 } : { probe_at: p.at, probe_failures: (memory.row().probe_failures as number) + 1 }),
    recordRemoteConnectorConfig: async (_sql: unknown, c: { sha256: string; changedAt: Date }) =>
      memory.set({ connector_config_sha256: c.sha256, connector_config_changed_at: c.changedAt }),
    setRemoteBindingFailing: async (_sql: unknown, since: Date) =>
      memory.set({ binding_failing_since: memory.row().binding_failing_since ?? since }),
  };
});

const { createRemoteAccess, RemoteAccessRefusal } = await import("./service.js");
const { createServingGate } = await import("../http/serving-gate.js");
const { startFakeRemoteService } = await import("./testing/fake-service.js");
const { readCertificate, writeCertificate } = await import("./certificates.js");
import { makeTestCert } from "../testing/cert.js";
import { ariCertId } from "./acme/der.js";
import type { ChallengeResolver } from "./dns-check.js";
import type { RemoteNotice } from "./notify.js";
import { FAKE_CA, FAKE_CA_DIRECTORY, fakeCa, type FakeCa } from "./testing/fake-ca.js";
import type { FakeRemoteService } from "./testing/fake-service.js";
import type { RemoteAccess, RemoteTiming } from "./service.js";

const sql = { begin: async (fn: (tx: unknown) => Promise<unknown>) => fn(sql) };

let fake: FakeRemoteService;
let work: string;
let remoteDir: string;
let dataDir: string;
const services: RemoteAccess[] = [];

/** The address always answers the self-check: nothing here goes through a relay. */
function service(
  opts: { publicOrigin?: string; timing?: Partial<RemoteTiming>; ca?: FakeCa; notify?: (n: RemoteNotice) => Promise<void> } = {},
): RemoteAccess {
  const s = createRemoteAccess({
    sql: sql as never,
    env: { publicOrigin: opts.publicOrigin ?? "http://livs-air.local:8787" },
    config: { service: fake.url, dir: remoteDir, dataDir },
    gate: createServingGate(),
    readsOwnBody: () => false,
    maxBodyBytes: () => 1 << 20,
    probe: async () => ({ ok: true }),
    ...(opts.timing ? { timing: opts.timing } : {}),
    ...(opts.ca ? { acmeTransport: opts.ca.transport, challengeResolver: fakeZone() } : {}),
    ...(opts.notify ? { notify: opts.notify } : {}),
    onError: () => {},
  });
  services.push(s);
  return s;
}

const refusal = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as InstanceType<typeof RemoteAccessRefusal>);
const pendingPath = () => join(dataDir, "secrets", "remote-binding.pending.jwk");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lastError = () => memory.row().last_error as { code: string; message: string } | null;

async function until(what: string, fn: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

/** Bound and on, with a day's certificate for its address on disk: what the service loop needs. */
async function bound(): Promise<RemoteAccess> {
  const s = service();
  await s.enable({ code: fake.mintCode("enroll"), acceptCaTerms: true, by: "liv" });
  const cert = makeTestCert({ dnsNames: [memory.row().hostname as string] });
  await writeCertificate(dataDir, cert.privateKey, cert.cert);
  return s;
}

/** The zone's servers, as the fake service's records. */
function fakeZone(): ChallengeResolver {
  return {
    servers: async () => ["192.0.2.53"],
    txt: async (_server, fqdn) => ({ authoritative: true, records: fake.txtRecords.has(fqdn) ? [[fake.txtRecords.get(fqdn)!]] : [] }),
  };
}

beforeEach(async () => {
  memory.reset();
  fake = await startFakeRemoteService({ acmeDirectory: FAKE_CA_DIRECTORY, zone: "mystuga.com" });
  work = mkdtempSync(join(tmpdir(), "stuga-remote-svc-"));
  remoteDir = join(work, "remote");
  dataDir = join(work, "data");
});

afterEach(async () => {
  for (const s of services.splice(0)) await s.stop();
  vi.restoreAllMocks();
  await fake.close();
  rmSync(work, { recursive: true, force: true });
});

describe("turning remote access on", () => {
  it("has the binding key on disk before the service first hears of it, and keeps it through a failure", async () => {
    const onDisk: boolean[] = [];
    const sent: string[] = [];
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      onDisk.push(existsSync(pendingPath()));
      const header = JSON.parse(Buffer.from(String(init!.body).split(".")[0]!, "base64url").toString()) as { jwk: { x: string } };
      sent.push(header.jwk.x);
      return realFetch(input, init);
    });
    fake.failNext("/v1/enroll", 503, { error: "unavailable", message: "Try later." });
    const code = fake.mintCode("enroll");
    const failed = await refusal(service().enable({ code, acceptCaTerms: true, by: "liv" }));
    expect(failed).toMatchObject({ status: 502, code: "service_unreachable", message: "Couldn't reach the remote access service. Try again." });
    expect(memory.row().enabled).toBe(false);
    const pending = JSON.parse(readFileSync(pendingPath(), "utf8")) as { x: string };
    expect(onDisk).toEqual([true]);
    expect(sent).toEqual([pending.x]);

    // The same code again, with the same key: the service takes it as the same request.
    const { via, status } = await service().enable({ code, acceptCaTerms: true, by: "liv" });
    expect(via).toBe("enroll");
    expect(sent).toEqual([pending.x, pending.x]);
    expect(status).toMatchObject({ enabled: true, address: `https://${memory.row().hostname as string}` });
    expect(readdirSync(join(dataDir, "secrets")).sort()).toEqual(["remote-binding.jwk"]);
    expect(JSON.parse(readFileSync(join(dataDir, "secrets", "remote-binding.jwk"), "utf8")).x).toBe(pending.x);
    expect(memory.row()).toMatchObject({ enabled: true, enabled_by: "liv", ca_terms_accepted_by: "liv", api_url: fake.url });
  });

  it("needs a code until the node is bound, and not after", async () => {
    expect(await refusal(service().enable({ acceptCaTerms: true, by: "liv" }))).toMatchObject({
      status: 400,
      code: "code_required",
      message: "Enter the code you were given.",
    });
    const s = service();
    await s.enable({ code: fake.mintCode("enroll"), acceptCaTerms: true, by: "liv" });
    await s.disable("liv");
    const again = await s.enable({ acceptCaTerms: true, by: "liv" });
    expect(again.via).toBe("resume");
  });

  it.each<[string, (f: FakeRemoteService) => string, object]>([
    ["a code that does not exist", () => "0000-0000-0000-0000", { status: 400, code: "enroll_code_invalid", message: "That code isn't valid." }],
    [
      "an expired code",
      (f) => {
        f.failNext("/v1/enroll", 410, { error: "enroll_code_expired", message: "That code has expired." });
        return f.mintCode("enroll");
      },
      { status: 400, code: "enroll_code_expired", message: "That code has expired." },
    ],
    [
      "a denied address",
      (f) => {
        f.failNext("/v1/enroll", 403, { error: "node_denied", message: "Remote access is off for this address.", reason: "abuse" });
        return f.mintCode("enroll");
      },
      { status: 409, code: "denied", message: "Remote access is off for this address." },
    ],
    [
      "a retired address",
      (f) => {
        f.failNext("/v1/enroll", 403, { error: "node_retired", message: "Retired." });
        return f.mintCode("enroll");
      },
      { status: 409, code: "retired" },
    ],
    [
      "an old protocol",
      (f) => {
        f.setMinProtocol(2);
        return f.mintCode("enroll");
      },
      { status: 409, code: "upgrade_required", message: "Update Stuga to turn on remote access." },
    ],
    [
      "a busy service",
      (f) => {
        f.failNext("/v1/enroll", 429, { error: "rate_limited", message: "Slow down.", retry_after: 60 });
        return f.mintCode("enroll");
      },
      { status: 502, code: "service_unreachable" },
    ],
  ])("refuses %s, and stays off", async (_name, arrange, expected) => {
    const code = arrange(fake);
    expect(await refusal(service().enable({ code, acceptCaTerms: true, by: "liv" }))).toMatchObject(expected);
    expect(memory.row().enabled).toBe(false);
    expect(existsSync(pendingPath())).toBe(true);
  });

  it("refuses a code another node already used", async () => {
    const code = fake.mintCode("enroll");
    await service().enable({ code, acceptCaTerms: true, by: "liv" });
    memory.reset();
    rmSync(join(dataDir, "secrets"), { recursive: true });
    expect(await refusal(service().enable({ code, acceptCaTerms: true, by: "liv" }))).toMatchObject({
      status: 400,
      code: "enroll_code_used",
      message: "That code has already been used.",
    });
  });

  it("goes to the other endpoint once when the service says the code is the other kind", async () => {
    const s = service();
    await s.enable({ code: fake.mintCode("enroll"), acceptCaTerms: true, by: "liv" });
    const first = memory.row().remote_id as string;
    // Bound, with an enrollment code: a new address.
    const renewed = await s.enable({ code: fake.mintCode("enroll"), acceptCaTerms: true, by: "liv" });
    expect(renewed.via).toBe("enroll");
    expect(memory.row().remote_id).not.toBe(first);
    expect(fake.requests.slice(-2).map((r) => [r.path, r.status])).toEqual([
      ["/v1/rebind", 409],
      ["/v1/enroll", 201],
    ]);
    expect(readdirSync(join(dataDir, "secrets")).filter((f) => f.startsWith("remote-binding.retired-"))).toHaveLength(1);
  });

  it("refuses a shared directory it cannot use, or a socket path too long, before calling the service", async () => {
    writeFileSync(join(work, "remote"), "a file");
    expect(await refusal(service().enable({ code: fake.mintCode("enroll"), acceptCaTerms: true, by: "liv" }))).toMatchObject({
      status: 409,
      code: "remote_dir_unusable",
    });
    rmSync(join(work, "remote"));
    remoteDir = join(work, "r".repeat(120));
    expect(await refusal(service().enable({ code: fake.mintCode("enroll"), acceptCaTerms: true, by: "liv" }))).toMatchObject({
      status: 409,
      code: "socket_path_too_long",
    });
    remoteDir = join(work, "open");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(remoteDir);
    chmodSync(remoteDir, 0o777);
    expect(await refusal(service().enable({ code: fake.mintCode("enroll"), acceptCaTerms: true, by: "liv" }))).toMatchObject({
      status: 409,
      code: "remote_dir_unusable",
    });
    expect(fake.requests).toEqual([]);
  });

  it("keeps to its budget: a service that has not answered by then is as good as none", async () => {
    fake.pause();
    const started = Date.now();
    const s = service({ timing: { enableTimeoutMs: 1_500 } });
    expect(await refusal(s.enable({ code: fake.mintCode("enroll"), acceptCaTerms: true, by: "liv" }))).toMatchObject({
      status: 502,
      code: "service_unreachable",
    });
    // Asked, and given up on at the budget.
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_000);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(memory.row().enabled).toBe(false);
    fake.resume();
  });

  it("does not try the other endpoint with too little of its budget left", async () => {
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      await sleep(700);
      return realFetch(input, init);
    });
    const s = service({ timing: { enableTimeoutMs: 1_500 } });
    // A restore code sent to enroll: the answer that it is the other kind leaves under a second.
    const code = fake.mintCode("rebind", "k7f3q2");
    expect(await refusal(s.enable({ code, acceptCaTerms: true, by: "liv" }))).toMatchObject({ status: 502, code: "service_unreachable" });
    expect(fake.requests.map((r) => [r.path, r.status])).toEqual([["/v1/enroll", 409]]);
  });

  it("calls the service no more, in this process, once it said to upgrade", async () => {
    fake.setMinProtocol(2);
    const s = service();
    expect(await refusal(s.enable({ code: fake.mintCode("enroll"), acceptCaTerms: true, by: "liv" }))).toMatchObject({ code: "upgrade_required" });
    fake.setMinProtocol(1);
    const heard = fake.requests.length;
    expect(await refusal(s.enable({ code: fake.mintCode("enroll"), acceptCaTerms: true, by: "liv" }))).toMatchObject({
      status: 409,
      code: "upgrade_required",
      message: "Update Stuga to turn on remote access.",
    });
    expect(fake.requests.length).toBe(heard);
    // A newer Stuga, in a new process.
    expect((await service().enable({ code: fake.mintCode("enroll"), acceptCaTerms: true, by: "liv" })).via).toBe("enroll");
  });

  it("refuses the address PUBLIC_ORIGIN already is", async () => {
    const code = fake.mintCode("enroll");
    // Learn which address the code gets, then start over as a node whose PUBLIC_ORIGIN is it.
    await service().enable({ code, acceptCaTerms: true, by: "liv" });
    const origin = `https://${memory.row().hostname as string}`;
    const s = service({ publicOrigin: origin });
    await s.disable("liv");
    expect(await refusal(s.enable({ acceptCaTerms: true, by: "liv" }))).toMatchObject({ status: 409 });
    expect(memory.row().enabled).toBe(false);
  });
});

describe("turning remote access off", () => {
  it("removes the connector's files and keeps the binding", async () => {
    const s = service();
    await s.enable({ code: fake.mintCode("enroll"), acceptCaTerms: true, by: "liv" });
    memory.set({ relays: [{ name: "relay-1", addr: "a", port: 7000, server_name: "a", ca_pem: "" }] });
    for (const name of ["relay-1.jwt", "relay-1.toml", "relay-1.ca.pem", "notes.txt"]) writeFileSync(join(remoteDir, name), "x");
    const status = await s.disable("liv");
    expect(status).toMatchObject({ enabled: false, state: "off" });
    expect(readdirSync(remoteDir)).toEqual(["notes.txt"]);
    expect(memory.row()).toMatchObject({ enabled: false, credential_expires_at: null });
    expect(memory.row().remote_id).not.toBeNull();
    expect(existsSync(join(dataDir, "secrets", "remote-binding.jwk"))).toBe(true);
    expect(s.view.current()).toMatchObject({ enabled: false, id: memory.row().remote_id });
  });
});

describe("the service loop", () => {
  it("checks in again for a fresh nonce when the service refuses one, and only once", async () => {
    const s = await bound();
    fake.failNext("/v1/relay-credential", 409, { error: "nonce_invalid", message: "The nonce is not valid." });
    const heard = fake.requests.length;
    await s.start();
    await until("a credential", () => fake.issuedCredentials.length === 1);
    expect(fake.requests.slice(heard).map((r) => [r.path, r.status])).toEqual([
      ["/v1/checkin", 200],
      ["/v1/relay-credential", 409],
      ["/v1/checkin", 200],
      ["/v1/relay-credential", 200],
    ]);
    await until("the token file", () => existsSync(join(remoteDir, "relay-1.jwt")));
    expect(readFileSync(join(remoteDir, "relay-1.jwt"), "utf8")).toBe(`${fake.issuedCredentials[0]!.credential}\n`);
    expect(lastError()).toBeNull();
  });

  it("takes a check-in that names another node as no answer at all", async () => {
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const res = await realFetch(input, init);
      if (!String(input).endsWith("/v1/checkin") || !res.ok) return res;
      return Response.json({ ...((await res.json()) as object), node: { id: "m9d4tz", hostname: "m9d4tz.mystuga.com" } });
    });
    const s = await bound();
    const heard = fake.requests.length;
    await s.start();
    await until("the refusal", () => lastError()?.code === "service_unreachable");
    expect(fake.requests.slice(heard).map((r) => r.path)).toEqual(["/v1/checkin"]);
    expect(memory.row()).toMatchObject({ hostname: expect.not.stringContaining("m9d4tz"), checkin_at: null });
    expect(existsSync(join(remoteDir, "relay-1.toml"))).toBe(false);
  });

  it("starts with a damaged binding key, and says which file, rather than failing the node's start", async () => {
    await bound();
    const path = join(dataDir, "secrets", "remote-binding.jwk");
    const damaged = readFileSync(path, "utf8").slice(0, 20);
    writeFileSync(path, damaged);
    const heard = fake.requests.length;
    const restarted = service();
    await expect(restarted.start()).resolves.toBeUndefined();
    await until("binding_rejected", () => lastError()?.code === "binding_rejected");
    expect(lastError()!.message.startsWith(`${path} can't be read: `)).toBe(true);
    expect(lastError()!.message).toMatch(/\. Enter a restore code to keep the address\.$/);
    expect(await restarted.status()).toMatchObject({ state: "error" });
    expect(fake.requests.length).toBe(heard);
    // Kept as it is: the node never deletes a binding key.
    expect(readFileSync(path, "utf8")).toBe(damaged);
  });

  it("is back on after a restart once the service stops asking for an upgrade", async () => {
    const s = await bound();
    await s.start();
    await until("a credential", () => fake.issuedCredentials.length === 1);
    fake.setMinProtocol(2);
    s.kick();
    await until("upgrade_required", () => lastError()?.code === "upgrade_required");
    expect(await s.status()).toMatchObject({ state: "error" });
    await s.stop();

    fake.setMinProtocol(1);
    const restarted = service();
    await restarted.start();
    await until("the error cleared", () => lastError() === null);
    expect(fake.requests.at(-1)).toMatchObject({ path: "/v1/checkin", status: 200 });
  });
});

describe("the certificate loop", () => {
  const HOUR = 3_600_000;
  const row = () => memory.row() as unknown as import("@stuga/db").NodeRemoteAccessRow;
  const timing = { certTickMs: 30 };
  const leafId = async () => {
    const disk = await readCertificate(dataDir);
    if (disk.kind !== "ok") throw new Error(`no certificate: ${disk.kind}`);
    return ariCertId(disk.cert.leaf.raw)!;
  };

  async function on(ca: FakeCa, notify?: (n: RemoteNotice) => Promise<void>): Promise<RemoteAccess> {
    const s = service({ ca, timing, ...(notify ? { notify } : {}) });
    await s.enable({ code: fake.mintCode("enroll"), acceptCaTerms: true, by: "liv" });
    await s.start();
    await until("a certificate", () => row().cert_serial !== null, 10_000);
    return s;
  }

  it("asks the CA when to renew, renews in its window, and names the certificate it replaces", async () => {
    const ca = fakeCa();
    const s = await on(ca);
    await until("the renewal window", () => row().cert_ari_window_start !== null);
    const first = await leafId();
    expect(ca.ariRequests).toEqual([first]);
    const r = row();
    expect(r).toMatchObject({ cert_directory: FAKE_CA_DIRECTORY, cert_account_url: `${FAKE_CA}/acct/1`, cert_failures: 0 });
    const life = r.cert_not_after!.getTime() - r.cert_not_before!.getTime();
    // The CA's own dates, to the millisecond; the certificate's are to the second.
    expect(Math.abs(r.cert_ari_window_start!.getTime() - (r.cert_not_before!.getTime() + life * 0.6))).toBeLessThan(1_000);
    expect(r.cert_renew_at!.getTime()).toBeGreaterThanOrEqual(r.cert_ari_window_start!.getTime());
    expect(r.cert_renew_at!.getTime()).toBeLessThan(r.cert_ari_window_end!.getTime());
    // Asked again when Retry-After says, not at every tick.
    expect(Math.abs(r.cert_ari_next_at!.getTime() - (Date.now() + 6 * HOUR))).toBeLessThan(60_000);
    await sleep(150);
    expect(ca.ariRequests).toHaveLength(1);

    // A window already over, as for a revoked certificate: renewed at once, naming the one it replaces.
    ca.setAri(first, { window: { start: new Date(Date.now() - 2 * HOUR), end: new Date(Date.now() - HOUR) }, retryAfter: "21600" });
    memory.set({ cert_ari_next_at: null });
    s.kick();
    await until("the renewal", () => row().cert_serial !== r.cert_serial);
    expect(ca.orders.at(-1)).toMatchObject({ replaces: first });
    expect(row()).toMatchObject({ cert_failures: 0, last_error: null });

    // Refused with it: ordered again without, and no failure counted.
    const second = await leafId();
    const serial = row().cert_serial;
    await until("the second window", () => row().cert_ari_window_start !== null);
    ca.refuseReplaces("alreadyReplaced");
    ca.setAri(second, { window: { start: new Date(Date.now() - 2 * HOUR), end: new Date(Date.now() - HOUR) }, retryAfter: "3600" });
    memory.set({ cert_ari_next_at: null });
    s.kick();
    await until("the next renewal", () => row().cert_serial !== serial);
    expect(ca.orders.slice(-2)).toEqual([
      { identifiers: [{ type: "dns", value: row().hostname }], replaces: second },
      { identifiers: [{ type: "dns", value: row().hostname }] },
    ]);
    expect(row()).toMatchObject({ cert_failures: 0, cert_retry_at: null, last_error: null });
  });

  it("keeps two thirds of the life when the CA can't say, and asks again in six hours", async () => {
    const ca = fakeCa();
    ca.setAri("*", { status: 500, body: '{"type":"urn:ietf:params:acme:error:serverInternal","detail":"busy"}' });
    await on(ca);
    await until("the next time to ask", () => row().cert_ari_next_at !== null);
    const r = row();
    expect(r.cert_ari_window_start).toBeNull();
    const life = r.cert_not_after!.getTime() - r.cert_not_before!.getTime();
    const renewAfter = r.cert_renew_at!.getTime() - r.cert_not_before!.getTime();
    expect(renewAfter).toBeGreaterThanOrEqual((life * 2) / 3 - life / 20);
    expect(renewAfter).toBeLessThanOrEqual((life * 2) / 3);
    expect(Math.abs(r.cert_ari_next_at!.getTime() - (Date.now() + 6 * HOUR))).toBeLessThan(60_000);
    await sleep(150);
    expect(ca.ariRequests).toHaveLength(1);
  });

  it("takes a window past the certificate's expiry as no answer", async () => {
    const ca = fakeCa();
    ca.setAri("*", { window: { start: new Date(Date.now() + 2 * 24 * HOUR), end: new Date(Date.now() + 3 * 24 * HOUR) }, retryAfter: "3600" });
    await on(ca);
    await until("the next time to ask", () => row().cert_ari_next_at !== null);
    const r = row();
    expect(r.cert_ari_window_start).toBeNull();
    expect(r.cert_renew_at!.getTime()).toBeLessThan(r.cert_not_after!.getTime());
    expect(Math.abs(r.cert_ari_next_at!.getTime() - (Date.now() + 6 * HOUR))).toBeLessThan(60_000);
  });

  it("does not ask a CA that offers no renewal information, nor fetch its directory again for it", async () => {
    const ca = fakeCa({ renewalInfo: false });
    let directoryFetches = 0;
    const counted: FakeCa = {
      ...ca,
      transport: {
        request: (url, init) => {
          if (url === FAKE_CA_DIRECTORY) directoryFetches += 1;
          return ca.transport.request(url, init);
        },
      },
    };
    await on(counted);
    await sleep(200);
    expect(ca.ariRequests).toEqual([]);
    expect(directoryFetches).toBe(1);
    expect(row()).toMatchObject({ cert_ari_next_at: null, cert_ari_window_start: null });
  });

  it("does not ask about a certificate from another directory", async () => {
    const ca = fakeCa();
    const s = await on(ca);
    await until("the renewal window", () => row().cert_ari_window_start !== null);
    memory.set({ cert_directory: "https://other-ca.stuga.test/dir", cert_ari_next_at: null });
    s.kick();
    await sleep(150);
    expect(ca.ariRequests).toHaveLength(1);
  });

  it("warns every administrator once, denied or not, never while off, and says when a new certificate is in use", async () => {
    const told: RemoteNotice[] = [];
    const ca = fakeCa();
    const s = await on(ca, async (n) => void told.push(n));
    await until("the renewal window", () => row().cert_ari_window_start !== null);
    await until("a credential", () => fake.issuedCredentials.length === 1);
    const serial = row().cert_serial!;
    const orders = ca.orders.length;

    memory.set({ cert_failures: 3, last_error: { code: "denied", message: "Remote access is off for this address.", at: new Date().toISOString() } });
    await until("the warning", () => told.length === 1);
    await sleep(150);
    expect(told.map((n) => `${n.event}:${n.key}`)).toEqual([`REMOTE_CERT_RENEWAL_FAILED:${serial}`]);
    expect(row().cert_alerted_serial).toBe(serial);
    expect(ca.orders).toHaveLength(orders);

    // Off: nothing, however the certificate stands.
    await s.disable("liv");
    memory.set({ cert_not_after: new Date(Date.now() - 1), binding_failing_since: new Date(Date.now() - 25 * HOUR) });
    s.kick();
    await sleep(150);
    expect(told).toHaveLength(1);
    const back = row().cert_not_after;
    expect(back).not.toBeNull();

    // On again: the key the service refused for a day, and then a new certificate after the warning.
    memory.set({ enabled: true, last_error: null, cert_failures: 0, cert_not_after: new Date(Date.now() + 20 * HOUR) });
    s.kick();
    await until("the binding warning", () => told.some((n) => n.event === "REMOTE_BINDING_REJECTED"));
    memory.set({ binding_failing_since: null, cert_renew_at: new Date(Date.now() - 1), cert_ari_next_at: new Date(Date.now() + HOUR) });
    s.kick();
    await until("the new certificate", () => row().cert_serial !== serial);
    await until("the announcement", () => told.some((n) => n.event === "REMOTE_CERT_RECOVERED"));
    expect(told.map((n) => n.event)).toEqual(["REMOTE_CERT_RENEWAL_FAILED", "REMOTE_BINDING_REJECTED", "REMOTE_CERT_RECOVERED"]);
    expect(told.at(-1)!.key).toBe(serial);
    expect(row().cert_alerted_serial).toBeNull();
  });
});
