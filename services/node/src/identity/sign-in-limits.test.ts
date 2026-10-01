import { describe, expect, it } from "vitest";
import {
  REMOTE_FAILURES_PER_MINUTE,
  STRENGTH_CHECKS_PER_SECOND,
  createSignInLimits,
  type Attempt,
} from "./sign-in-limits.js";

const MIN = 60_000;
const HOUR = 60 * MIN;

function clock(start = Date.UTC(2026, 8, 30, 12)) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

const remote = (over: Partial<Attempt> = {}): Attempt => ({
  arrival: "remote",
  username: "ada",
  exists: true,
  device: null,
  source: "203.0.113.7",
  ...over,
});
const local = (over: Partial<Attempt> = {}): Attempt => remote({ arrival: "local", source: "10.0.0.7", ...over });

function failTimes(limits: ReturnType<typeof createSignInLimits>, attempt: Attempt, n: number) {
  for (let i = 0; i < n; i++) limits.failed(attempt);
}

describe("an account's pauses", () => {
  it("pause it 1, 5, 15, then 60 minutes at every fifth failure, and 60 after that", () => {
    const c = clock();
    const limits = createSignInLimits({ now: c.now });
    // Each from a new address, so only the account's count is in play.
    let n = 0;
    const next = () => remote({ source: `198.51.100.${++n}` });
    for (const minutes of [1, 5, 15, 60, 60, 60]) {
      failTimes(limits, next(), 4);
      expect(limits.pausedFor(next())).toBeNull();
      // The failure that begins a pause says how long: what the hour-long pause's alert is told by.
      expect(limits.failed(next())).toBe(minutes);
      expect(limits.pausedFor(next())).toEqual({ retryAfterSeconds: minutes * 60 });
      c.advance(minutes * MIN);
      expect(limits.pausedFor(next())).toBeNull();
    }
  });

  it("starts over only after a day without a failure; a sign-in that works changes nothing", () => {
    const c = clock();
    const limits = createSignInLimits({ now: c.now });
    failTimes(limits, local(), 5);
    c.advance(MIN);
    // Whatever succeeded meanwhile is not reported: the count stays.
    failTimes(limits, local(), 5);
    expect(limits.pausedFor(local())?.retryAfterSeconds).toBe(5 * 60);
    c.advance(24 * HOUR);
    failTimes(limits, local(), 5);
    expect(limits.pausedFor(local())?.retryAfterSeconds).toBe(60);
  });

  it("counts each listener apart: guesses at the remote address never pause the LAN", () => {
    const limits = createSignInLimits({ now: clock().now });
    failTimes(limits, remote(), 5);
    expect(limits.pausedFor(remote({ source: "198.51.100.1" }))).not.toBeNull();
    expect(limits.pausedFor(local())).toBeNull();
  });

  it("answers a name with no account exactly as one with", () => {
    const limits = createSignInLimits({ now: clock().now });
    failTimes(limits, local({ username: "nobody", exists: false }), 5);
    failTimes(limits, local({ username: "ada", exists: true }), 5);
    expect(limits.pausedFor(local({ username: "nobody", exists: false }))).toEqual(limits.pausedFor(local({ username: "ada" })));
  });

  it("keeps a real account's count however many made-up names flood the rest", () => {
    const limits = createSignInLimits({ now: clock().now, unknownNames: 1000 });
    failTimes(limits, local(), 5);
    for (let i = 0; i < 20_000; i++) limits.failed(local({ username: `random-${i}`, exists: false }));
    expect(limits.sizes()).toMatchObject({ accounts: 1, unknown: 1000 });
    expect(limits.pausedFor(local())).not.toBeNull();
  });
});

describe("a known device", () => {
  it("signs in while its account is paused, on either listener, and has its own ten an hour", () => {
    const c = clock();
    const limits = createSignInLimits({ now: c.now });
    for (const at of [remote, local]) {
      failTimes(limits, at(), 20);
      expect(limits.pausedFor(at())).not.toBeNull();
      const mine = at({ device: "cookie-hash" });
      expect(limits.pausedFor(mine)).toBeNull();
      failTimes(limits, mine, 9);
      expect(limits.pausedFor(mine)).toBeNull();
      limits.failed(mine);
      expect(limits.pausedFor(mine)?.retryAfterSeconds).toBe(3600);
    }
    // A device's failures are its own: the account's count did not move past where it was.
    c.advance(HOUR);
    expect(limits.pausedFor(remote({ device: "cookie-hash" }))).toBeNull();
  });

  it("is known per listener: the LAN's cookie counts as no device at the remote address", () => {
    const limits = createSignInLimits({ now: clock().now });
    failTimes(limits, local({ device: "lan-cookie" }), 10);
    expect(limits.pausedFor(local({ device: "lan-cookie" }))).not.toBeNull();
    expect(limits.pausedFor(remote({ device: "lan-cookie" }))).toBeNull();
  });
});

describe("sources at the remote address", () => {
  it("pause one address after 30 failures in an hour, for 15 minutes, doubling each time", () => {
    const c = clock();
    const limits = createSignInLimits({ now: c.now });
    let n = 0;
    const from = () => remote({ username: `u${++n}`, exists: false });
    failTimes(limits, { ...from(), source: "203.0.113.7" }, 0);
    for (let i = 0; i < 29; i++) limits.failed({ ...from(), source: "203.0.113.7" });
    expect(limits.pausedFor({ ...from(), source: "203.0.113.7" })).toBeNull();
    limits.failed({ ...from(), source: "203.0.113.7" });
    expect(limits.pausedFor({ ...from(), source: "203.0.113.7" })?.retryAfterSeconds).toBe(15 * 60);
    // Another address is untouched.
    expect(limits.pausedFor({ ...from(), source: "203.0.113.8" })).toBeNull();
    c.advance(15 * MIN);
    for (let i = 0; i < 30; i++) limits.failed({ ...from(), source: "203.0.113.7" });
    expect(limits.pausedFor({ ...from(), source: "203.0.113.7" })?.retryAfterSeconds).toBe(30 * 60);
  });

  it("count an IPv6 /64 as one source, and a /48 as one at 300", () => {
    const limits = createSignInLimits({ now: clock().now });
    let n = 0;
    const at = (source: string) => remote({ username: `u${++n}`, exists: false, source });
    for (let i = 0; i < 30; i++) limits.failed(at(`2001:db8:5:17::${i.toString(16)}`));
    expect(limits.pausedFor(at("2001:db8:5:17::ffff"))).not.toBeNull();
    // Many /64s of one /48, nine failures each: each /64 under its limit, the /48 over its own.
    for (let net = 0x100; net < 0x100 + 33; net++) for (let i = 0; i < 9; i++) limits.failed(at(`2001:db8:5:${net.toString(16)}::1`));
    expect(limits.pausedFor(at("2001:db8:5:ffff::1"))?.retryAfterSeconds).toBe(15 * 60);
    expect(limits.pausedFor(at("2001:db8:6::1"))).toBeNull();
  });

  it("count a password the remote rule refused against the source, never the account", () => {
    const limits = createSignInLimits({ now: clock().now });
    for (let i = 0; i < 30; i++) limits.refusedUnhashed(remote());
    expect(limits.pausedFor(remote())).not.toBeNull();
    expect(limits.pausedFor(remote({ source: "198.51.100.1" }))).toBeNull();
  });

  it("never pause a source on the LAN, where one address can be a whole office", () => {
    const limits = createSignInLimits({ now: clock().now });
    let n = 0;
    for (let i = 0; i < 100; i++) limits.failed(local({ username: `u${++n}`, exists: false, source: "172.17.0.1" }));
    expect(limits.pausedFor(local({ username: "someone-else", source: "172.17.0.1" }))).toBeNull();
  });
});

describe("the remote address's budgets", () => {
  it("spends the minute's wrong passwords at 120, and refills at the next minute", () => {
    const c = clock();
    const limits = createSignInLimits({ now: c.now });
    let n = 0;
    for (let i = 0; i < REMOTE_FAILURES_PER_MINUTE - 1; i++) limits.failed(remote({ username: `u${++n}`, source: `2001:db8:${n.toString(16)}::1` }));
    expect(limits.remoteBudgetSpent()).toBe(false);
    limits.failed(remote({ username: "last" }));
    expect(limits.remoteBudgetSpent()).toBe(true);
    // The LAN's failures never spend it.
    c.advance(MIN);
    expect(limits.remoteBudgetSpent()).toBe(false);
    for (let i = 0; i < 200; i++) limits.failed(local({ username: `l${i}`, exists: false }));
    expect(limits.remoteBudgetSpent()).toBe(false);
  });

  it("scores at most 20 passwords a second", () => {
    const c = clock();
    const limits = createSignInLimits({ now: c.now });
    for (let i = 0; i < STRENGTH_CHECKS_PER_SECOND; i++) expect(limits.takeStrengthCheck()).toBe(true);
    expect(limits.takeStrengthCheck()).toBe(false);
    c.advance(100);
    expect(limits.takeStrengthCheck()).toBe(true);
    expect(limits.takeStrengthCheck()).toBe(true);
    expect(limits.takeStrengthCheck()).toBe(false);
  });
});

describe("memory", () => {
  it("forgets what a day passed without", () => {
    const c = clock();
    const limits = createSignInLimits({ now: c.now });
    failTimes(limits, remote(), 3);
    failTimes(limits, remote({ username: "x", exists: false }), 3);
    failTimes(limits, remote({ device: "d" }), 3);
    expect(limits.sizes()).toEqual({ accounts: 1, unknown: 1, devices: 1, sources: 1 });
    c.advance(24 * HOUR);
    limits.sweep();
    expect(limits.sizes()).toEqual({ accounts: 0, unknown: 0, devices: 0, sources: 0 });
  });
});
