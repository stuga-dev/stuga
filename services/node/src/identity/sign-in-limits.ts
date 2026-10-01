/**
 * Wrong passwords, counted in memory only (nothing is written before sign-in) and per listener, so
 * guesses at the remote address can never pause anyone on the node's own network.
 *
 *   per account   every 5 failures pause it for 1, 5, 15, then 60 minutes, then 60 for each 5 more;
 *                 only a day without a failure starts it over, never a sign-in that worked
 *   per device    a browser this account signed in from before counts on its own, 10 an hour,
 *                 and the account's pause does not apply to it
 *   per source    the remote address only: 30 an hour from one IPv4 address or IPv6 /64, 300 an
 *                 hour from one /48, pause it for 15 minutes, doubling each time, at most a day
 *   remote total  at most 120 hashed wrong passwords a minute from everyone at the remote address;
 *                 past it, a stranger's check is refused before it is hashed until the next minute
 *
 * The LAN has no per-source pause: behind Docker Desktop or docker-proxy one address is the whole
 * office. Accounts that exist are kept in a map nothing evicts, sized by the people on the node;
 * names that do not are kept in a bounded LRU, so a flood of made-up names cannot push a real
 * account's count out. Both answer alike.
 *
 * Also the budget for scoring passwords at the remote address (T18): zxcvbn runs on the event loop.
 */
import type { Arrival } from "../platform/http-server.js";
import { perSite, perSubnet, unmappedAddress } from "../net/addresses.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The account pause after the 5th, 10th, 15th and 20th failure; every 5 after that, the last. */
export const ACCOUNT_PAUSES_MIN = [1, 5, 15, 60] as const;
export const FAILURES_PER_PAUSE = 5;
export const DEVICE_FAILURES_PER_HOUR = 10;
export const SOURCE_FAILURES_PER_HOUR = 30;
export const SITE_FAILURES_PER_HOUR = 300;
export const SOURCE_PAUSE_MS = 15 * MINUTE;
export const REMOTE_FAILURES_PER_MINUTE = 120;
/** Passwords zxcvbn scores per second at the remote address. */
export const STRENGTH_CHECKS_PER_SECOND = 20;
/** Names that are no account, remembered at once; about 10 MB. */
export const UNKNOWN_NAMES = 100_000;
/** Devices, addresses and /48s remembered at once. */
const MAX_KEYS = 100_000;

/** One attempt's place in the counts. */
export interface Attempt {
  arrival: Arrival;
  /** Normalized: as typed, or the signed-in account's. */
  username: string;
  /** Whether an account has that name: decides only where its count is kept. */
  exists: boolean;
  /** A browser this account already signed in from at this listener (its device cookie, hashed); null otherwise. */
  device: string | null;
  /** The address it came from. Counted at the remote address only. */
  source: string;
}

export interface SignInLimits {
  /** When the attempt may be tried again; null when it may be tried now. */
  pausedFor(attempt: Attempt): { retryAfterSeconds: number } | null;
  /** A wrong password, after it was hashed. The minutes of the account pause it began, or null when it began none. */
  failed(attempt: Attempt): number | null;
  /** A password the remote rule refused unhashed: never the account's count, the source's. */
  refusedUnhashed(attempt: Attempt): void;
  /** Whether the remote address's wrong passwords this minute have used up the budget. */
  remoteBudgetSpent(): boolean;
  /** One zxcvbn score at the remote address, if the second's budget has room. */
  takeStrengthCheck(): boolean;
  /** Forget what a day has passed without; the maintenance tick calls it. Also done as counts are read. */
  sweep(): void;
  /** For tests. */
  sizes(): { accounts: number; unknown: number; devices: number; sources: number };
}

interface AccountCount {
  failures: number;
  lastFailure: number;
  pausedUntil: number;
}

/** Failures in a sliding hour, and the pause that crossing the limit started. */
interface WindowCount {
  hits: number[];
  pausedUntil: number;
  /** Pauses so far, which double the next; forgotten after a day without one. */
  strikes: number;
  lastPause: number;
}

/** A Map that forgets the least recently touched key past `max`. */
class Lru<V> {
  readonly map = new Map<string, V>();
  constructor(readonly max: number) {}
  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }
  set(key: string, v: V): void {
    this.map.delete(key);
    if (this.map.size >= this.max) {
      const oldest = this.map.keys().next();
      if (!oldest.done) this.map.delete(oldest.value);
    }
    this.map.set(key, v);
  }
}

export interface SignInLimitsOptions {
  now?: () => number;
  unknownNames?: number;
}

export function createSignInLimits(options: SignInLimitsOptions = {}): SignInLimits {
  const now = options.now ?? Date.now;
  const known = new Map<string, AccountCount>();
  const unknown = new Lru<AccountCount>(options.unknownNames ?? UNKNOWN_NAMES);
  const devices = new Lru<WindowCount>(MAX_KEYS);
  const sources = new Lru<WindowCount>(MAX_KEYS);
  let minute = -1;
  let remoteFailures = 0;
  let tokens = STRENGTH_CHECKS_PER_SECOND;
  let refilled = now();
  let lastSweep = now();

  const accountKey = (a: Attempt) => `${a.arrival}:${a.username}`;
  const deviceKey = (a: Attempt) => `${a.arrival}:${a.username}:${a.device}`;

  function account(a: Attempt, create: boolean): AccountCount | undefined {
    const key = accountKey(a);
    let count = a.exists ? known.get(key) : unknown.get(key);
    if (count && now() - count.lastFailure >= DAY) {
      if (a.exists) known.delete(key);
      else unknown.map.delete(key);
      count = undefined;
    }
    if (!count && create) {
      count = { failures: 0, lastFailure: 0, pausedUntil: 0 };
      if (a.exists) known.set(key, count);
      else unknown.set(key, count);
    }
    return count;
  }

  /** The source buckets an attempt at the remote address counts in: its address or /64, and its /48. */
  function sourceBuckets(a: Attempt): Array<{ key: string; limit: number }> {
    if (a.arrival !== "remote") return [];
    const address = unmappedAddress(a.source);
    const buckets = [{ key: `ip:${perSubnet(address)}`, limit: SOURCE_FAILURES_PER_HOUR }];
    const site = perSite(address);
    if (site) buckets.push({ key: `site:${site}`, limit: SITE_FAILURES_PER_HOUR });
    return buckets;
  }

  function windowOf(lru: Lru<WindowCount>, key: string): WindowCount {
    let w = lru.get(key);
    if (!w) {
      w = { hits: [], pausedUntil: 0, strikes: 0, lastPause: 0 };
      lru.set(key, w);
    }
    return w;
  }

  /** One failure in a sliding hour; at `limit`, a pause of `basePause` doubled per earlier strike, at most a day. */
  function hit(w: WindowCount, limit: number, basePause: number | null): void {
    const t = now();
    while (w.hits.length > 0 && w.hits[0]! <= t - HOUR) w.hits.shift();
    w.hits.push(t);
    if (w.hits.length < limit) return;
    if (basePause === null) {
      // A device's own bucket: closed until its oldest failure leaves the hour.
      w.pausedUntil = w.hits[0]! + HOUR;
      return;
    }
    if (t - w.lastPause >= DAY) w.strikes = 0;
    w.pausedUntil = t + Math.min(basePause * 2 ** w.strikes, DAY);
    w.strikes += 1;
    w.lastPause = t;
    w.hits = [];
  }

  function windowPausedUntil(lru: Lru<WindowCount>, key: string): number {
    return lru.map.get(key)?.pausedUntil ?? 0;
  }

  function maybeSweep(): void {
    if (now() - lastSweep >= HOUR) limits.sweep();
  }

  const limits: SignInLimits = {
    pausedFor(a) {
      maybeSweep();
      const t = now();
      let until = 0;
      if (a.device) {
        until = windowPausedUntil(devices, deviceKey(a));
      } else {
        until = account(a, false)?.pausedUntil ?? 0;
        for (const { key } of sourceBuckets(a)) until = Math.max(until, windowPausedUntil(sources, key));
      }
      return until > t ? { retryAfterSeconds: Math.ceil((until - t) / 1000) } : null;
    },

    failed(a) {
      const t = now();
      if (a.arrival === "remote") {
        const m = Math.floor(t / MINUTE);
        if (m !== minute) {
          minute = m;
          remoteFailures = 0;
        }
        remoteFailures += 1;
      }
      if (a.device) {
        hit(windowOf(devices, deviceKey(a)), DEVICE_FAILURES_PER_HOUR, null);
        return null;
      }
      const count = account(a, true)!;
      count.failures += 1;
      count.lastFailure = t;
      let paused: number | null = null;
      if (count.failures % FAILURES_PER_PAUSE === 0) {
        const step = Math.min(count.failures / FAILURES_PER_PAUSE, ACCOUNT_PAUSES_MIN.length) - 1;
        paused = ACCOUNT_PAUSES_MIN[step]!;
        count.pausedUntil = t + paused * MINUTE;
      }
      for (const { key, limit } of sourceBuckets(a)) hit(windowOf(sources, key), limit, SOURCE_PAUSE_MS);
      return paused;
    },

    refusedUnhashed(a) {
      if (a.device) return;
      for (const { key, limit } of sourceBuckets(a)) hit(windowOf(sources, key), limit, SOURCE_PAUSE_MS);
    },

    remoteBudgetSpent() {
      return Math.floor(now() / MINUTE) === minute && remoteFailures >= REMOTE_FAILURES_PER_MINUTE;
    },

    takeStrengthCheck() {
      const t = now();
      tokens = Math.min(STRENGTH_CHECKS_PER_SECOND, tokens + ((t - refilled) / 1000) * STRENGTH_CHECKS_PER_SECOND);
      refilled = t;
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },

    sweep() {
      const t = now();
      lastSweep = t;
      for (const [key, count] of known) if (t - count.lastFailure >= DAY) known.delete(key);
      for (const [key, count] of unknown.map) if (t - count.lastFailure >= DAY) unknown.map.delete(key);
      for (const lru of [devices, sources]) {
        for (const [key, w] of lru.map) {
          const last = Math.max(w.hits.at(-1) ?? 0, w.pausedUntil, w.lastPause);
          if (t - last >= DAY) lru.map.delete(key);
        }
      }
    },

    sizes: () => ({ accounts: known.size, unknown: unknown.map.size, devices: devices.map.size, sources: sources.map.size }),
  };
  return limits;
}
