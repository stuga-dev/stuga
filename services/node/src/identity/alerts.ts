/**
 * What the node tells people about their own sign-ins (docs/remote-access.md): a sign-in at the remote
 * address from a browser new to the account, a password changed or reset, everything revoked, an API
 * key made, an app connected at the remote address, a passkey added or removed, an email changed,
 * sign-ins paused for an hour after wrong passwords, and the node's notification channel changed.
 * Each is an in-app notification of no workspace and, when an administrator set one up, a message
 * through the node's sink, the way the security update notice goes; each row says whether that
 * message went (packages/db notifications.ts). Each opens the place where the person, or an
 * administrator for them, revokes everything. Every one is its own row: none is merged with another
 * of the hour, but a new device reaches each administrator at most once an hour per person.
 *
 * The person's own rows are `ACCOUNT_*`, which reach them whether or not they administer the node;
 * the administrators' copies are `MEMBER_*`, node rows. An administrator who is the person gets the
 * person's row only. A new device reaches each administrator at most once an hour per person.
 */
import { randomUUID } from "node:crypto";
import { failUnfinishedDeliveries, type CredentialArrival, type Sql } from "@stuga/db";
import { jobsDb, type JobsDb } from "../jobs/db.js";
import { deliveryErrorText, sinkDelivery } from "../jobs/notify.js";
import { deliver, type NotificationPayload } from "../jobs/sinks.js";
import type { NodeEnv, NotifyConfig } from "../env.js";

/** The person's own rows start with packages/db's ACCOUNT_EVENT_PREFIX, which lets them read the rows. */
export const ACCOUNT_NEW_SIGN_IN = "ACCOUNT_NEW_SIGN_IN";
export const ACCOUNT_PASSWORD_CHANGED = "ACCOUNT_PASSWORD_CHANGED";
export const ACCOUNT_EVERYTHING_REVOKED = "ACCOUNT_EVERYTHING_REVOKED";
export const ACCOUNT_API_KEY_CREATED = "ACCOUNT_API_KEY_CREATED";
export const ACCOUNT_SIGN_INS_PAUSED = "ACCOUNT_SIGN_INS_PAUSED";
export const ACCOUNT_PASSKEY_ADDED = "ACCOUNT_PASSKEY_ADDED";
export const ACCOUNT_PASSKEY_REMOVED = "ACCOUNT_PASSKEY_REMOVED";
export const ACCOUNT_APP_CONNECTED = "ACCOUNT_APP_CONNECTED";
export const ACCOUNT_EMAIL_CHANGED = "ACCOUNT_EMAIL_CHANGED";
export const MEMBER_NEW_SIGN_IN = "MEMBER_NEW_SIGN_IN";
export const MEMBER_PASSWORD_CHANGED = "MEMBER_PASSWORD_CHANGED";
export const MEMBER_EVERYTHING_REVOKED = "MEMBER_EVERYTHING_REVOKED";
export const MEMBER_EMAIL_CHANGED = "MEMBER_EMAIL_CHANGED";
/** A node row: every administrator reads it. */
export const NODE_NOTIFY_CHANNEL_CHANGED = "NODE_NOTIFY_CHANNEL_CHANGED";

/** Where a person revokes everything for themselves: Profile, with the dialog open. */
export const OWN_REVOKE_PATH = "/settings/profile?revoke=1";
/** Where an administrator sees the node's notification channel. */
export const NOTIFY_SETTINGS_PATH = "/settings/node/notifications";
/** Where an administrator does it for someone: Account recovery, with that person picked. */
export const memberRevokePath = (username: string): string => `/settings/node/access?revoke=${encodeURIComponent(username)}`;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** The person an alert is about. */
export interface AlertSubject {
  alias: string;
  username: string;
  /** Their display name, else their username. */
  name: string;
}

/** The browser and the moment something happened. */
export interface AlertOccasion {
  /** From the User-Agent (./devices.ts). */
  device: string;
  at: Date;
}

export interface SecurityAlerts {
  /** A sign-in at the remote address from a browser new to the account: the person and every administrator. */
  newDevice(input: AlertSubject & AlertOccasion & { remoteHost: string; from: string; deviceHash: string }): Promise<void>;
  /** The person; every administrator too when it happened at the remote address (`remoteHost`). */
  passwordChanged(input: AlertSubject & AlertOccasion & { how: "changed" | "reset"; remoteHost: string | null }): Promise<void>;
  /** The person and every administrator; `by` is the administrator who did it, absent when the person did. */
  revokedEverything(input: AlertSubject & AlertOccasion & { by?: { alias: string; name: string } }): Promise<void>;
  /** The person. */
  apiKeyCreated(input: { alias: string; keyId: string; keyName: string }): Promise<void>;
  /** The person, at most once a day per listener: their account reached the hour-long pause. */
  signInsPaused(input: { alias: string; username: string; arrival: CredentialArrival; remoteHost: string | null }): Promise<void>;
  /** The person: a passkey was added to their account at the remote address `remoteHost`, from `from`. */
  passkeyAdded(input: AlertOccasion & { alias: string; name: string; remoteHost: string; from: string }): Promise<void>;
  /** The person: one of their passkeys was removed. */
  passkeyRemoved(input: { alias: string; name: string }): Promise<void>;
  /**
   * The person: an app was allowed to act for them at the remote address `remoteHost`. `app` is the
   * name it gave itself; `appHost` is where it is known to be: its verified host, else where it
   * takes the grant back to.
   */
  appConnected(input: { alias: string; app: string; appHost: string; grantId: string; remoteHost: string }): Promise<void>;
  /**
   * The person, whose message by email goes to the address they had (`from`), and every administrator
   * but them. `to` is null when the address was removed.
   */
  emailChanged(input: AlertSubject & AlertOccasion & { from: string | null; to: string | null }): Promise<void>;
  /**
   * Every administrator, `by` included: the node's channel was changed from `before` to `after`. It
   * goes out through the channel it had, `before`, which the new one cannot quietly replace.
   */
  channelChanged(input: AlertOccasion & { by: { alias: string; name: string }; before: NotifyConfig; after: NotifyConfig }): Promise<void>;
}

export interface SecurityAlertsDeps {
  db: Pick<JobsDb, "listNodeAdmins" | "insertNotification" | "recordDelivery" | "userEmail">;
  /** The channel an administrator set up, sink "none" for none. */
  channel: () => NotifyConfig;
  /** Where the links in a delivered message point. */
  publicOrigin: string;
  /** Delivers through a channel other than the one in force: the old one, when it changes. */
  deliverThrough?: (cfg: NotifyConfig, n: NotificationPayload) => Promise<string | null>;
  /** Called when writing an alert fails: it is never the reason a request fails. */
  onError?: (err: unknown) => void;
}

/** A channel as a person names it, with which webhook or which sender, never the secret itself. */
export function channelText(cfg: NotifyConfig): string {
  const named: Record<string, string> = { slack: "Slack", teams: "Teams", discord: "Discord", webhook: "a webhook", email: "email" };
  const name = named[cfg.sink];
  if (!name) return "Stuga only";
  if (cfg.sink === "email") return cfg.emailFrom ? `email from ${cfg.emailFrom}` : "email";
  if (!cfg.webhookUrl) return name;
  try {
    const url = new URL(cfg.webhookUrl);
    return `${name} (${url.host})`;
  } catch {
    return name;
  }
}

/**
 * The channel a change moved to, as the alert names it: told apart from the one it had when only the
 * webhook or the mail server, which are secrets, changed.
 */
export function channelChangedTo(before: NotifyConfig, after: NotifyConfig): string {
  const text = channelText(after);
  if (sameChannel(before, after) || text !== channelText(before)) return text;
  if (after.sink === "email") return `${text}, through another mail server`;
  const named: Record<string, string> = { slack: "Slack", teams: "Teams", discord: "Discord", webhook: "" };
  const host = after.webhookUrl ? safeHost(after.webhookUrl) : null;
  const kind = named[after.sink] ? `${named[after.sink]} webhook` : "webhook";
  return host ? `another ${kind} (${host})` : `another ${kind}`;
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/**
 * A name someone else chose (an app's, a browser's), as an alert quotes it: one line, no control
 * characters, at most 100 characters.
 */
export function quoted(name: string): string {
  // eslint-disable-next-line no-control-regex
  const text = name.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim();
  return (text || "unnamed").slice(0, 100);
}

/** Whether two channels send to the same place: the same sink, webhook, server and sender. */
export function sameChannel(a: NotifyConfig, b: NotifyConfig): boolean {
  return a.sink === b.sink && (a.webhookUrl ?? "") === (b.webhookUrl ?? "") && (a.smtpUrl ?? "") === (b.smtpUrl ?? "") && (a.emailFrom ?? "") === (b.emailFrom ?? "");
}

/** The moment, as a delivered message states it. */
export function alertTime(d: Date): string {
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function createSecurityAlerts(deps: SecurityAlertsDeps): SecurityAlerts {
  async function send(input: {
    id: string;
    recipient: string;
    eventType: string;
    title: string;
    body: string;
    path: string;
    /** An address to email in place of the recipient's own; null for none, when only that one would do. */
    to?: string | null;
    /** Sent only by email: on a shared channel it would be read by others. */
    emailOnly?: boolean;
  }): Promise<void> {
    const url = `${deps.publicOrigin}${input.path}`;
    const channel = deps.channel();
    const { sink } = channel;
    const unsendable = (input.to === null && sink === "email") || (input.emailOnly === true && sink !== "email");
    const delivery = sinkDelivery(unsendable ? { sink: "none" } : channel, {
      recipient: input.recipient,
      title: input.title,
      body: input.body,
      url,
      ...(input.to ? { to: input.to } : {}),
    });
    await deps.db.insertNotification(
      {
        id: input.id,
        workspace_id: null,
        recipient_alias: input.recipient,
        event_type: input.eventType,
        resource_id: null,
        resource_title: input.title,
        resource_url: url,
        actor_alias: null,
        payload: { message: input.body },
      },
      delivery,
    );
  }

  /** One attempt through `cfg` for notification `id`, its outcome recorded on the row; never retried. */
  async function sendThrough(cfg: NotifyConfig, id: string, m: Omit<NotificationPayload, "recipientEmail">): Promise<void> {
    const payload: NotificationPayload = { ...m };
    try {
      if (cfg.sink === "email") payload.recipientEmail = await deps.db.userEmail(m.recipient);
      const unsent = await (deps.deliverThrough ?? deliver)(cfg, payload);
      await deps.db.recordDelivery(id, unsent === null ? { delivered: true } : { error: deliveryErrorText(unsent) });
    } catch (err) {
      await deps.db.recordDelivery(id, { error: deliveryErrorText(err) }).catch(() => {});
    }
  }

  /** Every administrator but the person themselves. */
  async function admins(except: string): Promise<string[]> {
    return (await deps.db.listNodeAdmins()).map((a) => a.alias).filter((alias) => alias !== except);
  }

  /** Never throws: an alert that cannot be written is logged, and what caused it goes on. */
  const safely =
    <A extends unknown[]>(fn: (...args: A) => Promise<void>) =>
    async (...args: A): Promise<void> => {
      try {
        await fn(...args);
      } catch (err) {
        (deps.onError ?? ((e) => console.warn("[auth] could not write a security alert", e)))(err);
      }
    };

  return {
    newDevice: safely(async (i) => {
      const where = `${i.device} · ${alertTime(i.at)} · from ${i.from}`;
      await send({
        id: `${ACCOUNT_NEW_SIGN_IN}:${i.alias}:${i.deviceHash.slice(0, 16)}`,
        recipient: i.alias,
        eventType: ACCOUNT_NEW_SIGN_IN,
        title: `New sign-in at ${i.remoteHost}: ${i.device}`,
        body: `New sign-in at ${i.remoteHost}: ${where}. Not you? Revoke everything.`,
        path: OWN_REVOKE_PATH,
      });
      const hour = Math.floor(i.at.getTime() / HOUR_MS);
      for (const admin of await admins(i.alias)) {
        await send({
          id: `${MEMBER_NEW_SIGN_IN}:${i.alias}:${hour}:${admin}`,
          recipient: admin,
          eventType: MEMBER_NEW_SIGN_IN,
          title: `${i.name} signed in at ${i.remoteHost}: ${i.device}`,
          body: `${i.name} signed in at ${i.remoteHost}: ${where}.`,
          path: memberRevokePath(i.username),
        });
      }
    }),

    passwordChanged: safely(async (i) => {
      const verb = i.how === "reset" ? "reset" : "changed";
      const key = randomUUID();
      // A new password ends every other sign-in, so whoever it was not can no longer sign in to act:
      // an administrator acts for them, and the only administrator gets back in on the node's machine.
      const all = (await deps.db.listNodeAdmins()).map((a) => a.alias);
      const others = all.filter((alias) => alias !== i.alias);
      const recourse =
        others.length > 0
          ? "Ask an administrator to revoke everything for you."
          : "Run reset-password on the node's machine to get back in, then revoke everything.";
      await send({
        id: `${ACCOUNT_PASSWORD_CHANGED}:${i.alias}:${key}`,
        recipient: i.alias,
        eventType: ACCOUNT_PASSWORD_CHANGED,
        title: `Your password was ${verb}`,
        body: `Your password was ${verb} on ${i.device} · ${alertTime(i.at)}. Not you? ${recourse}`,
        path: OWN_REVOKE_PATH,
      });
      if (!i.remoteHost) return;
      for (const admin of others) {
        await send({
          id: `${MEMBER_PASSWORD_CHANGED}:${i.alias}:${key}:${admin}`,
          recipient: admin,
          eventType: MEMBER_PASSWORD_CHANGED,
          title: `${i.name}'s password was ${verb} at ${i.remoteHost}`,
          body: `${i.name}'s password was ${verb} at ${i.remoteHost} on ${i.device} · ${alertTime(i.at)}.`,
          path: memberRevokePath(i.username),
        });
      }
    }),

    revokedEverything: safely(async (i) => {
      const key = randomUUID();
      await send({
        id: `${ACCOUNT_EVERYTHING_REVOKED}:${i.alias}:${key}`,
        recipient: i.alias,
        eventType: ACCOUNT_EVERYTHING_REVOKED,
        title: i.by ? `${i.by.name} revoked everything for you` : "Everything was revoked",
        body: i.by
          ? `${i.by.name} revoked everything for you · ${alertTime(i.at)}.`
          : `Everything was revoked on ${i.device} · ${alertTime(i.at)}.`,
        path: OWN_REVOKE_PATH,
      });
      const what = i.by ? `${i.by.name} revoked everything for ${i.name}` : `${i.name} revoked everything`;
      for (const admin of await admins(i.alias)) {
        if (admin === i.by?.alias) continue;
        await send({
          id: `${MEMBER_EVERYTHING_REVOKED}:${i.alias}:${key}:${admin}`,
          recipient: admin,
          eventType: MEMBER_EVERYTHING_REVOKED,
          title: what,
          body: `${what} · ${alertTime(i.at)}.`,
          path: memberRevokePath(i.username),
        });
      }
    }),

    apiKeyCreated: safely(async (i) => {
      await send({
        id: `${ACCOUNT_API_KEY_CREATED}:${i.keyId}`,
        recipient: i.alias,
        eventType: ACCOUNT_API_KEY_CREATED,
        title: `API key created: ${i.keyName}`,
        body: `API key created: ${i.keyName}. Not you? Revoke everything.`,
        path: OWN_REVOKE_PATH,
      });
    }),

    passkeyAdded: safely(async (i) => {
      await send({
        id: `${ACCOUNT_PASSKEY_ADDED}:${i.alias}:${randomUUID()}`,
        recipient: i.alias,
        eventType: ACCOUNT_PASSKEY_ADDED,
        title: `Passkey added at ${i.remoteHost}: ${quoted(i.name)}`,
        // The name follows what the adding browser says it is: where and when it was added are the node's.
        body: `Passkey added at ${i.remoteHost}: ${quoted(i.name)} · ${i.device} · ${alertTime(i.at)} · from ${i.from}. Not you? Revoke everything.`,
        path: OWN_REVOKE_PATH,
      });
    }),

    passkeyRemoved: safely(async (i) => {
      await send({
        id: `${ACCOUNT_PASSKEY_REMOVED}:${i.alias}:${randomUUID()}`,
        recipient: i.alias,
        eventType: ACCOUNT_PASSKEY_REMOVED,
        title: `Passkey removed: ${i.name}`,
        body: `Passkey removed: ${i.name}. Not you? Revoke everything.`,
        path: OWN_REVOKE_PATH,
      });
    }),

    appConnected: safely(async (i) => {
      await send({
        id: `${ACCOUNT_APP_CONNECTED}:${i.grantId}:${randomUUID()}`,
        recipient: i.alias,
        eventType: ACCOUNT_APP_CONNECTED,
        // The name is the app's own to choose: where it is known to be is the node's.
        title: `App connected at ${i.remoteHost}: ${quoted(i.app)} (${i.appHost})`,
        body: `App connected at ${i.remoteHost}: ${quoted(i.app)} (${i.appHost}). Not you? Revoke everything.`,
        path: OWN_REVOKE_PATH,
      });
    }),

    emailChanged: safely(async (i) => {
      const key = randomUUID();
      const when = `${i.device} · ${alertTime(i.at)}`;
      const what = i.to ? `changed to ${i.to}` : "removed";
      await send({
        id: `${ACCOUNT_EMAIL_CHANGED}:${i.alias}:${key}`,
        recipient: i.alias,
        eventType: ACCOUNT_EMAIL_CHANGED,
        title: `Your email was ${what}`,
        body: `Your email was ${what} on ${when}. Not you? Revoke everything.`,
        path: OWN_REVOKE_PATH,
        // By email only, to the address it was, or to none: whoever changed it is not who should hear
        // of it, and a shared channel is no place for someone's address.
        to: i.from,
        emailOnly: true,
      });
      for (const admin of await admins(i.alias)) {
        await send({
          id: `${MEMBER_EMAIL_CHANGED}:${i.alias}:${key}:${admin}`,
          recipient: admin,
          eventType: MEMBER_EMAIL_CHANGED,
          title: `${i.name}'s email was ${i.to ? "changed" : "removed"}`,
          body: `${i.name}'s email was ${i.to ? "changed" : "removed"} on ${when}.`,
          path: memberRevokePath(i.username),
        });
      }
    }),

    channelChanged: safely(async (i) => {
      const key = randomUUID();
      const title = `${i.by.name} changed where Stuga sends notifications`;
      const body = `${i.by.name} changed where Stuga sends notifications: ${channelText(i.before)} to ${channelChangedTo(i.before, i.after)} · ${i.device} · ${alertTime(i.at)}.`;
      const url = `${deps.publicOrigin}${NOTIFY_SETTINGS_PATH}`;
      const old = i.before.sink === "none" ? null : i.before;
      for (const admin of (await deps.db.listNodeAdmins()).map((a) => a.alias)) {
        const id = `${NODE_NOTIFY_CHANNEL_CHANGED}:${key}:${admin}`;
        // Written for the channel it had, and sent through it now: nothing queued later would know it.
        const isNew = await deps.db.insertNotification(
          {
            id,
            workspace_id: null,
            recipient_alias: admin,
            event_type: NODE_NOTIFY_CHANNEL_CHANGED,
            resource_id: null,
            resource_title: title,
            resource_url: url,
            actor_alias: i.by.alias,
            payload: { message: body },
            delivery_channel: old?.sink ?? "none",
          },
          null,
        );
        if (isNew && old) void sendThrough(old, id, { recipient: admin, title, body, url });
      }
    }),

    signInsPaused: safely(async (i) => {
      const where = i.remoteHost ? ` at ${i.remoteHost}` : " on this node's network";
      await send({
        id: `${ACCOUNT_SIGN_INS_PAUSED}:${i.alias}:${i.arrival}:${Math.floor(Date.now() / DAY_MS)}`,
        recipient: i.alias,
        eventType: ACCOUNT_SIGN_INS_PAUSED,
        title: `Many wrong passwords for @${i.username}${where}`,
        body: `Many wrong passwords for @${i.username}${where}. Sign-ins are paused for an hour at a time. A browser you signed in with before still signs you in.`,
        path: OWN_REVOKE_PATH,
      });
    }),
  };
}

/**
 * At start-up: a channel-change notice is sent once, with no job behind it, so one a restart cut
 * short is marked not sent rather than left "Sending by …".
 */
export async function settleChannelNotices(sql: Sql): Promise<number> {
  return failUnfinishedDeliveries(sql, NODE_NOTIFY_CHANNEL_CHANGED, "the node restarted before it was sent");
}

/** The node's alerts, through its database and its sink as set up now. */
export function alertsFor(env: Pick<NodeEnv, "sql" | "settings" | "publicOrigin">): SecurityAlerts {
  return createSecurityAlerts({
    db: jobsDb(env.sql),
    channel: () => env.settings.current().notify,
    publicOrigin: env.publicOrigin,
  });
}
