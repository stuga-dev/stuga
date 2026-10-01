// @vitest-environment jsdom
/** "Sign in faster next time": asked once after a password sign-in at the remote address. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { Root } from "react-dom/client";
import { toasts } from "../test/toast";
import { mountInto } from "../test/form-input";

vi.mock("@astryxdesign/core/Toast", () => import("../test/toast"));
const webauthn = vi.hoisted(() => ({ startRegistration: vi.fn() }));
vi.mock("@simplewebauthn/browser", async (orig) => ({
  ...(await orig<typeof import("@simplewebauthn/browser")>()),
  browserSupportsWebAuthn: () => true,
  startRegistration: webauthn.startRegistration,
}));

const { PasskeyOffer } = await import("./PasskeyOffer");
const { setAuthConfigForTest } = await import("../lib/session/auth-config");
const { notePasskeyOffer, passkeyOfferDue } = await import("../lib/session/passkey-offer");
const { setSession } = await import("../lib/session/tokens");

const fetchMock = vi.fn<typeof fetch>();
const json = (status: number, body?: unknown) =>
  body === undefined ? new Response(null, { status }) : new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));
let host: HTMLDivElement;
let root: Root;
const dialog = () => host.ownerDocument.querySelector("dialog");
const button = (label: string) => [...(dialog()?.querySelectorAll("button") ?? [])].find((b) => b.textContent === label);
async function click(label: string) {
  await act(async () => button(label)!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await settle();
}
const SESSION = { accessToken: "at-1", refreshToken: "rt-1", expiresIn: 3600 };

beforeEach(async () => {
  fetchMock.mockReset();
  webauthn.startRegistration.mockReset();
  toasts.shown = [];
  sessionStorage.clear();
  vi.stubGlobal("fetch", fetchMock);
  setSession(SESSION);
  setAuthConfigForTest({ passkey: true, remoteOrigin: "https://k7f3q2.mystuga.com" });
  ({ host, root } = mountInto());
  await act(async () => root.render(<PasskeyOffer />));
});
afterEach(() => setAuthConfigForTest(null));

describe("Sign in faster next time", () => {
  it("is asked once a sign-in brings the offer, and adds a passkey for this address", async () => {
    expect(dialog()?.open).toBeFalsy();
    await act(async () => notePasskeyOffer({ ...SESSION, passkeyOffer: true }));
    expect(dialog()?.open).toBe(true);
    expect(dialog()?.textContent).toContain("Add a passkey for k7f3q2.mystuga.com. Your face, fingerprint or screen lock signs you in.");
    const options = { challenge: "c", rp: { id: "k7f3q2.mystuga.com", name: "Office" }, user: { id: "dV9ibw", name: "bo", displayName: "Bo" }, pubKeyCredParams: [] };
    webauthn.startRegistration.mockResolvedValue({ id: "cred-1", rawId: "cred-1", type: "public-key", response: {} });
    fetchMock.mockResolvedValueOnce(json(200, { publicKey: options })).mockResolvedValueOnce(json(201, { id: "cred-1", name: "iCloud Keychain", synced: true }));
    await click("Add passkey");
    expect(fetchMock.mock.calls.map(([u]) => String(u))).toEqual(["/auth/passkey/options", "/auth/passkey/add"]);
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({ purpose: "add" });
    expect(webauthn.startRegistration).toHaveBeenCalledWith({ optionsJSON: options });
    expect(toasts.shown).toEqual([{ body: "Passkey added: iCloud Keychain.", type: "info" }]);
    expect(dialog()?.open).toBe(false);
    expect(passkeyOfferDue()).toBe(false);
  });

  it("remembers Not now on the account", async () => {
    await act(async () => notePasskeyOffer({ ...SESSION, passkeyOffer: true }));
    fetchMock.mockResolvedValueOnce(json(204));
    await click("Not now");
    expect(String(fetchMock.mock.calls[0]![0])).toBe("/api/me/passkey-offer/dismiss");
    expect(dialog()?.open).toBe(false);
    expect(passkeyOfferDue()).toBe(false);
  });

  it("is not asked without the offer, or where this page has no passkeys", async () => {
    await act(async () => notePasskeyOffer(SESSION));
    expect(dialog()?.open).toBeFalsy();
    setAuthConfigForTest({ passkey: false, remoteOrigin: "https://k7f3q2.mystuga.com" });
    await act(async () => notePasskeyOffer({ ...SESSION, passkeyOffer: true }));
    expect(dialog()?.open).toBeFalsy();
  });

  it("stays to try again when the prompt closes", async () => {
    await act(async () => notePasskeyOffer({ ...SESSION, passkeyOffer: true }));
    fetchMock.mockResolvedValueOnce(json(200, { publicKey: { challenge: "c" } }));
    webauthn.startRegistration.mockRejectedValue(Object.assign(new Error("closed"), { name: "NotAllowedError" }));
    await click("Add passkey");
    expect(dialog()?.textContent).toContain("The passkey prompt closed. Try again.");
    expect(dialog()?.open).toBe(true);
  });
});
