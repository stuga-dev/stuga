import { afterEach, describe, expect, it, vi } from "vitest";
import { HashBusy, createHashQueue, type HashLane } from "./hash-queue.js";

/** Work that runs until released, recording how many run at once. */
function gate() {
  let live = 0;
  let peak = 0;
  const releases: Array<() => void> = [];
  const work = () =>
    new Promise<string>((resolve) => {
      live += 1;
      peak = Math.max(peak, live);
      releases.push(() => {
        live -= 1;
        resolve("done");
      });
    });
  return {
    work,
    releaseOne: async () => {
      releases.shift()?.();
      await new Promise((r) => setImmediate(r));
    },
    get live() {
      return live;
    },
    get peak() {
      return peak;
    },
  };
}

const settled = () => new Promise((r) => setImmediate(r));

afterEach(() => vi.useRealTimers());

describe("the hash queue", () => {
  it("runs at most two at once, queues 32 more, and refuses the 35th", async () => {
    const q = createHashQueue();
    const g = gate();
    const all = Array.from({ length: 34 }, () => q.run("priority", g.work));
    await settled();
    expect(q.stats()).toMatchObject({ running: 2, waiting: { priority: 32, anonymous: 0 } });
    await expect(q.run("priority", g.work)).rejects.toBeInstanceOf(HashBusy);
    for (let i = 0; i < 34; i++) await g.releaseOne();
    await expect(Promise.all(all)).resolves.toHaveLength(34);
    expect(g.peak).toBe(2);
  });

  it("lets a stranger's line hold one slot at most, so the other is always there for the LAN", async () => {
    const q = createHashQueue();
    const g = gate();
    const strangers = Array.from({ length: 5 }, () => q.run("anonymous", g.work));
    await settled();
    expect(q.stats()).toMatchObject({ running: 1, anonymousRunning: 1, waiting: { anonymous: 4 } });
    const local = q.run("priority", g.work);
    await settled();
    expect(q.stats()).toMatchObject({ running: 2, anonymousRunning: 1 });
    for (let i = 0; i < 6; i++) await g.releaseOne();
    await Promise.all([...strangers, local]);
  });

  it("gives a freed slot to the priority line first", async () => {
    const q = createHashQueue();
    const order: HashLane[] = [];
    const g = gate();
    const first = [q.run("priority", g.work), q.run("priority", g.work)];
    await settled();
    const later = [
      q.run("anonymous", async () => void order.push("anonymous")),
      q.run("priority", async () => void order.push("priority")),
    ];
    await settled();
    await g.releaseOne();
    await g.releaseOne();
    await Promise.all([...first, ...later]);
    expect(order).toEqual(["priority", "anonymous"]);
  });

  it("still seats the priority line within the wait when the stranger's line is full", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const q = createHashQueue();
    const g = gate();
    const strangers = Array.from({ length: 33 }, () => q.run("anonymous", g.work).catch((e: unknown) => e));
    await expect(q.run("anonymous", g.work)).rejects.toBeInstanceOf(HashBusy);
    let seated = false;
    const mine = q.run("priority", async () => {
      seated = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(seated).toBe(true);
    await mine;
    await vi.advanceTimersByTimeAsync(10_001);
    await g.releaseOne();
    await Promise.all(strangers);
  });

  it("refuses one that waited longer than ten seconds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const q = createHashQueue();
    const g = gate();
    void q.run("priority", g.work);
    void q.run("priority", g.work);
    const late = q.run("priority", g.work);
    const caught = late.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10_001);
    expect(await caught).toBeInstanceOf(HashBusy);
    expect(q.stats().waiting.priority).toBe(0);
  });

  it("frees the slot when the work throws", async () => {
    const q = createHashQueue({ slots: 1 });
    await expect(q.run("priority", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(q.run("priority", async () => "next")).resolves.toBe("next");
    expect(q.stats().running).toBe(0);
  });
});
