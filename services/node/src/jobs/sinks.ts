/** Where a notification goes besides the in-app tray: one sink, chosen in node settings, shaped per channel. */
import type { NotifyConfig } from "../env.js";
import { sendMail as smtpSendMail, type MailMessage } from "./smtp.js";

export interface NotificationPayload {
  /** The recipient's alias. */
  recipient: string;
  /** The recipient's email, when the directory has one (the email sink needs it). */
  recipientEmail?: string | null;
  title: string;
  body: string;
  url: string;
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
export async function deliver(cfg: NotifyConfig, n: NotificationPayload, io: SinkIo = defaultIo): Promise<string | null> {
  switch (cfg.sink) {
    case "slack":
      return await postJson(io, cfg.webhookUrl, {
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: `*${forSlack(n.title)}*\n${forSlack(n.body)}` } },
          { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Open" }, url: n.url }] },
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
        text: `${forTeams(n.body)}\n\n[Open](${n.url})`,
      });
    case "webhook":
      return await postJson(io, cfg.webhookUrl, { recipient: n.recipient, title: n.title, body: n.body, url: n.url });
    case "email": {
      if (!cfg.smtpUrl || !cfg.emailFrom) return "email is not set up";
      if (!n.recipientEmail) return "you have no email address in Stuga";
      await io.sendMail(cfg.smtpUrl, {
        from: cfg.emailFrom,
        to: n.recipientEmail,
        subject: n.title,
        text: `${n.body}\n\n${n.url}\n`,
      });
      return null;
    }
    default:
      return "no sink is set up";
  }
}

async function postJson(io: SinkIo, url: string | undefined, body: unknown): Promise<string | null> {
  if (!url) return "no webhook URL is set";
  const res = await io.fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`notification sink answered ${res.status}`);
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
