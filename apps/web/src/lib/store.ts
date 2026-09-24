/** Module-level state shared by every mounted consumer, and cached server reads. */
import { useSyncExternalStore } from "react";

export interface Store<T> {
  get(): T;
  set(next: T): void;
  update(fn: (current: T) => T): void;
  subscribe(listener: () => void): () => void;
}

/** A value plus its listeners. Treat the value as immutable: `set` a new one, never mutate it. */
export function createStore<T>(initial: T): Store<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  const set = (next: T) => {
    if (Object.is(next, value)) return;
    value = next;
    for (const listener of listeners) listener();
  };
  return {
    get: () => value,
    set,
    update: (fn) => set(fn(value)),
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

interface CachedResource<T> {
  /** The fresh cached value, or undefined. Never starts a request. */
  peek(): T | undefined;
  /** The fresh cached value, else one request shared by every concurrent caller. A failure is not cached. */
  get(): Promise<T>;
  /** Drop the cached value and tell subscribers; a request already in flight cannot write its answer. */
  invalidate(): void;
  /** Called on every invalidation. */
  subscribe(listener: () => void): () => void;
}

export function cachedResource<T>(load: () => Promise<T>, ttlMs = Number.POSITIVE_INFINITY): CachedResource<T> {
  let cached: { value: T; expiresAt: number } | null = null;
  let inflight: Promise<T> | null = null;
  let generation = 0;
  const invalidations = createStore(0);

  const fresh = () => (cached && cached.expiresAt > Date.now() ? cached : null);

  return {
    peek: () => fresh()?.value,
    get() {
      const hit = fresh();
      if (hit) return Promise.resolve(hit.value);
      if (inflight) return inflight;
      const gen = generation;
      const request = load()
        .then((value) => {
          if (gen === generation) cached = { value, expiresAt: Date.now() + ttlMs };
          return value;
        })
        .finally(() => {
          if (inflight === request) inflight = null;
        });
      inflight = request;
      return request;
    },
    invalidate() {
      cached = null;
      inflight = null;
      generation += 1;
      invalidations.update((n) => n + 1);
    },
    subscribe: invalidations.subscribe,
  };
}
