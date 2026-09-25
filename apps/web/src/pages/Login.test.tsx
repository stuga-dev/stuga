// @vitest-environment jsdom
/** The sign-in page: the node's name, and the identity-provider parts (the button, the silent attempt, a failed return). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { Login } from "./Login";
import { setAuthConfigForTest } from "../lib/session/auth-config";
import {
  hasSsoHint,
  markLinkPending,
  noteSignOut,
  peekSilentAttempt,
  resetSilentAttemptForTest,
  selectAccountDue,
  setSsoHint,
} from "../lib/session/provider";
import { rememberLoginReturn } from "../lib/session/return-path";
import { setSession } from "../lib/session/tokens";

/** A node nobody has named goes by its host. */
const NODE_NAME = "livs-air.local:8787";

const fetchMock = vi.fn<typeof fetch>();
const assign = vi.fn();
const replace = vi.fn();
const originalLocation = window.location;
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let host: HTMLDivElement;
let root: Root;

/** The address the page is on, as the router sees it. */
function Where() {
  const loc = useLocation();
  return <p id="where">{loc.pathname + loc.search}</p>;
}

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

async function open(path = "/login") {
  await act(async () => {
    root.render(
      <StrictMode>
        <MemoryRouter initialEntries={[path]}>
          <Where />
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="*" element={<p id="app">the app</p>} />
          </Routes>
        </MemoryRouter>
      </StrictMode>,
    );
  });
  await settle();
}

const button = (label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === label);
const input = (label: string) =>
  [...host.querySelectorAll("input")].find((i) => host.querySelector(`label[for="${i.id}"]`)?.textContent?.startsWith(label));

async function type(label: string, value: string) {
  const el = input(label)!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(label: string) {
  await act(async () => button(label)!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await settle();
}

const startBodies = () =>
  fetchMock.mock.calls.filter(([url]) => String(url) === "/auth/oidc/start").map(([, init]) => JSON.parse(String(init!.body)) as unknown);

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  fetchMock.mockReset();
  assign.mockReset();
  replace.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  Object.defineProperty(window, "location", { configurable: true, value: { ...originalLocation, assign, replace } });
  localStorage.clear();
  sessionStorage.clear();
  resetSilentAttemptForTest();
  setAuthConfigForTest({ provider: { label: "Okta" }, nodeName: NODE_NAME });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
  setAuthConfigForTest(null);
});

describe("Login", () => {
  it("names the node in the brand slot and as what one signs in to, host or not", async () => {
    await open();
    expect(host.querySelector("h1")?.textContent).toBe("Welcome back");
    expect(host.textContent).toContain("livs-air.local:8787");
    expect(host.textContent).toContain("Sign in to livs-air.local:8787");

    act(() => root.unmount());
    root = createRoot(host);
    setAuthConfigForTest({ nodeName: "Studio" });
    await open();
    expect(host.textContent).toContain("Sign in to Studio");
  });

  it("greets setup with the product, since nobody has named the node yet", async () => {
    setAuthConfigForTest({ unclaimed: true, nodeName: NODE_NAME });
    await open();
    expect(host.querySelector("h1")?.textContent).toBe("Welcome to Stuga");
  });
});

describe("Login · where a sign-in goes", () => {
  it("goes where the visitor was headed, not to the start page", async () => {
    rememberLoginReturn("/doc/d1");
    fetchMock.mockImplementation(async () => reply(200, { access_token: "at-1", refresh_token: "rt-1", expires_in: 900 }));
    await open();
    await type("Username", "ada");
    await type("Password", "battery staple 9");
    await click("Sign in");
    expect(host.querySelector("#where")?.textContent).toBe("/doc/d1");
  });
});

describe("Login · a username the node refuses", () => {
  const registered = () =>
    fetchMock.mock.calls.filter(([url]) => String(url) === "/auth/register").map(([, init]) => JSON.parse(String(init!.body)) as Record<string, unknown>);

  it("offers the node's suggestion in one click on sign-up", async () => {
    rememberLoginReturn("/join/inv_abc");
    fetchMock.mockImplementation(async () =>
      reply(409, { error: "username_taken", message: "that username is taken", suggestion: "ada-2" }),
    );
    await open();
    await type("Username", "ada");
    await type("Password", "battery staple 9");
    await click("Create account");

    expect(host.textContent).toContain("That username is taken.");
    await click("Use ada-2");
    expect(input("Username")!.value).toBe("ada-2");
    expect(button("Use ada-2")).toBeUndefined();
    expect(host.textContent).not.toContain("That username is taken.");

    fetchMock.mockImplementation(async () => reply(201, { access_token: "at-1", refresh_token: "rt-1", expires_in: 900 }));
    await click("Create account");
    expect(registered().at(-1)).toMatchObject({ username: "ada-2", invite: "inv_abc" });
  });

  it("offers it at first-run setup too, for a reserved name", async () => {
    setAuthConfigForTest({ unclaimed: true, nodeName: NODE_NAME });
    fetchMock.mockImplementation(async () =>
      reply(409, { error: "username_reserved", message: "that username is reserved", suggestion: "admin-2" }),
    );
    await open("/login?setup=ABCDE-12345");
    await type("Username", "admin");
    await type("Password", "battery staple 9");
    await click("Create administrator account");

    expect(host.textContent).toContain("That username is reserved.");
    await click("Use admin-2");
    expect(input("Username")!.value).toBe("admin-2");
  });

  it("asks at setup whether the node may look for new versions, on unless unticked, and sends the answer with the account", async () => {
    setAuthConfigForTest({ unclaimed: true, nodeName: NODE_NAME });
    fetchMock.mockImplementation(async () => reply(409, { error: "username_taken", message: "that username is taken" }));
    await open("/login?setup=ABCDE-12345");
    const box = input("Check for new versions")!;
    expect(box.checked).toBe(true);
    expect(host.textContent).toContain("Checks GitHub daily. Sends no node data.");

    await type("Username", "ada");
    await type("Password", "battery staple 9");
    await click("Create administrator account");
    expect(registered().at(-1)).toMatchObject({ username: "ada", update_check: true });

    await act(async () => box.click());
    await click("Create administrator account");
    expect(registered().at(-1)).toMatchObject({ update_check: false });
  });

  it("takes the setup code from the link the node printed, asks nothing, and leaves the link in the address bar", async () => {
    setAuthConfigForTest({ unclaimed: true, nodeName: NODE_NAME });
    fetchMock.mockImplementation(async () => reply(201, { access_token: "at-1", refresh_token: "rt-1", expires_in: 900 }));
    await open("/login?setup=ABCDE-12345");
    expect(input("Setup code")).toBeUndefined();
    expect(host.querySelector("#where")?.textContent).toBe("/login?setup=ABCDE-12345");

    await type("Username", "ada");
    await type("Password", "battery staple 9");
    await click("Create administrator account");
    expect(registered().at(-1)).toMatchObject({ username: "ada", setup_code: "ABCDE-12345" });
  });

  it("asks for the setup code when the link had none", async () => {
    setAuthConfigForTest({ unclaimed: true, nodeName: NODE_NAME });
    await open();
    await type("Username", "ada");
    await type("Password", "battery staple 9");
    await click("Create administrator account");
    expect(registered()).toHaveLength(0);
    expect(host.textContent).toContain("Enter the setup code.");
    await type("Setup code", "abcde 12345");
    fetchMock.mockImplementation(async () => reply(201, { access_token: "at-1", refresh_token: "rt-1", expires_in: 900 }));
    await click("Create administrator account");
    expect(registered().at(-1)).toMatchObject({ setup_code: "abcde 12345" });
  });

  it("asks for the setup code again when the node refuses the one the link had", async () => {
    setAuthConfigForTest({ unclaimed: true, nodeName: NODE_NAME });
    fetchMock.mockImplementation(async (url) =>
      String(url) === "/auth/register"
        ? reply(403, { error: "setup_code_invalid", message: "that is not this node's setup code" })
        : reply(200, { unclaimed: true }),
    );
    await open("/login?setup=WRONG-CODE0");
    expect(input("Setup code")).toBeUndefined();
    await type("Username", "ada");
    await type("Password", "battery staple 9");
    await click("Create administrator account");
    expect(host.textContent).toContain("That setup code isn’t right.");
    expect(input("Setup code")!.value).toBe("WRONG-CODE0");
  });

  it("asks nobody but the person setting the node up", async () => {
    rememberLoginReturn("/join/inv_abc");
    fetchMock.mockImplementation(async () => reply(409, { error: "username_taken", message: "that username is taken" }));
    await open();
    expect(input("Check for new versions")).toBeUndefined();
    await type("Username", "ada");
    await type("Password", "battery staple 9");
    await click("Create account");
    expect(registered().at(-1)).not.toHaveProperty("update_check");
  });

  it("drops the suggestion when the visitor switches to sign in", async () => {
    rememberLoginReturn("/join/inv_abc");
    fetchMock.mockImplementation(async () =>
      reply(409, { error: "username_taken", message: "that username is taken", suggestion: "ada-2" }),
    );
    await open();
    await type("Username", "ada");
    await type("Password", "battery staple 9");
    await click("Create account");
    await click("Sign in");
    expect(button("Use ada-2")).toBeUndefined();
  });
});

describe("Login with an identity provider", () => {
  it("offers the provider under the password form and leaves for it with the stashed destination", async () => {
    rememberLoginReturn("/doc/d1");
    fetchMock.mockImplementation(async () => reply(200, { url: "https://id.example.com/authorize" }));
    await open();

    expect(button("Sign in")).toBeTruthy();
    await act(async () => button("Continue with Okta")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await settle();
    expect(startBodies()).toEqual([{ return_to: "/doc/d1" }]);
    expect(assign).toHaveBeenCalledWith("https://id.example.com/authorize");
    // Peeked, not spent: the landing page spends it once the sign-in is done.
    expect(sessionStorage.getItem("stuga_login_return")).toBe("/doc/d1");
  });

  it("offers the provider to an invited visitor signing up, but not at setup", async () => {
    rememberLoginReturn("/join/inv_abc");
    await open();
    expect(host.textContent).toContain("Create your account");
    expect(button("Continue with Okta")).toBeTruthy();

    act(() => root.unmount());
    root = createRoot(host);
    setAuthConfigForTest({ provider: { label: "Okta" }, unclaimed: true, nodeName: NODE_NAME });
    await open();
    expect(button("Create administrator account")).toBeTruthy();
    expect(button("Continue with Okta")).toBeUndefined();
  });

  it("tries the provider silently, once, when it signed someone in here before", async () => {
    setSsoHint();
    fetchMock.mockImplementation(async () => reply(200, { url: "https://id.example.com/authorize?prompt=none" }));
    await open();

    expect(host.textContent).toContain("Signing you in…");
    expect(button("Sign in")).toBeUndefined();
    expect(startBodies()).toEqual([{ return_to: "/", prompt: "none" }]);
    // Replaced, not pushed: Back from the provider never lands on this spinner.
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith("https://id.example.com/authorize?prompt=none");
    expect(assign).not.toHaveBeenCalled();
    expect(peekSilentAttempt()).toBe(true);
  });

  it("shows the form again when Back restores the page from the cache mid-attempt", async () => {
    setSsoHint();
    fetchMock.mockImplementation(async () => reply(200, { url: "https://id.example.com/authorize?prompt=none" }));
    await open();
    expect(host.textContent).toContain("Signing you in…");

    await act(async () => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    expect(button("Sign in")).toBeTruthy();
    expect(button("Continue with Okta")).toBeTruthy();
    expect(peekSilentAttempt()).toBe(false);
    // Only the restore: a plain page show changes nothing, and no second attempt starts.
    expect(startBodies()).toHaveLength(1);
  });

  it("ignores a page show that is not a restore", async () => {
    setSsoHint();
    fetchMock.mockImplementation(async () => reply(200, { url: "https://id.example.com/authorize?prompt=none" }));
    await open();
    await act(async () => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: false })));
    expect(host.textContent).toContain("Signing you in…");
  });

  it("asks the provider which account to use once, after a sign-out", async () => {
    noteSignOut();
    fetchMock.mockImplementation(async () => reply(200, { url: "https://id.example.com/authorize" }));
    await open();

    await act(async () => button("Continue with Okta")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await settle();
    await act(async () => button("Continue with Okta")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await settle();
    expect(startBodies()).toEqual([{ return_to: "/", prompt: "select_account" }, { return_to: "/" }]);
    expect(selectAccountDue()).toBe(false);
  });

  it("keeps asking for the account when the start is refused before leaving", async () => {
    noteSignOut();
    fetchMock.mockImplementation(async () => reply(502, { error: "provider_unreachable", message: "unreachable" }));
    await open();
    await act(async () => button("Continue with Okta")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await settle();
    expect(startBodies()).toEqual([{ return_to: "/", prompt: "select_account" }]);
    expect(selectAccountDue()).toBe(true);
  });

  it("shows the page as if nothing was tried when the silent attempt cannot start", async () => {
    setSsoHint();
    fetchMock.mockImplementation(async () => reply(502, { error: "provider_unreachable", message: "unreachable" }));
    await open();

    expect(button("Sign in")).toBeTruthy();
    expect(host.textContent).not.toContain("Couldn’t reach");
    expect(hasSsoHint()).toBe(false);
  });

  it("says a sign-in through the provider failed, forgets the hint, and tries nothing", async () => {
    setSsoHint();
    await open("/login?provider=failed");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Couldn’t sign in with Okta.");
    expect(hasSsoHint()).toBe(false);
    expect(host.querySelector("#where")?.textContent).toBe("/login");
  });

  it("sends someone already signed in on into the app, keeping the hint, even from a failed return", async () => {
    setSession({ accessToken: "at-1", refreshToken: "rt-1", expiresIn: 3600 });
    setSsoHint();
    await open("/login?provider=failed");

    expect(host.querySelector("#where")?.textContent).toBe("/");
    expect(host.querySelector("#app")).toBeTruthy();
    expect(hasSsoHint()).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends someone signed in back to Profile when a link came back failed after the node forgot it", async () => {
    setSession({ accessToken: "at-1", refreshToken: "rt-1", expiresIn: 3600 });
    markLinkPending("/settings/profile");
    await open("/login?provider=failed");
    expect(host.querySelector("#where")?.textContent).toBe("/settings/profile?provider=failed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not take a signed-in visit to Profile without a failed return, whatever the tab left for", async () => {
    setSession({ accessToken: "at-1", refreshToken: "rt-1", expiresIn: 3600 });
    markLinkPending("/settings/profile");
    await open("/login");
    expect(host.querySelector("#where")?.textContent).toBe("/");
  });

  it("says nothing when the failure was its own silent attempt", async () => {
    setSsoHint();
    sessionStorage.setItem("stuga_sso_silent", "1");
    await open("/login?provider=failed");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("Couldn’t sign in with Okta.");
    expect(button("Sign in")).toBeTruthy();
    expect(peekSilentAttempt()).toBe(false);
    expect(hasSsoHint()).toBe(false);
  });

  it("offers no provider button and tries nothing when the node has none", async () => {
    setAuthConfigForTest({ nodeName: NODE_NAME });
    setSsoHint();
    await open();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(button("Sign in")).toBeTruthy();
    expect([...host.querySelectorAll("button")].some((b) => b.textContent?.startsWith("Continue with"))).toBe(false);
  });
});
