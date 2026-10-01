import { createHash } from "node:crypto";
import type { NotifyDeliverMessage, NotifyMessage } from "@stuga/protocol/internal/jobs";
import type { NotifyConfig } from "../env.js";
import type { JobDeps, JobsEnv } from "./deps.js";
import type { NotificationPayload } from "./sinks.js";

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
  m: { recipient: string; title: string; body: string; url: string; to?: string },
): NotifyDeliverMessage | null {
  return cfg.sink === "none" ? null : { kind: "notify_deliver", channel: cfg.sink, channelKey: channelKey(cfg), ...m };
}

/** What a delivery records when the channel it was queued for is no longer the node's. */
export const CHANNEL_CHANGED_ERROR = "the notification channel changed before it was sent";

/**
 * Why a delivery failed, as its notification shows it: one line, at most ERROR_MAX characters, and
 * never a URL, which for a webhook is the credential and for SMTP may carry its password.
 */
export function deliveryErrorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const text = raw
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "the configured address")
    .replace(/\s+/g, " ")
    .trim();
  return (text || "it could not be sent").slice(0, ERROR_MAX);
}

/** Store an in-app notification; a new one also queues its delivery to the configured sink. */
export async function handleNotify(env: JobsEnv, deps: JobDeps, msg: NotifyMessage): Promise<void> {
  const { recipient, eventType, docId, title, body } = msg;
  // Bucketed by hour: a repeated share or comment within the hour is one notification and one ping.
  const id = `${eventType}:${docId}:${recipient}:${Math.floor(Date.now() / HOUR_MS)}`;
  const url = `${env.publicOrigin}/doc/${docId}`;
  const delivery = sinkDelivery(env.settings.current().notify, { recipient, title, body, url });

  await deps.db.insertNotification(
    {
      id,
      workspace_id: msg.workspaceId,
      recipient_alias: recipient,
      event_type: eventType,
      resource_id: docId || null,
      resource_title: title,
      resource_url: url,
      actor_alias: msg.actor,
      payload: msg,
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
  const payload: NotificationPayload = { recipient: msg.recipient, title: msg.title, body: msg.body, url: msg.url };
  // One settings snapshot, so the address lookup and the delivery agree on the sink.
  const notify = env.settings.current().notify;
  const record = (outcome: { delivered: true } | { error: string }) =>
    msg.notificationId ? deps.db.recordDelivery(msg.notificationId, outcome) : Promise.resolve();
  if (msg.channel !== notify.sink || (msg.channelKey !== undefined && msg.channelKey !== channelKey(notify))) {
    await record({ error: CHANNEL_CHANGED_ERROR });
    return;
  }
  if (notify.sink === "email") payload.recipientEmail = msg.to ?? (await deps.db.userEmail(msg.recipient));
  let unsent: string | null;
  try {
    unsent = await deps.deliver(notify, payload);
  } catch (err) {
    await record({ error: deliveryErrorText(err) }).catch(() => {});
    throw err;
  }
  await record(unsent === null ? { delivered: true } : { error: deliveryErrorText(unsent) });
}
