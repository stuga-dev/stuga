/**
 * Remote access (docs/remote-access.md): the binding to the remote-access service, the certificate,
 * the relay credential and the listener for the remote address. Two loops that never wait on each
 * other do the work: the certificate loop gets a certificate when the node's own evidence says it
 * needs one, and the service loop checks in, keeps the credential fresh and checks the address
 * from outside. At start the listener opens with the certificate on disk before anything touches
 * the network.
 */
import type { KeyObject } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Sql } from "@stuga/db";
import {
  getRemoteAccess,
  recordRemoteAccount,
  recordRemoteCert,
  recordRemoteCertFailure,
  recordRemoteCheckin,
  recordRemoteConnectorConfig,
  recordRemoteCredential,
  recordRemoteCredentialFailure,
  recordRemoteProbe,
  saveRemoteBinding,
  setRemoteBindingFailing,
  setRemoteCheckinNext,
  setRemoteEnabled,
  setRemoteError,
  type NodeRemoteAccessRow,
  type StoredRemoteError,
} from "@stuga/db";
import type { ConnectorStatus, RemoteAccessStatus } from "@stuga/protocol/api/remote-access";
import type { ConnectorHints } from "../config/env.js";
import type { NodeEnv, RemoteAccessView } from "../env.js";
import { applyRemoteHeaders, withRemoteHeaders, withSecurityHeaders } from "../http/security-headers.js";
import type { ServingGate } from "../http/serving-gate.js";
import { startInterval } from "../platform/interval.js";
import { createRemoteListener, removeSocketFile, type RemoteListener } from "../platform/remote-listener.js";
import type { AcmeDirectory } from "./acme/client.js";
import { fetchTransport, type AcmeTransport } from "./acme/transport.js";
import {
  certFailure,
  certRenewAt,
  certUsable,
  issuanceEvidence,
  obtainCertificate,
  readCertificate,
  writeCertificate,
  type LoadedCert,
} from "./certificates.js";
import { createConnectorControl, type ConnectorLine } from "./connector.js";
import {
  clampNextCheckin,
  clampRefreshAt,
  credentialClaims,
  DEFAULT_PROBE_REFRESH_SPACING_MS,
  DEFAULT_REFRESH_SPACING_MS,
  planServiceTick,
  proofOfPossession,
  readHeldCredential,
  type HeldCredential,
  type RefreshReason,
} from "./credential.js";
import { systemChallengeResolver, waitForTxt, type ChallengeResolver } from "./dns-check.js";
import { ensureRemoteDir, RemoteDirError, SOCKET_NAME } from "./files.js";
import { removeConnectorFiles, removeTokenFiles, writeConnectorFiles, writeTokenFiles } from "./frpc-config.js";
import {
  generateP256,
  pendingBindingKey,
  promotePendingKey,
  readBindingKey,
  readPendingBindingKey,
  UnreadableKey,
  type BindingKey,
} from "./keys.js";
import { probeThroughRelay, type ProbeResult } from "./probe.js";
import { createServiceClient, ServiceError, type CheckinAnswer, type EnrollAnswer } from "./service-client.js";
import { clearedBy, deniedCheckinDelay, remoteError, remoteStatus, serviceFailure, type ErrorKind } from "./state.js";

export interface RemoteTiming {
  certTickMs: number;
  serviceTickMs: number;
  /** After the first credential and after a new certificate. */
  probeDelayMs: number;
  probeEveryMs: number;
  refreshSpacingMs: number;
  probeRefreshSpacingMs: number;
  issuanceTimeoutMs: number;
  enableTimeoutMs: number;
  /** How often the connector's status is read while it is asked on and not yet running. */
  connectorPollMs: number;
}

const DEFAULT_TIMING: RemoteTiming = {
  certTickMs: 60_000,
  serviceTickMs: 30_000,
  probeDelayMs: 30_000,
  probeEveryMs: 10 * 60_000,
  refreshSpacingMs: DEFAULT_REFRESH_SPACING_MS,
  probeRefreshSpacingMs: DEFAULT_PROBE_REFRESH_SPACING_MS,
  issuanceTimeoutMs: 10 * 60_000,
  enableTimeoutMs: 25_000,
  connectorPollMs: 5_000,
};

export interface RemoteAccessDeps {
  sql: Sql;
  env: Pick<NodeEnv, "publicOrigin">;
  /**
   * The packaging's hints, and the data directory the keys and the certificate live under.
   * `connector` is there where the packaging runs the connector.
   */
  config: { service: string; dir: string; dataDir: string; connector?: ConnectorHints | undefined };
  /** The LAN's gate: the remote listener serves and pauses with it. */
  gate: ServingGate;
  readsOwnBody: (method: string, path: string) => boolean;
  maxBodyBytes: () => number;
  /** Epoch milliseconds. Tests. */
  now?: () => number;
  /** Tests: a DNS server that stands for the zone's (challtestsrv). */
  challengeResolver?: ChallengeResolver;
  /** Tests: trusts the test CA's root. */
  acmeTransport?: AcmeTransport;
  /** Tests: straight to the socket rather than through a relay. */
  probe?: (hostname: string, expectedSpkiSha256: string) => Promise<ProbeResult>;
  /** Tests: shorter intervals. */
  timing?: Partial<RemoteTiming>;
  random?: () => number;
  onError?: (error: unknown) => void;
}

export interface RemoteAccess {
  view: RemoteAccessView;
  /** Open the listener with the certificate on disk when on, then start both loops. */
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): Promise<RemoteAccessStatus>;
  enable(input: { code?: string; acceptCaTerms: true; by: string }): Promise<EnableResult>;
  disable(by: string): Promise<RemoteAccessStatus>;
  /** Ask the packaging again for the connector it refused; refused where the packaging does not run it. */
  retryConnector(by: string): Promise<RemoteAccessStatus>;
  /** Check in and look at the certificate now, rather than when next due. */
  kick(): void;
}

export interface EnableResult {
  status: RemoteAccessStatus;
  /** How the node got its binding this time: a new address, a restored one, or the one it had. */
  via: "enroll" | "rebind" | "resume";
}

/** A refused enable, as the admin API answers it. */
export class RemoteAccessRefusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
  }
}

const CODE_REFUSALS: Record<string, [number, string]> = {
  enroll_code_invalid: [400, "That code isn't valid."],
  enroll_code_used: [400, "That code has already been used."],
  enroll_code_expired: [400, "That code has expired."],
  node_denied: [409, "Remote access is off for this address."],
  node_retired: [409, "Remote access is off for this address."],
  upgrade_required: [409, "Update Stuga to turn on remote access."],
};

/** Errors that stay until the work they came from succeeds, or an administrator acts. */
const STICKY = new Set([
  "binding_rejected",
  "upgrade_required",
  "acme_action_required",
  "remote_dir_unusable",
  "socket_path_too_long",
  "denied",
  "retired",
]);

/** Less than this left of enable's budget is too little for the service to answer in. */
const MIN_CALL_MS = 1_000;

/** One runs at a time; what it runs may not take the lock again. */
function createLock(): <T>(fn: () => Promise<T>) => Promise<T> {
  let last: Promise<unknown> = Promise.resolve();
  return (fn) => {
    const run = last.then(fn, fn);
    last = run.catch(() => {});
    return run;
  };
}

/** Why an issuance was abandoned: turned off, or the node stopping. */
class Stopped extends Error {}

export function createRemoteAccess(deps: RemoteAccessDeps): RemoteAccess {
  const { sql, config } = deps;
  const timing: RemoteTiming = { ...DEFAULT_TIMING, ...deps.timing };
  const now = deps.now ?? Date.now;
  const rand = deps.random ?? Math.random;
  const onError = deps.onError ?? ((e: unknown) => console.error("[remote] remote access failed", e));
  const transport = deps.acmeTransport ?? fetchTransport();
  const resolver = deps.challengeResolver ?? systemChallengeResolver();
  const probe = deps.probe ?? probeThroughRelay;
  const client = createServiceClient({ now });
  const locked = createLock();
  const directories = new Map<string, { directory: AcmeDirectory; at: number }>();
  const connector = config.connector ? createConnectorControl({ hints: config.connector, now, onError }) : null;

  let row: NodeRemoteAccessRow | null = null;
  /** The certificate the listener serves: the last good one, even while the file is being replaced. */
  let cert: LoadedCert | null = null;
  let credential: HeldCredential | null = null;
  /** The credential is in the connector's token files. */
  let jwtOnDisk = false;
  /** Whether the shared directory was usable when last checked. */
  let dirUsable = false;
  /** The settings the packaging's connector was last seen running, by their sha-256; null when not running. */
  let connectorRunningFor: string | null = null;
  /** The settings the connector has run since it was last asked on: the self-check waits for it once per settings. */
  let connectorRanFor: string | null = null;
  let connectorWatched = false;
  let listener: RemoteListener | null = null;
  let listenerHost: string | null = null;
  let listenerSerial: string | null = null;
  /** Bumped by enable and disable: a tick that started before drops what it learned. */
  let generation = 0;
  let upgradeRequired = false;
  let checkinWanted = false;
  let refreshWanted = false;
  let lastRefreshAt: number | null = null;
  let lastProbeRefreshAt: number | null = null;
  let probeDueAt: number | null = null;
  let deniedProbeCheckinAt: number | null = null;
  /** The issuance under way: turning off or stopping aborts it, and nothing more of it goes out. */
  let issuing: AbortController | null = null;
  let stopped = false;
  const timers = new Set<NodeJS.Timeout>();
  let certLoop: ReturnType<typeof startInterval> | null = null;
  let serviceLoop: ReturnType<typeof startInterval> | null = null;

  const later = (ms: number, fn: () => void): void => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!stopped) fn();
    }, ms);
    timers.add(timer);
  };

  async function refreshRow(): Promise<NodeRemoteAccessRow> {
    row = await getRemoteAccess(sql);
    return row;
  }

  /** The service's clock, in seconds, to this node's, in milliseconds. */
  const local = (serviceSeconds: number): number => (serviceSeconds - client.clockOffset()) * 1000;

  /** When the credential was issued, on the service's clock (as `credential_not_before` is), and when it expires, on this one's. */
  const held = () => (credential ? { iat: credential.iat * 1000, exp: local(credential.exp) } : null);

  /** Record `err` unless a sticky one stands and this one is not, or it says what is already said. */
  async function recordError(err: StoredRemoteError): Promise<void> {
    const current = row?.last_error ?? null;
    if (current && STICKY.has(current.code) && !STICKY.has(err.code)) return;
    if (current && current.code === err.code && current.message === err.message && current.retry_at === err.retry_at) return;
    await setRemoteError(sql, err);
    await refreshRow();
  }

  /** A success of `kind` clears the error it would have raised. */
  async function succeeded(kind: ErrorKind): Promise<void> {
    // An order that ran on past the 426 is no sign of a newer Stuga: that takes a restart.
    if (upgradeRequired && row?.last_error?.code === "upgrade_required") return;
    if (clearedBy(kind, row?.last_error ?? null)) {
      await setRemoteError(sql, null);
      await refreshRow();
    }
  }

  /**
   * The key that signs requests: the one the service has, which a crash may have left pending. Null
   * when this node has none it can use, missing or damaged, with an error that says which.
   */
  async function bindingKey(r: NodeRemoteAccessRow): Promise<BindingKey | null> {
    const damaged: UnreadableKey[] = [];
    const read = async (load: (dataDir: string) => Promise<BindingKey | null>): Promise<BindingKey | null> => {
      try {
        return await load(config.dataDir);
      } catch (e) {
        if (!(e instanceof UnreadableKey)) throw e;
        damaged.push(e);
        return null;
      }
    };
    const key = await read(readBindingKey);
    if (key && key.thumbprint === r.binding_thumbprint) return key;
    const pending = await read(readPendingBindingKey);
    if (pending && pending.thumbprint === r.binding_thumbprint) {
      // Under the lock, as enable promotes the key it binds: a second promotion would retire it.
      await locked(() => promotePendingKey(config.dataDir, new Date(now())));
      return pending;
    }
    if (key) return key;
    const why = damaged[0] ? `${damaged[0].message}.` : "This node's key for its remote address is missing.";
    await recordError(remoteError("binding_rejected", `${why} Enter a restore code to keep the address.`, new Date(now())));
    return null;
  }

  /** The shared directory is usable, and a problem with it cleared once it is; false after recording why not. */
  async function checkDir(): Promise<boolean> {
    try {
      await ensureRemoteDir(config.dir);
    } catch (e) {
      if (!(e instanceof RemoteDirError)) throw e;
      await recordError(remoteError(e.code, e.message, new Date(now())));
      return false;
    }
    await succeeded("dir");
    return true;
  }

  // ---- the listener ----------------------------------------------------------

  /**
   * The listener, the credential and the connector in line with the state: without a certificate
   * that serves the hostname there is no listener, no credential and no tunnel. Under the lock.
   */
  async function syncListener(dirOk: boolean): Promise<void> {
    dirUsable = dirOk;
    const r = row;
    if (r?.enabled && !certUsable(cert, r.hostname, now()) && (credential || jwtOnDisk || r.credential_expires_at)) {
      await dropCredential(r);
    }
    await syncSocket(dirOk);
    await syncConnector();
  }

  /** Open while on with a certificate that serves the hostname, closed otherwise. Under the lock. */
  async function syncSocket(dirOk: boolean): Promise<void> {
    const r = row;
    const want = r !== null && r.enabled && dirOk && certUsable(cert, r.hostname, now());
    if (!want) {
      await closeListener();
      return;
    }
    if (listener && listenerHost !== r.hostname) await closeListener();
    if (listener) {
      if (listenerSerial !== cert!.serial) {
        listener.setCertificate({ key: cert!.keyPem, cert: cert!.chainPem });
        listenerSerial = cert!.serial;
      }
      return;
    }
    const socketPath = await ensureRemoteDir(config.dir);
    const next = createRemoteListener({
      socketPath,
      hostname: r.hostname!,
      handler: withRemoteHeaders(withSecurityHeaders(deps.gate.handler)),
      upgrade: withRemoteHeaders(withSecurityHeaders(deps.gate.upgrade)),
      decorate: applyRemoteHeaders,
      maxBodyBytes: deps.maxBodyBytes,
      readsOwnBody: deps.readsOwnBody,
      onError,
    });
    next.setCertificate({ key: cert!.keyPem, cert: cert!.chainPem });
    try {
      await next.listen();
    } catch (e) {
      // It may have bound the socket before failing: closed, not left listening with no one holding it.
      await next.close().catch(() => {});
      if (!(e instanceof RemoteDirError)) throw e;
      await recordError(remoteError(e.code, e.message, new Date(now())));
      return;
    }
    listener = next;
    listenerHost = r.hostname;
    listenerSerial = cert!.serial;
  }

  async function closeListener(): Promise<void> {
    const open = listener;
    listener = null;
    listenerHost = null;
    listenerSerial = null;
    if (open) await open.close();
  }

  /**
   * The connector asked off, then the credential gone from its files, the row and memory: a new one
   * comes once a certificate serves the hostname again, and only then is the connector asked on.
   * Under the lock.
   */
  async function dropCredential(r: NodeRemoteAccessRow): Promise<void> {
    jwtOnDisk = false;
    await syncConnector();
    await removeTokenFiles(config.dir, r.relays.map((relay) => relay.name)).catch(() => {});
    credential = null;
    await recordRemoteCredential(sql, { issuedAt: null, expiresAt: null, refreshAt: null });
    await refreshRow();
  }

  // ---- the connector, where the packaging runs it ------------------------------

  /** On with the current settings once there is a certificate, a credential in its files and settings to run; off otherwise. */
  function connectorLine(): ConnectorLine {
    const r = row;
    const current = held();
    const sha = r?.connector_config_sha256 ?? null;
    const on =
      r !== null &&
      r.enabled &&
      dirUsable &&
      r.relays.length > 0 &&
      sha !== null &&
      certUsable(cert, r.hostname, now()) &&
      current !== null &&
      current.exp > now() &&
      jwtOnDisk;
    return on ? `on ${sha}` : "off";
  }

  /** Ask for the connector the state allows, at once when that changed. Under the lock. */
  async function syncConnector(opts: { force?: boolean } = {}): Promise<void> {
    if (!connector) return;
    const line = connectorLine();
    await connector.want(line, opts);
    if (line === "off") connectorRanFor = null;
    watchConnector();
  }

  /** Take in the connector's status, read by `read`: once it runs the current settings, the self-check follows. */
  async function observeConnector(read: () => Promise<ConnectorStatus | null>): Promise<void> {
    if (!connector) return;
    await read();
    const sha = row?.connector_config_sha256 ?? null;
    const running = connector.running(sha);
    // Started, or restarted on new settings: the self-check within seconds.
    if (running && connectorRunningFor !== sha) {
      probeDueAt = now();
      serviceLoop?.kick();
    }
    connectorRunningFor = running ? sha : null;
    if (running) connectorRanFor = sha;
    watchConnector();
  }

  /** Whether the packaging's connector was last seen running the current settings. */
  const connectorRunsCurrent = (): boolean => connectorRunningFor !== null && connectorRunningFor === row?.connector_config_sha256;

  /** While asked on and not yet running, the status is read every few seconds rather than every tick. */
  function watchConnector(): void {
    if (!connector || connectorWatched || stopped || connectorRunsCurrent() || !connector.line()?.startsWith("on ")) return;
    connectorWatched = true;
    later(timing.connectorPollMs, () => {
      connectorWatched = false;
      observeConnector(connector.read).catch(onError);
    });
  }

  /** Check the directory, then bring the listener in line; under the lock. */
  async function settleListener(): Promise<void> {
    const dirOk = row?.enabled ? await checkDir() : false;
    await syncListener(dirOk);
  }

  // ---- the service's refusals ------------------------------------------------

  /** A failure calling the service, from either loop: the error, and the side effects the table names. */
  async function serviceRefused(err: ServiceError, loop: "service" | "cert"): Promise<Date | null> {
    const r = row!;
    const at = new Date(now());
    if (err.code === "unknown_key" || err.code === "bad_signature") {
      await setRemoteBindingFailing(sql, at);
      await refreshRow();
    }
    const failures = (loop === "service" ? r.credential_failures : r.cert_failures) + 1;
    const f = serviceFailure(err, { now: at, failures, bindingFailingSince: row!.binding_failing_since, rand });
    if (f.upgradeRequired) upgradeRequired = true;
    const wasDenied = r.last_error?.code === "denied" || r.last_error?.code === "retired";
    await recordError(f.lastError);
    if (f.denied || wasDenied) {
      // A denied node checks in hourly, whatever else went wrong.
      await setRemoteCheckinNext(sql, f.retryAt ?? new Date(at.getTime() + deniedCheckinDelay(rand)));
    } else if (loop === "service") {
      await recordRemoteCredentialFailure(sql, { failures, retryAt: f.retryAt });
    }
    await refreshRow();
    return f.retryAt;
  }

  // ---- the service loop ------------------------------------------------------

  async function applyCheckin(answer: CheckinAnswer): Promise<void> {
    const before = row!;
    // The id names the connector's proxy, and the row keeps the one this node was bound to.
    if (answer.node.id !== before.remote_id) {
      throw new ServiceError(502, "malformed", "the remote access service's answer to checkin names another node");
    }
    const at = new Date(now());
    const nowS = Math.floor(now() / 1000) + client.clockOffset();
    const next = clampNextCheckin(nowS, answer.next_checkin_at);
    await recordRemoteCheckin(sql, {
      at,
      nextAt: new Date(local(next)),
      apiUrl: answer.api ?? before.api_url!,
      hostname: answer.node.hostname,
      relays: answer.relays,
      acmeDirectory: answer.acme.directory,
      acmeProfile: answer.acme.profile,
      acmeReissueBefore: answer.acme.reissue_before === null ? null : new Date(answer.acme.reissue_before * 1000),
      credentialTtl: answer.credential_ttl,
      credentialNotBefore: answer.credential_not_before === null ? null : new Date(answer.credential_not_before * 1000),
    });
    const wasDenied = before.last_error?.code === "denied" || before.last_error?.code === "retired";
    await refreshRow();
    await succeeded("service");
    if (wasDenied) {
      // Let back in: a credential straight away.
      refreshWanted = true;
      serviceLoop?.kick();
    }
    if (await checkDir()) {
      const { sha256 } = await writeConnectorFiles({
        dir: config.dir,
        id: answer.node.id,
        hostname: answer.node.hostname,
        relays: answer.relays,
        previous: before.relays,
        logLevel: connector ? "warn" : "info",
      });
      if (sha256 !== row!.connector_config_sha256) await recordRemoteConnectorConfig(sql, { sha256, changedAt: at });
      const names = (relays: readonly { name: string }[]) => relays.map((relay) => relay.name).join(",");
      if (credential && names(before.relays) !== names(answer.relays)) await writeTokenFiles(config.dir, answer.relays, credential.jwt);
      await refreshRow();
    }
    // Credentials from before this time are refused: a new one now, not at the next tick.
    if (credential && answer.credential_not_before !== null && credential.iat < answer.credential_not_before) serviceLoop?.kick();
    if (before.hostname !== answer.node.hostname) await settleListener();
    certLoop?.kick();
  }

  async function checkIn(key: BindingKey, gen: number): Promise<CheckinAnswer | null> {
    const r = row!;
    const answer = await client.checkin(r.api_url!, key, r.remote_id!);
    return locked(async () => {
      if (gen !== generation || !row?.enabled) return null;
      await applyCheckin(answer);
      return answer;
    });
  }

  async function refreshCredential(key: BindingKey, gen: number, first: CheckinAnswer, reason: RefreshReason): Promise<void> {
    let answer = first;
    for (let attempt = 0; ; attempt++) {
      const r = row!;
      if (!certUsable(cert, r.hostname, now())) return;
      const held = cert!;
      try {
        const issued = await client.relayCredential(r.api_url!, key, r.remote_id!, {
          nonce: answer.nonce,
          certificate: held.leafPem,
          pop: proofOfPossession(held.key, r.remote_id!, answer.nonce),
        });
        await locked(async () => {
          if (gen !== generation || !row?.enabled) return;
          const claims = credentialClaims(issued.credential);
          const firstCredential = credential === null;
          credential = { jwt: issued.credential, iat: claims?.iat ?? issued.issued_at, exp: claims?.exp ?? issued.expires_at };
          if (await checkDir()) {
            await writeTokenFiles(config.dir, row.relays, issued.credential);
            jwtOnDisk = true;
          }
          await recordRemoteCredential(sql, {
            issuedAt: new Date(local(issued.issued_at)),
            expiresAt: new Date(local(issued.expires_at)),
            refreshAt: new Date(local(clampRefreshAt(issued.issued_at, issued.expires_at, issued.refresh_at))),
          });
          await refreshRow();
          lastRefreshAt = now();
          if (reason === "probe") lastProbeRefreshAt = lastRefreshAt;
          refreshWanted = false;
          if (firstCredential) scheduleProbe(timing.probeDelayMs);
          // The connector may run now: asked here, not at the next tick.
          await syncConnector();
        });
        return;
      } catch (e) {
        // The nonce went stale or was used: one more check-in for a fresh one.
        if (!(e instanceof ServiceError && e.code === "nonce_invalid" && attempt === 0)) throw e;
        const again = await checkIn(key, gen);
        if (!again) return;
        answer = again;
      }
    }
  }

  function scheduleProbe(inMs: number): void {
    probeDueAt = now() + inMs;
    later(inMs, () => serviceLoop?.kick());
  }

  async function maybeProbe(): Promise<void> {
    const r = row;
    if (!r?.enabled || !listener || !cert || !r.hostname) return;
    const current = held();
    if (!current || current.exp <= now()) return;
    // The packaging's connector not yet started on these settings: nothing to check, and no failure.
    // Once it has, the self-check is what notices it stopped.
    if (connector && connectorRanFor !== r.connector_config_sha256) return;
    if (probeDueAt !== null && now() < probeDueAt) return;
    probeDueAt = now() + timing.probeEveryMs;
    const result = await probe(r.hostname, cert.spkiSha256);
    const at = new Date(now());
    await recordRemoteProbe(sql, { at, ok: result.ok });
    await refreshRow();
    if (result.ok) {
      await succeeded("probe");
      // Back through the relay while denied: the deny may have been lifted.
      const code = row!.last_error?.code;
      if ((code === "denied" || code === "retired") && (deniedProbeCheckinAt === null || now() - deniedProbeCheckinAt >= 10 * 60_000)) {
        deniedProbeCheckinAt = now();
        checkinWanted = true;
        serviceLoop?.kick();
      }
    } else {
      await recordError(remoteError(result.code, result.message, at));
    }
  }

  async function serviceTick(): Promise<void> {
    if (stopped) return;
    try {
      await serviceWork();
    } finally {
      // Settings a check-in just changed are asked for now; then, while the packaging has not done what
      // was asked, again after 1, 5, 15 and 60 minutes, whatever else failed this tick.
      if (connector && !stopped) {
        await locked(async () => {
          await syncConnector();
          await observeConnector(connector.reconcile);
        });
      }
    }
  }

  async function serviceWork(): Promise<void> {
    const gen = generation;
    const r = await refreshRow();
    if (!r.enabled || !r.remote_id || !r.api_url) {
      await locked(async () => syncListener(false));
      return;
    }
    await locked(settleListener);
    if (upgradeRequired) return;
    const plan = planServiceTick({
      now: now(),
      row: row!,
      credential: held(),
      certUsable: certUsable(cert, row!.hostname, now()),
      checkinWanted,
      refreshWanted,
      lastRefreshAt,
      lastProbeRefreshAt,
      refreshSpacingMs: timing.refreshSpacingMs,
      probeRefreshSpacingMs: timing.probeRefreshSpacingMs,
    });
    if (plan.checkin || plan.refresh) {
      checkinWanted = false;
      const key = await bindingKey(row!);
      if (!key) return;
      try {
        const answer = await checkIn(key, gen);
        if (answer && plan.refresh) await refreshCredential(key, gen, answer, plan.refresh);
      } catch (e) {
        if (!(e instanceof ServiceError)) throw e;
        await serviceRefused(e, "service");
      }
    }
    await maybeProbe();
  }

  // ---- the certificate loop --------------------------------------------------

  async function certTick(): Promise<void> {
    if (stopped) return;
    const r = await refreshRow();
    if (!r.enabled || !r.hostname || !r.api_url || !r.remote_id || upgradeRequired) return;
    // Nothing to ask for before the first check-in names a CA.
    if (!r.acme_directory) return;
    const code = r.last_error?.code;
    if (code === "acme_action_required" || code === "denied" || code === "retired") return;
    const disk = await readCertificate(config.dataDir);
    if (disk.kind === "ok" && certUsable(disk.cert, r.hostname, now())) {
      const found = disk.cert;
      if (found.serial !== r.cert_serial) {
        // A certificate the row does not describe, as after the database was recreated: described now.
        await recordRemoteCert(sql, {
          serial: found.serial,
          directory: r.cert_serial === null ? null : r.cert_directory,
          notBefore: found.notBefore,
          notAfter: found.notAfter,
          renewAt: certRenewAt(found.notBefore, found.notAfter, rand),
          reissueBefore: null,
        });
        await refreshRow();
      }
      if (cert?.serial !== found.serial) {
        await locked(async () => {
          cert = found;
          await settleListener();
        });
      }
    }
    const evidence = issuanceEvidence(disk, row!, now());
    if (!evidence) return;
    if (r.cert_retry_at && now() < r.cert_retry_at.getTime()) return;
    try {
      await issue(r);
    } catch (e) {
      if (e instanceof Stopped) return;
      await refreshRow();
      if (e instanceof ServiceError) {
        const retryAt = await serviceRefused(e, "cert");
        await recordRemoteCertFailure(sql, { failures: row!.cert_failures + 1, retryAt });
      } else {
        const f = certFailure(e, { now: new Date(now()), failures: row!.cert_failures + 1, rand });
        if (f.forgetAccount) await recordRemoteAccount(sql, { directory: null, url: null, termsUrl: row!.ca_terms_url });
        await recordRemoteCertFailure(sql, { failures: row!.cert_failures + 1, retryAt: f.retryAt });
        await recordError(f.lastError);
      }
      await refreshRow();
    }
  }

  async function issue(r: NodeRemoteAccessRow): Promise<void> {
    const key = await bindingKey(r);
    if (!key) return;
    const directoryUrl = r.acme_directory!;
    const hostname = r.hostname!;
    const fqdn = `_acme-challenge.${hostname}`;
    // Turned off, or the node stopping: every request stops, the cleanup's too. Out of time: the
    // order stops and its cleanup still goes out. Either way it ends here, not in the background.
    const off = new AbortController();
    const late = new AbortController();
    const signal = AbortSignal.any([off.signal, late.signal]);
    const timer = setTimeout(
      () => late.abort(new Error(`no certificate within ${timing.issuanceTimeoutMs / 60_000} minutes`)),
      timing.issuanceTimeoutMs,
    );
    issuing = off;
    const sleep = (ms: number) => delay(ms, undefined, { signal });
    let obtained: { key: KeyObject; chainPem: string };
    try {
      obtained = await obtainCertificate({
        transport: { request: (url, init) => transport.request(url, { ...init, signal }) },
        dataDir: config.dataDir,
        directoryUrl,
        account: { directory: r.acme_account_directory, url: r.acme_account_url },
        hostname,
        profile: r.acme_profile,
        dns: {
          present: async (value) => {
            const published = (await client.acmeTxt(r.api_url!, key, r.remote_id!, value, { signal })).fqdn;
            // The name the CA looks up is this one; the service has no other to name.
            if (published !== fqdn) throw new ServiceError(502, "malformed", `the remote access service published ${published}, not ${fqdn}`);
          },
          verify: (value) => waitForTxt({ resolver, hostname, fqdn, value, sleep, now }),
          cleanup: async () => {
            await client.acmeTxtCleanup(r.api_url!, key, r.remote_id!, { signal: off.signal }).catch(() => {});
          },
        },
        onAccount: async (a) => {
          await recordRemoteAccount(sql, { directory: a.directory, url: a.url, termsUrl: a.termsUrl });
        },
        directories,
        clock: { now, sleep },
        newKey: generateP256,
      });
    } catch (e) {
      // Cut short, it fails for the reason it was: Stopped, or out of time.
      throw signal.aborted ? signal.reason : e;
    } finally {
      clearTimeout(timer);
      if (issuing === off) issuing = null;
    }
    await writeCertificate(config.dataDir, obtained.key, obtained.chainPem);
    const written = await readCertificate(config.dataDir);
    if (written.kind !== "ok") throw new Error("the certificate the CA issued does not match its key");
    const next = written.cert;
    await recordRemoteCert(sql, {
      serial: next.serial,
      directory: directoryUrl,
      notBefore: next.notBefore,
      notAfter: next.notAfter,
      renewAt: certRenewAt(next.notBefore, next.notAfter, rand),
      reissueBefore: r.acme_reissue_before,
    });
    await refreshRow();
    await succeeded("issuance");
    await locked(async () => {
      cert = next;
      await settleListener();
    });
    scheduleProbe(timing.probeDelayMs);
    serviceLoop?.kick();
  }

  // ---- enable and disable ----------------------------------------------------

  async function bind(
    code: string,
    bound: boolean,
    deadline: number,
  ): Promise<{ answer: EnrollAnswer; via: "enroll" | "rebind"; key: BindingKey }> {
    let key: BindingKey;
    try {
      key = await pendingBindingKey(config.dataDir);
    } catch (e) {
      // Never deleted by the node, so set aside by hand.
      if (e instanceof UnreadableKey) throw new RemoteAccessRefusal(409, undefined, `${e.message}. Move it aside, then try again.`);
      throw e;
    }
    const base = row!.api_url ?? config.service;
    // Each call gets what is left of the budget, and none starts with too little left to be answered.
    const call = (via: "enroll" | "rebind"): Promise<EnrollAnswer> => {
      const timeoutMs = deadline - now();
      if (timeoutMs < MIN_CALL_MS) throw new ServiceError(503, "timeout", "the remote access service took too long");
      return via === "enroll" ? client.enroll(base, key, code, { timeoutMs }) : client.rebind(base, key, code, { timeoutMs });
    };
    let via: "enroll" | "rebind" = bound ? "rebind" : "enroll";
    try {
      let answer: EnrollAnswer;
      try {
        answer = await call(via);
      } catch (e) {
        // A restore code sent to enroll, or an enrollment code to rebind: the service says which.
        if (!(e instanceof ServiceError && e.code === "enroll_code_wrong_kind")) throw e;
        via = via === "enroll" ? "rebind" : "enroll";
        answer = await call(via);
      }
      // However late it came, the service has bound this key: kept, so a retry is not refused as a used code.
      return { answer, via, key };
    } catch (e) {
      if (!(e instanceof ServiceError)) throw e;
      const known = CODE_REFUSALS[e.code];
      if (e.code === "upgrade_required" || e.status === 426) {
        upgradeRequired = true;
        await recordError(remoteError("upgrade_required", "Update Stuga to use remote access.", new Date(now())));
      }
      if (known) {
        const code = e.code === "node_denied" ? "denied" : e.code === "node_retired" ? "retired" : e.code;
        throw new RemoteAccessRefusal(known[0], code, known[1]);
      }
      throw new RemoteAccessRefusal(502, "service_unreachable", "Couldn't reach the remote access service. Try again.");
    }
  }

  async function enable(input: { code?: string; acceptCaTerms: true; by: string }): Promise<EnableResult> {
    const deadline = now() + timing.enableTimeoutMs;
    const via = await locked(async () => {
      // Told to upgrade: nothing more goes to the service from this process.
      if (upgradeRequired) throw new RemoteAccessRefusal(409, "upgrade_required", "Update Stuga to turn on remote access.");
      const r = await refreshRow();
      try {
        await ensureRemoteDir(config.dir);
      } catch (e) {
        if (e instanceof RemoteDirError) throw new RemoteAccessRefusal(409, e.code, e.message);
        throw e;
      }
      await succeeded("dir");
      const code = input.code?.trim() || null;
      const bound = r.remote_id !== null;
      if (!code && !bound) throw new RemoteAccessRefusal(400, "code_required", "Enter the code you were given.");
      const at = new Date(now());
      const enabled = { enabled: true as const, by: input.by, at, caTermsAcceptedBy: input.by, caTermsAcceptedAt: at };
      if (!code) {
        if (`https://${r.hostname}` === deps.env.publicOrigin) throw sameOrigin();
        await setRemoteEnabled(sql, enabled);
        return "resume" as const;
      }
      const { answer, via, key } = await bind(code, bound, deadline);
      if (`https://${answer.hostname}` === deps.env.publicOrigin) throw sameOrigin();
      await sql.begin(async (tx) => {
        await saveRemoteBinding(tx, {
          remoteId: answer.id,
          hostname: answer.hostname,
          apiUrl: answer.api ?? r.api_url ?? config.service,
          thumbprint: key.thumbprint,
          boundAt: at,
        });
        await setRemoteEnabled(tx, enabled);
      });
      await promotePendingKey(config.dataDir, at);
      if (answer.id !== r.remote_id) {
        // A credential names the address it was issued for.
        credential = null;
        await recordRemoteCredential(sql, { issuedAt: null, expiresAt: null, refreshAt: null });
      }
      return via;
    });
    await locked(async () => {
      generation += 1;
      const r = await refreshRow();
      // An administrator turning it on again is the action these wait for.
      if (r.last_error && ["acme_action_required", "binding_rejected"].includes(r.last_error.code)) {
        await setRemoteError(sql, null);
        await recordRemoteCertFailure(sql, { failures: 0, retryAt: null });
      }
      await refreshRow();
      checkinWanted = true;
      await settleListener();
    });
    certLoop?.kick();
    serviceLoop?.kick();
    return { status: await status(), via };
  }

  function sameOrigin(): RemoteAccessRefusal {
    return new RemoteAccessRefusal(409, undefined, "PUBLIC_ORIGIN is this node's remote address; the remote address needs an origin of its own.");
  }

  async function disable(_by: string): Promise<RemoteAccessStatus> {
    await locked(async () => {
      generation += 1;
      // An order under way stops where it is: nothing more goes to the service or the CA.
      issuing?.abort(new Stopped());
      const r = await refreshRow();
      await setRemoteEnabled(sql, { enabled: false });
      await recordRemoteCredential(sql, { issuedAt: null, expiresAt: null, refreshAt: null });
      credential = null;
      probeDueAt = null;
      await closeListener();
      // One a stopped node left behind; the listener removes its own.
      await removeSocketFile(join(config.dir, SOCKET_NAME), { refuseOther: false }).catch(() => {});
      await removeConnectorFiles(config.dir, r.relays.map((relay) => relay.name));
      jwtOnDisk = false;
      await refreshRow();
      await syncConnector();
    });
    return status();
  }

  async function retryConnector(_by: string): Promise<RemoteAccessStatus> {
    if (!connector) throw new RemoteAccessRefusal(409, "unavailable", "The connector isn't run by this node's packaging.");
    await locked(async () => {
      await refreshRow();
      await syncConnector({ force: true });
    });
    return status();
  }

  async function status(): Promise<RemoteAccessStatus> {
    const r = await refreshRow();
    return remoteStatus(r, { dir: config.dir, now: new Date(now()), connector: connector ? await connector.report() : undefined });
  }

  const view: RemoteAccessView = {
    current() {
      const r = row;
      return {
        enabled: r?.enabled ?? false,
        id: r?.remote_id ?? null,
        hostname: r?.hostname ?? null,
        origin: r?.hostname ? `https://${r.hostname}` : null,
      };
    },
  };

  return {
    view,
    async start() {
      stopped = false;
      // A check-in first thing, while on.
      checkinWanted = true;
      // Asked once at every start, whatever was asked before: the packaging compares it with what runs.
      connector?.reset();
      connectorRunningFor = null;
      connectorRanFor = null;
      connectorWatched = false;
      // Whatever is wrong here is the loops' to report and retry: never a reason for the node not to start.
      try {
        const r = await refreshRow();
        if (r.binding_thumbprint) await bindingKey(r);
        const disk = await readCertificate(config.dataDir);
        cert = disk.kind === "ok" ? disk.cert : null;
        credential = await readHeldCredential(config.dir, r.relays);
        jwtOnDisk = credential !== null;
        if (r.enabled) await locked(settleListener);
        await locked(() => syncConnector());
      } catch (e) {
        onError(e);
      }
      certLoop = startInterval(timing.certTickMs, certTick, { onError });
      serviceLoop = startInterval(timing.serviceTickMs, serviceTick, { onError });
      certLoop.kick();
      serviceLoop.kick();
    },
    async stop() {
      stopped = true;
      issuing?.abort(new Stopped());
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      const loops = [certLoop, serviceLoop];
      certLoop = null;
      serviceLoop = null;
      // The issuance is abandoned above; a check-in or a credential request in flight may take a while longer.
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([Promise.all(loops.map((l) => l?.stop())), new Promise((r) => (timer = setTimeout(r, 5_000)))]);
      clearTimeout(timer);
      await locked(closeListener);
    },
    status,
    enable,
    disable,
    retryConnector,
    kick() {
      checkinWanted = true;
      certLoop?.kick();
      serviceLoop?.kick();
    },
  };
}
