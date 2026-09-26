// @vitest-environment jsdom
/**
 * Sessions: how they are established, renewed and ended, and how a Web Storage
 * that refuses writes is reported rather than mistaken for a successful sign-in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authConfig,
  authConfigUnavailable,
  loadAuthConfig,
  nodeUnclaimed,
  providerLabel,
  setAuthConfigForTest,
  setupSearchLanguages,
} from "./auth-config";
import { AuthError, describeError, StorageBlockedError } from "./errors";
import { hasSsoHint, selectAccountDue, setSsoHint } from "./provider";
import { peekLoginReturn, pendingInviteToken, rememberLoginReturn, safeReturn, takeLoginReturn } from "./return-path";
import { signInWithPassword, signUp } from "./sign-in";
import { clearTokens, ensureFreshToken, getToken, logout, setSession } from "./tokens";

const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
let stubbed = false;

function stubLocalStorage(value: unknown): void {
  stubbed = true;
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value });
}

/** A permissive store, standing in for a browser that allows site data. */
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

/** Safari private mode / an exhausted origin quota: reads fine, writes throw. */
function readOnlyStore(): Storage {
  const store = workingStore();
  return {
    ...store,
    getItem: (k: string) => store.getItem(k),
    removeItem: (k: string) => store.removeItem(k),
    setItem: () => {
      throw new DOMException("quota exceeded", "QuotaExceededError");
    },
  } as Storage;
}

const SESSION = { accessToken: "at-1", refreshToken: "rt-1", expiresIn: 3600 };

/** A JSON response the way the node's routes send one. */
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  setAuthConfigForTest(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (!stubbed) return;
  if (originalDescriptor) Object.defineProperty(globalThis, "localStorage", originalDescriptor);
  else delete (globalThis as Record<string, unknown>).localStorage;
  stubbed = false;
});

function lastRequest(): { url: string; init: RequestInit } {
  const call = fetchMock.mock.calls.at(-1);
  if (!call) throw new Error("fetch was not called");
  const [input, init] = call;
  return { url: String(input), init: init ?? {} };
}

describe("loadAuthConfig", () => {
  /** A claimed node with no provider, as /auth/config answers. */
  const CONFIG = {
    provider: null,
    unclaimed: false,
    node_name: "Acme",
    node_label: "Acme",
    origin: "https://acme.example",
    branding: { accent_color: "#7c3aed" },
    search_languages: null,
  };

  it("reads a node with no identity provider from /auth/config", async () => {
    fetchMock.mockResolvedValueOnce(json(200, { provider: null, unclaimed: false }));
    await loadAuthConfig();
    expect(lastRequest().url).toBe("/auth/config");
    expect(providerLabel()).toBeNull();
    expect(authConfigUnavailable()).toBe(false);
    expect(nodeUnclaimed()).toBe(false);
  });

  it("reads an unclaimed node", async () => {
    fetchMock.mockResolvedValueOnce(json(200, { provider: null, unclaimed: true }));
    await loadAuthConfig();
    expect(nodeUnclaimed()).toBe(true);
    expect(setupSearchLanguages()).toBeNull();
  });

  it("reads the search languages setup starts from, and none from a list that is not of the choices", async () => {
    fetchMock.mockResolvedValueOnce(json(200, { provider: null, unclaimed: true, search_languages: ["ar", "ko"] }));
    await loadAuthConfig();
    expect(setupSearchLanguages()).toEqual(["ko", "ar"]);
    fetchMock.mockResolvedValueOnce(json(200, { provider: null, unclaimed: true, search_languages: ["ko", "fr"] }));
    await loadAuthConfig();
    expect(setupSearchLanguages()).toBeNull();
  });

  it("reads the identity provider's button text, and nothing else about it", async () => {
    fetchMock.mockResolvedValueOnce(json(200, { ...CONFIG, provider: { label: " Okta " } }));
    await loadAuthConfig();
    expect(providerLabel()).toBe("Okta");
    expect(authConfig().provider).toEqual({ label: "Okta" });
  });

  it("reads the node's name, label and origin from the top level, and its branding apart from them", async () => {
    fetchMock.mockResolvedValueOnce(json(200, CONFIG));
    await loadAuthConfig();
    expect(authConfig()).toEqual({
      provider: null,
      unclaimed: false,
      nodeName: "Acme",
      nodeLabel: "Acme",
      origin: "https://acme.example",
      branding: { accentColor: "#7c3aed" },
      searchLanguages: null,
    });
  });

  it("keeps the config it has when a reload fails, rather than falling back", async () => {
    fetchMock.mockResolvedValueOnce(json(200, { ...CONFIG, provider: { label: "Okta" } }));
    await loadAuthConfig();
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await loadAuthConfig();
    expect(providerLabel()).toBe("Okta");
    expect(authConfig().nodeName).toBe("Acme");
    expect(authConfigUnavailable()).toBe(false);

    fetchMock.mockResolvedValueOnce(json(503, { error: "unavailable" }));
    await loadAuthConfig();
    expect(providerLabel()).toBe("Okta");
    expect(authConfigUnavailable()).toBe(false);
  });

  it("treats a provider with no label as none", async () => {
    fetchMock.mockResolvedValueOnce(json(200, { provider: { label: "" }, unclaimed: false }));
    await loadAuthConfig();
    expect(providerLabel()).toBeNull();
  });

  it("falls back to a claimed node with passwords only when the fetch fails, and says so", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(loadAuthConfig()).resolves.toBeUndefined();
    expect(authConfig()).toEqual({
      provider: null,
      unclaimed: false,
      nodeName: null,
      nodeLabel: null,
      origin: null,
      branding: { accentColor: null },
      searchLanguages: null,
    });
    expect(authConfigUnavailable()).toBe(true);
    expect(nodeUnclaimed()).toBe(false);

    // Still nothing to keep: a second failure leaves the fallback, and says so.
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await loadAuthConfig();
    expect(authConfigUnavailable()).toBe(true);
    fetchMock.mockResolvedValueOnce(json(200, CONFIG));
    await loadAuthConfig();
    expect(authConfigUnavailable()).toBe(false);
    expect(authConfig().nodeName).toBe("Acme");
  });
});

describe("signInWithPassword", () => {
  it("posts to /auth/login and returns the session to persist", async () => {
    fetchMock.mockResolvedValueOnce(json(200, { access_token: "at-9", refresh_token: "rt-9", expires_in: 900 }));
    const session = await signInWithPassword("ann", "hunter22");
    const { url, init } = lastRequest();
    expect(url).toBe("/auth/login");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ username: "ann", password: "hunter22" });
    expect(session).toEqual({ accessToken: "at-9", refreshToken: "rt-9", expiresIn: 900 });
  });

  it("surfaces a refusal with its status, in words a person can act on", async () => {
    fetchMock.mockResolvedValueOnce(json(401, { error: "invalid credentials" }));
    const err = await signInWithPassword("ann", "nope").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).status).toBe(401);
    expect(describeError(err)).toMatch(/don't match/);
  });

  it("refuses a response with no usable token", async () => {
    fetchMock.mockResolvedValueOnce(json(200, { ok: true }));
    await expect(signInWithPassword("ann", "hunter22")).rejects.toBeInstanceOf(AuthError);
  });
});

describe("signUp", () => {
  it("posts to /auth/register with the optional name and returns a session", async () => {
    fetchMock.mockResolvedValueOnce(json(201, { access_token: "at-2", refresh_token: "rt-2", expires_in: 900 }));
    const session = await signUp("bo", "hunter22", { name: "  Bo  " });
    const { url, init } = lastRequest();
    expect(url).toBe("/auth/register");
    expect(JSON.parse(String(init.body))).toEqual({ username: "bo", password: "hunter22", name: "Bo" });
    expect(session.accessToken).toBe("at-2");
  });

  it("omits an empty name", async () => {
    fetchMock.mockResolvedValueOnce(json(201, { access_token: "at-2", expires_in: 900 }));
    await signUp("bo", "hunter22", { name: "   " });
    expect(JSON.parse(String(lastRequest().init.body))).toEqual({ username: "bo", password: "hunter22" });
  });

  /** The node sends a code, not prose, in `error` on these refusals. */
  it("turns the node's error codes into prose, never showing the code", async () => {
    const cases: Array<[string, RegExp]> = [
      ["invite_invalid", /no longer valid/],
      ["invite_required", /needs an invite link/],
    ];
    for (const [code, expected] of cases) {
      fetchMock.mockResolvedValueOnce(json(403, { error: code }));
      const msg = describeError(await signUp("x", "hunter22").catch((e: unknown) => e));
      expect(msg).toMatch(expected);
      expect(msg).not.toContain(code);
    }
  });

  it("explains a refused username with the rule, not the code", async () => {
    fetchMock.mockResolvedValueOnce(json(400, { error: "invalid_username" }));
    const msg = describeError(await signUp("Not Valid", "hunter22").catch((e: unknown) => e));
    expect(msg).toMatch(/lowercase letters/);
    expect(msg).not.toContain("invalid_username");
  });

  it("names a closed sign-up and a taken username distinctly", async () => {
    fetchMock.mockResolvedValueOnce(json(403, { error: "some_unmapped_code" }));
    expect(describeError(await signUp("x", "hunter22").catch((e: unknown) => e))).toMatch(/invitation/);
    fetchMock.mockResolvedValueOnce(json(409, { error: "exists" }));
    expect(describeError(await signUp("x", "hunter22").catch((e: unknown) => e))).toMatch(/username is taken/);
  });

  it("carries the node's suggestion with a refused username, and names a reserved one", async () => {
    fetchMock.mockResolvedValueOnce(json(409, { error: "username_reserved", message: "reserved", suggestion: "admin-2" }));
    const err = (await signUp("admin", "hunter22").catch((e: unknown) => e)) as AuthError;
    expect(err.suggestion).toBe("admin-2");
    expect(describeError(err)).toMatch(/reserved/);
    expect(describeError(err)).not.toContain("username_reserved");
  });

  it("shows the node's own sentence for a 400 it has no words for, never the code", async () => {
    fetchMock.mockResolvedValueOnce(json(400, { error: "bad_request", message: "A name is too long." }));
    expect(describeError(await signUp("x", "hunter22").catch((e: unknown) => e))).toBe("A name is too long.");
  });

  it("forwards an invite token to the node, trimmed, and omits it when blank", async () => {
    fetchMock.mockResolvedValueOnce(json(201, { access_token: "a", refresh_token: "r", expires_in: 60 }));
    await signUp("x", "hunter22", { name: "X", invite: "  inv_abc  " });
    expect(JSON.parse(String(lastRequest().init.body)).invite).toBe("inv_abc");

    fetchMock.mockResolvedValueOnce(json(201, { access_token: "a", refresh_token: "r", expires_in: 60 }));
    await signUp("x", "hunter22", { name: "X", invite: "   " });
    expect(JSON.parse(String(lastRequest().init.body))).not.toHaveProperty("invite");

    fetchMock.mockResolvedValueOnce(json(201, { access_token: "a", refresh_token: "r", expires_in: 60 }));
    await signUp("x", "hunter22");
    expect(JSON.parse(String(lastRequest().init.body))).not.toHaveProperty("invite");
  });
});

describe("the login-return stash", () => {
  let store: Storage;
  const originalSession = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");

  beforeEach(() => {
    store = workingStore();
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: store });
  });
  afterEach(() => {
    if (originalSession) Object.defineProperty(globalThis, "sessionStorage", originalSession);
    else delete (globalThis as Record<string, unknown>).sessionStorage;
  });

  it("round-trips a real destination", () => {
    rememberLoginReturn("/join/inv_abc");
    expect(takeLoginReturn()).toBe("/join/inv_abc");
    // One-shot: spent by the read.
    expect(takeLoginReturn()).toBe("/");
  });

  it("refuses to store a page sign-in passes through, so none can clobber a real destination", () => {
    rememberLoginReturn("/join/inv_abc");
    rememberLoginReturn("/login");
    rememberLoginReturn("/login?next=x");
    rememberLoginReturn("/auth/complete");
    rememberLoginReturn("/auth/first-visit#ticket=t");
    rememberLoginReturn("/reset/rst_abc");
    expect(takeLoginReturn()).toBe("/join/inv_abc");
  });

  it("refuses a path a browser would read as another origin (open redirect)", () => {
    rememberLoginReturn("//evil.example/join/x");
    rememberLoginReturn("/\\evil.example/join/x");
    expect(takeLoginReturn()).toBe("/");
  });

  it("refuses control characters, which a browser strips into another origin, as the node does", () => {
    // "/\t/evil.example" is fetched as "//evil.example".
    for (const path of ["/\t/evil.example", "/\n/evil.example", "/\r/evil.example", "/doc/d1\u0000", "/doc/d1\u007f"]) {
      expect(safeReturn(path)).toBe("/");
      rememberLoginReturn(path);
      expect(takeLoginReturn()).toBe("/");
    }
    expect(safeReturn("/doc/d1?q=two words")).toBe("/doc/d1?q=two words");
  });

  it("refuses a destination longer than the node would carry", () => {
    expect(safeReturn(`/doc/${"a".repeat(2043)}`)).toBe(`/doc/${"a".repeat(2043)}`);
    expect(safeReturn(`/doc/${"a".repeat(2044)}`)).toBe("/");
  });

  it("peeks without spending, for a sign-in that leaves for the identity provider", () => {
    rememberLoginReturn("/doc/d1");
    expect(peekLoginReturn()).toBe("/doc/d1");
    expect(peekLoginReturn()).toBe("/doc/d1");
    expect(takeLoginReturn()).toBe("/doc/d1");
    expect(peekLoginReturn()).toBe("/");
  });

  it("holds a destination the node hands back to the same rules", () => {
    expect(safeReturn("/join/inv_abc")).toBe("/join/inv_abc");
    expect(safeReturn(undefined)).toBe("/");
    expect(safeReturn("https://evil.example/")).toBe("/");
    expect(safeReturn("//evil.example/")).toBe("/");
    expect(safeReturn("/auth/first-visit")).toBe("/");
    expect(safeReturn("/reset/rst_abc")).toBe("/");
    expect(safeReturn("/resets")).toBe("/resets");
  });
});

describe("pendingInviteToken", () => {
  const originalSession = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  let store: Storage;
  beforeEach(() => {
    store = workingStore();
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: store });
  });
  afterEach(() => {
    if (originalSession) Object.defineProperty(globalThis, "sessionStorage", originalSession);
    else delete (globalThis as Record<string, unknown>).sessionStorage;
  });

  it("reads the token WITHOUT consuming it — the sign-in path still needs it", () => {
    rememberLoginReturn("/join/inv_abc");
    expect(pendingInviteToken()).toBe("inv_abc");
    expect(pendingInviteToken()).toBe("inv_abc");
    expect(takeLoginReturn()).toBe("/join/inv_abc");
  });

  it("ignores a query string and a hash", () => {
    rememberLoginReturn("/join/inv_abc?x=1#y");
    expect(pendingInviteToken()).toBe("inv_abc");
  });

  it("is /join-only and refuses anything that is not a plain token", () => {
    for (const path of ["/doc/abc", "/s/share_tok", "/join/", "//evil.example/join/x", "/joinx/abc"]) {
      store.clear();
      // written directly: rememberLoginReturn would refuse some of these anyway
      store.setItem(KEY_FOR_TEST, path);
      expect(pendingInviteToken()).toBeNull();
    }
  });

  it("returns null with no stash at all", () => {
    expect(pendingInviteToken()).toBeNull();
  });
});

const KEY_FOR_TEST = "stuga_login_return";

describe("ensureFreshToken", () => {
  beforeEach(() => {
    stubLocalStorage(workingStore());
    // Renewal is the node's own whatever else the node offers.
    setAuthConfigForTest({ provider: { label: "Okta" } });
  });

  // jsdom has no Web Locks; one test installs a stand-in and this removes it.
  afterEach(() => {
    Reflect.deleteProperty(globalThis.navigator as object, "locks");
  });

  it("returns the stored token untouched while it is still fresh", async () => {
    setSession(SESSION);
    await expect(ensureFreshToken()).resolves.toBe("at-1");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renews through /auth/refresh once the token is about to expire", async () => {
    // 30s left: inside the 60s renewal window.
    setSession({ ...SESSION, expiresIn: 30 });
    fetchMock.mockResolvedValueOnce(json(200, { access_token: "at-2", refresh_token: "rt-2", expires_in: 900 }));
    await expect(ensureFreshToken()).resolves.toBe("at-2");
    const { url, init } = lastRequest();
    expect(url).toBe("/auth/refresh");
    expect(JSON.parse(String(init.body))).toEqual({ refresh_token: "rt-1" });
    // The renewed session is what the next call reads.
    expect(getToken()).toBe("at-2");
    await expect(ensureFreshToken()).resolves.toBe("at-2");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the old refresh token when the node rotates only the access token", async () => {
    setSession({ ...SESSION, expiresIn: 10 });
    fetchMock.mockResolvedValueOnce(json(200, { access_token: "at-3", expires_in: 1 }));
    await expect(ensureFreshToken()).resolves.toBe("at-3");
    fetchMock.mockResolvedValueOnce(json(200, { access_token: "at-4", expires_in: 900 }));
    await expect(ensureFreshToken()).resolves.toBe("at-4");
    expect(JSON.parse(String(lastRequest().init.body))).toEqual({ refresh_token: "rt-1" });
  });

  it("ends the session when the node refuses the refresh", async () => {
    setSession({ ...SESSION, expiresIn: 10 });
    fetchMock.mockResolvedValueOnce(json(401, { error: "revoked" }));
    await expect(ensureFreshToken()).resolves.toBeNull();
    expect(getToken()).toBeNull();
  });

  it("ends the session when there is nothing to refresh with", async () => {
    setSession({ accessToken: "at-1", expiresIn: 10 });
    await expect(ensureFreshToken()).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /** A refresh token is one-use: the node reads a second presentation as a replay and revokes every session. */
  it("renews once no matter how many callers wake on the same expiring token", async () => {
    setSession({ ...SESSION, expiresIn: 10 });
    fetchMock.mockResolvedValueOnce(json(200, { access_token: "at-2", refresh_token: "rt-2", expires_in: 900 }));

    const all = await Promise.all([ensureFreshToken(), ensureFreshToken(), ensureFreshToken()]);

    expect(all).toEqual(["at-2", "at-2", "at-2"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(lastRequest().init.body))).toEqual({ refresh_token: "rt-1" });
  });

  it("renews again on a later expiry, so the single-flight guard is not a one-shot", async () => {
    setSession({ ...SESSION, expiresIn: 10 });
    fetchMock.mockResolvedValueOnce(json(200, { access_token: "at-2", refresh_token: "rt-2", expires_in: 1 }));
    await expect(ensureFreshToken()).resolves.toBe("at-2");
    fetchMock.mockResolvedValueOnce(json(200, { access_token: "at-3", refresh_token: "rt-3", expires_in: 900 }));
    await expect(ensureFreshToken()).resolves.toBe("at-3");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  /** An unanswered renewal says nothing about the session, unlike a refusal. */
  it("keeps the session when the node cannot be reached", async () => {
    setSession({ ...SESSION, expiresIn: 10 });
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(ensureFreshToken()).resolves.toBe("at-1");
    expect(getToken()).toBe("at-1");
  });

  it("keeps the session when the node answers 500", async () => {
    setSession({ ...SESSION, expiresIn: 10 });
    fetchMock.mockResolvedValueOnce(json(500, { error: "database unavailable" }));
    await expect(ensureFreshToken()).resolves.toBe("at-1");
    expect(getToken()).toBe("at-1");
  });

  it("retries a renewal that failed transiently rather than staying stuck on it", async () => {
    setSession({ ...SESSION, expiresIn: 10 });
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(ensureFreshToken()).resolves.toBe("at-1");
    fetchMock.mockResolvedValueOnce(json(200, { access_token: "at-2", refresh_token: "rt-2", expires_in: 900 }));
    await expect(ensureFreshToken()).resolves.toBe("at-2");
  });

  /** The tab that waited for the lock re-reads storage and finds the winner's token. */
  it("takes the token another tab just wrote instead of presenting a spent one", async () => {
    setSession({ ...SESSION, expiresIn: 10 });
    Object.defineProperty(globalThis.navigator, "locks", {
      configurable: true,
      value: {
        request: async (_name: string, fn: () => Promise<string | null>) => {
          // Another tab finishing its rotation while this one waited.
          setSession({ accessToken: "at-other-tab", refreshToken: "rt-2", expiresIn: 3600 });
          return fn();
        },
      },
    });

    await expect(ensureFreshToken()).resolves.toBe("at-other-tab");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renews unlocked when the browser exposes no lock manager", async () => {
    // Plain HTTP on a LAN address is not a secure context, so navigator.locks is absent.
    expect("locks" in globalThis.navigator).toBe(false);
    setSession({ ...SESSION, expiresIn: 10 });
    fetchMock.mockResolvedValueOnce(json(200, { access_token: "at-2", refresh_token: "rt-2", expires_in: 900 }));
    await expect(ensureFreshToken()).resolves.toBe("at-2");
  });
});

describe("setSession", () => {
  it("persists a session when storage accepts it", () => {
    stubLocalStorage(workingStore());
    expect(() => setSession(SESSION)).not.toThrow();
    expect(getToken()).toBe("at-1");
  });

  it("throws StorageBlockedError when the write is refused", () => {
    stubLocalStorage(readOnlyStore());
    expect(() => setSession(SESSION)).toThrow(StorageBlockedError);
    expect(getToken()).toBeNull();
  });

  it("throws when storage is missing entirely", () => {
    stubLocalStorage(undefined);
    expect(() => setSession(SESSION)).toThrow(StorageBlockedError);
  });

  it("carries the actionable message, not a generic one", () => {
    stubLocalStorage(readOnlyStore());
    expect(() => setSession(SESSION)).toThrow(new StorageBlockedError().message);
    expect(new StorageBlockedError().message).toContain("site data");
    expect(describeError(new StorageBlockedError())).toBe(new StorageBlockedError().message);
  });
});

describe("logout", () => {
  it("drops the session, revokes it at the node and revokes the media cookie", () => {
    stubLocalStorage(workingStore());
    fetchMock.mockResolvedValue(json(200, {}));
    setSession(SESSION);
    logout();
    expect(getToken()).toBeNull();
    const requests = fetchMock.mock.calls.map(([url, init]) => `${init?.method ?? "GET"} ${String(url)}`);
    expect(requests).toContain("DELETE /api/media/ticket");
    expect(requests).toContain("POST /auth/logout");
  });

  it("forgets the provider hint, or the login page would sign straight back in", () => {
    stubLocalStorage(workingStore());
    fetchMock.mockResolvedValue(json(200, {}));
    setSession(SESSION);
    setSsoHint();
    logout();
    expect(hasSsoHint()).toBe(false);
  });

  it("has the next sign-in through the provider ask which account, since the provider's own session lives on", () => {
    stubLocalStorage(workingStore());
    fetchMock.mockResolvedValue(json(200, {}));
    setSession(SESSION);
    expect(selectAccountDue()).toBe(false);
    logout();
    expect(selectAccountDue()).toBe(true);
    // A sign-in through the provider settles the choice.
    setSsoHint();
    expect(selectAccountDue()).toBe(false);
  });
});

describe("clearTokens", () => {
  it("removes the session and never throws on a blocked store", () => {
    stubLocalStorage(workingStore());
    setSession(SESSION);
    clearTokens();
    expect(getToken()).toBeNull();

    stubLocalStorage(readOnlyStore());
    expect(() => clearTokens()).not.toThrow();
  });
});
