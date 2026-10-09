/**
 * What remote access tells the node's administrators (docs/remote-access.md): a certificate that
 * will not renew, runs short or has run out, and one in use again after that; a key the service
 * no longer takes; and an address that moved to another computer. Each goes to every node
 * administrator, in the app and through the node's sink, once: its id names the certificate, the
 * run of refusals or the move it is about.
 */
import type { NodeRemoteAccessRow } from "@stuga/db";
import { notification, type NotificationParams } from "@stuga/protocol/notify/events";
import { sinkDelivery } from "../jobs/notify.js";
import { jobsDb, type JobsDb } from "../jobs/db.js";
import type { JobsEnv } from "../jobs/deps.js";
import { BINDING_REJECTED_AFTER_MS } from "./state.js";

/** Where a notification about remote access opens. */
export const REMOTE_ACCESS_PATH = "/settings/node/remote";

export type CertNoticeKind = "renewal_failed" | "expiring" | "expired" | "recovered";

export const BINDING_REJECTED_EVENT = "REMOTE_BINDING_REJECTED";

export const MOVED_EVENT = "REMOTE_ADDRESS_MOVED";

const CERT_EVENTS = {
  renewal_failed: "REMOTE_CERT_RENEWAL_FAILED",
  expiring: "REMOTE_CERT_EXPIRING",
  expired: "REMOTE_CERT_EXPIRED",
  recovered: "REMOTE_CERT_RECOVERED",
} as const;

export const certEvent = (kind: CertNoticeKind): string => CERT_EVENTS[kind];

type RemoteEvent = (typeof CERT_EVENTS)[CertNoticeKind] | typeof BINDING_REJECTED_EVENT | typeof MOVED_EVENT;

/** One notice: its event and params (@stuga/protocol/notify/events), which each reader's language words. */
export type RemoteNotice = {
  [E in RemoteEvent]: {
    event: E;
    /** Which certificate or run of refusals it is about: the id is `<event>:<key>:<alias>`. */
    key: string;
    params: NotificationParams[E];
  };
}[RemoteEvent];

/** Failed renewals in a row before the administrators hear of it. */
export const RENEWAL_FAILURES_TOLD = 3;

/** Errors that wait for someone, not for the next try. */
const RENEWAL_STOPPED = new Set(["acme_action_required", "issuance_budget"]);

/** Errors under which the node does not try to renew at all. */
const RENEWAL_BLOCKED = new Set([...RENEWAL_STOPPED, "denied", "retired", "upgrade_required", "binding_rejected"]);

function certNotice(kind: CertNoticeKind, serial: string, hostname: string, notAfter: Date, detail?: string): RemoteNotice {
  const address = `https://${hostname}`;
  const expires = notAfter.toISOString();
  switch (kind) {
    case "renewal_failed":
      return { event: CERT_EVENTS[kind], key: serial, params: { address, expires, detail: detail || null } };
    case "expired":
      return { event: CERT_EVENTS[kind], key: serial, params: { address } };
    default:
      return { event: CERT_EVENTS[kind], key: serial, params: { address, expires } };
  }
}
/**
 * The warnings the certificate the row describes calls for now: that renewing it keeps failing,
 * and that it runs short or has run out. Short or out only once renewing it has failed or can't be
 * tried: after a long sleep, or turned on again, the node renews before anyone hears of it. The
 * caller checks remote access is on.
 */
export function certNotices(row: NodeRemoteAccessRow, now: number): RemoteNotice[] {
  const { cert_serial: serial, hostname, cert_not_before: notBefore, cert_not_after: notAfter } = row;
  if (!serial || !hostname || !notBefore || !notAfter) return [];
  const out: RemoteNotice[] = [];
  const code = row.last_error?.code;
  if (row.cert_failures >= RENEWAL_FAILURES_TOLD || (code && RENEWAL_STOPPED.has(code))) {
    out.push(certNotice("renewal_failed", serial, hostname, notAfter, row.last_error?.message));
  }
  if (row.cert_failures === 0 && !(code && RENEWAL_BLOCKED.has(code))) return out;
  const left = notAfter.getTime() - now;
  if (left <= 0) out.push(certNotice("expired", serial, hostname, notAfter));
  // A tenth of whatever life the CA gives it: a day of a ten-day certificate, nine of a 90-day one.
  else if (left < (notAfter.getTime() - notBefore.getTime()) / 10) out.push(certNotice("expiring", serial, hostname, notAfter));
  return out;
}

/** A new certificate after a warning about `alerted`, the one it replaces. */
export function recoveredNotice(alerted: string, hostname: string, notAfter: Date): RemoteNotice {
  return certNotice("recovered", alerted, hostname, notAfter);
}

/**
 * The service has refused this node's key for a day, or the key is missing or damaged. Keyed by
 * when the refusals began, or when the key was found unusable, so a later run is told again.
 */
export function bindingNotice(row: NodeRemoteAccessRow, now: number): RemoteNotice | null {
  const since = row.binding_failing_since;
  const address = row.hostname ? `https://${row.hostname}` : null;
  if (since && now - since.getTime() >= BINDING_REJECTED_AFTER_MS) {
    return { event: BINDING_REJECTED_EVENT, key: since.toISOString(), params: { address, reason: "refused" } };
  }
  // The node's own finding, not the service's refusal, which names the code it refused with.
  const error = row.last_error;
  if (error?.code === "binding_rejected" && !error.service_code) {
    return { event: BINDING_REJECTED_EVENT, key: error.at, params: { address, reason: "key_unusable" } };
  }
  return null;
}

/** A restore code moved `hostname` to another computer, which this node learned at `at`. */
export function movedNotice(hostname: string, at: string): RemoteNotice {
  return { event: MOVED_EVENT, key: at, params: { address: `https://${hostname}` } };
}

/** One notification per administrator, in the app and through the sink; one already written is left alone. */
export async function notifyRemoteAccess(
  env: Pick<JobsEnv, "sql" | "settings" | "publicOrigin">,
  n: RemoteNotice,
  db: Pick<JobsDb, "listNodeAdmins" | "insertNotification"> = jobsDb(env.sql),
): Promise<void> {
  const url = `${env.publicOrigin}${REMOTE_ACCESS_PATH}`;
  const what = notification(n.event, n.params);
  for (const admin of await db.listNodeAdmins()) {
    const delivery = sinkDelivery(env.settings.current().notify, { recipient: admin.alias, ...what, url });
    await db.insertNotification(
      {
        id: `${n.event}:${n.key}:${admin.alias}`,
        workspace_id: null,
        recipient_alias: admin.alias,
        event_type: n.event,
        resource_id: null,
        resource_title: null,
        resource_url: url,
        actor_alias: null,
        payload: what.params,
      },
      delivery,
    );
  }
}
