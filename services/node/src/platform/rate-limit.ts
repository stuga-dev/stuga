/**
 * An in-process sliding-window rate limiter. Memory is bounded: a key's log never exceeds
 * `limit` entries, and keys quiet for a full window are swept, or evicted oldest-first past `maxKeys`.
 */

/** Reports no reset instant; callers answer Retry-After with the window length. */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

interface SlidingWindowOptions {
  /** Hits allowed per key per window. */
  limit: number;
  windowSeconds: number;
  /** Upper bound on tracked keys. Default 100 000. */
  maxKeys?: number;
  /** Clock, in epoch ms. */
  now?: () => number;
}

export function slidingWindowRateLimiter(options: SlidingWindowOptions): RateLimiter & { size(): number } {
  const { limit } = options;
  const windowMs = options.windowSeconds * 1000;
  const maxKeys = options.maxKeys ?? 100_000;
  const now = options.now ?? Date.now;
  /** key → hit timestamps, oldest first. Map order doubles as last-seen order. */
  const hits = new Map<string, number[]>();
  let lastSweep = now();

  const sweep = (t: number): void => {
    lastSweep = t;
    for (const [key, log] of hits) {
      if (log.length === 0 || log[log.length - 1]! <= t - windowMs) hits.delete(key);
    }
  };

  return {
    async limit({ key }) {
      const t = now();
      if (t - lastSweep >= windowMs) sweep(t);

      let log = hits.get(key);
      if (log) {
        hits.delete(key); // re-insert below so the map stays in last-seen order
        let drop = 0;
        while (drop < log.length && log[drop]! <= t - windowMs) drop += 1;
        if (drop > 0) log.splice(0, drop);
      } else {
        log = [];
        if (hits.size >= maxKeys) {
          const oldest = hits.keys().next();
          if (!oldest.done) hits.delete(oldest.value);
        }
      }

      const success = log.length < limit;
      if (success) log.push(t);
      hits.set(key, log);
      return { success };
    },
    size: () => hits.size,
  };
}
