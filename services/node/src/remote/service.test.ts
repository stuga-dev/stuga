/**
 * Turning remote access on and off against the fake service, with the database row in memory:
 * the binding key's order of writes, and what each refusal becomes; and the service loop on a
 * certificate made here. The loops run end to end, with a real CA, in remote-access.integration.test.ts.
 */
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
  /** Every error recorded, in order: one replaced at once is still seen. */
  let errors: string[] = [];
  /** The database is out of reach: reading the row fails. */
  let broken = false;
  return {
    row: () => row,
    errors: () => errors,
    broken: () => broken,
    breakReads: (b: boolean) => {
      broken = b;
    },
    reset: () => {
      row = blank();
      errors = [];
      broken = false;
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
    getRemoteAccess: async () => {
      if (memory.broken()) throw new Error("the database is out of reach");
      return { ...memory.row() };
    },
    saveRemoteBinding: async (_sql: unknown, b: Parameters<Db["saveRemoteBinding"]>[1]) =>
      memory.set({ remote_id: b.remoteId, hostname: b.hostname, api_url: b.apiUrl, binding_thumbprint: b.thumbprint, bound_at: b.boundAt, binding_failing_since: null }),
    forgetRemoteBinding: async () =>
      memory.set({ enabled: false, remote_id: null, hostname: null, binding_thumbprint: null, bound_at: null, binding_failing_since: null }),
    setRemoteEnabled: async (_sql: unknown, e: { enabled: boolean; by?: string; at?: Date; caTermsAcceptedBy?: string; caTermsAcceptedAt?: Date }) =>
      memory.set(
        e.enabled
          ? { enabled: true, enabled_by: e.by, enabled_at: e.at, ca_terms_accepted_by: e.caTermsAcceptedBy, ca_terms_accepted_at: e.caTermsAcceptedAt }
          : { enabled: false },
      ),
    setRemoteError: async (_sql: unknown, err: { code: string } | null) => {
      if (err) memory.errors().push(err.code);
      memory.set({ last_error: err });
    },
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
    clearRemoteProbe: async () => memory.set({ probe_at: null, probe_ok_at: null, probe_failures: 0 }),
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
import type { ConnectorHints, RemoteGroup } from "../config/env.js";
import { ariCertId } from "./acme/der.js";
import { okpThumbprint } from "./keys.js";
import { createServiceClient } from "./service-client.js";
import type { ChallengeResolver } from "./dns-check.js";
import type { RemoteNotice } from "./notify.js";
import { FAKE_CA, FAKE_CA_DIRECTORY, fakeCa, type FakeCa } from "./testing/fake-ca.js";
import type { FakeRemoteService } from "./testing/fake-service.js";
import type { ProbeResult } from "./probe.js";
import type { RemoteAccess, RemoteTiming } from "./service.js";

const sql = { begin: async (fn: (tx: unknown) => Promise<unknown>) => fn(sql) };

let fake: FakeRemoteService;
let work: string;
let remoteDir: string;
let dataDir: string;
const services: RemoteAccess[] = [];

/** The address always answers the self-check, unless told otherwise: nothing here goes through a relay. */
function service(
  opts: {
    publicOrigin?: string;
    timing?: Partial<RemoteTiming>;
    connector?: ConnectorHints;
    group?: RemoteGroup;
    probe?: () => Promise<ProbeResult>;
    now?: () => number;
    ca?: FakeCa;
    notify?: (n: RemoteNotice) => Promise<void>;
  } = {},
): RemoteAccess {
  const s = createRemoteAccess({
    sql: sql as never,
    env: { publicOrigin: opts.publicOrigin ?? "http://livs-air.local:8787" },
    config: { service: fake.url, dir: remoteDir, dataDir, connector: opts.connector, group: opts.group },
    gate: createServingGate(),
    readsOwnBody: () => false,
    maxBodyBytes: () => 1 << 20,
    frontDoor: async () => ({}),
    probe: opts.probe ?? (async () => ({ ok: true })),
    ...(opts.timing ? { timing: opts.timing } : {}),
    ...(opts.now ? { now: opts.now } : {}),
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
async function bound(opts: Parameters<typeof service>[0] & { certFor?: { notBefore: Date; notAfter: Date } } = {}): Promise<RemoteAccess> {
  const { certFor, ...rest } = opts;
  const s = service(rest);
  await s.enable({ code: fake.mintCode("enroll"), acceptCaTerms: true, by: "liv" });
  const cert = makeTestCert({ dnsNames: [memory.row().hostname as string], ...certFor });
  await writeCertificate(dataDir, cert.privateKey, cert.cert);
  return s;
}

/** Another computer takes the address with a restore code: the service replaces this node's key. */
async function moveElsewhere(id: string): Promise<void> {
  const { privateKey } = generateKeyPairSync("ed25519");
  const x = (privateKey.export({ format: "jwk" }) as { x: string }).x;
  await createServiceClient().rebind(fake.url, { privateKey, x, thumbprint: okpThumbprint(x) }, fake.mintCode("rebind", id));
}

/**
 * A new computer that took the address with a restore code, with a day's certificate for it on disk.
 * `boundAt` is taken before the code goes in.
 */
async function restored(opts: Parameters<typeof service>[0] = {}): Promise<{ s: RemoteAccess; boundAt: number }> {
  await service().enable({ code: fake.mintCode("enroll"), acceptCaTerms: true, by: "liv" });
  const id = memory.row().remote_id as string;
  memory.reset();
  rmSync(join(dataDir, "secrets"), { recursive: true });
  const s = service(opts);
  const boundAt = Date.now();
  const { via } = await s.enable({ code: fake.mintCode("rebind", id), acceptCaTerms: true, by: "liv" });
  expect(via).toBe("rebind");
  const cert = makeTestCert({ dnsNames: [memory.row().hostname as string] });
  await writeCertificate(dataDir, cert.privateKey, cert.cert);
  return { s, boundAt };
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

  it("keeps a binding made while a request under the key it replaced was out", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const res = await realFetch(input, init);
      if (String(input).endsWith("/v1/checkin")) await held;
      return res;
    });
    const s = await bound();
    const id = memory.row().remote_id as string;
    fake.failNext("/v1/checkin", 401, { error: "node_moved", message: "This address moved to another computer." });
    await s.start();
    await until("the check-in out", () => fake.requests.some((r) => r.path === "/v1/checkin"));
    // Restored with a code meanwhile, as the node still bound.
    await s.enable({ code: fake.mintCode("rebind", id), acceptCaTerms: true, by: "liv" });
    expect(fake.requests.map((r) => r.path)).toEqual(["/v1/enroll", "/v1/checkin", "/v1/rebind"]);
    const thumbprint = memory.row().binding_thumbprint;
    release();
    await until("a check-in with the new key", () => fake.requests.some((r) => r.path === "/v1/checkin" && r.status === 200));
    expect(memory.row()).toMatchObject({ enabled: true, remote_id: id, binding_thumbprint: thumbprint });
    expect(lastError()?.code).not.toBe("moved");
  });

  it("gets a new credential at once after a restore code on the same address", async () => {
    const s = await bound();
    const id = memory.row().remote_id as string;
    await s.start();
    // Held, not just issued: one still on its way when the code goes in would be taken for the new binding's.
    await until("a credential", () => memory.row().credential_expires_at !== null);
    // The relays refuse a credential issued before a rebind: the one held is no use now.
    await s.enable({ code: fake.mintCode("rebind", id), acceptCaTerms: true, by: "liv" });
    await until("a new credential", () => fake.issuedCredentials.length === 2);
    expect(memory.row()).toMatchObject({ enabled: true, remote_id: id, last_error: null });
  });

  it("holds the first self-check a few minutes after a restore code, and not after an enrollment", async () => {
    const probes: number[] = [];
    const probe = async (): Promise<ProbeResult> => {
      probes.push(Date.now());
      return { ok: true };
    };
    const timing = { serviceTickMs: 100, probeDelayMs: 10, probeAfterRebindMs: 1_500 };
    const enrolled = await bound({ probe, timing });
    const started = Date.now();
    await enrolled.start();
    await until("the self-check", () => probes.length === 1);
    expect(probes[0]! - started).toBeLessThan(1_000);
    await enrolled.stop();

    probes.length = 0;
    const { s, boundAt } = await restored({ probe, timing });
    await s.start();
    await until("a credential", () => memory.row().credential_expires_at !== null);
    await sleep(300);
    // Waiting for the relay to let go of the computer it moved from: starting, with nothing wrong.
    expect(probes).toEqual([]);
    expect(await s.status()).toMatchObject({ state: "starting", last_error: null });
    await until("the self-check", () => probes.length === 1, 5_000);
    expect(probes[0]! - boundAt).toBeGreaterThanOrEqual(1_500);
    await until("on", () => memory.row().probe_ok_at !== null);
    expect(await s.status()).toMatchObject({ state: "on" });
  });

  it("shows starting after a restore code on a computer restored from a backup, until its own self-check", async () => {
    const probes: number[] = [];
    const s = await bound({
      probe: async () => {
        probes.push(Date.now());
        return { ok: true };
      },
      timing: { serviceTickMs: 100, probeDelayMs: 10, probeAfterRebindMs: 1_500 },
    });
    await s.start();
    await until("on", () => memory.row().probe_ok_at !== null);
    // The backup's record of the self-check, as the old computer last made it.
    memory.set({ probe_failures: 1 });
    const boundAt = Date.now();
    await s.enable({ code: fake.mintCode("rebind", memory.row().remote_id as string), acceptCaTerms: true, by: "liv" });
    expect(memory.row()).toMatchObject({ probe_at: null, probe_ok_at: null, probe_failures: 0 });
    await until("a new credential", () => fake.issuedCredentials.length === 2);
    await until("the credential recorded", () => memory.row().credential_expires_at !== null);
    expect(await s.status()).toMatchObject({ state: "starting", last_error: null });
    await until("the self-check", () => probes.length === 2, 5_000);
    expect(probes[1]! - boundAt).toBeGreaterThanOrEqual(1_500);
    await until("on", () => memory.row().probe_ok_at !== null);
    expect(await s.status()).toMatchObject({ state: "on" });
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

describe("where the packaging runs the connector", () => {
  let hints: ConnectorHints;
  /** This node's clock and the fake service's, moved together. */
  let shift = 0;
  const clock = () => Date.now() + shift;
  const CONNECTOR_SHA = "c".repeat(64);

  beforeEach(async () => {
    shift = 0;
    await fake.close();
    fake = await startFakeRemoteService({ acmeDirectory: "https://ca.stuga.test/dir", zone: "mystuga.com", now: clock });
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(work, "requests"), { recursive: true });
    mkdirSync(join(work, "status"), { recursive: true });
    hints = { request: join(work, "requests", "remote"), status: join(work, "status", "remote.json") };
  });

  const request = () => (existsSync(hints.request) ? readFileSync(hints.request, "utf8").trim() : null);
  const on = () => `on ${memory.row().connector_config_sha256 as string}`;

  /** The helper's answer to the request as it stands; `ago` puts it that long before now. */
  function helper(state: string, over: { message?: string; ago?: number } = {}) {
    const line = request() ?? "off";
    writeFileSync(
      hints.status,
      JSON.stringify({
        state,
        message: over.message ?? "",
        at: new Date(clock() - (over.ago ?? 0)).toISOString(),
        connector_sha: CONNECTOR_SHA,
        config_sha: line.startsWith("on ") ? line.slice(3) : null,
      }),
    );
  }

  function managed(opts: { probe?: () => Promise<ProbeResult>; timing?: Partial<RemoteTiming>; certFor?: { notBefore: Date; notAfter: Date } } = {}) {
    return bound({
      connector: hints,
      now: clock,
      ...(opts.probe ? { probe: opts.probe } : {}),
      ...(opts.certFor ? { certFor: opts.certFor } : {}),
      timing: { serviceTickMs: 100, connectorPollMs: 20, probeDelayMs: 10, ...opts.timing },
    });
  }

  it("asks for off until there is a credential in the connector's files, and for on then, without waiting for a tick", async () => {
    const s = await managed({ timing: { serviceTickMs: 60_000 } });
    expect(request()).toBe("off");
    await s.start();
    await until("on", () => request()?.startsWith("on ") ?? false);
    expect(request()).toBe(on());
    expect(existsSync(join(remoteDir, "relay-1.jwt"))).toBe(true);
    expect(readFileSync(join(remoteDir, "relay-1.toml"), "utf8")).toContain('log.level = "warn"');
    const status = await s.status();
    expect(status).toMatchObject({ state: "starting", connector: { managed: true, status: null, config_path: null } });
  });

  it("keeps a connector apart by a group: the directory arranged at every start, off too, and every file the group's", async () => {
    // A group this user is in, other than its own where it has one: only such a group can be given without root.
    const gid = process.getgroups!().find((g) => g !== process.getgid!()) ?? process.getgid!();
    const group = { gid, connectorUid: process.getuid!() };
    const layout = { request: join(remoteDir, "control", "request"), status: join(remoteDir, "status", "status.json") };
    const off = service({ connector: layout, group });
    await off.start();
    expect(lstatSync(remoteDir).mode & 0o7777).toBe(0o2750);
    expect(lstatSync(join(remoteDir, "status")).mode & 0o7777).toBe(0o750);
    expect(readFileSync(layout.request, "utf8")).toBe("off\n");
    expect(lstatSync(layout.request).gid).toBe(gid);
    await off.stop();

    chmodSync(join(remoteDir, "control"), 0o777);
    const s = await bound({ connector: layout, group, now: clock, timing: { serviceTickMs: 100, connectorPollMs: 20, probeDelayMs: 10 } });
    await s.start();
    expect(lstatSync(join(remoteDir, "control")).mode & 0o7777).toBe(0o750);
    await until("on", () => readFileSync(layout.request, "utf8").startsWith("on "));
    for (const name of ["control/request", "relay-1.toml", "relay-1.ca.pem", "relay-1.jwt"]) {
      expect(lstatSync(join(remoteDir, name)).gid, name).toBe(gid);
      expect(lstatSync(join(remoteDir, name)).mode & 0o777, name).toBe(0o640);
    }
    expect(lstatSync(join(remoteDir, "https.sock"))).toMatchObject({ gid });
  });

  it("holds the first self-check until the connector runs these settings, then makes it within seconds", async () => {
    let probes = 0;
    const s = await managed({
      probe: async () => {
        probes += 1;
        return { ok: true };
      },
    });
    await s.start();
    await until("on", () => request()?.startsWith("on ") ?? false);
    helper("installing", { message: "Downloading the connector." });
    await sleep(400);
    expect(probes).toBe(0);
    expect(lastError()).toBeNull();
    expect(await s.status()).toMatchObject({ state: "starting", connector: { status: { state: "installing" } } });

    // Running an older config is not running this one.
    writeFileSync(hints.status, JSON.stringify({ state: "running", message: "", at: new Date(clock()).toISOString(), config_sha: "d".repeat(64) }));
    await sleep(200);
    expect(probes).toBe(0);

    helper("running");
    const started = Date.now();
    await until("the self-check", () => probes === 1);
    expect(Date.now() - started).toBeLessThan(1_000);
    await until("on", () => memory.row().probe_ok_at !== null);
    expect(await s.status()).toMatchObject({ state: "on", connector: { managed: true, status: { state: "running" }, reachable: true } });
  });

  it("asks for off once turning off has removed the connector's files", async () => {
    const s = await managed();
    await s.start();
    await until("on", () => request()?.startsWith("on ") ?? false);
    await s.disable("liv");
    expect(request()).toBe("off");
    expect(existsSync(join(remoteDir, "relay-1.jwt"))).toBe(false);
    expect(existsSync(join(remoteDir, "relay-1.toml"))).toBe(false);
  });

  it("asks once at every start, whatever it asked before", async () => {
    const s = await managed({ timing: { serviceTickMs: 60_000 } });
    await s.start();
    await until("on", () => request()?.startsWith("on ") ?? false);
    const line = request();
    await s.stop();
    rmSync(hints.request);
    const restarted = service({ connector: hints, now: clock, timing: { serviceTickMs: 60_000 } });
    await restarted.start();
    // The credential in the connector's files is still good: on again straight away, not after a check-in.
    expect(request()).toBe(line);
  });

  it("takes the tunnel down when the certificate stops serving the address, and brings it back with a new one", async () => {
    const t = Date.now();
    const s = await managed({
      timing: { certTickMs: 60_000 },
      certFor: { notBefore: new Date(t - 60_000), notAfter: new Date(t + 60 * 60_000) },
    });
    await s.start();
    await until("on", () => request()?.startsWith("on ") ?? false);
    await until("the credential in the row", () => memory.row().credential_expires_at !== null);
    helper("running");

    shift = 2 * 60 * 60_000;
    await until("off", () => request() === "off");
    await until("the credential gone", () => memory.row().credential_expires_at === null);
    expect(existsSync(join(remoteDir, "relay-1.jwt"))).toBe(false);
    // The rest stays for when it comes back.
    expect(existsSync(join(remoteDir, "relay-1.toml"))).toBe(true);
    helper("stopped");
    const expired = await s.status();
    expect(expired).toMatchObject({ state: "degraded", last_error: { code: "certificate_expired" } });

    // A new certificate: a credential first, then on.
    const heard = fake.issuedCredentials.length;
    const renewed = makeTestCert({
      dnsNames: [memory.row().hostname as string],
      notBefore: new Date(clock() - 60_000),
      notAfter: new Date(clock() + 24 * 60 * 60_000),
    });
    await writeCertificate(dataDir, renewed.privateKey, renewed.cert);
    s.kick();
    await until("on again", () => request()?.startsWith("on ") ?? false);
    expect(fake.issuedCredentials.length).toBe(heard + 1);
    expect(readFileSync(join(remoteDir, "relay-1.jwt"), "utf8")).toBe(`${fake.issuedCredentials.at(-1)!.credential}\n`);
  });

  it("shows a refusal until an administrator retries, and never asks again by itself", async () => {
    const s = await managed();
    await s.start();
    await until("on", () => request()?.startsWith("on ") ?? false);
    const line = request();
    helper("refused", { message: "The connector's signature isn't Stuga's." });
    expect(await s.status()).toMatchObject({
      state: "error",
      last_error: { code: "connector_refused", message: "The connector's signature isn't Stuga's." },
      connector: { status: { state: "refused" } },
    });
    // Kept out of the row: it goes when the status does.
    expect(lastError()).toBeNull();

    rmSync(hints.request);
    await sleep(400);
    expect(request()).toBeNull();

    // An answer from before the retry is no answer to it.
    helper("refused", { message: "The connector's signature isn't Stuga's.", ago: 2_000 });
    const retried = await s.retryConnector("liv");
    expect(request()).toBe(line);
    expect(retried).toMatchObject({ state: "starting", last_error: null });
  });

  it("shows a failure the packaging retries, with when the node asks again", async () => {
    const s = await managed();
    await s.start();
    await until("on", () => request()?.startsWith("on ") ?? false);
    helper("failed", { message: "Couldn't download the connector." });
    const status = await s.status();
    expect(status).toMatchObject({ state: "degraded", last_error: { code: "connector_failed", message: "Couldn't download the connector." } });
    if (!status.available) throw new Error("unavailable");
    expect(Date.parse(status.last_error!.retry_at!)).toBeGreaterThan(clock());
  });

  /** The relay's certificate replaced: new settings for the connector. */
  function newRelayCa(): void {
    const name = "relay-1.mystuga.com";
    fake.setRelays([{ name: "relay-1", addr: name, port: 7000, server_name: name, ca_pem: makeTestCert({ dnsNames: [name] }).cert }]);
  }

  it("asks for new settings in the tick that brings them, and holds the self-check until the connector runs them", async () => {
    let probes = 0;
    const s = await managed({
      probe: async () => {
        probes += 1;
        return { ok: true };
      },
      // Ticks only when kicked; a self-check due at every one.
      timing: { serviceTickMs: 60_000, probeEveryMs: 50 },
    });
    await s.start();
    await until("on", () => request()?.startsWith("on ") ?? false);
    helper("running");
    await until("the first self-check", () => probes === 1);
    const before = request();

    newRelayCa();
    s.kick();
    await until("the new settings asked for", () => request() !== before);
    expect(request()).toBe(on());

    // The status still names the settings before.
    for (let i = 0; i < 3; i += 1) {
      s.kick();
      await sleep(100);
    }
    expect(probes).toBe(1);

    helper("running");
    const started = Date.now();
    await until("the self-check", () => probes === 2);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("asks for new settings after a refusal without waiting for Retry", async () => {
    const s = await managed({ timing: { serviceTickMs: 60_000 } });
    await s.start();
    await until("on", () => request()?.startsWith("on ") ?? false);
    const before = request();
    helper("refused", { message: "The connector's signature isn't Stuga's." });
    expect(await s.status()).toMatchObject({ state: "error" });

    shift += 2_000;
    newRelayCa();
    s.kick();
    await until("the new settings asked for", () => request() !== before);
    expect(request()).toBe(on());
    // The refusal answered other settings. The request is written before the error is cleared, so
    // a status read in between still shows the refusal: wait for it.
    const deadline = Date.now() + 5_000;
    let status = await s.status();
    while (!("state" in status && status.state === "starting") && Date.now() < deadline) {
      await sleep(20);
      status = await s.status();
    }
    expect(status).toMatchObject({ state: "starting", last_error: null });
  });

  it("keeps checking the address once the connector has run, and says when it no longer answers", async () => {
    let up = true;
    const s = await managed({
      probe: async () => (up ? { ok: true } : { ok: false, code: "connector_unreachable", message: "no answer through the relay" }),
      timing: { probeEveryMs: 50 },
    });
    await s.start();
    await until("on", () => request()?.startsWith("on ") ?? false);
    helper("running");
    await until("reachable", () => memory.row().probe_ok_at !== null);
    expect(await s.status()).toMatchObject({ state: "on" });

    // Seen stopped before the address stops answering.
    helper("stopped");
    await sleep(300);
    up = false;
    await until("the self-check fails", () => lastError()?.code === "connector_unreachable");
    expect(await s.status()).toMatchObject({ state: "degraded", last_error: { code: "connector_unreachable" } });
  });

  it("takes a status from before a restart as no answer, and checks the address once the connector answers", async () => {
    let probes = 0;
    const probe = async (): Promise<ProbeResult> => {
      probes += 1;
      return { ok: true };
    };
    const s = await managed({ probe });
    await s.start();
    await until("on", () => request()?.startsWith("on ") ?? false);
    helper("running");
    await until("the self-check", () => probes === 1);
    await s.stop();

    helper("running", { ago: 60 * 60_000 });
    const restarted = service({ connector: hints, now: clock, probe, timing: { serviceTickMs: 100, connectorPollMs: 20, probeDelayMs: 10 } });
    await restarted.start();
    await sleep(500);
    expect(probes).toBe(1);

    helper("running");
    await until("the self-check", () => probes === 2);
  });

  it("says an installation without the connector is an error, and doesn't ask again by itself", async () => {
    const s = await managed();
    await s.start();
    await until("on", () => request()?.startsWith("on ") ?? false);
    helper("unavailable", { message: "This installation doesn't include the connector." });
    expect(await s.status()).toMatchObject({
      state: "error",
      last_error: { code: "connector_unavailable", message: "This installation doesn't include the connector." },
      connector: { status: { state: "unavailable" } },
    });

    rmSync(hints.request);
    shift += 5 * 60_000;
    await sleep(400);
    expect(request()).toBeNull();
  });

  it("says the connector isn't running once it was asked again to no effect", async () => {
    const s = await managed();
    await s.start();
    await until("on", () => request()?.startsWith("on ") ?? false);
    helper("stopped");
    expect(await s.status()).toMatchObject({ state: "starting", last_error: null });

    shift += 2 * 60_000;
    await sleep(300);
    const status = await s.status();
    expect(status).toMatchObject({ state: "degraded", last_error: { code: "connector_failed", message: "The connector isn't running." } });
    if (!status.available) throw new Error("unavailable");
    expect(Date.parse(status.last_error!.retry_at!)).toBeGreaterThan(clock());
  });

  it("asks again on its backoff even while the rest of the tick fails", async () => {
    const s = await managed();
    await s.start();
    await until("on", () => request()?.startsWith("on ") ?? false);
    const line = request();
    memory.breakReads(true);
    // A tick already past reading the row finishes first.
    await sleep(300);
    rmSync(hints.request);
    shift += 2 * 60_000;
    await until("asked again", () => request() === line);
  });

  it("stops as Turn off does once the address moved to another computer, and turns on again only with a code", async () => {
    const told: RemoteNotice[] = [];
    const s = await bound({
      connector: hints,
      now: clock,
      notify: async (n) => void told.push(n),
      timing: { serviceTickMs: 100, connectorPollMs: 20, probeDelayMs: 10 },
    });
    await s.start();
    await until("on", () => request()?.startsWith("on ") ?? false);
    const id = memory.row().remote_id as string;
    const hostname = memory.row().hostname as string;
    const keyPath = join(dataDir, "secrets", "remote-binding.jwk");
    const key = readFileSync(keyPath, "utf8");

    await moveElsewhere(id);
    s.kick();
    await until("moved", () => lastError()?.code === "moved");
    expect(request()).toBe("off");
    expect(readdirSync(remoteDir).filter((f) => f.startsWith("relay-1.") || f === "https.sock")).toEqual([]);
    expect(memory.row()).toMatchObject({ enabled: false, remote_id: null, hostname: null, binding_thumbprint: null, credential_expires_at: null });
    expect(await s.status()).toMatchObject({
      state: "off",
      address: null,
      last_error: { code: "moved", message: "This address moved to another computer.", service_code: "node_moved" },
    });
    expect(s.view.current()).toEqual({ enabled: false, id: null, hostname: null, origin: null });
    // The key the service no longer takes and the certificate both stay.
    expect(readFileSync(keyPath, "utf8")).toBe(key);
    expect((await readCertificate(dataDir)).kind).toBe("ok");
    await until("the notice", () => told.some((n) => n.event === "REMOTE_ADDRESS_MOVED"));
    expect(told.find((n) => n.event === "REMOTE_ADDRESS_MOVED")!.body).toContain(`https://${hostname}`);

    // Nothing more goes to the service.
    const heard = fake.requests.length;
    for (let i = 0; i < 3; i += 1) {
      s.kick();
      await sleep(100);
    }
    expect(fake.requests.length).toBe(heard);
    expect(request()).toBe("off");

    expect(await refusal(s.enable({ acceptCaTerms: true, by: "liv" }))).toMatchObject({ status: 400, code: "code_required" });
    // A code for this address brings it back.
    const back = await s.enable({ code: fake.mintCode("rebind", id), acceptCaTerms: true, by: "liv" });
    expect(back.via).toBe("rebind");
    expect(memory.row()).toMatchObject({ enabled: true, remote_id: id, hostname, last_error: null });
    await until("on again", () => request()?.startsWith("on ") ?? false);
    expect(readdirSync(join(dataDir, "secrets")).filter((f) => f.startsWith("remote-binding.retired-"))).toHaveLength(1);
  });

  it("holds the first self-check after a restore code even once the connector runs", async () => {
    const probes: number[] = [];
    const { s, boundAt } = await restored({
      connector: hints,
      now: clock,
      probe: async () => {
        probes.push(Date.now());
        return { ok: true };
      },
      timing: { serviceTickMs: 100, connectorPollMs: 20, probeDelayMs: 10, probeAfterRebindMs: 1_500 },
    });
    await s.start();
    await until("on", () => request()?.startsWith("on ") ?? false);
    helper("running");
    await sleep(300);
    expect(probes).toEqual([]);
    expect(await s.status()).toMatchObject({ state: "starting", last_error: null, connector: { status: { state: "running" } } });
    await until("the self-check", () => probes.length === 1, 5_000);
    expect(probes[0]! - boundAt).toBeGreaterThanOrEqual(1_500);
  });

  it("refuses a retry where the packaging does not run the connector", async () => {
    const s = service();
    expect(await refusal(s.retryConnector("liv"))).toMatchObject({ status: 409, code: "unavailable" });
  });
});

describe("the self-check", () => {
  /** This node's clock and the fake service's, moved together. */
  let shift = 0;
  const clock = () => Date.now() + shift;
  const WRONG: ProbeResult = { ok: false, code: "wrong_certificate", message: "another certificate" };

  beforeEach(async () => {
    shift = 0;
    await fake.close();
    fake = await startFakeRemoteService({ acmeDirectory: "https://ca.stuga.test/dir", zone: "mystuga.com", now: clock });
  });

  const paths = (from: number) => fake.requests.slice(from).map((r) => r.path);

  it("checks in when another certificate answers, and turns off without calling it a problem once the address moved", async () => {
    let answer: ProbeResult = { ok: true };
    const s = await bound({ now: clock, probe: async () => answer, timing: { serviceTickMs: 100, probeDelayMs: 10, probeEveryMs: 50 } });
    await s.start();
    await until("reachable", () => memory.row().probe_ok_at !== null);
    await moveElsewhere(memory.row().remote_id as string);
    const heard = fake.requests.length;
    answer = WRONG;
    await until("moved", () => lastError()?.code === "moved");
    // The check-in, signed by the key the restore code replaced, is the call that learns it.
    expect(fake.requests.slice(heard).map((r) => [r.path, r.status])).toEqual([["/v1/checkin", 401]]);
    expect(memory.errors()).not.toContain("wrong_certificate");
    expect(memory.row()).toMatchObject({ enabled: false, remote_id: null, probe_failures: 1 });
    expect(await s.status()).toMatchObject({
      state: "off",
      last_error: { code: "moved", message: "This address moved to another computer.", service_code: "node_moved" },
    });
  });

  it("says another certificate answers after a check-in that finds the address still here, and checks in for it every ten minutes at most", async () => {
    const s = await bound({ now: clock, probe: async () => WRONG, timing: { serviceTickMs: 100, probeDelayMs: 10, probeEveryMs: 50, probeRetryMs: 50 } });
    await s.start();
    await until("wrong_certificate", () => lastError()?.code === "wrong_certificate");
    expect(paths(0)).toEqual(["/v1/enroll", "/v1/checkin", "/v1/relay-credential", "/v1/checkin"]);
    expect(await s.status()).toMatchObject({ state: "degraded", last_error: { code: "wrong_certificate" } });

    const heard = fake.requests.length;
    await until("more self-checks", () => (memory.row().probe_failures as number) >= 4);
    expect(paths(heard)).toEqual([]);

    // Nine minutes on: a new credential for the failing self-checks, and no check-in for the certificate yet.
    shift = 9 * 60_000;
    const failures = memory.row().probe_failures as number;
    await until("more self-checks", () => (memory.row().probe_failures as number) >= failures + 3);
    expect(paths(heard)).toEqual(["/v1/checkin", "/v1/relay-credential"]);

    // Ten: the certificate's check-in again, and nothing else.
    shift = 10 * 60_000 + 1_000;
    await until("the check-in", () => paths(heard).length === 3);
    const after = memory.row().probe_failures as number;
    await until("more self-checks", () => (memory.row().probe_failures as number) >= after + 3);
    expect(paths(heard)).toEqual(["/v1/checkin", "/v1/relay-credential", "/v1/checkin"]);
    expect(lastError()?.code).toBe("wrong_certificate");
  });

  it("checks again soon after a failure, twice, then at the usual interval, without calling the service", async () => {
    let up = true;
    const failed: number[] = [];
    const s = await bound({
      now: clock,
      probe: async () => {
        if (up) return { ok: true };
        failed.push(Date.now());
        return { ok: false, code: "connector_unreachable", message: "no answer through the relay" };
      },
      timing: { serviceTickMs: 50, probeDelayMs: 10, probeEveryMs: 1_000, probeRetryMs: 150 },
    });
    await s.start();
    await until("reachable", () => memory.row().probe_ok_at !== null);
    const heard = fake.requests.length;
    up = false;
    await until("four failures", () => failed.length === 4, 6_000);
    const gaps = failed.slice(1).map((t, i) => t - failed[i]!);
    expect(gaps[0]).toBeGreaterThanOrEqual(150);
    expect(gaps[0]).toBeLessThan(600);
    expect(gaps[1]).toBeGreaterThanOrEqual(150);
    expect(gaps[1]).toBeLessThan(600);
    expect(gaps[2]).toBeGreaterThanOrEqual(1_000);
    expect(paths(heard)).toEqual([]);
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

  it("stops when the service says the address moved while it orders a certificate", async () => {
    const s = service({ ca: fakeCa(), timing });
    await s.enable({ code: fake.mintCode("enroll"), acceptCaTerms: true, by: "liv" });
    fake.failNext("/v1/acme/txt", 401, { error: "node_moved", message: "This address moved to another computer." });
    await s.start();
    await until("moved", () => lastError()?.code === "moved", 10_000);
    const heard = fake.requests.length;
    await sleep(150);
    expect(row()).toMatchObject({ enabled: false, remote_id: null, cert_serial: null, cert_failures: 0 });
    expect(fake.requests.slice(heard).filter((r) => r.path !== "/v1/acme/txt/cleanup")).toEqual([]);
  });

  /** Under a tenth of its life left, by the row: the certificate on disk stays as it is. */
  const runningShort = () => ({ cert_not_before: new Date(Date.now() - 19 * HOUR), cert_not_after: new Date(Date.now() + HOUR) });
  const keys = (told: RemoteNotice[]) => told.map((n) => `${n.event}:${n.key}`);

  it("says renewing waits for someone at once, and orders nothing", async () => {
    const told: RemoteNotice[] = [];
    const ca = fakeCa();
    await on(ca, async (n) => void told.push(n));
    await until("the renewal window", () => row().cert_ari_window_start !== null);
    const serial = row().cert_serial!;
    const orders = ca.orders.length;
    memory.set({ cert_failures: 0, cert_renew_at: new Date(Date.now() - 1), last_error: { code: "acme_action_required", message: "Accept the CA's new terms.", at: new Date().toISOString() } });
    await until("the warning", () => told.length === 1);
    await sleep(150);
    expect(keys(told)).toEqual([`REMOTE_CERT_RENEWAL_FAILED:${serial}`]);
    expect(row().cert_alerted_serial).toBe(serial);
    expect(ca.orders).toHaveLength(orders);
  });

  it("says the certificate runs short once renewing it has failed", async () => {
    const told: RemoteNotice[] = [];
    await on(fakeCa(), async (n) => void told.push(n));
    await until("the renewal window", () => row().cert_ari_window_start !== null);
    const serial = row().cert_serial!;
    memory.set({ ...runningShort(), cert_failures: 1, cert_retry_at: new Date(Date.now() + HOUR) });
    await until("the warning", () => told.length === 1);
    await sleep(150);
    expect(keys(told)).toEqual([`REMOTE_CERT_EXPIRING:${serial}`]);
    expect(row().cert_alerted_serial).toBe(serial);
  });

  it("says the certificate runs short while waiting on a newer Stuga", async () => {
    const told: RemoteNotice[] = [];
    const s = await on(fakeCa(), async (n) => void told.push(n));
    await until("a credential", () => fake.issuedCredentials.length === 1);
    fake.setMinProtocol(2);
    s.kick();
    await until("upgrade_required", () => lastError()?.code === "upgrade_required");
    const serial = row().cert_serial!;
    memory.set(runningShort());
    await until("the warning", () => told.length === 1);
    expect(keys(told)).toEqual([`REMOTE_CERT_EXPIRING:${serial}`]);
  });

  it("renews a certificate that ran out while off without a word", async () => {
    const told: RemoteNotice[] = [];
    const ca = fakeCa();
    const s = await on(ca, async (n) => void told.push(n));
    await until("the renewal window", () => row().cert_ari_window_start !== null);
    const serial = row().cert_serial!;
    await s.disable("liv");
    memory.set({ cert_not_after: new Date(Date.now() - HOUR), cert_renew_at: new Date(Date.now() - 2 * HOUR) });
    await s.enable({ acceptCaTerms: true, by: "liv" });
    await until("the new certificate", () => row().cert_serial !== serial);
    await sleep(150);
    expect(told).toEqual([]);
    expect(row().cert_alerted_serial).toBeNull();
  });

  it("says a certificate found on disk replaces the one warned about, until that is told", async () => {
    const told: RemoteNotice[] = [];
    let failing = true;
    await on(fakeCa(), async (n) => {
      if (n.event === "REMOTE_CERT_RECOVERED" && failing) {
        failing = false;
        throw new Error("the notifications table is busy");
      }
      told.push(n);
    });
    await until("the renewal window", () => row().cert_ari_window_start !== null);
    const serial = row().cert_serial!;
    memory.set({ cert_alerted_serial: serial });
    const replacement = makeTestCert({ dnsNames: [row().hostname!] });
    await writeCertificate(dataDir, replacement.privateKey, replacement.cert);
    await until("the announcement", () => told.length === 1);
    expect(failing).toBe(false);
    expect(row().cert_serial).toBe(replacement.serial);
    expect(keys(told)).toEqual([`REMOTE_CERT_RECOVERED:${serial}`]);
    await until("the mark cleared", () => row().cert_alerted_serial === null);
  });
});
