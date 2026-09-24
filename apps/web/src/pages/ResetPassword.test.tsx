// @vitest-environment jsdom
/** Where a password reset link lands: a new password, a session, and a spent link sent back to sign in. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { ResetPassword } from "./ResetPassword";
import { getToken } from "../lib/session/tokens";
import { rememberLoginReturn } from "../lib/session/return-path";

const fetchMock = vi.fn<typeof fetch>();
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const SESSION = { access_token: "at-1", refresh_token: "rt-1", expires_in: 900, token_type: "Bearer" };

let host: HTMLDivElement;
let root: Root;

function Probe() {
  const loc = useLocation();
  return <p id="probe">{JSON.stringify({ path: loc.pathname, state: loc.state ?? null })}</p>;
}

function landed(): { path: string; state: { notice?: string } | null } | null {
  return JSON.parse(host.querySelector("#probe")?.textContent ?? "null") as { path: string; state: { notice?: string } | null } | null;
}

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

async function open(path: string) {
  await act(async () => {
    root.render(
      <StrictMode>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/reset/:token" element={<ResetPassword />} />
            <Route path="*" element={<Probe />} />
          </Routes>
        </MemoryRouter>
      </StrictMode>,
    );
  });
  await settle();
}

async function type(label: string, value: string) {
  const el = [...host.querySelectorAll("input")].find((i) => host.querySelector(`label[for="${i.id}"]`)?.textContent?.startsWith(label));
  expect(el, `no input ${label}`).toBeTruthy();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(el!, value);
    el!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(label: string) {
  const el = [...host.querySelectorAll("button")].find((b) => b.textContent === label);
  expect(el, `no button ${label}`).toBeTruthy();
  await act(async () => el!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await settle();
}

const sent = (path: string) => {
  const call = fetchMock.mock.calls.find(([url]) => String(url) === path);
  return call ? (JSON.parse(String(call[1]!.body)) as Record<string, unknown>) : null;
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  localStorage.clear();
  sessionStorage.clear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("ResetPassword", () => {
  it("sets the new password with the link's token, signs in, and goes where the visitor was headed", async () => {
    rememberLoginReturn("/doc/d1");
    fetchMock.mockImplementation(async () => reply(200, SESSION));
    await open("/reset/rst_abc");

    expect(host.textContent).toContain("Choose a new password");
    await type("New password", "battery staple 9");
    await click("Set password");
    expect(sent("/auth/reset")).toEqual({ token: "rst_abc", new_password: "battery staple 9" });
    expect(getToken()).toBe("at-1");
    expect(landed()?.path).toBe("/doc/d1");
  });

  it("asks for a password the node would accept before sending anything", async () => {
    await open("/reset/rst_abc");
    await type("New password", "short");
    await click("Set password");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Choose a password that meets all the requirements below.");
    expect(host.textContent).toContain("At least 8 characters");
  });

  it("sends a spent or expired link back to sign in, saying why", async () => {
    fetchMock.mockImplementation(async () => reply(403, { error: "reset_invalid", message: "invalid" }));
    await open("/reset/rst_old");
    await type("New password", "battery staple 9");
    await click("Set password");
    expect(landed()).toEqual({ path: "/login", state: { notice: "This reset link is invalid, expired, or already used." } });
    expect(getToken()).toBeNull();
  });

  it("keeps the form up for any other refusal", async () => {
    fetchMock.mockImplementation(async () => reply(429, { error: "rate_limited", message: "too many attempts" }));
    await open("/reset/rst_abc");
    await type("New password", "battery staple 9");
    await click("Set password");
    expect(landed()).toBeNull();
    expect(host.textContent).toContain("Too many attempts. Wait a moment and try again.");
  });
});
