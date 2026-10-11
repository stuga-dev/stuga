/**
 * The active workspace pointer outlives a session in localStorage, so signing
 * out clears it, and a server that resolves no active workspace clears it too.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { getActiveWorkspace, rememberWorkspaceName, setActiveWorkspace } from "./workspace-pointer";
import { adoptActiveWorkspace, clearMembershipEnded, membershipEnded } from "./endings";
import { clearTokens } from "./tokens";

function stubStorage(store: Map<string, string>) {
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  };
}
const store = new Map<string, string>();
const localStorageStub = stubStorage(store);
const sessionStorageStub = stubStorage(new Map());

/** The sync WorkspaceLayout and WorkspaceSwitcher perform. */
function syncActive(serverActive: string | null): void {
  if (getActiveWorkspace() !== serverActive) setActiveWorkspace(serverActive);
}

describe("active workspace pointer", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", localStorageStub);
    vi.stubGlobal("sessionStorage", sessionStorageStub);
    store.clear();
    sessionStorageStub.clear();
  });

  it("round-trips a workspace id", () => {
    setActiveWorkspace("ws-abc");
    expect(getActiveWorkspace()).toBe("ws-abc");
  });

  it("is cleared by signing out, so the next account can't inherit it", () => {
    setActiveWorkspace("ws-previous-account");
    clearTokens();
    expect(getActiveWorkspace()).toBeNull();
  });

  it("is cleared when the server resolves no active workspace", () => {
    // A fresh account with zero memberships: the server returns active: null.
    setActiveWorkspace("ws-previous-account");
    syncActive(null);
    expect(getActiveWorkspace()).toBeNull();
  });

  it("adopts the server's choice over a stale local one", () => {
    setActiveWorkspace("ws-stale");
    syncActive("ws-real");
    expect(getActiveWorkspace()).toBe("ws-real");
  });

  it("notes, once the list comes back empty, that the workspace this browser had open ended, before forgetting it", () => {
    setActiveWorkspace("ws-bakery");
    rememberWorkspaceName("ws-bakery", "Liv's Bakery");
    adoptActiveWorkspace(null, 0);
    expect(getActiveWorkspace()).toBeNull();
    expect(membershipEnded()).toBe("Liv's Bakery");
  });

  it("notes nothing for an account that never had a workspace, or that still has one", () => {
    adoptActiveWorkspace(null, 0);
    expect(membershipEnded()).toBeNull();
    setActiveWorkspace("ws-stale");
    adoptActiveWorkspace("ws-real", 1);
    expect(getActiveWorkspace()).toBe("ws-real");
    expect(membershipEnded()).toBeNull();
    clearMembershipEnded();
  });

  it("leaves an already-correct pointer untouched", () => {
    setActiveWorkspace("ws-real");
    syncActive("ws-real");
    expect(getActiveWorkspace()).toBe("ws-real");
  });
});
