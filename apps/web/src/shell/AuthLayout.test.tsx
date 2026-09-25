// @vitest-environment jsdom
/** A signed-out visit: invite and share links sign in where they are; anything else goes to /login. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { AuthLayout } from "./AuthLayout";
import { setAuthConfigForTest } from "../lib/session/auth-config";
import { resetSilentAttemptForTest } from "../lib/session/provider";

const fetchMock = vi.fn<typeof fetch>();
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let host: HTMLDivElement;
let root: Root;

function Where() {
  const loc = useLocation();
  return <p id="where">{loc.pathname + loc.search}</p>;
}

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));
const where = () => host.querySelector("#where")?.textContent;
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

async function open(path: string) {
  await act(async () => {
    root.render(
      <StrictMode>
        <MemoryRouter initialEntries={[path]}>
          <Where />
          <Routes>
            <Route path="/login" element={<p id="login">the login page</p>} />
            <Route element={<AuthLayout />}>
              <Route path="/join/:token" element={<p id="join">join this workspace</p>} />
              <Route path="/s/:token" element={<p id="share">open this document</p>} />
              <Route path="/doc/:docId" element={<p id="doc">a document</p>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </StrictMode>,
    );
  });
  await settle();
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  localStorage.clear();
  sessionStorage.clear();
  resetSilentAttemptForTest();
  setAuthConfigForTest({ nodeName: "Studio" });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  setAuthConfigForTest(null);
});

describe("AuthLayout, signed out", () => {
  it("keeps an invite link in the address bar and offers sign-up there", async () => {
    await open("/join/inv_abc");
    expect(where()).toBe("/join/inv_abc");
    expect(host.querySelector("h1")?.textContent).toBe("Create your account");
    expect(host.textContent).toContain("You’re invited.");
  });

  it("keeps a share link in the address bar and offers sign-in there", async () => {
    await open("/s/shr_abc");
    expect(where()).toBe("/s/shr_abc");
    expect(host.querySelector("h1")?.textContent).toBe("Welcome back");
  });

  it("shows the invite once signed in, at the same address", async () => {
    fetchMock.mockImplementation(async () => reply(200, { access_token: "at-1", refresh_token: "rt-1", expires_in: 900 }));
    await open("/join/inv_abc");
    await click("Sign in");
    await type("Username", "ada");
    await type("Password", "battery staple 9");
    await click("Sign in");
    expect(where()).toBe("/join/inv_abc");
    expect(host.querySelector("#join")).toBeTruthy();
  });

  it("sends any other page to /login, remembering where it was headed", async () => {
    await open("/doc/d1");
    expect(where()).toBe("/login");
    expect(host.querySelector("#login")).toBeTruthy();
    expect(sessionStorage.getItem("stuga_login_return")).toBe("/doc/d1");
  });
});
