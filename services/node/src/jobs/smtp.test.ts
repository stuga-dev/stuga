import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { sendMail } from "./smtp.js";

/** A plain-text SMTP server that answers each command from `replies` and records what it received. */
async function scriptedServer(replies: { rcpt: string }): Promise<{ url: string; received: string[]; close: () => Promise<void> }> {
  const received: string[] = [];
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    let inData = false;
    socket.write("220 test ready\r\n");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let at: number;
      while ((at = buffer.indexOf("\r\n")) !== -1) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            socket.write("250 queued\r\n");
          }
          continue;
        }
        received.push(line);
        const verb = line.split(/[ :]/)[0]!.toUpperCase();
        if (verb === "EHLO") socket.write("250-test\r\n250 SIZE 1000000\r\n");
        else if (verb === "MAIL") socket.write("250 ok\r\n");
        else if (verb === "RCPT") socket.write(`${replies.rcpt}\r\n`);
        else if (verb === "DATA") {
          inData = true;
          socket.write("354 go ahead\r\n");
        } else if (verb === "QUIT") {
          socket.write("221 bye\r\n");
          socket.end();
        } else socket.write("502 unknown\r\n");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    url: `smtp://127.0.0.1:${port}?tls=off`,
    received,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

const message = { from: "Stuga <stuga@example.test>", to: "r@example.test", subject: "Hello", text: "Body" };

let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  await close?.();
  close = null;
});

describe("sendMail", () => {
  it("delivers when the server accepts the recipient with 250", async () => {
    const server = await scriptedServer({ rcpt: "250 ok" });
    close = server.close;
    await sendMail(server.url, message);
    expect(server.received).toContain("RCPT TO:<r@example.test>");
  });

  it("delivers when the server will forward the recipient (251)", async () => {
    const server = await scriptedServer({ rcpt: "251 user not local; will forward" });
    close = server.close;
    await expect(sendMail(server.url, message)).resolves.toBeUndefined();
    expect(server.received).toContain("DATA");
  });

  it("throws on a refused recipient", async () => {
    const server = await scriptedServer({ rcpt: "550 no such user" });
    close = server.close;
    await expect(sendMail(server.url, message)).rejects.toThrow(/RCPT TO: server answered 550/);
  });
});
