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
  /** The database is out of reach: reading the row fails. */
  let broken = false;
  return {
    row: () => row,
    broken: () => broken,
    breakReads: (b: boolean) => {
      broken = b;
    },
    reset: () => {
      row = blank();
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
        cert_failures: 0,
        cert_retry_at: null,
      }),
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
const { writeCertificate } = await import("./certificates.js");
import { makeTestCert } from "../testing/cert.js";
import type { ConnectorHints } from "../config/env.js";
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
    probe?: () => Promise<ProbeResult>;
    now?: () => number;
  } = {},
): RemoteAccess {
  const s = createRemoteAccess({
    sql: sql as never,
    env: { publicOrigin: opts.publicOrigin ?? "http://livs-air.local:8787" },
    config: { service: fake.url, dir: remoteDir, dataDir, connector: opts.connector },
    gate: createServingGate(),
    readsOwnBody: () => false,
    maxBodyBytes: () => 1 << 20,
    probe: opts.probe ?? (async () => ({ ok: true })),
    ...(opts.timing ? { timing: opts.timing } : {}),
    ...(opts.now ? { now: opts.now } : {}),
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

beforeEach(async () => {
  memory.reset();
  fake = await startFakeRemoteService({ acmeDirectory: "https://ca.stuga.test/dir", zone: "mystuga.com" });
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
    // The refusal answered other settings.
    expect(await s.status()).toMatchObject({ state: "starting", last_error: null });
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

  it("refuses a retry where the packaging does not run the connector", async () => {
    const s = service();
    expect(await refusal(s.retryConnector("liv"))).toMatchObject({ status: 409, code: "unavailable" });
  });
});
