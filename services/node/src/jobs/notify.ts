import { createHash } from "node:crypto";
import type { NotifyApproversMessage, NotifyDeliverMessage, NotifyMessage } from "@stuga/protocol/internal/jobs";
import type { DeliveryErrorCode } from "@stuga/protocol/notify/events";
import { reviewCardPath } from "@stuga/protocol/domain/runs";
import { changeCardPath } from "@stuga/protocol/domain/changes";
import type { WikiChangeRow } from "@stuga/db";
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

/**
 * What a notification is about, which its hour's bucket is keyed on: a flurry of shares or comments
 * on a document within the hour is one notification and one ping, whose link opens the first
 * comment. Each mention is its own, replies are one per thread, and an AI run's notice one per run.
 */
function aboutOf(msg: NotifyMessage): string {
  if (msg.eventType === "MENTIONED_IN_COMMENT" && msg.commentNum !== undefined) return `${msg.docId}#${msg.commentNum}`;
  // A run's own notice, whose link opens that run's card.
  if (msg.runId !== undefined) return `${msg.docId}#r${msg.runId}`;
  if (msg.eventType === "COMMENT_REPLY" && msg.thread !== undefined) return `${msg.docId}#t${msg.thread}`;
  return msg.docId;
}

/** The notice a run's own becomes when the run belongs to a change: its person hears of the change once. */
const CHANGE_NOTICE: Partial<Record<string, "CHANGE_PROPOSED" | "CHANGE_APPLIED">> = {
  AGENT_EDITS_PROPOSED: "CHANGE_PROPOSED",
  DATABASE_AGENT_PROPOSED: "CHANGE_PROPOSED",
  AGENT_EDITS_APPLIED: "CHANGE_APPLIED",
};

/** A run's change, when the message names one of this workspace's. */
async function changeOf(deps: JobDeps, changeId: string | undefined, workspaceId: string | null): Promise<WikiChangeRow | null> {
  if (!changeId) return null;
  const change = await deps.db.getChange(changeId);
  return change && change.workspace_id === workspaceId ? change : null;
}

/**
 * The notice to whoever asked about a run of a change: one per change, however many pages and runs
 * it grows to, opening the change's card. Its title is the change's, never a page's.
 */
async function notifyChange(env: JobsEnv, deps: JobDeps, msg: NotifyMessage, change: WikiChangeRow, eventType: "CHANGE_PROPOSED" | "CHANGE_APPLIED"): Promise<void> {
  const params = { agent: String((msg.params as { agent?: unknown }).agent ?? change.agent), change: change.title };
  const url = `${env.publicOrigin}${changeCardPath(change.change_id, msg.workspaceId)}`;
  const delivery = sinkDelivery(env.settings.current().notify, { recipient: msg.recipient, eventType, params, url });
  await deps.db.insertNotification(
    {
      id: `${eventType}:change:${change.change_id}:${msg.recipient}`,
      workspace_id: msg.workspaceId,
      recipient_alias: msg.recipient,
      event_type: eventType,
      resource_id: msg.docId || null,
      resource_title: change.title,
      resource_url: url,
      actor_alias: msg.actor,
      payload: params,
    },
    delivery,
  );
}

/** Store an in-app notification; a new one also queues its delivery to the configured sink. */
export async function handleNotify(env: JobsEnv, deps: JobDeps, msg: NotifyMessage): Promise<void> {
  const asChange = CHANGE_NOTICE[msg.eventType];
  if (asChange) {
    const change = await changeOf(deps, msg.changeId, msg.workspaceId);
    if (change) return notifyChange(env, deps, msg, change, asChange);
  }
  const { recipient, eventType, docId, params, commentNum } = msg;
  const about = aboutOf(msg);
  // Access requests are per requester, since each is answered on its own.
  const from = eventType === "REQUEST_ACCESS" ? `${msg.actor}:` : "";
  const id = `${eventType}:${about}:${recipient}:${from}${Math.floor(Date.now() / HOUR_MS)}`;
  const url = msg.folder
    ? `${env.publicOrigin}/?folder=${encodeURIComponent(docId)}`
    : msg.runId
      ? `${env.publicOrigin}${reviewCardPath(docId, msg.runId, msg.workspaceId)}`
      : commentNum === undefined
        ? `${env.publicOrigin}/doc/${docId}`
        : `${env.publicOrigin}/doc/${docId}?comment=${commentNum}`;
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

/** Sinks that post to one shared channel: a notice each for N approvers would be N posts there. */
const CHAT_SINKS: ReadonlySet<string> = new Set(["slack", "teams", "discord"]);

/**
 * Tell each person who may approve a run at `colleague` that it waits for them (APPROVAL_WAITING): who
 * can write the item now, holding its approver groups, other than whoever asked the AI, or the owner or
 * an admin standing in when nobody else can. After a folder's approver group changed, only those who
 * could not approve it before. When nobody may, the item's owner and the workspace's admins who can
 * read it hear that it waits for an approver (APPROVER_NEEDED), the person who asked left out.
 *
 * In the app always, and through the node's channel: by email or webhook to each; to a chat channel
 * once, from the notice to the person who asked when they were told, else from the first of these.
 * One notice per person, run and hour, so a second run on the same item is told too.
 */
export async function handleNotifyApprovers(env: JobsEnv, deps: JobDeps, msg: NotifyApproversMessage): Promise<void> {
  const doc = await deps.db.getDoc(msg.docId);
  if (!doc || doc.trashed || doc.workspace_id !== msg.workspaceId) return;
  const current = await deps.db.docApproverGroup(doc);
  const groupsWith = (group: string | null) => [...new Set([msg.approverGroup, group].filter((g): g is string => !!g))];
  const { aliases, cause } = await deps.db.colleagueApprovers(doc, msg.reviewer, groupsWith(current));
  const before = msg.groupBefore !== undefined ? new Set((await deps.db.colleagueApprovers(doc, msg.reviewer, groupsWith(msg.groupBefore))).aliases) : null;
  const author = (await deps.db.displayNameOf(msg.reviewer)) || msg.reviewer;
  const base = { agent: msg.agent, author, doc: msg.doc || doc.title, count: msg.count };
  // A run of a change: each approver hears of the change once, and its card opens.
  const change = await changeOf(deps, msg.changeId, msg.workspaceId);
  // The run's review card, where an approver decides it on any screen.
  const url = change
    ? `${env.publicOrigin}${changeCardPath(change.change_id, msg.workspaceId)}`
    : `${env.publicOrigin}${reviewCardPath(msg.docId, msg.runId, msg.workspaceId)}`;
  const cfg = env.settings.current().notify;
  const hour = Math.floor(Date.now() / HOUR_MS);
  const chat = CHAT_SINKS.has(cfg.sink);
  let channelPosted = msg.askerTold;
  const send = async (recipient: string, eventType: "APPROVAL_WAITING" | "APPROVER_NEEDED", params: Record<string, unknown>) => {
    const delivery = chat && channelPosted ? null : sinkDelivery(cfg, { recipient, eventType, params, url });
    if (chat && delivery) channelPosted = true;
    await deps.db.insertNotification(
      {
        id: `${eventType}:${msg.docId}:${msg.runId}:${recipient}:${hour}`,
        workspace_id: msg.workspaceId,
        recipient_alias: recipient,
        event_type: eventType,
        resource_id: msg.docId,
        resource_title: base.doc,
        resource_url: url,
        actor_alias: msg.actor,
        payload: params,
      },
      delivery,
    );
  };
  if (aliases.length === 0) {
    // Whoever can open it up to an approver: the item's owner and the admins who can read it.
    for (const recipient of await deps.db.managersWhoCanRead(doc, msg.reviewer)) {
      await send(recipient, "APPROVER_NEEDED", { ...base, cause: cause ?? "nobody" });
    }
    return;
  }
  for (const recipient of aliases) {
    if (before?.has(recipient)) continue;
    if (!change) {
      await send(recipient, "APPROVAL_WAITING", base);
      continue;
    }
    const params = { agent: msg.agent, author, change: change.title };
    const delivery = chat && channelPosted ? null : sinkDelivery(cfg, { recipient, eventType: "CHANGE_APPROVAL_WAITING", params, url });
    if (chat && delivery) channelPosted = true;
    await deps.db.insertNotification(
      {
        id: `CHANGE_APPROVAL_WAITING:change:${change.change_id}:${recipient}`,
        workspace_id: msg.workspaceId,
        recipient_alias: recipient,
        event_type: "CHANGE_APPROVAL_WAITING",
        resource_id: msg.docId,
        resource_title: change.title,
        resource_url: url,
        actor_alias: msg.actor,
        payload: params,
      },
      delivery,
    );
  }
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
