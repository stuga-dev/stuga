// @vitest-environment jsdom
/** Profile's sign-in parts: a password to set or change, and the identity provider to link or unlink. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { toasts } from "../../test/toast";
import { mountInto, typeInto } from "../../test/form-input";

const me = vi.hoisted(() => ({
  whoami: vi.fn(),
  setDisplayName: vi.fn(),
  setEmail: vi.fn(),
  revokeEverythingCounts: vi.fn(),
  passkeys: vi.fn(async () => [] as unknown[]),
  renamePasskey: vi.fn(),
  removePasskey: vi.fn(),
}));

vi.mock("../../api", async (orig) => ({
  ...(await orig<typeof import("../../api")>()),
  Me: me,
}));
vi.mock("@astryxdesign/core/Toast", () => import("../../test/toast"));
vi.mock("./SettingsLayout", () => ({ useSettingsScope: () => ({ reload: vi.fn() }) }));

const { Profile, revokeSummary } = await import("./Profile");
const { setAuthConfigForTest } = await import("../../lib/session/auth-config");
const { getToken, setSession } = await import("../../lib/session/tokens");
const { markLinkPending, pendingLinkReturn } = await import("../../lib/session/provider");
const { PASSWORD_RULES } = await import("../../lib/session/sign-in");
const { WORKS_HERE_ONLY } = await import("../../ui/PasswordStrengthHint");
const { loadStrength } = await import("../../lib/session/password-strength");

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
/** Settle until `check` holds: the strength rule loads on demand, a few turns later. */
async function until(check: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await settle();
  expect(check()).toBe(true);
}
const REMOTE = "https://k7f3q2.mystuga.com";

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
  await typeInto(el, value);
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
  ({ host, root } = mountInto());
});

afterEach(() => {
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
    expect(toasts.shown.at(-1)).toEqual({ body: "Password set.", type: "info", uniqueID: "settings-password" });
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

    expect(request("/auth/password")).toEqual({
      body: { username: "ada", current_password: "correct horse 1", new_password: "battery staple 9" },
      // On the node's own network the current password is the proof, as it always was.
      authorization: null,
    });
    expect(getToken()).toBe("at-2");
  });

  it("at the remote address, changes it with this session instead of the current password, confirming it's you first", async () => {
    setAuthConfigForTest({ provider: null, remoteOrigin: REMOTE });
    Object.defineProperty(window, "location", { configurable: true, value: { ...originalLocation, origin: REMOTE, assign } });
    me.whoami.mockResolvedValue({ ...PERSON, has_password: true, provider_linked: false });
    const { setConfirmer } = await import("../../lib/session/reauth");
    const asked: string[][] = [];
    const remove = setConfirmer(async (methods) => (asked.push(methods), true));
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "reauth_required", message: "confirm it's you", methods: ["password", "provider"] }), {
          status: 401,
          headers: { "x-stuga-reauth": "1" },
        }),
      )
      .mockResolvedValue(reply(200, { access_token: "at-2", refresh_token: "rt-2", expires_in: 900, token_type: "Bearer" }));
    await open();
    // A current password too short for this address could never be checked here: it is not asked for.
    expect(input("Current password")).toBeUndefined();
    await type("New password", "battery staple 9");
    await click("Change password");
    expect(asked).toEqual([["password", "provider"]]);
    expect(request("/auth/password")).toEqual({ body: { new_password: "battery staple 9" }, authorization: "Bearer at-1" });
    expect(getToken()).toBe("at-2");
    remove();
  });

  it("says why a current password too short for the remote address was refused, not that it is wrong", async () => {
    me.whoami.mockResolvedValue({ ...PERSON, has_password: true, provider_linked: false });
    fetchMock.mockResolvedValue(reply(401, { error: "remote_password_weak", message: "weak" }));
    await open();
    await type("Current password", "short pw 1");
    await type("New password", "battery staple 9");
    await click("Change password");
    expect(toasts.shown.at(-1)).toEqual({
      body: "From outside this network, sign in with a passkey or a password of 15 characters or more that is hard to guess.",
      type: "error",
      uniqueID: "settings-password",
    });
  });

  it("says, while the remote address is on, whether the new password works from anywhere, without stopping the form", async () => {
    setAuthConfigForTest({ provider: null, remoteOrigin: REMOTE });
    me.whoami.mockResolvedValue({ ...PERSON, has_password: false, provider_linked: false });
    fetchMock.mockResolvedValue(reply(204));
    await open();

    await type("New password", "battery9");
    await until(() => host.textContent!.includes(WORKS_HERE_ONLY));
    // Only a hint: a password that works on this network alone is still set.
    await click("Set password");
    expect(request("/auth/password")?.body).toEqual({ new_password: "battery9" });

    await type("New password", "trumpet walnut ceiling");
    await until(() => host.textContent!.includes("Works from anywhere."));
  });

  it("takes a long passphrase with no number, which meets the remote rule", async () => {
    me.whoami.mockResolvedValue({ ...PERSON, has_password: false, provider_linked: false });
    fetchMock.mockResolvedValue(reply(204));
    await open();
    // Scored even with the remote address off, only because it is long enough to pass; no hint is shown.
    await loadStrength();
    await type("New password", "trumpet walnut ceiling");
    await settle();
    await settle();
    await click("Set password");
    expect(request("/auth/password")?.body).toEqual({ new_password: "trumpet walnut ceiling" });
    expect(host.textContent).not.toContain("Works from anywhere.");
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
      ({ host, root } = mountInto());
      await open();
      expect(hint("New password")).toBe("At least 8 characters, with a letter, a number and a symbol.");
      await type("New password", "battery9");
      await click("Set password");
      expect(fetchMock).not.toHaveBeenCalled();
      // On the field, not in a toast that would stack under the next outcome.
      expect(hint("New password")).toContain("Choose another password. At least 8 characters, with a letter, a number and a symbol.");
      expect(toasts.shown).toEqual([]);
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
    expect(hint("Current password")).toContain("That isn’t your current password.");
    expect(toasts.shown).toEqual([]);
    expect(getToken()).toBe("at-1");

    // Typing again clears it.
    await type("Current password", "nope again");
    expect(hint("Current password") ?? "").not.toContain("That isn’t your current password.");
  });

  it("ends a change that took tries in one message, not a stack of them", async () => {
    me.whoami.mockResolvedValue({ ...PERSON, has_password: true, provider_linked: false });
    fetchMock.mockResolvedValueOnce(reply(401, { error: "invalid_credentials", message: "invalid" }));
    fetchMock.mockResolvedValueOnce(reply(200, { access_token: "at-2", refresh_token: "rt-2", expires_in: 900, token_type: "Bearer" }));
    await open();

    await type("Current password", "nope");
    await type("New password", "short1");
    await click("Change password");
    await type("New password", "battery staple 9");
    await click("Change password");
    await type("Current password", "correct horse 1");
    await click("Change password");

    expect(toasts.shown).toEqual([{ body: "Password changed. You’re signed out everywhere else.", type: "info", uniqueID: "settings-password" }]);
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

describe("Profile · Sign out everywhere", () => {
  const COUNTS = { sessions: 3, passkeys: 0, provider: true, apps: 2, api_keys: 1, invites: 1, share_links: 2 };
  const dialog = () => [...host.querySelectorAll("dialog")].find((d) => d.textContent?.includes("Choose a new password"));
  const inDialog = (label: string) =>
    [...(dialog()?.querySelectorAll("input") ?? [])].find((i) => dialog()!.querySelector(`label[for="${i.id}"]`)?.textContent?.startsWith(label));
  const dialogButton = (label: string) => [...(dialog()?.querySelectorAll("button") ?? [])].find((b) => b.textContent === label);

  beforeEach(() => {
    me.whoami.mockResolvedValue({ ...PERSON, has_password: true, provider_linked: true });
    me.revokeEverythingCounts.mockResolvedValue(COUNTS);
  });

  it("says what it takes, then signs this browser in with the new password", async () => {
    fetchMock.mockResolvedValue(reply(200, { access_token: "at-9", refresh_token: "rt-9", expires_in: 900, token_type: "Bearer" }));
    await open();
    await click("Sign out everywhere");
    expect(dialog()?.textContent).toContain(
      "Signs you out everywhere and removes Okta sign-in, 2 connected apps, an API key and 3 links you shared. Choose a new password to sign in with.",
    );
    await typeInto(inDialog("New password"), "battery staple 9");
    await act(async () => dialogButton("Sign out everywhere")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await settle();

    expect(request("/auth/revoke-everything")).toEqual({ body: { new_password: "battery staple 9" }, authorization: "Bearer at-1" });
    expect(getToken()).toBe("at-9");
    expect(toasts.shown.at(-1)).toEqual({ body: "Signed out everywhere. You’re signed in here with your new password.", type: "info", uniqueID: "settings-revoke" });
  });

  it("opens from an alert's link, once", async () => {
    await open("/settings/profile?revoke=1");
    await settle();
    expect(dialog()?.open).toBe(true);
    expect(host.querySelector("#where")?.textContent).toBe("/settings/profile");
  });

  it("asks for a confirmation the page cannot give here, and says so", async () => {
    fetchMock.mockResolvedValue(reply(401, { error: "reauth_required", message: "confirm it's you", methods: ["password"] }));
    await open();
    await click("Sign out everywhere");
    await typeInto(inDialog("New password"), "battery staple 9");
    await act(async () => dialogButton("Sign out everywhere")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await settle();
    expect(toasts.shown.at(-1)).toEqual({ body: "Confirm it’s you to continue.", type: "error", uniqueID: "settings-revoke" });
    expect(getToken()).toBe("at-1");
  });

  it("names only what there is to take", () => {
    const none = { sessions: 1, passkeys: 0, provider: false, apps: 0, api_keys: 0, invites: 0, share_links: 0 };
    expect(revokeSummary(none, null)).toBe("Signs you out everywhere. Choose a new password to sign in with.");
    expect(revokeSummary({ ...none, api_keys: 2, share_links: 1 }, null)).toBe(
      "Signs you out everywhere and removes 2 API keys and a link you shared. Choose a new password to sign in with.",
    );
    expect(revokeSummary({ ...none, passkeys: 2, provider: true }, "Okta")).toBe(
      "Signs you out everywhere and removes 2 passkeys and Okta sign-in. Choose a new password to sign in with.",
    );
  });
});

describe("Profile · passkeys", () => {
  const SYNCED = { id: "cred-1", name: "iCloud Keychain", synced: true, created_at: "2026-09-30T10:00:00.000Z", last_used_at: null };
  const KEY = { id: "cred-2", name: "Security key", synced: false, created_at: "2026-09-29T10:00:00.000Z", last_used_at: "2026-09-30T09:00:00.000Z" };
  beforeEach(() => {
    me.passkeys.mockReset();
    me.removePasskey.mockReset();
    me.renamePasskey.mockReset();
    me.whoami.mockResolvedValue({ ...PERSON, has_password: true, provider_linked: false });
  });

  it("is not there while remote access is off and there are none", async () => {
    me.passkeys.mockResolvedValue([]);
    await open();
    expect(host.textContent).not.toContain("Passkeys");
  });

  it("on the node's own network, says where to add one, while remote access is on", async () => {
    setAuthConfigForTest({ provider: null, remoteOrigin: REMOTE });
    me.passkeys.mockResolvedValue([]);
    await open();
    expect(host.textContent).toContain("Passkeys");
    expect(host.textContent).toContain("Add one at k7f3q2.mystuga.com.");
    expect(host.querySelector(`a[href="${REMOTE}/settings/profile"]`)).not.toBeNull();
    expect(button("Add a passkey")).toBeUndefined();
  });

  it("lists each, synced or not, and asks before removing one in words that say what else it signs out", async () => {
    setAuthConfigForTest({ provider: null, remoteOrigin: REMOTE });
    me.passkeys.mockResolvedValue([SYNCED, KEY]);
    me.removePasskey.mockResolvedValue({ removed: true, signed_out: false });
    await open();
    expect(host.textContent).toContain("iCloud Keychain");
    expect(host.textContent).toContain("Synced");
    expect(host.textContent).toContain("Never used");
    const removes = () => [...host.querySelectorAll("button")].filter((b) => b.textContent === "Remove");
    await act(async () => removes()[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await settle();
    expect(host.textContent).toContain("Remove iCloud Keychain? It is signed out on every device that shares it.");
    await click("Cancel");
    await act(async () => removes()[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await settle();
    expect(host.textContent).toContain("Remove Security key? Anyone signed in with it at k7f3q2.mystuga.com is signed out.");
    // The confirming Remove is the destructive one, beside Cancel.
    const confirm = removes().at(-1)!;
    await act(async () => confirm.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await settle();
    expect(me.removePasskey).toHaveBeenCalledWith("cred-2");
    expect(toasts.shown.at(-1)).toEqual({ body: "Removed Security key.", type: "info" });
  });

  it("says a passkey made for an earlier remote address signs in nowhere, and badges a synced one once", async () => {
    setAuthConfigForTest({ provider: null, remoteOrigin: REMOTE });
    me.passkeys.mockResolvedValue([{ ...KEY, elsewhere: true }, { ...SYNCED, id: "cred-3", name: "Synced · Chrome" }]);
    await open();
    expect(host.textContent).toContain("Made for an earlier remote address. It signs in nowhere now.");
    expect(button("Remove")).toBeDefined();
    // "Synced · Chrome" says it already: no badge beside it.
    expect([...host.querySelectorAll("li")].find((li) => li.textContent?.includes("Synced · Chrome"))!.textContent).not.toMatch(/Chrome.*Synced/);
  });

  it("signs this browser out when the passkey removed is the one it signed in with", async () => {
    setAuthConfigForTest({ provider: null, remoteOrigin: REMOTE });
    me.passkeys.mockResolvedValue([KEY]);
    me.removePasskey.mockResolvedValue({ removed: true, signed_out: true });
    fetchMock.mockResolvedValue(reply(204));
    await open();
    await click("Remove");
    const confirm = [...host.querySelectorAll("button")].filter((b) => b.textContent === "Remove").at(-1)!;
    await act(async () => confirm.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await settle();
    expect(getToken()).toBeNull();
  });

  it("renames one", async () => {
    setAuthConfigForTest({ provider: null, remoteOrigin: REMOTE });
    me.passkeys.mockResolvedValue([KEY]);
    me.renamePasskey.mockResolvedValue({ id: "cred-2", name: "Yubikey" });
    await open();
    await click("Rename");
    await type("Passkey name", "Yubikey");
    // The row's own Save, after the profile's.
    const save = [...host.querySelectorAll("button")].filter((b) => b.textContent === "Save").at(-1)!;
    await act(async () => save.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await settle();
    expect(me.renamePasskey).toHaveBeenCalledWith("cred-2", "Yubikey");
  });
});
