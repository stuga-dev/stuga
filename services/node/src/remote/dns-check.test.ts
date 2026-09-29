import { createSocket, type Socket } from "node:dgram";
import { afterEach, describe, expect, it } from "vitest";
import { DnsNotVisible, queryTxt, waitForTxt, type ChallengeResolver, type TxtAnswer } from "./dns-check.js";

const HOST = "k7f3q2.mystuga.com";
const FQDN = `_acme-challenge.${HOST}`;
const VALUE = "LoqXcYV8q5ONbJQxbmR7SCTNo3tiAXDfowyjxAjEuX0";

/** A fake clock the waits advance, and servers that answer from `answers(server, round)`. */
function setup(answers: (server: string, round: number) => string[][] | TxtAnswer | Error) {
  let t = 0;
  const rounds = new Map<string, number>();
  const asked: string[] = [];
  const resolver: ChallengeResolver = {
    servers: async (zone) => {
      asked.push(zone);
      return ["192.0.2.1", "192.0.2.2"];
    },
    txt: async (server, fqdn) => {
      expect(fqdn).toBe(FQDN);
      const round = rounds.get(server) ?? 0;
      rounds.set(server, round + 1);
      const a = answers(server, round);
      if (a instanceof Error) throw a;
      return Array.isArray(a) ? { authoritative: true, records: a } : a;
    },
  };
  const sleeps: number[] = [];
  return {
    asked,
    sleeps,
    rounds,
    elapsed: () => t,
    opts: {
      resolver,
      hostname: HOST,
      fqdn: FQDN,
      value: VALUE,
      now: () => t,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        t += ms;
      },
    },
  };
}

const timeout = () => Object.assign(new Error("timeout"), { code: "ETIMEOUT" });
const nodata = (): TxtAnswer => ({ authoritative: true, records: [] });
/** What a network that answers port 53 itself says, having cached "no such record". */
const standIn = (): TxtAnswer => ({ authoritative: false, records: [] });

describe("waiting for the challenge record", () => {
  it("asks the zone's own servers, and goes on once every one of them has the value", async () => {
    const s = setup((server, round) => (server === "192.0.2.2" && round < 2 ? nodata() : [["other"], [VALUE.slice(0, 20), VALUE.slice(20)]]));
    await waitForTxt(s.opts);
    expect(s.asked).toEqual(["mystuga.com"]);
    expect(s.sleeps).toEqual([2000, 2000]);
    // A server that has it is not asked again.
    expect(s.rounds.get("192.0.2.1")).toBe(1);
  });

  it("gives up after a minute with dns_not_visible", async () => {
    const s = setup((server) => (server === "192.0.2.1" ? [[VALUE]] : [["stale"]]));
    const err = await waitForTxt(s.opts).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DnsNotVisible);
    expect((err as DnsNotVisible).code).toBe("dns_not_visible");
    expect((err as Error).message).toContain("192.0.2.2");
    expect(s.elapsed()).toBeLessThanOrEqual(60_000);
    expect(s.elapsed()).toBeGreaterThanOrEqual(58_000);
  });

  it("waits a fixed 20 seconds and goes on when no server answers at all, as behind a firewall on port 53", async () => {
    const s = setup(() => timeout());
    await waitForTxt(s.opts);
    expect(s.sleeps).toEqual([20_000]);
  });

  it("keeps asking when only some servers time out at first", async () => {
    const s = setup((server, round) => (server === "192.0.2.1" && round === 0 ? timeout() : [[VALUE]]));
    await waitForTxt(s.opts);
    expect(s.sleeps).toEqual([2000]);
  });

  it("takes answers without the AA flag for no answer: waits 20 seconds and goes on", async () => {
    const s = setup((server) => (server === "192.0.2.1" ? standIn() : timeout()));
    await waitForTxt(s.opts);
    expect(s.sleeps).toEqual([20_000]);
  });

  it("leaves a server behind a stand-in to the others", async () => {
    const s = setup((server, round) => (server === "192.0.2.1" ? standIn() : round < 1 ? nodata() : [[VALUE]]));
    await waitForTxt(s.opts);
    expect(s.sleeps).toEqual([2000]);
    expect(s.rounds.get("192.0.2.1")).toBe(1);
  });

  it("takes a port 53 refused on the way, as by an ICMP reject, like one dropped: waits 20 seconds", async () => {
    const s = setup(() => Object.assign(new Error("refused"), { code: "ECONNREFUSED" }));
    await waitForTxt(s.opts);
    expect(s.sleeps).toEqual([20_000]);
  });

  it("waits 20 seconds too when the last trustworthy server turns out to be behind a stand-in", async () => {
    const s = setup((server, round) => (server === "192.0.2.1" ? standIn() : round === 0 ? nodata() : standIn()));
    await waitForTxt(s.opts);
    expect(s.sleeps).toEqual([2000, 20_000]);
  });

  it("never counts a stand-in's copy of the value", async () => {
    const s = setup((server) => (server === "192.0.2.1" ? { authoritative: false, records: [[VALUE]] } : nodata()));
    await expect(waitForTxt(s.opts)).rejects.toBeInstanceOf(DnsNotVisible);
  });
});

/** A DNS server on loopback that answers each query with `reply(query)`, or not at all for null. */
async function udpServer(reply: (query: Buffer) => Buffer | null): Promise<{ server: string; socket: Socket }> {
  const socket = createSocket("udp4");
  socket.on("message", (msg, rinfo) => {
    const out = reply(msg);
    if (out) socket.send(out, rinfo.port, rinfo.address);
  });
  await new Promise<void>((r) => socket.bind(0, "127.0.0.1", r));
  return { server: `127.0.0.1:${socket.address().port}`, socket };
}

/** An answer to `query`: its header and question, then `answers`, which may point back at the question's name (offset 12). */
function answer(query: Buffer, flags: number, answers: Buffer[]): Buffer {
  const header = Buffer.from(query.subarray(0, 12));
  header.writeUInt16BE(0x8000 | flags, 2);
  header.writeUInt16BE(answers.length, 6);
  return Buffer.concat([header, query.subarray(12), ...answers]);
}

function txtRecord(name: Buffer, strings: string[], type = 16): Buffer {
  const rdata = Buffer.concat(strings.map((s) => Buffer.concat([Buffer.from([s.length]), Buffer.from(s)])));
  const fixed = Buffer.alloc(10);
  fixed.writeUInt16BE(type, 0);
  fixed.writeUInt16BE(1, 2);
  fixed.writeUInt32BE(60, 4);
  fixed.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([name, fixed, rdata]);
}

const POINTER_TO_QUESTION = Buffer.from([0xc0, 12]);
const AA = 0x0400;

describe("one query on the wire", () => {
  const sockets: Socket[] = [];
  afterEach(() => {
    for (const s of sockets.splice(0)) s.close();
  });
  async function serve(reply: (query: Buffer) => Buffer | null): Promise<string> {
    const { server, socket } = await udpServer(reply);
    sockets.push(socket);
    return server;
  }

  it("asks for TXT without recursion, and reads the AA flag and every string of each record", async () => {
    let asked: Buffer | null = null;
    const server = await serve((q) => {
      asked = q;
      return answer(q, AA, [
        txtRecord(POINTER_TO_QUESTION, [VALUE.slice(0, 20), VALUE.slice(20)]),
        txtRecord(POINTER_TO_QUESTION, ["other"]),
        txtRecord(POINTER_TO_QUESTION, ["not txt"], 5),
      ]);
    });
    await expect(queryTxt(server, FQDN)).resolves.toEqual({ authoritative: true, records: [[VALUE.slice(0, 20), VALUE.slice(20)], ["other"]] });
    const q = asked!;
    expect(q.readUInt16BE(2)).toBe(0);
    expect(q.readUInt16BE(q.length - 4)).toBe(16);
  });

  it("reports an answer without AA as not authoritative, and reads none of its records", async () => {
    const server = await serve((q) => answer(q, 0x0080, [txtRecord(POINTER_TO_QUESTION, [VALUE])]));
    await expect(queryTxt(server, FQDN)).resolves.toEqual({ authoritative: false, records: [] });
  });

  it("reads a refusal without AA as not authoritative, not as the zone's refusal", async () => {
    const server = await serve((q) => answer(q, 0x0080 | 5, []));
    await expect(queryTxt(server, FQDN)).resolves.toEqual({ authoritative: false, records: [] });
  });

  it("rejects, and never throws past the promise, when the socket cannot connect", async () => {
    // A multicast address with no scope: connect(2) fails on macOS and Linux alike.
    await expect(queryTxt("ff02::1", FQDN, 500)).rejects.toBeInstanceOf(Error);
  });

  it("takes NXDOMAIN for no records, and skips records for other names", async () => {
    const nx = await serve((q) => answer(q, AA | 3, []));
    await expect(queryTxt(nx, FQDN)).resolves.toEqual({ authoritative: true, records: [] });
    const other = Buffer.concat([Buffer.from([5]), Buffer.from("other"), POINTER_TO_QUESTION]);
    const elsewhere = await serve((q) => answer(q, AA, [txtRecord(other, [VALUE])]));
    await expect(queryTxt(elsewhere, FQDN)).resolves.toEqual({ authoritative: true, records: [] });
  });

  it("ignores an answer to another query, and times out with ETIMEOUT", async () => {
    const server = await serve((q) => {
      const wrong = answer(q, AA, [txtRecord(POINTER_TO_QUESTION, [VALUE])]);
      wrong.writeUInt16BE((q.readUInt16BE(0) + 1) & 0xffff, 0);
      return wrong;
    });
    await expect(queryTxt(server, FQDN, 200)).rejects.toMatchObject({ code: "ETIMEOUT" });
  });

  it("refuses a pointer loop rather than following it", async () => {
    const server = await serve((q) => answer(q, AA, [txtRecord(Buffer.from([0xc0, q.length]), [VALUE])]));
    await expect(queryTxt(server, FQDN)).rejects.toMatchObject({ code: "EBADRESP" });
  });
});
