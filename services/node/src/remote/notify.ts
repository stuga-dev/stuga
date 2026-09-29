/**
 * What remote access tells the node's administrators (docs/remote-access.md): a certificate that
 * will not renew, runs short or has run out, and one in use again after that; and a key the service
 * no longer takes. Each goes to every node administrator, in the app and through the node's sink,
 * once: its id names the certificate or the run of refusals it is about.
 */
import type { NodeRemoteAccessRow } from "@stuga/db";
import type { NotifyDeliverMessage } from "@stuga/protocol/internal/jobs";
import { jobsDb, type JobsDb } from "../jobs/db.js";
import type { JobsEnv } from "../jobs/deps.js";
import { BINDING_REJECTED_AFTER_MS } from "./state.js";

/** Where a notification about remote access opens. */
export const REMOTE_ACCESS_PATH = "/settings/node/remote";

export type CertNoticeKind = "renewal_failed" | "expiring" | "expired" | "recovered";

export const BINDING_REJECTED_EVENT = "REMOTE_BINDING_REJECTED";

export const certEvent = (kind: CertNoticeKind): string => `REMOTE_CERT_${kind.toUpperCase()}`;

export interface RemoteNotice {
  event: string;
  /** Which certificate or run of refusals it is about: the id is `<event>:<key>:<alias>`. */
  key: string;
  title: string;
  body: string;
}

/** Failed renewals in a row before the administrators hear of it. */
export const RENEWAL_FAILURES_TOLD = 3;

/** Errors that wait for someone, not for the next try. */
const RENEWAL_STOPPED = new Set(["acme_action_required", "issuance_budget"]);

/** Errors under which the node does not try to renew at all. */
const RENEWAL_BLOCKED = new Set([...RENEWAL_STOPPED, "denied", "retired", "upgrade_required", "binding_rejected"]);

const when = (d: Date): string => `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;

function certNotice(kind: CertNoticeKind, serial: string, hostname: string, notAfter: Date, detail?: string): RemoteNotice {
  const address = `https://${hostname}`;
  const copy: Record<CertNoticeKind, [title: string, body: string]> = {
    renewal_failed: ["Remote access can't renew its certificate", `The certificate for ${address} expires ${when(notAfter)}.${detail ? ` ${detail}` : ""}`],
    expiring: ["Remote access's certificate expires soon", `The certificate for ${address} expires ${when(notAfter)}.`],
    expired: ["Remote access's certificate expired", `${address} can't be reached until there is a new one.`],
    recovered: ["Remote access has a new certificate", `The certificate for ${address} is valid until ${when(notAfter)}.`],
  };
  const [title, body] = copy[kind];
  return { event: certEvent(kind), key: serial, title, body };
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
  const address = row.hostname ? `https://${row.hostname}` : "the remote address";
  const title = "Remote access needs a restore code";
  if (since && now - since.getTime() >= BINDING_REJECTED_AFTER_MS) {
    return {
      event: BINDING_REJECTED_EVENT,
      key: since.toISOString(),
      title,
      body: `The remote access service no longer accepts this node's key. Enter a restore code to keep ${address}.`,
    };
  }
  // The node's own finding, not the service's refusal, which names the code it refused with.
  const error = row.last_error;
  if (error?.code === "binding_rejected" && !error.service_code) {
    return { event: BINDING_REJECTED_EVENT, key: error.at, title, body: error.message };
  }
  return null;
}

/** One notification per administrator, in the app and through the sink; one already written is left alone. */
export async function notifyRemoteAccess(
  env: Pick<JobsEnv, "sql" | "settings" | "publicOrigin">,
  n: RemoteNotice,
  db: Pick<JobsDb, "listNodeAdmins" | "insertNotification"> = jobsDb(env.sql),
): Promise<void> {
  const url = `${env.publicOrigin}${REMOTE_ACCESS_PATH}`;
  for (const admin of await db.listNodeAdmins()) {
    const delivery: NotifyDeliverMessage | null =
      env.settings.current().notify.sink === "none"
        ? null
        : { kind: "notify_deliver", recipient: admin.alias, title: n.title, body: n.body, url };
    await db.insertNotification(
      {
        id: `${n.event}:${n.key}:${admin.alias}`,
        workspace_id: null,
        recipient_alias: admin.alias,
        event_type: n.event,
        resource_id: null,
        resource_title: n.title,
        resource_url: url,
        actor_alias: null,
        payload: { message: n.body },
      },
      delivery,
    );
  }
}
