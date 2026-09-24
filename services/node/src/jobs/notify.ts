import type { NotifyDeliverMessage, NotifyMessage } from "@stuga/protocol/internal/jobs";
import type { JobDeps, JobsEnv } from "./deps.js";
import type { NotificationPayload } from "./sinks.js";

const HOUR_MS = 3_600_000;

/** Store an in-app notification; a new one also queues its delivery to the configured sink. */
export async function handleNotify(env: JobsEnv, deps: JobDeps, msg: NotifyMessage): Promise<void> {
  const { recipient, eventType, docId, title, body } = msg;
  // Bucketed by hour: a repeated share or comment within the hour is one notification and one ping.
  const id = `${eventType}:${docId}:${recipient}:${Math.floor(Date.now() / HOUR_MS)}`;
  const url = `${env.publicOrigin}/doc/${docId}`;
  const delivery: NotifyDeliverMessage | null =
    env.settings.current().notify.sink === "none" ? null : { kind: "notify_deliver", recipient, title, body, url };

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

/** Deliver one stored notification to the sink; a failure throws, and the queue retries this delivery alone. */
export async function handleNotifyDeliver(env: JobsEnv, deps: JobDeps, msg: NotifyDeliverMessage): Promise<void> {
  const payload: NotificationPayload = { recipient: msg.recipient, title: msg.title, body: msg.body, url: msg.url };
  // One settings snapshot, so the address lookup and the delivery agree on the sink.
  const notify = env.settings.current().notify;
  if (notify.sink === "email") payload.recipientEmail = await deps.db.userEmail(msg.recipient);
  await deps.deliver(notify, payload);
}
