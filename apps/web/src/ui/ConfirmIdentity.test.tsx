// @vitest-environment jsdom
/**
 * "Confirm it's you": a change the node refuses for want of a recent confirmation is confirmed and
 * sent once more, and the refusal never ends the session.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { Root } from "react-dom/client";
import { toasts } from "../test/toast";
import { mountInto, typeInto } from "../test/form-input";

vi.mock("@astryxdesign/core/Toast", () => import("../test/toast"));

const { ConfirmIdentity } = await import("./ConfirmIdentity");
const { api } = await import("../lib/http/client");
const { setAuthConfigForTest } = await import("../lib/session/auth-config");
const { getToken, setSession } = await import("../lib/session/tokens");
const { withConfirmation } = await import("../lib/session/reauth");
const { setFirstPassword } = await import("../lib/session/sign-in");

const fetchMock = vi.fn<typeof fetch>();
const assign = vi.fn();
const originalLocation = window.location;
let host: HTMLDivElement;
let root: Root;

const json = (status: number, body?: unknown, headers: Record<string, string> = {}) =>
  body === undefined
    ? new Response(null, { status, headers })
    : new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const reauth = (methods: string[]) => json(401, { error: "reauth_required", message: "confirm it's you", methods }, { "x-stuga-reauth": "1" });

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));
const dialog = () => host.ownerDocument.querySelector("dialog");
const button = (label: string) => [...(dialog()?.querySelectorAll("button") ?? [])].find((b) => b.textContent === label);
const passwordField = () => dialog()?.querySelector<HTMLInputElement>('input[type="password"]') ?? null;
async function click(label: string) {
  const el = button(label);
  expect(el, `no button ${label}`).toBeTruthy();
  await act(async () => el!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await settle();
}
const calls = () => fetchMock.mock.calls.map(([url]) => String(url));

beforeEach(async () => {
  fetchMock.mockReset();
  assign.mockReset();
  toasts.shown = [];
  vi.stubGlobal("fetch", fetchMock);
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...originalLocation, pathname: "/settings/node/access", search: "", href: "http://node.test/settings/node/access", assign },
  });
  setSession({ accessToken: "at-1", refreshToken: "rt-1", expiresIn: 3600 });
  setAuthConfigForTest({ provider: { label: "Okta" } });
  ({ host, root } = mountInto());
  await act(async () => root.render(<ConfirmIdentity />));
});

afterEach(() => {
  Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
  setAuthConfigForTest(null);
});

describe("a change that takes a recent confirmation", () => {
  it("is sent once more once the password confirms it, and the session is never dropped", async () => {
    fetchMock
      .mockResolvedValueOnce(reauth(["password", "provider"]))
      .mockResolvedValueOnce(json(204))
      .mockResolvedValueOnce(json(200, { alias: "u_bo", granted: true }));
    const sent = api<{ granted: boolean }>("/api/node/admins", { method: "POST", body: JSON.stringify({ username: "bo" }) });
    await settle();
    expect(dialog()?.open).toBe(true);
    expect(dialog()?.textContent).toContain("Enter your password to continue.");
    expect(button("Use Okta")).toBeTruthy();
    expect(getToken()).toBe("at-1");

    await typeInto(passwordField(), "trumpet walnut ceiling");
    await click("Continue");
    expect(await sent).toEqual({ alias: "u_bo", granted: true });
    expect(calls()).toEqual(["/api/node/admins", "/auth/confirm", "/api/node/admins"]);
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]!.body))).toEqual({ password: "trumpet walnut ceiling" });
    expect(new Headers(fetchMock.mock.calls[1]![1]!.headers).get("authorization")).toBe("Bearer at-1");
    expect(JSON.parse(String(fetchMock.mock.calls[2]![1]!.body))).toEqual({ username: "bo" });
    expect(dialog()?.open).toBe(false);
  });

  it("stays open on a wrong password, and gives up with the refusal when cancelled", async () => {
    fetchMock.mockResolvedValueOnce(reauth(["password"])).mockResolvedValueOnce(json(401, { error: "invalid_credentials", message: "x" }));
    const sent = api("/api/keys", { method: "POST", body: "{}" });
    const outcome = sent.catch((e: Error) => e.message);
    await settle();
    await typeInto(passwordField(), "not it");
    await click("Continue");
    expect(dialog()?.textContent).toContain("That isn’t your password.");
    await click("Cancel");
    expect(await outcome).toBe("Confirm it’s you to continue.");
    expect(getToken()).toBe("at-1");
  });

  it("through the provider leaves to sign in there again, back to this page", async () => {
    fetchMock.mockResolvedValueOnce(reauth(["provider"])).mockResolvedValueOnce(json(200, { url: "https://okta.test/authorize?x=1" }));
    void api("/api/node/settings", { method: "PUT", body: "{}" }).catch(() => {});
    await settle();
    expect(passwordField()).toBeNull();
    await click("Continue with Okta");
    expect(calls()[1]).toBe("/auth/oidc/start");
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]!.body))).toEqual({ return_to: "/settings/node/access", prompt: "login" });
    expect(assign).toHaveBeenCalledWith("https://okta.test/authorize?x=1");
  });

  it("works for the sign-in routes too", async () => {
    fetchMock.mockResolvedValueOnce(reauth(["password"])).mockResolvedValueOnce(json(204)).mockResolvedValueOnce(json(204));
    const sent = setFirstPassword("battery staple 9");
    await settle();
    await typeInto(passwordField(), "trumpet walnut ceiling");
    await click("Continue");
    await sent;
    expect(calls()).toEqual(["/auth/password", "/auth/confirm", "/auth/password"]);
  });

  it("passes any other refusal through untouched", async () => {
    await expect(withConfirmation(async () => Promise.reject(new Error("nope")))).rejects.toThrow("nope");
    expect(dialog()?.open).toBeFalsy();
  });
});

describe("coming back from the provider", () => {
  it("says whether it confirmed, once", async () => {
    await act(async () => root.unmount());
    const replace = vi.spyOn(window.history, "replaceState");
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, href: "http://node.test/settings/node/access?reauth=confirmed", assign },
    });
    ({ root } = mountInto());
    await act(async () => root.render(<ConfirmIdentity />));
    expect(toasts.shown).toEqual([{ body: "Confirmed. Try that again.", type: "info" }]);
    expect(replace.mock.calls.at(-1)?.[2]).toBe("/settings/node/access");
  });
});
