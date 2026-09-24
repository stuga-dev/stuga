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

export async function deliver(cfg: NotifyConfig, n: NotificationPayload, io: SinkIo = defaultIo): Promise<void> {
  switch (cfg.sink) {
    case "slack":
      return postJson(io, cfg.webhookUrl, {
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: `*${n.title}*\n${n.body}` } },
          { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Open" }, url: n.url }] },
        ],
      });
    case "discord":
      return postJson(io, cfg.webhookUrl, { content: `**${n.title}**\n${n.body}\n${n.url}` });
    case "teams":
      return postJson(io, cfg.webhookUrl, {
        "@type": "MessageCard",
        summary: n.title,
        text: `${n.body}\n\n[Open](${n.url})`,
      });
    case "webhook":
      return postJson(io, cfg.webhookUrl, { recipient: n.recipient, title: n.title, body: n.body, url: n.url });
    case "email": {
      if (!cfg.smtpUrl || !cfg.emailFrom || !n.recipientEmail) return;
      return io.sendMail(cfg.smtpUrl, {
        from: cfg.emailFrom,
        to: n.recipientEmail,
        subject: n.title,
        text: `${n.body}\n\n${n.url}\n`,
      });
    }
    default:
      return;
  }
}

async function postJson(io: SinkIo, url: string | undefined, body: unknown): Promise<void> {
  if (!url) return;
  const res = await io.fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`notification sink answered ${res.status}`);
}
