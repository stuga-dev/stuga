import { describe, expect, it, vi } from "vitest";
import { deliver, type NotificationPayload, type SinkIo } from "./sinks.js";
import { parseSmtpUrl } from "./smtp.js";

const n: NotificationPayload = {
  recipient: "u_r",
  recipientEmail: "r@example.com",
  title: "Q3 plan",
  body: "Ada shared a document with you",
  url: "http://localhost:8787/doc/d1",
};

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
    expect(JSON.stringify(i.calls[0]?.body)).toContain(n.url);
  });

  it("the generic webhook receives the raw payload", async () => {
    const i = io();
    await deliver({ sink: "webhook", webhookUrl: "https://sink.example" }, n, i);
    expect(i.calls[0]?.body).toEqual({ recipient: n.recipient, title: n.title, body: n.body, url: n.url });
  });

  it("a sink answering non-2xx throws so the job retries", async () => {
    await expect(deliver({ sink: "discord", webhookUrl: "https://d.example" }, n, io(500))).rejects.toThrow("500");
  });

  it("email sends through SMTP, and silently skips a recipient with no address", async () => {
    const cfg = { sink: "email", smtpUrl: "smtp://mail.example:587", emailFrom: "stuga@example.com" };
    const i = io();
    await deliver(cfg, n, i);
    expect(i.sendMail).toHaveBeenCalledWith(
      "smtp://mail.example:587",
      expect.objectContaining({ from: "stuga@example.com", to: "r@example.com", subject: n.title }),
    );
    const skip = io();
    await deliver(cfg, { ...n, recipientEmail: null }, skip);
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
