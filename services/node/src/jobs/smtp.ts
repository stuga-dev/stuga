/**
 * A minimal SMTP client for the email sink: one message per connection.
 * `smtp://user:pass@host:587` upgrades with STARTTLS when offered (`?tls=off`
 * never, `?tls=require` insists); `smtps://host:465` is TLS from the first byte.
 */
import net from "node:net";
import tls from "node:tls";
import { randomUUID } from "node:crypto";

export interface MailMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
}

export interface SmtpTarget {
  host: string;
  port: number;
  /** TLS from the first byte (smtps://). */
  implicitTls: boolean;
  /** "auto" upgrades when offered, "require" insists, "off" never upgrades. */
  starttls: "auto" | "require" | "off";
  username?: string;
  password?: string;
}

class SmtpError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
    this.name = "SmtpError";
  }
}

const COMMAND_TIMEOUT_MS = 30_000;

export function parseSmtpUrl(raw: string): SmtpTarget {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`the SMTP URL is not a URL: ${raw}`);
  }
  if (url.protocol !== "smtp:" && url.protocol !== "smtps:") {
    throw new Error(`the SMTP URL must start with smtp:// or smtps://, got ${url.protocol}//`);
  }
  const implicitTls = url.protocol === "smtps:";
  const port = url.port ? Number(url.port) : implicitTls ? 465 : 587;
  const tlsParam = (url.searchParams.get("tls") ?? "auto").toLowerCase();
  if (tlsParam !== "auto" && tlsParam !== "require" && tlsParam !== "off") {
    throw new Error(`the SMTP URL's ?tls= must be auto, require or off, got ${tlsParam}`);
  }
  const target: SmtpTarget = { host: url.hostname, port, implicitTls, starttls: implicitTls ? "off" : tlsParam };
  if (url.username) target.username = decodeURIComponent(url.username);
  if (url.password) target.password = decodeURIComponent(url.password);
  return target;
}

interface Reply {
  code: number;
  lines: string[];
}

/** One line-oriented SMTP session over a socket that may be upgraded to TLS. */
class Session {
  private socket: net.Socket | tls.TLSSocket;
  private buffer = "";
  private pending: { resolve: (r: Reply) => void; reject: (e: Error) => void; timer: NodeJS.Timeout } | null = null;
  private closedWith: Error | null = null;

  private constructor(socket: net.Socket | tls.TLSSocket) {
    this.socket = socket;
    this.attach(socket);
  }

  static async open(target: SmtpTarget): Promise<Session> {
    const socket = await new Promise<net.Socket | tls.TLSSocket>((resolve, reject) => {
      const s = target.implicitTls
        ? tls.connect({ host: target.host, port: target.port, servername: target.host }, () => resolve(s))
        : net.connect({ host: target.host, port: target.port }, () => resolve(s));
      s.once("error", reject);
    });
    socket.setNoDelay(true);
    const session = new Session(socket);
    await session.expect(session.waitReply(), 220, "greeting");
    return session;
  }

  private attach(socket: net.Socket | tls.TLSSocket): void {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.onData(chunk));
    socket.on("error", (e: Error) => this.fail(e));
    socket.on("close", () => this.fail(new SmtpError("connection closed by the server", 0)));
  }

  private fail(e: Error): void {
    this.closedWith ??= e;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(e);
      this.pending = null;
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let at: number;
    const lines: string[] = [];
    while ((at = this.buffer.indexOf("\r\n")) !== -1) {
      const line = this.buffer.slice(0, at);
      this.buffer = this.buffer.slice(at + 2);
      lines.push(line);
      // "250-more" continues a multi-line reply; "250 done" ends it.
      if (/^\d{3}(?: |$)/.test(line)) {
        const reply = { code: Number(line.slice(0, 3)), lines: lines.map((l) => l.slice(4)) };
        lines.length = 0;
        const p = this.pending;
        if (p) {
          clearTimeout(p.timer);
          this.pending = null;
          p.resolve(reply);
        }
      }
    }
    // Continuation lines of an unfinished reply go back to the buffer.
    if (lines.length > 0) this.buffer = `${lines.join("\r\n")}\r\n${this.buffer}`;
  }

  waitReply(): Promise<Reply> {
    if (this.closedWith) return Promise.reject(this.closedWith);
    return new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        reject(new SmtpError("timed out waiting for the server", 0));
      }, COMMAND_TIMEOUT_MS);
      this.pending = { resolve, reject, timer };
    });
  }

  command(line: string): Promise<Reply> {
    const reply = this.waitReply();
    this.socket.write(`${line}\r\n`);
    return reply;
  }

  async expect(reply: Promise<Reply>, codes: number | readonly number[], what: string): Promise<Reply> {
    const r = await reply;
    const accepted = typeof codes === "number" ? [codes] : codes;
    if (!accepted.includes(r.code)) throw new SmtpError(`${what}: server answered ${r.code} ${r.lines.join(" / ")}`, r.code);
    return r;
  }

  async upgrade(host: string): Promise<void> {
    const plain = this.socket;
    plain.removeAllListeners("data");
    plain.removeAllListeners("error");
    plain.removeAllListeners("close");
    this.buffer = "";
    const secure = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const s = tls.connect({ socket: plain, servername: host }, () => resolve(s));
      s.once("error", reject);
    });
    this.socket = secure;
    this.attach(secure);
  }

  end(): void {
    this.socket.end();
  }

  destroy(): void {
    this.socket.destroy();
  }
}

/** RFC 2047 encoding for a header value with non-ASCII characters. */
function headerValue(v: string): string {
  const clean = v.replace(/[\r\n]+/g, " ");
  return /^[\x20-\x7e]*$/.test(clean) ? clean : `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`;
}

/**
 * The bare address of a mailbox for the envelope commands. Whitespace is
 * stripped: a command is one CRLF-terminated line, so a stray newline here
 * would inject a second command.
 */
function addressOf(mailbox: string): string {
  const m = /<([^>]+)>/.exec(mailbox);
  return (m ? m[1] : mailbox)!.replace(/[\s<>]+/g, "");
}

/** Serialise a message for DATA: CRLF line ends and dot-stuffing. */
function formatMessage(msg: MailMessage, now: Date = new Date(), id: string = randomUUID()): string {
  const domain = addressOf(msg.from).split("@")[1] ?? "localhost";
  const headers = [
    `From: ${headerValue(msg.from)}`,
    `To: ${headerValue(msg.to)}`,
    `Subject: ${headerValue(msg.subject)}`,
    `Date: ${now.toUTCString()}`,
    `Message-ID: <${id}@${domain}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
  ];
  const body = msg.text
    .replace(/\r\n|\r|\n/g, "\r\n")
    .split("\r\n")
    .map((l) => (l.startsWith(".") ? `.${l}` : l))
    .join("\r\n");
  return `${headers.join("\r\n")}\r\n\r\n${body}\r\n`;
}

/** Deliver one message. Throws `SmtpError` with the server's code on refusal. */
export async function sendMail(smtpUrl: string, msg: MailMessage): Promise<void> {
  const target = parseSmtpUrl(smtpUrl);
  const session = await Session.open(target);
  try {
    let ehlo = await session.expect(session.command("EHLO stuga"), 250, "EHLO");
    const offers = (name: string): boolean => ehlo.lines.some((l) => l.toUpperCase().startsWith(name));

    if (!target.implicitTls && target.starttls !== "off") {
      if (offers("STARTTLS")) {
        await session.expect(session.command("STARTTLS"), 220, "STARTTLS");
        await session.upgrade(target.host);
        ehlo = await session.expect(session.command("EHLO stuga"), 250, "EHLO after STARTTLS");
      } else if (target.starttls === "require") {
        throw new SmtpError("server does not offer STARTTLS and the SMTP URL requires it", 0);
      }
    }

    if (target.username !== undefined) {
      const auth = ehlo.lines.find((l) => l.toUpperCase().startsWith("AUTH ")) ?? "";
      const mechanisms = auth.slice(5).toUpperCase().split(/\s+/);
      const password = target.password ?? "";
      if (mechanisms.includes("PLAIN") || !mechanisms.includes("LOGIN")) {
        const token = Buffer.from(`\0${target.username}\0${password}`, "utf8").toString("base64");
        await session.expect(session.command(`AUTH PLAIN ${token}`), 235, "AUTH PLAIN");
      } else {
        await session.expect(session.command("AUTH LOGIN"), 334, "AUTH LOGIN");
        await session.expect(session.command(Buffer.from(target.username, "utf8").toString("base64")), 334, "AUTH LOGIN username");
        await session.expect(session.command(Buffer.from(password, "utf8").toString("base64")), 235, "AUTH LOGIN password");
      }
    }

    await session.expect(session.command(`MAIL FROM:<${addressOf(msg.from)}>`), 250, "MAIL FROM");
    // 251: the server accepted the recipient and will forward (RFC 5321).
    await session.expect(session.command(`RCPT TO:<${addressOf(msg.to)}>`), [250, 251], "RCPT TO");
    await session.expect(session.command("DATA"), 354, "DATA");
    await session.expect(session.command(`${formatMessage(msg)}.`), 250, "message body");
    await session.command("QUIT").catch(() => undefined);
    session.end();
  } catch (e) {
    session.destroy();
    throw e;
  }
}
