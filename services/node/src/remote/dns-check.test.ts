import { describe, expect, it } from "vitest";
import { DnsNotVisible, waitForTxt, type ChallengeResolver } from "./dns-check.js";

const HOST = "k7f3q2.mystuga.com";
const FQDN = `_acme-challenge.${HOST}`;
const VALUE = "LoqXcYV8q5ONbJQxbmR7SCTNo3tiAXDfowyjxAjEuX0";

/** A fake clock the waits advance, and servers that answer from `answers(server, round)`. */
function setup(answers: (server: string, round: number) => string[][] | Error) {
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
      return a;
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
const nodata = () => Object.assign(new Error("no data"), { code: "ENODATA" });

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
});
