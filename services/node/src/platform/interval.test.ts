import { describe, expect, it } from "vitest";
import { startInterval } from "./interval.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("startInterval", () => {
  it("never overlaps a slow tick and keeps going after a failure", async () => {
    let active = 0;
    let maxActive = 0;
    let runs = 0;
    const handle = startInterval(
      10,
      async () => {
        runs += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          if (runs === 1) {
            await sleep(45);
            throw new Error("first tick fails");
          }
          await sleep(5);
        } finally {
          active -= 1;
        }
      },
      { onError: () => {} },
    );
    // Polled rather than a fixed wait, so a loaded machine's late timers cannot fail it.
    const deadline = Date.now() + 5000;
    while (runs < 3 && Date.now() < deadline) await sleep(5);
    await handle.stop();
    expect(maxActive).toBe(1);
    expect(runs).toBeGreaterThanOrEqual(3);
    expect(runs).toBeLessThan(12);
    const after = runs;
    await sleep(30);
    expect(runs).toBe(after);
  });

  it("stop() waits for the tick in flight", async () => {
    let started = false;
    let done = false;
    const handle = startInterval(1, async () => {
      started = true;
      await sleep(30);
      done = true;
    });
    while (!started) await sleep(1);
    await handle.stop();
    expect(done).toBe(true);
  });
});

describe("kick", () => {
  it("runs a tick at once, without waiting for the interval", async () => {
    let runs = 0;
    const handle = startInterval(60_000, () => {
      runs += 1;
    });
    handle.kick();
    const deadline = Date.now() + 2000;
    while (runs < 1 && Date.now() < deadline) await sleep(1);
    await handle.stop();
    expect(runs).toBe(1);
  });

  it("during a tick, runs one more once it ends, however often it is kicked", async () => {
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const handle = startInterval(60_000, async () => {
      runs += 1;
      if (runs === 1) await gate;
    });
    handle.kick();
    while (runs < 1) await sleep(1);
    handle.kick();
    handle.kick();
    handle.kick();
    expect(runs).toBe(1);
    release();
    const deadline = Date.now() + 2000;
    while (runs < 2 && Date.now() < deadline) await sleep(1);
    await sleep(20);
    await handle.stop();
    expect(runs).toBe(2);
  });

  it("does nothing once stopped", async () => {
    let runs = 0;
    const handle = startInterval(60_000, () => {
      runs += 1;
    });
    await handle.stop();
    handle.kick();
    await sleep(20);
    expect(runs).toBe(0);
  });
});
