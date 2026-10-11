/**
 * The checked connection, against servers on loopback with answers in place of DNS: nothing here
 * resolves a real name or leaves the machine. The npm Agent runs through the global fetch, so a
 * version of undici the built-in fetch cannot drive fails here too.
 */
import type { LookupAddress, LookupAllOptions } from "node:dns";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import type { TLSSocket } from "node:tls";
import type { Agent } from "undici";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestCert } from "../testing/cert.js";
import { OutboundRefusedError, createOutboundAgent, outboundFetch, parseOutboundUrl, vetOutboundUrl, type OutboundAgentOptions } from "./outbound.js";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));
const { lookup: previewLookup } = await import("node:dns/promises");
// The resolver the default agent connects with.
vi.mock("node:dns", async (orig) => ({ ...(await orig<typeof import("node:dns")>()), lookup: vi.fn() }));
const { lookup: systemLookup } = await import("node:dns");

beforeEach(() => {
  vi.mocked(previewLookup).mockReset();
  vi.mocked(systemLookup).mockReset();
});

/** A resolver answering every name with `addresses`, in that order. */
function answering(...addresses: string[]): NonNullable<OutboundAgentOptions["lookup"]> {
  return (_hostname, _options, callback) => {
    callback(null, addresses.map((address): LookupAddress => ({ address, family: address.includes(":") ? 6 : 4 })));
  };
}

const permissive = () => null;

const agents: Agent[] = [];
const servers: Server[] = [];
/** An agent closed when the file is done. */
function agent(options: OutboundAgentOptions = {}): Agent {
  const made = createOutboundAgent(options);
  agents.push(made);
  return made;
}

afterAll(async () => {
  await Promise.all(agents.map((a) => a.close()));
  for (const s of servers) s.closeAllConnections();
  await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
});

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
const echo: Handler = (req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ host: req.headers.host, sni: (req.socket as TLSSocket).servername ?? null }));
};

/** A server on loopback that counts the connections it is offered: both families where it can, or IPv4 only. */
async function listen(options: { host?: string; handler?: Handler; tls?: { key: string; cert: string } } = {}) {
  let connections = 0;
  const handler = options.handler ?? echo;
  const server = options.tls ? createHttpsServer(options.tls, handler) : createServer(handler);
  server.on("connection", () => void (connections += 1));
  servers.push(server);
  const on = (host: string) =>
    new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, host, () => {
        server.off("error", reject);
        resolve();
      });
    });
  if (options.host) await on(options.host);
  else await on("::").catch(() => on("127.0.0.1"));
  return { port: (server.address() as AddressInfo).port, connections: () => connections };
}

/** What a refused fetch rejects with. */
async function refusal(promise: Promise<unknown>): Promise<OutboundRefusedError> {
  const e = await promise.then(
    () => null,
    (err: unknown) => err,
  );
  if (!(e instanceof OutboundRefusedError)) throw new Error(`expected a refusal, got ${String(e)}`);
  return e;
}

describe("parseOutboundUrl and vetOutboundUrl", () => {
  it.each([
    "http://[::1]:8787/x",
    "http://127.0.0.1/",
    "http://[::ffff:c0a8:101]/",
    "https://printer.local/",
    "http://nas.home.arpa/",
    "http://nas.local./",
    "http://nas/",
    "http://[64:ff9b::a00:1]/",
    "http://192.0.0.192/latest/meta-data/",
  ])("refuses %s without resolving anything", async (raw) => {
    expect(parseOutboundUrl(raw)).toEqual({ ok: false, reason: "refusing to reach a private or loopback address" });
    expect(await vetOutboundUrl(raw)).toEqual({ ok: false, reason: "refusing to reach a private or loopback address" });
    expect(previewLookup).not.toHaveBeenCalled();
  });

  it.each(["https://8.8.8.8/image.png", "http://[2606:4700::1111]/", "http://[64:ff9b::808:808]/"])(
    "allows the public address literal %s without resolving anything",
    async (raw) => {
      const parsed = parseOutboundUrl(raw);
      expect(parsed.ok && parsed.url.href).toBe(raw);
      const vetted = await vetOutboundUrl(raw);
      expect(vetted.ok && vetted.url.href).toBe(raw);
      expect(previewLookup).not.toHaveBeenCalled();
    },
  );

  it("refuses a scheme other than http(s) and a relative URL", async () => {
    expect((await vetOutboundUrl("file:///etc/passwd")).ok).toBe(false);
    expect((await vetOutboundUrl("/relative")).ok).toBe(false);
  });

  it("looks where a name resolves now, for a plain answer at registration", async () => {
    vi.mocked(previewLookup).mockResolvedValue([{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.1", family: 4 }] as never);
    expect(await vetOutboundUrl("https://hooks.example.com/x")).toEqual({ ok: false, reason: "refusing to reach a private or loopback address" });
    vi.mocked(previewLookup).mockResolvedValue([{ address: "198.18.0.9", family: 4 }] as never);
    expect(await vetOutboundUrl("https://hooks.example.com/x")).toEqual({ ok: false, reason: expect.stringMatching(/fake-IP/) });
    vi.mocked(previewLookup).mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never);
    expect((await vetOutboundUrl("https://hooks.example.com/x")).ok).toBe(true);
  });
});

describe("the checked connection", () => {
  it("checks every connection by default, with the system's resolver", async () => {
    const server = await listen();
    vi.mocked(systemLookup).mockImplementation(((_hostname: string, _options: LookupAllOptions, callback: (err: null, addresses: LookupAddress[]) => void) => {
      callback(null, [{ address: "127.0.0.1", family: 4 }]);
    }) as never);
    const refused = await refusal(outboundFetch(`http://rebind.example.com:${server.port}/`));
    expect(refused).toMatchObject({ reason: "private", host: "rebind.example.com", address: "127.0.0.1" });
    expect(systemLookup).toHaveBeenCalledWith("rebind.example.com", expect.objectContaining({ all: true }), expect.any(Function));
    expect(server.connections()).toBe(0);
  });

  it("refuses a name that answered public when checked and private when connected, opening no socket", async () => {
    const server = await listen();
    const url = `http://rebind.example.com:${server.port}/`;
    vi.mocked(previewLookup).mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never);
    expect((await vetOutboundUrl(url)).ok).toBe(true);

    const refused = await refusal(outboundFetch(url, {}, agent({ lookup: answering("127.0.0.1") })));
    expect(refused).toMatchObject({ reason: "private", host: "rebind.example.com", address: "127.0.0.1" });
    expect(refused.message).toBe("refusing to reach a private or loopback address");
    expect(server.connections()).toBe(0);

    // The same server and answer under a policy that allows everything: the refusal above was the policy's.
    const res = await outboundFetch(url, {}, agent({ lookup: answering("127.0.0.1"), forbidden: permissive }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ host: `rebind.example.com:${server.port}` });
    expect(server.connections()).toBe(1);
  });

  it("refuses the whole answer when any address in it is private, in either order", async () => {
    const server = await listen();
    for (const answer of [["93.184.216.34", "10.0.0.1"], ["10.0.0.1", "93.184.216.34"]]) {
      const refused = await refusal(outboundFetch(`http://mixed.example.com:${server.port}/`, {}, agent({ lookup: answering(...answer) })));
      expect(refused.address).toBe("10.0.0.1");
    }
    expect(server.connections()).toBe(0);
  });

  it("hands back what it checked whether asked for every address or for one", async () => {
    const server = await listen({ host: "127.0.0.1" });
    const url = `http://forms.example.com:${server.port}/`;
    expect((await outboundFetch(url, {}, agent({ lookup: answering("127.0.0.1"), forbidden: permissive }))).status).toBe(200);
    const one = agent({ lookup: answering("127.0.0.1"), forbidden: permissive, connect: { autoSelectFamily: false } });
    expect((await outboundFetch(url, {}, one)).status).toBe(200);
  });

  it("keeps Happy Eyeballs: an IPv6 answer that refuses falls back to the IPv4 one", async () => {
    const server = await listen({ host: "127.0.0.1" });
    const res = await outboundFetch(`http://both.example.com:${server.port}/`, {}, agent({ lookup: answering("::1", "127.0.0.1"), forbidden: permissive }));
    expect(res.status).toBe(200);
  });

  it("refuses an IP literal before any socket, however it is spelled", async () => {
    const server = await listen();
    const checked = agent();
    for (const host of ["127.0.0.1", "127.1", "2130706433", "0x7f.1", "[::1]", "[::ffff:127.0.0.1]"]) {
      const url = `http://${host}:${server.port}/`;
      // At the URL, before fetch is called, and at the connection, where every redirect hop goes too.
      await refusal(outboundFetch(url, {}, checked));
      const viaAgent = await fetch(url, { dispatcher: checked } as RequestInit).catch((e: unknown) => e);
      expect((viaAgent as TypeError).cause).toBeInstanceOf(OutboundRefusedError);
    }
    expect(server.connections()).toBe(0);
    // The same literal under a policy that allows everything connects.
    expect((await fetch(`http://127.0.0.1:${server.port}/`, { dispatcher: agent({ forbidden: permissive }) } as RequestInit)).status).toBe(200);
  });

  it("refuses a local name at the connection, before resolving it", async () => {
    const server = await listen({ host: "127.0.0.1" });
    const named = agent({ lookup: answering("127.0.0.1"), forbidden: permissive });
    for (const host of ["nas.local.", "nas", "localhost"]) {
      const viaAgent = await fetch(`http://${host}:${server.port}/`, { dispatcher: named } as RequestInit).catch((e: unknown) => e);
      expect((viaAgent as TypeError).cause).toMatchObject({ host, address: null });
    }
    expect(server.connections()).toBe(0);
  });

  it("keeps the URL's name for Host, SNI and the certificate check", async () => {
    const pair = makeTestCert({ dnsNames: ["ok.test"] });
    const server = await listen({ host: "127.0.0.1", tls: { key: pair.key, cert: pair.cert } });
    const tls = agent({ lookup: answering("127.0.0.1"), forbidden: permissive, connect: { ca: pair.cert } });
    const res = await outboundFetch(`https://ok.test:${server.port}/`, {}, tls);
    expect(await res.json()).toEqual({ host: `ok.test:${server.port}`, sni: "ok.test" });
    const other = await outboundFetch(`https://other.test:${server.port}/`, {}, tls).catch((e: unknown) => e);
    expect((other as TypeError).cause).toMatchObject({ code: "ERR_TLS_CERT_ALTNAME_INVALID" });
  });

  it("never follows a redirect, whatever the caller asks", async () => {
    // The redirect points at another loopback server, so a regression shows here and goes nowhere else.
    const target = await listen({ host: "127.0.0.1" });
    const location = `http://127.0.0.1:${target.port}/landed`;
    const server = await listen({
      handler: (_req, res) => {
        res.writeHead(302, { location });
        res.end();
      },
    });
    const res = await outboundFetch(`http://moved.example.com:${server.port}/`, { redirect: "follow" }, agent({ lookup: answering("127.0.0.1"), forbidden: permissive }));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(location);
    expect(target.connections()).toBe(0);
  });

  it("says a fake-IP proxy answered, without the address", async () => {
    const refused = await refusal(outboundFetch("http://proxied.example.com/", {}, agent({ lookup: answering("198.18.0.9") })));
    expect(refused.reason).toBe("fake-ip");
    expect(refused.message).toBe("the name resolves into 198.18.0.0/15, where fake-IP proxies answer; give Stuga real DNS");
  });

  it("leaves other failures as fetch reports them", async () => {
    const nothing = await outboundFetch("http://nowhere.example.com/", {}, agent({ lookup: answering() })).catch((e: unknown) => e);
    expect(nothing).toBeInstanceOf(TypeError);
    expect((nothing as TypeError).cause).toMatchObject({ code: "ENOTFOUND" });
    await expect(outboundFetch("ftp://example.com/", {}, agent())).rejects.toThrow(/unsupported URL scheme/);
  });
});
