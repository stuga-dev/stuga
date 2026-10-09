/**
 * Where a notification goes besides the in-app tray: one sink, chosen in node settings, shaped per
 * channel, and written in the recipient's language.
 */
import type { DeliveryErrorCode } from "@stuga/protocol/notify/events";
import { renderNotification, renderOpenAction } from "@stuga/protocol/notify/render";
import type { NotifyConfig } from "../env.js";
import { sendMail as smtpSendMail, type MailMessage } from "./smtp.js";

export interface NotificationPayload {
  /** The recipient's alias. */
  recipient: string;
  /** The recipient's email, when the directory has one (the email sink needs it). */
  recipientEmail?: string | null;
  /** What it says (@stuga/protocol/notify/events), written when it is sent. */
  eventType: string;
  params: Record<string, unknown>;
  /** The recipient's language, which the message is written in. */
  language: string;
  url: string;
}

/** Why nothing was sent, when trying again would change nothing: a code the notification keeps. */
export type UnsentCode = Extract<DeliveryErrorCode, "email_not_set_up" | "no_email_address" | "no_webhook_url" | "no_sink">;

/** The same in English, for the settings page's test, which answers as the API does. */
export const UNSENT_ENGLISH: Record<UnsentCode, string> = {
  email_not_set_up: "email is not set up",
  no_email_address: "you have no email address in Stuga",
  no_webhook_url: "no webhook URL is set",
  no_sink: "no sink is set up",
};

/** A sink that answered with an error status, kept on the notification as `sink_answered:<status>`. */
export class SinkAnsweredError extends Error {
  constructor(readonly status: number) {
    super(`notification sink answered ${status}`);
  }
}

/** The title and body a notification reads in its recipient's language. */
export function notificationText(n: Pick<NotificationPayload, "eventType" | "params" | "language">): { title: string; body: string } {
  return renderNotification(n.eventType, n.params, n.language) ?? { title: n.eventType, body: "" };
}

export interface SinkIo {
  fetch: typeof fetch;
  sendMail: (smtpUrl: string, msg: MailMessage) => Promise<void>;
}

const defaultIo: SinkIo = { fetch: (...args) => fetch(...args), sendMail: smtpSendMail };

/**
 * Deliver one notification. Throws when the sink refused it or could not be reached, which is worth
 * trying again; returns why nothing was sent when trying again would change nothing (no address to
 * send to), and null when it was sent.
 */
export async function deliver(cfg: NotifyConfig, payload: NotificationPayload, io: SinkIo = defaultIo): Promise<UnsentCode | null> {
  const n = { ...payload, ...notificationText(payload) };
  const open = renderOpenAction(payload.language);
  switch (cfg.sink) {
    case "slack":
      return await postJson(io, cfg.webhookUrl, {
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: `*${forSlack(n.title)}*\n${forSlack(n.body)}` } },
          { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: open }, url: n.url }] },
        ],
      });
    case "discord":
      return await postJson(io, cfg.webhookUrl, {
        content: `**${forDiscord(n.title)}**\n${forDiscord(n.body)}\n${n.url}`,
        allowed_mentions: { parse: [] },
      });
    case "teams":
      return await postJson(io, cfg.webhookUrl, {
        "@type": "MessageCard",
        summary: n.title,
        text: `${forTeams(n.body)}\n\n[${forTeams(open)}](${n.url})`,
      });
    case "webhook":
      // The text for whoever reads it as it comes, and the event and its params for whatever acts on it.
      return await postJson(io, cfg.webhookUrl, {
        recipient: n.recipient,
        event_type: n.eventType,
        params: n.params,
        language: n.language,
        title: n.title,
        body: n.body,
        url: n.url,
      });
    case "email": {
      if (!cfg.smtpUrl || !cfg.emailFrom) return "email_not_set_up";
      if (!n.recipientEmail) return "no_email_address";
      await io.sendMail(cfg.smtpUrl, {
        from: cfg.emailFrom,
        to: n.recipientEmail,
        subject: n.title,
        text: `${n.body}\n\n${n.url}\n`,
      });
      return null;
    }
    default:
      return "no_sink";
  }
}

async function postJson(io: SinkIo, url: string | undefined, body: unknown): Promise<UnsentCode | null> {
  if (!url) return "no_webhook_url";
  const res = await io.fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new SinkAnsweredError(res.status);
  return null;
}

/*
 * A notification's text quotes names other people chose (a document's title, an app's name): as
 * text, never as the channel's markup, so none can pass for a link or a mention.
 */

/** Slack's mrkdwn: `&`, `<` and `>` are its control characters, escaped as Slack documents. */
export function forSlack(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Discord's markdown, escaped with a backslash; mentions are switched off with `allowed_mentions`. */
export function forDiscord(text: string): string {
  return text.replace(/[\\*_~`|[\]<>]/g, (c) => `\\${c}`);
}

/** Teams' markdown: a link needs `](` together, so they are kept apart. */
export function forTeams(text: string): string {
  return text.replace(/\]\(/g, "] (");
}
