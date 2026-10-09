import { describe, expect, it, vi } from "vitest";
import { deliver, type NotificationPayload, type SinkIo } from "./sinks.js";
import { parseSmtpUrl } from "./smtp.js";

const n: NotificationPayload = {
  recipient: "u_r",
  recipientEmail: "r@example.com",
  eventType: "DIRECT_DOC_PERMISSIONS",
  params: { actor: "Ada", doc: "Q3 plan" },
  language: "en",
  url: "http://localhost:8787/doc/d1",
};
const TITLE = "Ada shared “Q3 plan” with you";
const BODY = "You now have access to this document.";

function io(status = 200): SinkIo & { calls: Array<{ url: string; body: unknown }> } {
  const calls: Array<{ url: string; body: unknown }> = [];
  return {
    calls,
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(null, { status });
    }) as typeof fetch,
    sendMail: vi.fn(async () => {}),
  };
}

describe("deliver", () => {
  it("none delivers nowhere", async () => {
    const i = io();
    await deliver({ sink: "none" }, n, i);
    expect(i.calls).toHaveLength(0);
    expect(i.sendMail).not.toHaveBeenCalled();
  });

  it("slack posts blocks with an Open button", async () => {
    const i = io();
    await deliver({ sink: "slack", webhookUrl: "https://hooks.example/T" }, n, i);
    expect(i.calls[0]?.url).toBe("https://hooks.example/T");
    expect(i.calls[0]?.body).toEqual({
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: `*${TITLE}*\n${BODY}` } },
        { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Open" }, url: n.url }] },
      ],
    });
  });

  it("writes every channel in the recipient's language", async () => {
    const ja = { ...n, language: "ja" };
    const slack = io();
    await deliver({ sink: "slack", webhookUrl: "https://hooks.example/T" }, ja, slack);
    expect(JSON.stringify(slack.calls[0]!.body)).toContain("Adaが「Q3 plan」をあなたと共有しました");
    expect(JSON.stringify(slack.calls[0]!.body)).toContain('"text":"開く"');
    const teams = io();
    await deliver({ sink: "teams", webhookUrl: "https://t.example" }, { ...n, language: "de" }, teams);
    expect(teams.calls[0]!.body).toMatchObject({ summary: "Ada hat „Q3 plan“ mit dir geteilt", text: expect.stringContaining("[Öffnen](") });
    const mail = io();
    await deliver({ sink: "email", smtpUrl: "smtp://mail.example", emailFrom: "stuga@example.com" }, { ...n, language: "zh-Hans" }, mail);
    expect(mail.sendMail).toHaveBeenCalledWith("smtp://mail.example", expect.objectContaining({ subject: "Ada 与你共享了“Q3 plan”" }));
  });

  it("quotes names as text, never as the channel's markup: no link, no mention", async () => {
    const named = {
      ...n,
      eventType: "MENTIONED_IN_COMMENT",
      params: { actor: "Ada", doc: "<https://evil.example|Revoke everything>", excerpt: "[Revoke everything](https://evil.example) @everyone" },
    };
    const slack = io();
    await deliver({ sink: "slack", webhookUrl: "https://hooks.example/T" }, named, slack);
    const text = (slack.calls[0]!.body as { blocks: Array<{ text?: { text: string } }> }).blocks[0]!.text!.text;
    expect(text).toContain("&lt;https://evil.example|Revoke everything&gt;");
    expect(text).not.toContain("<https://evil");
    const discord = io();
    await deliver({ sink: "discord", webhookUrl: "https://d.example" }, named, discord);
    const content = discord.calls[0]!.body as { content: string; allowed_mentions: unknown };
    expect(content.content).toContain("\\[Revoke everything\\](https://evil.example)");
    expect(content.allowed_mentions).toEqual({ parse: [] });
    const teams = io();
    await deliver({ sink: "teams", webhookUrl: "https://t.example" }, named, teams);
    expect((teams.calls[0]!.body as { text: string }).text).toContain("[Revoke everything] (https://evil.example)");
  });

  it("the generic webhook receives the text, and the event and its params", async () => {
    const i = io();
    await deliver({ sink: "webhook", webhookUrl: "https://sink.example" }, n, i);
    expect(i.calls[0]?.body).toEqual({
      recipient: n.recipient,
      event_type: "DIRECT_DOC_PERMISSIONS",
      params: { actor: "Ada", doc: "Q3 plan" },
      language: "en",
      title: TITLE,
      body: BODY,
      url: n.url,
    });
  });

  it("a sink answering non-2xx throws so the job retries", async () => {
    await expect(deliver({ sink: "discord", webhookUrl: "https://d.example" }, n, io(500))).rejects.toMatchObject({ status: 500 });
  });

  it("says why nothing was sent as a code", async () => {
    expect(await deliver({ sink: "slack" }, n, io())).toBe("no_webhook_url");
    expect(await deliver({ sink: "email" }, n, io())).toBe("email_not_set_up");
    expect(await deliver({ sink: "carrier-pigeon" }, n, io())).toBe("no_sink");
  });

  it("email sends through SMTP, and silently skips a recipient with no address", async () => {
    const cfg = { sink: "email", smtpUrl: "smtp://mail.example:587", emailFrom: "stuga@example.com" };
    const i = io();
    await deliver(cfg, n, i);
    expect(i.sendMail).toHaveBeenCalledWith(
      "smtp://mail.example:587",
      expect.objectContaining({ from: "stuga@example.com", to: "r@example.com", subject: TITLE, text: `${BODY}\n\n${n.url}\n` }),
    );
    const skip = io();
    expect(await deliver(cfg, { ...n, recipientEmail: null }, skip)).toBe("no_email_address");
    expect(skip.sendMail).not.toHaveBeenCalled();
  });
});

describe("parseSmtpUrl", () => {
  it("smtp:// defaults to 587 with opportunistic STARTTLS", () => {
    expect(parseSmtpUrl("smtp://mail.example")).toEqual({
      host: "mail.example",
      port: 587,
      implicitTls: false,
      starttls: "auto",
    });
  });

  it("smtps:// is TLS from the first byte on 465", () => {
    expect(parseSmtpUrl("smtps://mail.example")).toMatchObject({ port: 465, implicitTls: true, starttls: "off" });
  });

  it("decodes credentials and honours ?tls=", () => {
    expect(parseSmtpUrl("smtp://a%40b:p%23w@h:2525?tls=require")).toMatchObject({
      host: "h",
      port: 2525,
      username: "a@b",
      password: "p#w",
      starttls: "require",
    });
    expect(() => parseSmtpUrl("smtp://h?tls=sometimes")).toThrow(/tls=/);
    expect(() => parseSmtpUrl("http://h")).toThrow(/smtp/);
  });
});
