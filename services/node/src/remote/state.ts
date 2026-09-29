/**
 * What remote access reports (docs/remote-access.md): the state the Settings page shows, the one
 * error it keeps, and how each refusal from the service turns into that error and a time to try
 * again. The error is replaced by the next one, and cleared by the next success of the kind of
 * work that raised it.
 */
import type { NodeRemoteAccessRow, StoredRemoteError } from "@stuga/db";
import type { RemoteAccessState, RemoteAccessStatus, RemoteError, RemoteErrorCode } from "@stuga/protocol/api/remote-access";
import type { ConnectorReport } from "./connector.js";
import { configFile } from "./frpc-config.js";
import type { ServiceError } from "./service-client.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The codes that need an administrator, or a newer Stuga, before anything works again. */
const ERROR_STATE = new Set<string>([
  "binding_rejected",
  "upgrade_required",
  "acme_action_required",
  "remote_dir_unusable",
  "socket_path_too_long",
  "connector_refused",
  "connector_unavailable",
]);

/**
 * The error the page shows. One an administrator must act on comes first; then what the state
 * itself says, never kept, so it goes when the state does: a refused or missing connector, an
 * expired certificate (after a kept reason renewal is stuck, which says more), a failed connector,
 * one not running what it was asked to; then the error kept. `connector` is there where the
 * packaging runs the connector.
 */
export function shownError(row: NodeRemoteAccessRow, now: Date, connector?: ConnectorReport): RemoteError | null {
  const kept = row.last_error as RemoteError | null;
  if (!row.enabled) return kept;
  if (kept && (ERROR_STATE.has(kept.code) || kept.code === "denied" || kept.code === "retired")) return kept;
  // A status from before the node last changed what it asks for answers something else.
  const status = connector && !connector.stale ? connector.status : null;
  if (status?.state === "refused") {
    return { code: "connector_refused", message: status.message || "The connector was refused.", at: status.at };
  }
  if (status?.state === "unavailable") {
    return { code: "connector_unavailable", message: status.message || "This installation doesn't include the connector.", at: status.at };
  }
  if (row.cert_not_after !== null && row.cert_not_after.getTime() <= now.getTime()) {
    if (kept && errorKind(kept.code) === "issuance") return kept;
    return { code: "certificate_expired", message: "The certificate expired.", at: row.cert_not_after.toISOString() };
  }
  const retry = connector?.retryAt ? { retry_at: connector.retryAt.toISOString() } : {};
  if (status?.state === "failed") {
    return { code: "connector_failed", message: status.message || "The connector failed.", at: status.at, ...retry };
  }
  if (connector?.behindSince) {
    return { code: "connector_failed", message: "The connector isn't running.", at: connector.behindSince.toISOString(), ...retry };
  }
  return kept;
}

/** The first row of the table that holds. */
export function remoteState(row: NodeRemoteAccessRow, now: Date, connector?: ConnectorReport): RemoteAccessState {
  if (!row.enabled) return "off";
  const error = shownError(row, now, connector);
  const code = error?.code;
  if (code && ERROR_STATE.has(code)) return "error";
  if (code === "denied" || code === "retired") return "denied";
  const t = now.getTime();
  const certValid = row.cert_not_after !== null && row.cert_not_after.getTime() > t;
  const credentialValid = row.credential_expires_at !== null && row.credential_expires_at.getTime() > t;
  const probed = row.probe_at !== null && row.probe_ok_at !== null && row.probe_ok_at.getTime() >= row.probe_at.getTime();
  if (certValid && credentialValid && probed && !error) return "on";
  if (error) return "degraded";
  return "starting";
}

/** Which kind of work an error came from: that kind's next success clears it. */
export type ErrorKind = "service" | "issuance" | "probe" | "dir";

export function errorKind(code: string): ErrorKind {
  switch (code) {
    case "acme_rate_limited":
    case "acme_challenge_failed":
    case "dns_not_visible":
    case "acme_action_required":
    case "acme_error":
    // A check-in does not lift it: issuance waits for retry_at all the same.
    case "issuance_budget":
      return "issuance";
    case "connector_unreachable":
    case "wrong_certificate":
      return "probe";
    case "remote_dir_unusable":
    case "socket_path_too_long":
      return "dir";
    default:
      return "service";
  }
}

/**
 * Whether a success of `kind` clears `current`. An issuance talks to the service too, so its
 * success clears the service's errors. After `upgrade_required` the node calls the service no more
 * until it restarts, so the first success that clears it is a newer Stuga's.
 */
export function clearedBy(kind: ErrorKind, current: StoredRemoteError | null): boolean {
  if (!current) return false;
  const of = errorKind(current.code);
  return of === kind || (kind === "issuance" && of === "service");
}

export function remoteError(
  code: RemoteErrorCode,
  message: string,
  at: Date,
  extra: { retryAt?: Date | null; serviceCode?: string; reason?: string } = {},
): StoredRemoteError {
  return {
    code,
    message,
    at: at.toISOString(),
    ...(extra.retryAt ? { retry_at: extra.retryAt.toISOString() } : {}),
    ...(extra.serviceCode ? { service_code: extra.serviceCode } : {}),
    ...(extra.reason ? { reason: extra.reason } : {}),
  };
}

/** `ms` give or take `fraction` of it. */
export function jitter(ms: number, rand: () => number, fraction = 0.1): number {
  return Math.round(ms * (1 + (rand() * 2 - 1) * fraction));
}

/** Network errors and 5xx: 1, 5, 15, 60 minutes, then every 3 hours, ±10%. `failures` counts this one. */
export function generalBackoff(failures: number, rand: () => number): number {
  const steps = [1, 5, 15, 60];
  return jitter((steps[failures - 1] ?? 180) * MINUTE, rand);
}

/** A key the service no longer knows: 15 minutes, an hour, then every 6 hours. */
export function bindingBackoff(failures: number): number {
  return failures <= 1 ? 15 * MINUTE : failures === 2 ? HOUR : 6 * HOUR;
}

/** How long a denied node waits between check-ins. */
export function deniedCheckinDelay(rand: () => number): number {
  return jitter(HOUR, rand);
}

/** A key refused for this long is reported as rejected, not just failing. */
export const BINDING_REJECTED_AFTER_MS = 24 * HOUR;

/** What a refusal or failure from the service means for this node (the protocol's error table). */
export interface ServiceFailure {
  lastError: StoredRemoteError;
  /** When to call the service again; null for never, in this process. */
  retryAt: Date | null;
  /** The binding key was refused: its first refusal in a run is recorded. */
  bindingRefused?: true;
  /** Denied or retired: no credential until a check-in gets through. */
  denied?: true;
  upgradeRequired?: true;
}

/** `failures` counts this one; `bindingFailingSince` is the run's start, now when this is its first. */
export function serviceFailure(
  err: ServiceError,
  ctx: { now: Date; failures: number; bindingFailingSince: Date | null; rand: () => number },
): ServiceFailure {
  const { now, failures, rand } = ctx;
  const t = now.getTime();
  const at = (ms: number) => new Date(t + ms);
  const refused = (retryAt: Date): ServiceFailure => ({
    lastError: remoteError("service_refused", err.message, now, { retryAt, serviceCode: err.code }),
    retryAt,
  });
  const unreachable = (): ServiceFailure => {
    const retryAt = at(err.detail.retryAfter !== undefined ? err.detail.retryAfter * 1000 : generalBackoff(failures, rand));
    return { lastError: remoteError("service_unreachable", "Couldn't reach the remote access service.", now, { retryAt }), retryAt };
  };
  if (err.status >= 500) return unreachable();
  switch (err.code) {
    case "unknown_key":
    case "bad_signature": {
      const retryAt = at(bindingBackoff(failures));
      const since = ctx.bindingFailingSince ?? now;
      const rejected = t - since.getTime() >= BINDING_REJECTED_AFTER_MS;
      return {
        lastError: rejected
          ? remoteError("binding_rejected", "The remote access service no longer accepts this node's key.", now, {
              retryAt,
              serviceCode: err.code,
            })
          : remoteError("service_refused", err.message, now, { retryAt, serviceCode: err.code }),
        retryAt,
        bindingRefused: true,
      };
    }
    case "node_denied":
    case "node_retired": {
      const retryAt = at(deniedCheckinDelay(rand));
      return {
        lastError: remoteError(err.code === "node_denied" ? "denied" : "retired", err.message, now, {
          retryAt,
          serviceCode: err.code,
          ...(err.detail.reason ? { reason: err.detail.reason } : {}),
        }),
        retryAt,
        denied: true,
      };
    }
    case "upgrade_required":
      return { lastError: remoteError("upgrade_required", "Update Stuga to use remote access.", now), retryAt: null, upgradeRequired: true };
    case "rate_limited":
      return refused(at((err.detail.retryAfter ?? 60) * 1000));
    case "issuance_budget": {
      const retryAt = at((err.detail.retryAfter ?? 3600) * 1000);
      return { lastError: remoteError("issuance_budget", err.message, now, { retryAt, serviceCode: err.code }), retryAt };
    }
    default:
      // Any other 4xx, a bad request or a certificate the service would not take: an hour, then from the top.
      if (err.status === 426) {
        return { lastError: remoteError("upgrade_required", "Update Stuga to use remote access.", now), retryAt: null, upgradeRequired: true };
      }
      return refused(at(HOUR));
  }
}

/**
 * The body of `GET /api/node/remote-access`, and of the enable and disable answers. `connector` is
 * there where the packaging runs the connector.
 */
export function remoteStatus(row: NodeRemoteAccessRow, opts: { dir: string; now: Date; connector?: ConnectorReport }): RemoteAccessStatus {
  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  const firstRelay = row.relays[0];
  const reachable = row.probe_at !== null && row.probe_ok_at !== null && row.probe_ok_at.getTime() >= row.probe_at.getTime();
  const managed = opts.connector !== undefined;
  const reported = opts.connector?.status ?? null;
  return {
    available: true,
    enabled: row.enabled,
    state: remoteState(row, opts.now, opts.connector),
    address: row.hostname ? `https://${row.hostname}` : null,
    certificate: row.cert_not_after ? { expires_at: row.cert_not_after.toISOString(), renew_at: iso(row.cert_renew_at) } : null,
    credential: row.credential_expires_at ? { expires_at: row.credential_expires_at.toISOString() } : null,
    connector:
      firstRelay || row.probe_at || reported
        ? {
            managed,
            status: reported,
            config_path: firstRelay && !managed ? configFile(opts.dir, firstRelay.name) : null,
            config_changed_at: iso(row.connector_config_changed_at),
            reachable,
            checked_at: iso(row.probe_at),
          }
        : null,
    ca_terms: row.ca_terms_accepted_at
      ? { accepted_by: row.ca_terms_accepted_by, accepted_at: row.ca_terms_accepted_at.toISOString(), url: row.ca_terms_url }
      : null,
    last_error: shownError(row, opts.now, opts.connector),
  };
}
