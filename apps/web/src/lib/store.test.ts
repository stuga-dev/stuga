import { describe, expect, it, vi } from "vitest";
import { cachedResource, createStore } from "./store";

describe("createStore", () => {
  it("notifies subscribers on a change and not on the same value", () => {
    const store = createStore(1);
    const listener = vi.fn();
    const stop = store.subscribe(listener);
    store.set(1);
    expect(listener).not.toHaveBeenCalled();
    store.update((n) => n + 1);
    expect(store.get()).toBe(2);
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
    store.set(3);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("cachedResource", () => {
  it("shares one request between concurrent callers and serves the cache after it", async () => {
    const load = vi.fn(async () => "value");
    const resource = cachedResource(load);
    expect(resource.peek()).toBeUndefined();
    const [a, b] = await Promise.all([resource.get(), resource.get()]);
    expect([a, b]).toEqual(["value", "value"]);
    await resource.get();
    expect(load).toHaveBeenCalledTimes(1);
    expect(resource.peek()).toBe("value");
  });

  it("asks again once the value is older than its lifetime", async () => {
    vi.useFakeTimers();
    try {
      const load = vi.fn(async () => Date.now());
      const resource = cachedResource(load, 1_000);
      await resource.get();
      vi.advanceTimersByTime(1_001);
      expect(resource.peek()).toBeUndefined();
      await resource.get();
      expect(load).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not cache a failure", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValueOnce("up");
    const resource = cachedResource<string>(load);
    await expect(resource.get()).rejects.toThrow("down");
    await expect(resource.get()).resolves.toBe("up");
  });

  it("keeps an answer that started before an invalidation out of the cache", async () => {
    let release!: (v: string) => void;
    const load = vi
      .fn<() => Promise<string>>()
      .mockImplementationOnce(() => new Promise((resolve) => (release = resolve)))
      .mockResolvedValueOnce("after");
    const resource = cachedResource(load);
    const listener = vi.fn();
    resource.subscribe(listener);
    const stale = resource.get();
    resource.invalidate();
    release("before");
    await expect(stale).resolves.toBe("before");
    expect(resource.peek()).toBeUndefined();
    await expect(resource.get()).resolves.toBe("after");
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
