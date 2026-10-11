import { createHash } from "node:crypto";
import type { NotifyDeliverMessage, NotifyMessage } from "@stuga/protocol/internal/jobs";
import type { DeliveryErrorCode } from "@stuga/protocol/notify/events";
import { recipientLanguage } from "@stuga/protocol/notify/render";
import type { NotifyConfig } from "../env.js";
import type { JobDeps, JobsEnv } from "./deps.js";
import { SinkAnsweredError, type NotificationPayload } from "./sinks.js";

const HOUR_MS = 3_600_000;

/** The longest delivery error a notification shows (packages/db's DELIVERY_ERROR_MAX). */
const ERROR_MAX = 300;

/** Which setup of a sink `cfg` is, as a hash that gives away none of its secrets. */
export function channelKey(cfg: NotifyConfig): string {
  return createHash("sha256")
    .update([cfg.sink, cfg.webhookUrl ?? "", cfg.smtpUrl ?? "", cfg.emailFrom ?? ""].join("\n"))
    .digest("hex")
    .slice(0, 16);
}

/**
 * The delivery a new notification queues through the node's channel, `cfg` as set up now; null
 * when there is none, and the notification is shown in Stuga only. Its row is stamped with the channel.
 */
export function sinkDelivery(
  cfg: NotifyConfig,
  m: { recipient: string; eventType: string; params: Record<string, unknown>; url: string; to?: string },
): NotifyDeliverMessage | null {
  return cfg.sink === "none" ? null : { kind: "notify_deliver", channel: cfg.sink, channelKey: channelKey(cfg), ...m };
}

/** What a delivery records when the channel it was queued for is no longer the node's. */
export const CHANNEL_CHANGED_ERROR: DeliveryErrorCode = "channel_changed";

/**
 * Why a delivery failed, as its notification keeps it (@stuga/protocol/notify/events
 * parseDeliveryError), for the reader's app to word: `sink_answered:<status>`, or `failed:` and what
 * the channel said, on one line, at most ERROR_MAX characters, and never with a URL, which for a
 * webhook is the credential and for SMTP may carry its password.
 */
export function deliveryErrorText(err: unknown): string {
  if (err instanceof SinkAnsweredError) return `sink_answered:${err.status}`;
  const raw = err instanceof Error ? err.message : String(err);
  const text = raw
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<address>")
    .replace(/\s+/g, " ")
    .trim();
  return text ? `failed:${text}`.slice(0, ERROR_MAX) : "not_sent";
}

/** A notification's payload for the recipient: written in their language, the person's choice else their browser's. */
export async function payloadFor(
  db: Pick<JobDeps["db"], "uiLanguage">,
  m: { recipient: string; eventType: string; params: Record<string, unknown>; url: string },
): Promise<NotificationPayload> {
  const language = recipientLanguage(await db.uiLanguage(m.recipient));
  return { recipient: m.recipient, eventType: m.eventType, params: m.params, language, url: m.url };
}

/** Store an in-app notification; a new one also queues its delivery to the configured sink. */
export async function handleNotify(env: JobsEnv, deps: JobDeps, msg: NotifyMessage): Promise<void> {
  const { recipient, eventType, docId, params, commentNum } = msg;
  // Bucketed by hour: a flurry of shares or comments within the hour is one notification and one
  // ping, whose link opens the first comment. Each mention is its own, and access requests are per
  // requester, since each is answered on its own.
  const about = commentNum === undefined || eventType !== "MENTIONED_IN_COMMENT" ? docId : `${docId}#${commentNum}`;
  const from = eventType === "REQUEST_ACCESS" ? `${msg.actor}:` : "";
  const id = `${eventType}:${about}:${recipient}:${from}${Math.floor(Date.now() / HOUR_MS)}`;
  const url = commentNum === undefined ? `${env.publicOrigin}/doc/${docId}` : `${env.publicOrigin}/doc/${docId}?comment=${commentNum}`;
  const delivery = sinkDelivery(env.settings.current().notify, { recipient, eventType, params, url });

  await deps.db.insertNotification(
    {
      id,
      workspace_id: msg.workspaceId,
      recipient_alias: recipient,
      event_type: eventType,
      resource_id: docId || null,
      // The document's own title, as data; what the notification says is written from its params.
      resource_title: params.doc,
      resource_url: url,
      actor_alias: msg.actor,
      payload: params,
    },
    delivery,
  );
}

/**
 * Deliver one stored notification to the sink, and record on its row how that went: delivered, or
 * why not. A failure throws, and the queue retries this delivery alone; one that trying again cannot
 * help (no address to send to) is recorded and not retried. It goes only through the channel it was
 * queued for: once that has changed, it is recorded as not sent, and goes nowhere else.
 */
export async function handleNotifyDeliver(env: JobsEnv, deps: JobDeps, msg: NotifyDeliverMessage): Promise<void> {
  // One settings snapshot, so the address lookup and the delivery agree on the sink.
  const notify = env.settings.current().notify;
  const record = (outcome: { delivered: true } | { error: string }) =>
    msg.notificationId ? deps.db.recordDelivery(msg.notificationId, outcome) : Promise.resolve();
  if (msg.channel !== notify.sink || (msg.channelKey !== undefined && msg.channelKey !== channelKey(notify))) {
    await record({ error: CHANNEL_CHANGED_ERROR });
    return;
  }
  const payload = await payloadFor(deps.db, msg);
  if (notify.sink === "email") payload.recipientEmail = msg.to ?? (await deps.db.userEmail(msg.recipient));
  let unsent: string | null;
  try {
    unsent = await deps.deliver(notify, payload);
  } catch (err) {
    await record({ error: deliveryErrorText(err) }).catch(() => {});
    throw err;
  }
  await record(unsent === null ? { delivered: true } : { error: unsent });
}
