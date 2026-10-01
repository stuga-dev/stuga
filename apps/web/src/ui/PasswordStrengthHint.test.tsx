// @vitest-environment jsdom
/** The hint under a field that sets a password, and the rule it runs, loaded only when wanted. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { Root } from "react-dom/client";
import { mountInto } from "../test/form-input";

const loads = vi.hoisted(() => ({ count: 0 }));
const webauthn = vi.hoisted(() => ({ supported: false }));
vi.mock("@simplewebauthn/browser", async (orig) => ({
  ...(await orig<typeof import("@simplewebauthn/browser")>()),
  browserSupportsWebAuthn: () => webauthn.supported,
}));
vi.mock("@stuga/password-strength", async (orig) => {
  loads.count += 1;
  return orig();
});

const { setAuthConfigForTest } = await import("../lib/session/auth-config");
const { useRemoteStrength } = await import("../lib/session/password-strength");
const {
  GUESSABLE_HERE,
  GUESSABLE_HERE_ONLY,
  GUESSABLE_OR_PASSKEY,
  PasswordStrengthHint,
  USE_LONGER_HERE,
  USE_LONGER_OR_PASSKEY,
  WORKS_ANYWHERE,
  WORKS_HERE_ONLY,
} = await import("./PasswordStrengthHint");
const { passwordOk } = await import("../lib/session/sign-in");

const REMOTE = "https://k7f3q2.mystuga.com";
const originalLocation = window.location;
let host: HTMLDivElement;
let root: Root;

function Field({ password }: { password: string }) {
  const strength = useRemoteStrength(password, { username: "bo", displayName: "Bo Larsson" });
  return (
    <div>
      <PasswordStrengthHint password={password} strength={strength} />
      <p id="settled">{String(strength.settled)}</p>
    </div>
  );
}

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));
/** Render, and wait until the rule has scored this password: it loads on demand, later on a busy machine. */
async function show(password: string) {
  await act(async () => root.render(<Field password={password} />));
  const end = Date.now() + 10_000;
  do await settle();
  while (host.querySelector("#settled")?.textContent !== "true" && Date.now() < end);
  await settle();
}
const text = () => host.textContent ?? "";

beforeEach(() => {
  ({ host, root } = mountInto());
});
afterEach(() => {
  act(() => root.unmount());
  setAuthConfigForTest(null);
  Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
});

describe("the password hint", () => {
  it("shows nothing and loads nothing while the remote address is off and the password is short", async () => {
    setAuthConfigForTest({ remoteOrigin: null });
    await show("battery9");
    expect(text()).not.toContain(WORKS_HERE_ONLY);
    expect(text()).not.toContain(WORKS_ANYWHERE);
    expect(loads.count).toBe(0);
  });

  it("says whether a password also works from anywhere, while the remote address is on", async () => {
    setAuthConfigForTest({ remoteOrigin: REMOTE, nodeName: "North Office" });
    await show("battery9");
    expect(text()).toContain(WORKS_HERE_ONLY);
    // Long enough already: what it lacks is being hard to guess, not length.
    await show("password1234567");
    expect(text()).toContain(GUESSABLE_HERE_ONLY);
    await show("trumpet walnut ceiling");
    expect(text()).toContain(WORKS_ANYWHERE);
    expect(loads.count).toBe(1);
  });

  it("says it the remote address's way when the page is open there", async () => {
    setAuthConfigForTest({ remoteOrigin: REMOTE });
    Object.defineProperty(window, "location", { configurable: true, value: { ...originalLocation, origin: REMOTE } });
    await show("battery9");
    expect(text()).toContain(USE_LONGER_HERE);
    await show("qwertyuiopasdfghjkl");
    expect(text()).toContain(GUESSABLE_HERE);
    expect(text()).not.toContain("passkey");
  });

  it("offers a passkey there only where this browser can add one", async () => {
    setAuthConfigForTest({ remoteOrigin: REMOTE, passkey: true });
    Object.defineProperty(window, "location", { configurable: true, value: { ...originalLocation, origin: REMOTE } });
    webauthn.supported = true;
    await show("battery9");
    expect(text()).toContain(USE_LONGER_OR_PASSKEY);
    await show("qwertyuiopasdfghjkl");
    expect(text()).toContain(GUESSABLE_OR_PASSKEY);
    // An in-app browser with no WebAuthn is told only what it can do.
    webauthn.supported = false;
    await show("battery10");
    expect(text()).toContain(USE_LONGER_HERE);
    expect(text()).not.toContain("passkey");
  });

  it("keeps spaces and pastes as typed: a passphrase is scored whole", async () => {
    setAuthConfigForTest({ remoteOrigin: REMOTE });
    await show("  trumpet walnut ceiling  ");
    expect(text()).toContain(WORKS_ANYWHERE);
  });
});

describe("the letter and number rule", () => {
  it("is skipped for a password that meets the remote rule, and only then", () => {
    expect(passwordOk("trumpet walnut ceiling")).toBe(false);
    expect(passwordOk("trumpet walnut ceiling", true)).toBe(true);
    expect(passwordOk("battery9")).toBe(true);
    // The length is never skipped.
    expect(passwordOk("short", true)).toBe(false);
  });
});
