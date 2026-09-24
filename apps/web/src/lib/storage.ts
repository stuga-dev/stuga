/**
 * Web Storage access that cannot throw. Blocked site data makes the
 * `localStorage` getter itself throw, private modes refuse writes, and test hosts
 * lack the globals; reads degrade to null and writes report failure. A failed
 * write is never faked in memory: a session that dies on reload is worse.
 */

type Kind = "local" | "session";

/** Not memoized: permission can change mid-session. */
function store(kind: Kind): Storage | null {
  try {
    const s = kind === "local" ? globalThis.localStorage : globalThis.sessionStorage;
    return s ?? null;
  } catch {
    return null;
  }
}

export function readStored(kind: Kind, key: string): string | null {
  try {
    return store(kind)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** Whether the write persisted. */
export function writeStored(kind: Kind, key: string, value: string): boolean {
  try {
    const s = store(kind);
    if (!s) return false;
    s.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function removeStored(kind: Kind, key: string): void {
  try {
    store(kind)?.removeItem(key);
  } catch {
    /* already unreachable */
  }
}

/** An integer clamped to `[min, max]`; `fallback` when absent or unparseable. */
export function readStoredInt(
  kind: Kind,
  key: string,
  { min, max, fallback }: { min: number; max: number; fallback: number },
): number {
  const n = parseInt(readStored(kind, key) ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Read and remove, for one-shot handoffs. */
export function takeStored(kind: Kind, key: string): string | null {
  const value = readStored(kind, key);
  if (value !== null) removeStored(kind, key);
  return value;
}
