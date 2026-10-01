/**
 * What the node tells people about their own sign-ins (docs/remote-access.md): a sign-in at the remote
 * address from a browser new to the account, a password changed or reset, everything revoked, an API
 * key made, and sign-ins paused for an hour after wrong passwords. Each is an in-app notification of
 * no workspace and, when an administrator set one up, a message through the node's sink, the way the
 * security update notice goes. Each opens the place where the person, or an administrator for them,
 * revokes everything.
 *
 * The person's own rows are `ACCOUNT_*`, which reach them whether or not they administer the node;
 * the administrators' copies are `MEMBER_*`, node rows. An administrator who is the person gets the
 * person's row only. A new device reaches each administrator at most once an hour per person.
 */
import { randomUUID } from "node:crypto";
import type { NotifyDeliverMessage } from "@stuga/protocol/internal/jobs";
import type { CredentialArrival } from "@stuga/db";
import { jobsDb, type JobsDb } from "../jobs/db.js";
import type { NodeEnv } from "../env.js";

/** The person's own rows start with packages/db's ACCOUNT_EVENT_PREFIX, which lets them read the rows. */
export const ACCOUNT_NEW_SIGN_IN = "ACCOUNT_NEW_SIGN_IN";
export const ACCOUNT_PASSWORD_CHANGED = "ACCOUNT_PASSWORD_CHANGED";
export const ACCOUNT_EVERYTHING_REVOKED = "ACCOUNT_EVERYTHING_REVOKED";
export const ACCOUNT_API_KEY_CREATED = "ACCOUNT_API_KEY_CREATED";
export const ACCOUNT_SIGN_INS_PAUSED = "ACCOUNT_SIGN_INS_PAUSED";
export const MEMBER_NEW_SIGN_IN = "MEMBER_NEW_SIGN_IN";
export const MEMBER_PASSWORD_CHANGED = "MEMBER_PASSWORD_CHANGED";
export const MEMBER_EVERYTHING_REVOKED = "MEMBER_EVERYTHING_REVOKED";

/** Where a person revokes everything for themselves: Profile, with the dialog open. */
export const OWN_REVOKE_PATH = "/settings/profile?revoke=1";
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
}

export interface SecurityAlertsDeps {
  db: Pick<JobsDb, "listNodeAdmins" | "insertNotification">;
  /** Whether an administrator set up a sink to deliver through. */
  sinkConfigured: () => boolean;
  /** Where the links in a delivered message point. */
  publicOrigin: string;
  /** Called when writing an alert fails: it is never the reason a request fails. */
  onError?: (err: unknown) => void;
}

/** The moment, as a delivered message states it. */
export function alertTime(d: Date): string {
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function createSecurityAlerts(deps: SecurityAlertsDeps): SecurityAlerts {
  async function send(input: { id: string; recipient: string; eventType: string; title: string; body: string; path: string }): Promise<void> {
    const url = `${deps.publicOrigin}${input.path}`;
    const delivery: NotifyDeliverMessage | null = deps.sinkConfigured()
      ? { kind: "notify_deliver", recipient: input.recipient, title: input.title, body: input.body, url }
      : null;
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

/** The node's alerts, through its database and its sink as set up now. */
export function alertsFor(env: Pick<NodeEnv, "sql" | "settings" | "publicOrigin">): SecurityAlerts {
  return createSecurityAlerts({
    db: jobsDb(env.sql),
    sinkConfigured: () => env.settings.current().notify.sink !== "none",
    publicOrigin: env.publicOrigin,
  });
}
