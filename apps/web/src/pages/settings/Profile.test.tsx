// @vitest-environment jsdom
/** Profile's sign-in parts: a password to set or change, and the identity provider to link or unlink. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

const me = vi.hoisted(() => ({ whoami: vi.fn(), setDisplayName: vi.fn(), setEmail: vi.fn() }));
const toasts = vi.hoisted(() => ({ shown: [] as Array<{ body: string; type?: string }> }));

vi.mock("../../api", async (orig) => ({
  ...(await orig<typeof import("../../api")>()),
  Me: me,
}));
vi.mock("@astryxdesign/core/Toast", () => ({
  useToast: () => (t: { body: string; type?: string }) => toasts.shown.push(t),
}));
vi.mock("./SettingsLayout", () => ({ useSettingsScope: () => ({ reload: vi.fn() }) }));

const { Profile } = await import("./Profile");
const { setAuthConfigForTest } = await import("../../lib/session/auth-config");
const { getToken, setSession } = await import("../../lib/session/tokens");
const { markLinkPending, pendingLinkReturn } = await import("../../lib/session/provider");
const { PASSWORD_RULES } = await import("../../lib/session/sign-in");

const PERSON = {
  alias: "u_ada",
  display_name: "Ada",
  username: "ada",
  email: null,
  principals: ["user:u_ada"],
  workspace_id: "ws1",
  node_admin: false,
};

const fetchMock = vi.fn<typeof fetch>();
const assign = vi.fn();
const originalLocation = window.location;
const reply = (status: number, body?: unknown) =>
  body === undefined
    ? new Response(null, { status })
    : new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let host: HTMLDivElement;
let root: Root;

function Where() {
  const loc = useLocation();
  return <p id="where">{loc.pathname + loc.search}</p>;
}

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

async function open(path = "/settings/profile") {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Where />
        <Routes>
          <Route path="/settings/profile" element={<Profile />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  await settle();
}

function input(label: string): HTMLInputElement | undefined {
  return [...host.querySelectorAll("input")].find((i) => host.querySelector(`label[for="${i.id}"]`)?.textContent?.startsWith(label));
}

async function type(label: string, value: string) {
  const el = input(label);
  expect(el, `no input ${label}`).toBeTruthy();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(el!, value);
    el!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const button = (label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === label);
const isDisabled = (b: HTMLButtonElement | undefined) => !!b && (b.disabled || b.getAttribute("aria-disabled") === "true");

async function pressEnter(label: string) {
  const el = input(label);
  expect(el, `no input ${label}`).toBeTruthy();
  await act(async () => el!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  await settle();
}

/** The hint under a field, which Astryx links to it. */
function hint(label: string): string | null {
  const ids = input(label)?.getAttribute("aria-describedby")?.split(" ") ?? [];
  return ids.map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim() || null;
}

async function click(label: string) {
  const el = button(label);
  expect(el, `no button ${label}`).toBeTruthy();
  await act(async () => el!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await settle();
}

function request(path: string): { body: Record<string, unknown>; authorization: string | null } | null {
  const call = fetchMock.mock.calls.find(([url]) => String(url) === path);
  if (!call) return null;
  return {
    body: JSON.parse(String(call[1]!.body)) as Record<string, unknown>,
    authorization: new Headers(call[1]!.headers).get("authorization"),
  };
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  fetchMock.mockReset();
  assign.mockReset();
  me.whoami.mockReset();
  toasts.shown = [];
  vi.stubGlobal("fetch", fetchMock);
  Object.defineProperty(window, "location", { configurable: true, value: { ...originalLocation, assign } });
  localStorage.clear();
  sessionStorage.clear();
  setSession({ accessToken: "at-1", refreshToken: "rt-1", expiresIn: 3600 });
  setAuthConfigForTest({ provider: { label: "Okta" } });
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

describe("Profile · password", () => {
  it("sets a first password with the session alone", async () => {
    me.whoami
      .mockResolvedValueOnce({ ...PERSON, has_password: false, provider_linked: true })
      .mockResolvedValue({ ...PERSON, has_password: true, provider_linked: true });
    fetchMock.mockResolvedValue(reply(204));
    await open();

    expect(input("Current password")).toBeUndefined();
    await type("New password", "battery staple 9");
    await click("Set password");

    expect(request("/auth/password")).toEqual({ body: { new_password: "battery staple 9" }, authorization: "Bearer at-1" });
    expect(toasts.shown.at(-1)).toEqual({ body: "Password set.", type: "info" });
    // Now it has one, so the next change asks for it.
    expect(button("Change password")).toBeTruthy();
  });

  it("changes a password with the current one and keeps this browser signed in", async () => {
    me.whoami.mockResolvedValue({ ...PERSON, has_password: true, provider_linked: false });
    fetchMock.mockResolvedValue(reply(200, { access_token: "at-2", refresh_token: "rt-2", expires_in: 900, token_type: "Bearer" }));
    await open();

    expect(isDisabled(button("Change password"))).toBe(true);
    await type("Current password", "correct horse 1");
    await type("New password", "battery staple 9");
    await click("Change password");

    expect(request("/auth/password")?.body).toEqual({
      username: "ada",
      current_password: "correct horse 1",
      new_password: "battery staple 9",
    });
    expect(getToken()).toBe("at-2");
  });

  it("sends nothing on Enter that the button would not send", async () => {
    me.whoami.mockResolvedValue({ ...PERSON, has_password: true, provider_linked: false });
    fetchMock.mockResolvedValue(reply(200, { access_token: "at-2", refresh_token: "rt-2", expires_in: 900, token_type: "Bearer" }));
    await open();

    // A new password but no current one: the button is disabled, and Enter is too.
    await type("New password", "battery staple 9");
    expect(isDisabled(button("Change password"))).toBe(true);
    await pressEnter("New password");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(toasts.shown).toEqual([]);

    // Filled in, Enter in either field submits once.
    await type("Current password", "correct horse 1");
    await pressEnter("Current password");
    expect(request("/auth/password")?.body).toMatchObject({ current_password: "correct horse 1", new_password: "battery staple 9" });
  });

  it("describes the password rules from the policy the form checks", async () => {
    me.whoami.mockResolvedValue({ ...PERSON, has_password: false, provider_linked: false });
    await open();
    expect(hint("New password")).toBe("At least 8 characters, with a letter and a number.");

    // A rule added to the policy shows up in the hint, and in the refusal, with no second copy to update.
    PASSWORD_RULES.push({ label: "A symbol", test: (pw) => /[^A-Za-z0-9]/.test(pw) });
    try {
      act(() => root.unmount());
      root = createRoot(host);
      await open();
      expect(hint("New password")).toBe("At least 8 characters, with a letter, a number and a symbol.");
      await type("New password", "battery9");
      await click("Set password");
      expect(fetchMock).not.toHaveBeenCalled();
      expect(toasts.shown.at(-1)).toEqual({
        body: "Choose another password. At least 8 characters, with a letter, a number and a symbol.",
        type: "error",
      });
    } finally {
      PASSWORD_RULES.pop();
    }
  });

  it("says the current password is wrong without signing anyone out", async () => {
    me.whoami.mockResolvedValue({ ...PERSON, has_password: true, provider_linked: false });
    fetchMock.mockResolvedValue(reply(401, { error: "invalid_credentials", message: "invalid" }));
    await open();

    await type("Current password", "nope");
    await type("New password", "battery staple 9");
    await click("Change password");
    expect(toasts.shown.at(-1)).toEqual({ body: "That isn’t your current password.", type: "error" });
    expect(getToken()).toBe("at-1");
  });

  it("offers no fallback name the node does not have", async () => {
    me.whoami.mockResolvedValue({ ...PERSON, has_password: true, provider_linked: false });
    await open();
    expect(host.textContent).toContain("Shown to collaborators.");
    expect(host.textContent).not.toContain("name from your sign-in");
  });

  it("keeps the email editable whatever the account signs in with", async () => {
    me.whoami.mockResolvedValue({ ...PERSON, has_password: false, provider_linked: true });
    await open();
    expect(input("Email")).toBeTruthy();
  });
});

describe("Profile · identity provider", () => {
  it("links the provider with this session and comes back to Profile", async () => {
    me.whoami.mockResolvedValue({ ...PERSON, has_password: true, provider_linked: false });
    fetchMock.mockResolvedValue(reply(200, { url: "https://id.example.com/authorize" }));
    await open();

    expect(host.textContent).toContain("Sign-in with Okta");
    await click("Link");
    expect(request("/auth/oidc/start")).toEqual({ body: { return_to: "/settings/profile" }, authorization: "Bearer at-1" });
    expect(assign).toHaveBeenCalledWith("https://id.example.com/authorize");
  });

  it("marks the link as under way before leaving, so a flow the node forgets still comes back here", async () => {
    me.whoami.mockResolvedValue({ ...PERSON, has_password: true, provider_linked: false });
    fetchMock.mockResolvedValue(reply(200, { url: "https://id.example.com/authorize" }));
    await open();
    await click("Link");
    expect(pendingLinkReturn()).toBe("/settings/profile");
  });

  it("forgets the mark once the link comes back, whatever came of it", async () => {
    me.whoami.mockResolvedValue({ ...PERSON, has_password: true, provider_linked: false });
    markLinkPending("/settings/profile");
    await open("/settings/profile?provider=failed");
    expect(toasts.shown).toEqual([{ body: "Couldn’t link Okta. Try again.", type: "error" }]);
    expect(pendingLinkReturn()).toBeNull();
  });

  it("makes Link usable again when Back from the provider restores the page", async () => {
    me.whoami.mockResolvedValue({ ...PERSON, has_password: true, provider_linked: false });
    fetchMock.mockResolvedValue(reply(200, { url: "https://id.example.com/authorize" }));
    await open();
    await click("Link");
    // Left for the provider: the button stays busy (labelled, its text a spinner's) until the page goes.
    const busyLink = () => [...host.querySelectorAll("button")].find((el) => el.getAttribute("aria-label") === "Link");
    expect(isDisabled(busyLink())).toBe(true);

    await act(async () => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    expect(busyLink()).toBeUndefined();
    expect(isDisabled(button("Link"))).toBe(false);
    expect(pendingLinkReturn()).toBeNull();
  });

  it("says the provider could not be reached, without telling a signed-in person to sign in", async () => {
    me.whoami.mockResolvedValue({ ...PERSON, has_password: true, provider_linked: false });
    fetchMock.mockResolvedValue(reply(502, { error: "provider_unreachable", message: "unreachable" }));
    await open();

    await click("Link");
    expect(toasts.shown.at(-1)).toEqual({ body: "Couldn’t reach Okta. Try again shortly.", type: "error" });
    expect(assign).not.toHaveBeenCalled();
    expect(isDisabled(button("Link"))).toBe(false);
    // Never left, so nothing is under way.
    expect(pendingLinkReturn()).toBeNull();
  });

  it("will not unlink an account with no password to fall back on", async () => {
    me.whoami.mockResolvedValue({ ...PERSON, has_password: false, provider_linked: true });
    await open();
    expect(isDisabled(button("Unlink"))).toBe(true);
    expect(host.textContent).toContain("Set a password first.");
  });

  it("unlinks with this session", async () => {
    me.whoami
      .mockResolvedValueOnce({ ...PERSON, has_password: true, provider_linked: true })
      .mockResolvedValue({ ...PERSON, has_password: true, provider_linked: false });
    localStorage.setItem("stuga_sso_hint", "1");
    fetchMock.mockResolvedValue(reply(204));
    await open();

    await click("Unlink");
    expect(request("/auth/oidc/unlink")).toEqual({ body: {}, authorization: "Bearer at-1" });
    expect(localStorage.getItem("stuga_sso_hint")).toBeNull();
    expect(button("Link")).toBeTruthy();
  });

  it("announces how a link came back once, then clears it from the address", async () => {
    me.whoami.mockResolvedValue({ ...PERSON, has_password: true, provider_linked: false });
    await open("/settings/profile?provider=taken");
    expect(toasts.shown).toEqual([{ body: "That Okta account is already linked to another account here.", type: "error" }]);
    expect(host.querySelector("#where")?.textContent).toBe("/settings/profile");
  });

  it("has no provider section on a node without one", async () => {
    setAuthConfigForTest({ provider: null });
    me.whoami.mockResolvedValue({ ...PERSON, has_password: true, provider_linked: false });
    await open();
    expect(host.textContent).not.toContain("Sign-in with");
    expect(button("Link")).toBeUndefined();
  });
});
