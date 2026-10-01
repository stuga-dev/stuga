/**
 * The password hashes a node runs at once, and the line for the rest. scrypt runs on libuv's thread
 * pool, which files and DNS share, and each hash holds 64 MiB: unbounded, a burst of sign-ins would
 * take every thread and the memory with them.
 *
 * Two lines wait for the slots. `priority` is everything on the node's own network and anything a
 * signed-in person asks at the remote address; `anonymous` is a stranger's sign-in, registration,
 * reset or link at the remote address, which may hold at most `anonymousSlots` slots at a time. A
 * freed slot goes to the priority line first. Each line holds at most `maxQueued`, each waiting at
 * most `maxWaitMs`; past either, HashBusy, which the node answers with 503 and Retry-After.
 */

export type HashLane = "priority" | "anonymous";

export class HashBusy extends Error {
  constructor() {
    super("too many passwords are being checked; try again shortly");
    this.name = "HashBusy";
  }
}

export interface HashQueueOptions {
  /** Hashes run at once. Default 2. */
  slots?: number;
  /** Of those, held by the anonymous line at once. Default 1. */
  anonymousSlots?: number;
  /** Waiting in each line. Default 32. */
  maxQueued?: number;
  /** How long one may wait for a slot. Default 10 s. */
  maxWaitMs?: number;
}

export interface HashQueue {
  /** Run `work` in a slot, once `lane` gets one. Rejects with HashBusy when the line is full or the wait too long. */
  run<T>(lane: HashLane, work: () => Promise<T>): Promise<T>;
  /** For tests and logs. */
  stats(): { running: number; anonymousRunning: number; waiting: Record<HashLane, number> };
}

export const HASH_SLOTS = 2;
export const ANONYMOUS_HASH_SLOTS = 1;
export const HASH_QUEUE_LENGTH = 32;
export const HASH_WAIT_MS = 10_000;

interface Waiter {
  start: () => void;
  timer: NodeJS.Timeout;
}

export function createHashQueue(options: HashQueueOptions = {}): HashQueue {
  const slots = options.slots ?? HASH_SLOTS;
  const anonymousSlots = Math.min(options.anonymousSlots ?? ANONYMOUS_HASH_SLOTS, slots);
  const maxQueued = options.maxQueued ?? HASH_QUEUE_LENGTH;
  const maxWaitMs = options.maxWaitMs ?? HASH_WAIT_MS;
  let running = 0;
  let anonymousRunning = 0;
  const waiting: Record<HashLane, Waiter[]> = { priority: [], anonymous: [] };

  const mayStart = (lane: HashLane): boolean => running < slots && (lane === "priority" || anonymousRunning < anonymousSlots);

  function take(lane: HashLane): void {
    running += 1;
    if (lane === "anonymous") anonymousRunning += 1;
  }

  /** Hand free slots to whoever waits, the priority line first. */
  function pump(): void {
    for (const lane of ["priority", "anonymous"] as const) {
      while (waiting[lane].length > 0 && mayStart(lane)) {
        const next = waiting[lane].shift()!;
        clearTimeout(next.timer);
        take(lane);
        next.start();
      }
    }
  }

  async function acquire(lane: HashLane): Promise<void> {
    if (waiting[lane].length === 0 && mayStart(lane)) {
      take(lane);
      return;
    }
    if (waiting[lane].length >= maxQueued) throw new HashBusy();
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        start: resolve,
        timer: setTimeout(() => {
          const line = waiting[lane];
          const at = line.indexOf(waiter);
          if (at >= 0) line.splice(at, 1);
          reject(new HashBusy());
        }, maxWaitMs),
      };
      waiting[lane].push(waiter);
    });
  }

  function release(lane: HashLane): void {
    running -= 1;
    if (lane === "anonymous") anonymousRunning -= 1;
    pump();
  }

  return {
    async run(lane, work) {
      await acquire(lane);
      try {
        return await work();
      } finally {
        release(lane);
      }
    },
    stats: () => ({
      running,
      anonymousRunning,
      waiting: { priority: waiting.priority.length, anonymous: waiting.anonymous.length },
    }),
  };
}
