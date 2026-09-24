// @vitest-environment jsdom
/**
 * Sign-in through the identity provider: when the login page may try it
 * silently, and what leaving for the provider sends.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAuthConfigForTest } from "./auth-config";
import { AuthError, describeError } from "./errors";
import {
  clearLinkPending,
  clearSilentAttempt,
  clearSsoHint,
  hasSsoHint,
  markLinkPending,
  noteSignOut,
  peekSilentAttempt,
  pendingLinkReturn,
  resetSilentAttemptForTest,
  selectAccountDue,
  setSsoHint,
  silentSignInDue,
  startProviderSignIn,
} from "./provider";
import { linkProvider } from "./sign-in";
import { setSession } from "./tokens";

const WITH_PROVIDER = { provider: { label: "Okta" }, unclaimed: false };

const fetchMock = vi.fn<typeof fetch>();
const assign = vi.fn();
const replace = vi.fn();
const originalLocation = window.location;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** The page's own facts on a plain visit: nobody signed in, nothing came back. */
const PLAIN = { signedIn: false, failedReturn: false, silentReturn: false };

beforeEach(() => {
  fetchMock.mockReset();
  assign.mockReset();
  replace.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  // jsdom cannot navigate; the address the page would leave for is what matters.
  Object.defineProperty(window, "location", { configurable: true, value: { ...originalLocation, assign, replace } });
  localStorage.clear();
  sessionStorage.clear();
  resetSilentAttemptForTest();
  setAuthConfigForTest(WITH_PROVIDER);
});

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
  setAuthConfigForTest(null);
});

describe("silentSignInDue", () => {
  it("is due once the provider signed someone in here before", () => {
    expect(silentSignInDue(PLAIN)).toBe(false);
    setSsoHint();
    expect(silentSignInDue(PLAIN)).toBe(true);
  });

  it("is not due without a provider, on an unclaimed node, or with a session", () => {
    setSsoHint();
    setAuthConfigForTest({ ...WITH_PROVIDER, provider: null });
    expect(silentSignInDue(PLAIN)).toBe(false);
    setAuthConfigForTest({ ...WITH_PROVIDER, unclaimed: true });
    expect(silentSignInDue(PLAIN)).toBe(false);
    setAuthConfigForTest(WITH_PROVIDER);
    expect(silentSignInDue({ ...PLAIN, signedIn: true })).toBe(false);
  });

  it("is never due on the way back from a failure, or from an attempt of its own", () => {
    setSsoHint();
    expect(silentSignInDue({ ...PLAIN, failedReturn: true })).toBe(false);
    expect(silentSignInDue({ ...PLAIN, silentReturn: true })).toBe(false);
  });

  it("waits a minute before trying again in the same tab, whatever came of the last attempt", async () => {
    setSsoHint();
    fetchMock.mockResolvedValue(json(200, { url: "https://id.example.com/authorize" }));
    await startProviderSignIn({ prompt: "none", returnTo: "/" });
    // A new page load: the memory is gone, the tab's record is not.
    resetSilentAttemptForTest();
    clearSilentAttempt();
    expect(silentSignInDue(PLAIN)).toBe(false);
    sessionStorage.setItem("stuga_sso_silent_at", String(Date.now() - 61_000));
    expect(silentSignInDue(PLAIN)).toBe(true);
  });

  it("runs at most once per page load, even when the node refuses it", async () => {
    setSsoHint();
    fetchMock.mockResolvedValue(json(502, { error: "provider_unreachable", message: "unreachable" }));
    await expect(startProviderSignIn({ prompt: "none", returnTo: "/" })).rejects.toBeInstanceOf(AuthError);
    expect(silentSignInDue(PLAIN)).toBe(false);
    // A second call in the same load (StrictMode's second effect) does not ask again.
    await startProviderSignIn({ prompt: "none", returnTo: "/" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("startProviderSignIn", () => {
  it("asks the node for the provider's address and leaves for it", async () => {
    fetchMock.mockResolvedValue(json(200, { url: "https://id.example.com/authorize?state=s" }));
    await startProviderSignIn({ returnTo: "/join/inv_abc" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/auth/oidc/start");
    expect(JSON.parse(String(init!.body))).toEqual({ return_to: "/join/inv_abc" });
    expect(new Headers(init!.headers).get("authorization")).toBeNull();
    expect(assign).toHaveBeenCalledWith("https://id.example.com/authorize?state=s");
    // Not silent, so its failure would be news.
    expect(peekSilentAttempt()).toBe(false);
  });

  it("marks a silent attempt across the round trip, and leaves in place of this page", async () => {
    fetchMock.mockResolvedValue(json(200, { url: "https://id.example.com/authorize" }));
    await startProviderSignIn({ prompt: "none", returnTo: "/" });
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({ return_to: "/", prompt: "none" });
    // Replaced, so Back from the provider skips the half-done sign-in.
    expect(replace).toHaveBeenCalledWith("https://id.example.com/authorize");
    expect(assign).not.toHaveBeenCalled();
    expect(peekSilentAttempt()).toBe(true);
    clearSilentAttempt();
    expect(peekSilentAttempt()).toBe(false);
  });

  it("asks for the account when told to, and spends the sign-out's request for it by leaving", async () => {
    noteSignOut();
    fetchMock.mockResolvedValue(json(200, { url: "https://id.example.com/authorize?prompt=select_account" }));
    await startProviderSignIn({ prompt: "select_account", returnTo: "/doc/d1" });
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({ return_to: "/doc/d1", prompt: "select_account" });
    // Interactive: pushed, so Back returns here.
    expect(assign).toHaveBeenCalledWith("https://id.example.com/authorize?prompt=select_account");
    expect(peekSilentAttempt()).toBe(false);
    expect(selectAccountDue()).toBe(false);
  });

  it("links to the signed-in account with its bearer", async () => {
    fetchMock.mockResolvedValue(json(200, { url: "https://id.example.com/authorize" }));
    await startProviderSignIn({ returnTo: "/settings/profile", bearer: "at-1" });
    expect(new Headers(fetchMock.mock.calls[0]![1]!.headers).get("authorization")).toBe("Bearer at-1");
  });

  it("stays put and says why when the node cannot reach the provider", async () => {
    fetchMock.mockResolvedValue(json(502, { error: "provider_unreachable", message: "The identity provider did not answer." }));
    const err = await startProviderSignIn({ returnTo: "/" }).catch((e: unknown) => e);
    expect(assign).not.toHaveBeenCalled();
    expect(describeError(err)).toBe("Couldn’t reach Okta. Try again, or sign in with your password.");
  });
});

describe("a pending link", () => {
  it("is marked with where it will be announced before leaving, and dropped when the start is refused", async () => {
    setSession({ accessToken: "at-1", refreshToken: "rt-1", expiresIn: 3600 });
    fetchMock.mockResolvedValueOnce(json(200, { url: "https://id.example.com/authorize" }));
    await linkProvider("/settings/profile");
    expect(pendingLinkReturn()).toBe("/settings/profile");
    clearLinkPending();

    fetchMock.mockResolvedValueOnce(json(502, { error: "provider_unreachable", message: "unreachable" }));
    await expect(linkProvider("/settings/profile")).rejects.toBeInstanceOf(AuthError);
    expect(pendingLinkReturn()).toBeNull();
  });

  it("is read back only as a path on this node", () => {
    markLinkPending("//evil.example/settings/profile");
    expect(pendingLinkReturn()).toBeNull();
    markLinkPending("/settings/profile");
    expect(pendingLinkReturn()).toBe("/settings/profile");
  });
});

describe("the hint", () => {
  it("is set and cleared", () => {
    expect(hasSsoHint()).toBe(false);
    setSsoHint();
    expect(hasSsoHint()).toBe(true);
    clearSsoHint();
    expect(hasSsoHint()).toBe(false);
  });
});
