import { beforeEach, describe, expect, it, vi } from "vitest";
import { rateLimitRefusal } from "./rate-limit.js";
import type { NodeEnv } from "../env.js";

/** A limiter that allows the first `allow` calls, then refuses. */
function limiter(allow: number) {
  let seen = 0;
  const fn = vi.fn(async (_options: { key: string }) => ({ success: seen++ < allow }));
  return { limit: fn, calls: () => fn.mock.calls };
}

function envWith(allow: number) {
  const standard = limiter(allow);
  return { env: { rateLimit: standard } as unknown as Pick<NodeEnv, "rateLimit">, standard };
}

const check = (env: Pick<NodeEnv, "rateLimit">, principal = "user-1", ws = "ws1") =>
  rateLimitRefusal(env, principal, ws);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("within the budget", () => {
  it("answers after one limiter call", async () => {
    const { env, standard } = envWith(1);
    expect(await check(env)).toBeNull();
    expect(standard.limit).toHaveBeenCalledTimes(1);
  });

  it("keys the budget on the workspace and the principal", async () => {
    const { env, standard } = envWith(99);
    await check(env, "user-1", "ws1");
    await check(env, "user-1", "ws2");
    await check(env, "agent:bot", "ws1");
    const keys = standard.calls().map((c) => c[0].key);
    expect(new Set(keys).size).toBe(3);
    expect(keys).toContain("ws1:user-1");
  });
});

describe("past the limit", () => {
  it("refuses with 429", async () => {
    const { env } = envWith(0);
    const res = await check(env);
    expect(res?.status).toBe(429);
  });

  it("sets Retry-After to the whole window", async () => {
    const { env } = envWith(0);
    const res = await check(env);
    expect(res?.headers.get("retry-after")).toBe("60");
  });

  it("applies one limit to every workspace", async () => {
    const { env } = envWith(1);
    expect(await check(env, "u", "ws-any")).toBeNull();
    expect((await check(env, "u", "ws-any"))?.status).toBe(429);
  });
});
