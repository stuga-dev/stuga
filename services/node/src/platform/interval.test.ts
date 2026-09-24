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
