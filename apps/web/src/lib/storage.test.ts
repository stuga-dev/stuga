// @vitest-environment jsdom
/** Storage helpers under the conditions that break Web Storage: absent, a throwing getter, refused writes. */
import { afterEach, describe, expect, it } from "vitest";
import { readStored, readStoredInt, removeStored, takeStored, writeStored } from "./storage";

type Slot = "localStorage" | "sessionStorage";

const original = new Map<Slot, PropertyDescriptor | undefined>();

/** Install a definition for a storage global, remembering what was there. */
function stub(slot: Slot, descriptor: PropertyDescriptor): void {
  if (!original.has(slot)) {
    original.set(slot, Object.getOwnPropertyDescriptor(globalThis, slot));
  }
  Object.defineProperty(globalThis, slot, { configurable: true, ...descriptor });
}

/** A working in-memory store, standing in for a permissive browser. */
function workingStore(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

afterEach(() => {
  for (const [slot, descriptor] of original) {
    if (descriptor) Object.defineProperty(globalThis, slot, descriptor);
    else delete (globalThis as Record<string, unknown>)[slot];
  }
  original.clear();
});

describe("when storage is absent", () => {
  it("reads null, reports failed writes, and lets removes pass", () => {
    stub("localStorage", { value: undefined });
    expect(readStored("local", "k")).toBeNull();
    expect(writeStored("local", "k", "v")).toBe(false);
    expect(() => removeStored("local", "k")).not.toThrow();
    expect(takeStored("local", "k")).toBeNull();
  });
});

describe("when the property getter itself throws", () => {
  // Chrome/Firefox with site data blocked: touching `window.localStorage` throws
  // SecurityError. This is the case a `typeof localStorage` check misses.
  it("survives a throwing accessor on every operation", () => {
    stub("localStorage", {
      get() {
        throw new DOMException("access denied", "SecurityError");
      },
    });
    expect(readStored("local", "k")).toBeNull();
    expect(writeStored("local", "k", "v")).toBe(false);
    expect(() => removeStored("local", "k")).not.toThrow();
    expect(readStoredInt("local", "k", { min: 0, max: 10, fallback: 4 })).toBe(4);
  });
});

describe("when the store exists but refuses writes", () => {
  // Safari Private Browsing: present, readable, zero quota.
  it("reports the failed write and keeps reading", () => {
    const store = workingStore();
    store.setItem("existing", "value");
    stub("localStorage", {
      value: {
        ...store,
        getItem: (k: string) => store.getItem(k),
        setItem: () => {
          throw new DOMException("quota exceeded", "QuotaExceededError");
        },
        removeItem: (k: string) => store.removeItem(k),
      },
    });
    expect(readStored("local", "existing")).toBe("value");
    expect(writeStored("local", "fresh", "v")).toBe(false);
    expect(readStored("local", "fresh")).toBeNull();
  });
});

describe("when storage works", () => {
  it("round-trips a value and reports the write as persisted", () => {
    stub("localStorage", { value: workingStore() });
    expect(writeStored("local", "k", "v")).toBe(true);
    expect(readStored("local", "k")).toBe("v");
    removeStored("local", "k");
    expect(readStored("local", "k")).toBeNull();
  });

  it("keeps local and session independent", () => {
    stub("localStorage", { value: workingStore() });
    stub("sessionStorage", { value: workingStore() });
    writeStored("local", "k", "from-local");
    writeStored("session", "k", "from-session");
    expect(readStored("local", "k")).toBe("from-local");
    expect(readStored("session", "k")).toBe("from-session");
  });

  it("takeStored returns the value and removes it in one step", () => {
    stub("sessionStorage", { value: workingStore() });
    writeStored("session", "once", "payload");
    expect(takeStored("session", "once")).toBe("payload");
    // Single-use: the PKCE verifier and state depend on this not surviving.
    expect(takeStored("session", "once")).toBeNull();
  });
});

describe("readStoredInt", () => {
  it("clamps, and falls back on anything unparseable", () => {
    stub("localStorage", { value: workingStore() });
    const bounds = { min: 100, max: 500, fallback: 240 };
    expect(readStoredInt("local", "w", bounds)).toBe(240); // absent

    writeStored("local", "w", "300");
    expect(readStoredInt("local", "w", bounds)).toBe(300);

    // Out of range in both directions — a stored width from a build with
    // different bounds must not escape the current ones.
    writeStored("local", "w", "9999");
    expect(readStoredInt("local", "w", bounds)).toBe(500);
    writeStored("local", "w", "-40");
    expect(readStoredInt("local", "w", bounds)).toBe(100);

    for (const junk of ["", "abc", "NaN", "Infinity", "{}"]) {
      writeStored("local", "w", junk);
      expect(readStoredInt("local", "w", bounds), `junk: ${junk}`).toBe(240);
    }

    // parseInt tolerates a trailing unit; keeping that is fine, since the value
    // still lands inside the clamp.
    writeStored("local", "w", "320px");
    expect(readStoredInt("local", "w", bounds)).toBe(320);
  });
});
