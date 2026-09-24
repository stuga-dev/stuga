import { describe, expect, it } from "vitest";
import { slidingWindowRateLimiter } from "./rate-limit.js";

describe("slidingWindowRateLimiter", () => {
  it("allows `limit` hits per window and lets them back in as the window slides", async () => {
    const clock = { now: 1_000_000 };
    const rl = slidingWindowRateLimiter({ limit: 3, windowSeconds: 10, now: () => clock.now });
    const hit = () => rl.limit({ key: "u1" }).then((r) => r.success);

    expect(await hit()).toBe(true);
    clock.now += 2000;
    expect(await hit()).toBe(true);
    clock.now += 2000;
    expect(await hit()).toBe(true);
    expect(await hit()).toBe(false);
    expect((await rl.limit({ key: "u2" })).success).toBe(true); // keys are independent

    clock.now += 5000; // 9s after the first hit: still inside its window
    expect(await hit()).toBe(false);
    clock.now += 1000; // 10s: the first hit falls out
    expect(await hit()).toBe(true);
    expect(await hit()).toBe(false);
  });

  it("evicts keys that have gone quiet for a window, and caps the key count", async () => {
    const clock = { now: 0 };
    const rl = slidingWindowRateLimiter({ limit: 2, windowSeconds: 1, maxKeys: 3, now: () => clock.now });
    for (const key of ["a", "b", "c"]) await rl.limit({ key });
    expect(rl.size()).toBe(3);
    await rl.limit({ key: "d" }); // over the cap: the least recently seen key goes
    expect(rl.size()).toBe(3);

    clock.now = 5000;
    await rl.limit({ key: "e" }); // a sweep runs once a full window has passed
    expect(rl.size()).toBe(1);
  });
});
