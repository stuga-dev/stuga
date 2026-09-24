// @vitest-environment jsdom
/** The landing page of a sign-in through the identity provider, for someone the node does not know yet. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { FirstVisit } from "./FirstVisit";
import { getToken } from "../lib/session/tokens";
import { hasSsoHint } from "../lib/session/provider";
import { rememberLoginReturn } from "../lib/session/return-path";

const fetchMock = vi.fn<typeof fetch>();
const assign = vi.fn();
const originalLocation = window.location;
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const SESSION = { access_token: "at-1", refresh_token: "rt-1", expires_in: 900, token_type: "Bearer" };

/** What the node says about the ticket; `return_to` is where the sign-in started from. */
function ticketAnswer(returnTo: string) {
  return {
    label: "Okta",
    preferred_username: "ada",
    name: "Ada Lovelace",
    email: "ada@example.com",
    suggestion: "ada",
    return_to: returnTo,
  };
}

/** Answers by path; the ticket is always readable. */
function node(returnTo: string, steps: Record<string, () => Response>, ticket: Record<string, unknown> = {}) {
  fetchMock.mockImplementation(async (input) => {
    const path = String(input);
    if (path === "/auth/oidc/ticket") return reply(200, { ...ticketAnswer(returnTo), ...ticket });
    const step = steps[path];
    if (!step) throw new Error(`unexpected ${path}`);
    return step();
  });
}

const sent = (path: string) => {
  const call = fetchMock.mock.calls.find(([url]) => String(url) === path);
  return call ? (JSON.parse(String(call[1]!.body)) as Record<string, unknown>) : null;
};

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

async function open(fragment: string) {
  window.history.replaceState({}, "", `/auth/first-visit${fragment}`);
  await act(async () => {
    root.render(
      <StrictMode>
        <MemoryRouter initialEntries={["/auth/first-visit"]}>
          <Routes>
            <Route path="/auth/first-visit" element={<FirstVisit />} />
            <Route path="*" element={<Probe />} />
          </Routes>
        </MemoryRouter>
      </StrictMode>,
    );
  });
  await settle();
}

function input(label: string): HTMLInputElement {
  const found = [...host.querySelectorAll("input")].find(
    (i) => host.querySelector(`label[for="${i.id}"]`)?.textContent?.startsWith(label),
  );
  expect(found, `no input ${label}`).toBeTruthy();
  return found!;
}

async function type(label: string, value: string) {
  const el = input(label);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const button = (label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === label);
const isDisabled = (b: HTMLButtonElement | undefined) => !!b && (b.disabled || b.getAttribute("aria-disabled") === "true");

async function click(label: string) {
  const el = button(label);
  expect(el, `no button ${label}`).toBeTruthy();
  await act(async () => el!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await settle();
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  fetchMock.mockReset();
  assign.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  // The live location, so the fragment the page reads is the one each test sets; only leaving is caught.
  // Over a plain object: Location's own members cannot be stood in for through a proxy of it.
  const live = new Proxy({} as Location, {
    get: (_, key) => (key === "assign" ? assign : (originalLocation[key as keyof Location] as unknown)),
  });
  Object.defineProperty(window, "location", { configurable: true, value: live });
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
  Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
  window.history.replaceState({}, "", "/");
});

describe("FirstVisit", () => {
  it("creates an account with the invite the sign-in started from, and lands in the app", async () => {
    rememberLoginReturn("/join/inv_abc");
    node("/join/inv_abc", { "/auth/oidc/complete": () => reply(201, { ...SESSION, return_to: "/join/inv_abc" }) });
    await open("#ticket=t1");

    expect(window.location.hash).toBe("");
    expect(host.textContent).toContain("Signed in with Okta as Ada Lovelace.");
    expect(input("Username").value).toBe("ada");
    expect(input("Full name").value).toBe("Ada Lovelace");

    await click("Create account");
    expect(sent("/auth/oidc/complete")).toEqual({ ticket: "t1", username: "ada", name: "Ada Lovelace", invite: "inv_abc" });
    // Creation redeemed the invite: its /join link is not visited again.
    expect(landed()?.path).toBe("/");
    expect(getToken()).toBe("at-1");
    expect(hasSsoHint()).toBe(true);
    expect(sessionStorage.getItem("stuga_first_visit_ticket")).toBeNull();
  });

  it("offers only the link to an existing account when the visitor holds no invite", async () => {
    node("/", {});
    await open("#ticket=t1");

    expect(host.textContent).toContain("Link your account");
    expect(host.textContent).toContain("Creating an account here needs an invite link.");
    expect(button("Create a new account")).toBeUndefined();
    expect(button("Create account")).toBeUndefined();
  });

  it("links an account here by its password and goes where the sign-in was headed", async () => {
    // "ada" is taken here, so the node suggests "ada-2" for a new account.
    node("/doc/d1", { "/auth/oidc/link": () => reply(200, { ...SESSION, return_to: "/doc/d1" }) }, { suggestion: "ada-2" });
    await open("#ticket=t1");

    // The provider's name for the person, not the free suggestion, which is nobody's account.
    expect(input("Username").value).toBe("ada");
    await type("Username", "Ada.L");
    await type("Password", "correct horse");
    await click("Link and sign in");
    expect(sent("/auth/oidc/link")).toEqual({ ticket: "t1", username: "ada.l", password: "correct horse" });
    expect(landed()?.path).toBe("/doc/d1");
    expect(getToken()).toBe("at-1");
  });

  it("offers the node's suggestion for a taken username in one click", async () => {
    node("/join/inv_abc", {
      "/auth/oidc/complete": () =>
        reply(409, { error: "username_taken", message: "That username is taken.", suggestion: "ada-2" }),
    });
    await open("#ticket=t1");

    await click("Create account");
    expect(host.textContent).toContain("That username is taken.");
    await click("Use ada-2");
    expect(input("Username").value).toBe("ada-2");
    expect(button("Use ada-2")).toBeUndefined();
    expect(landed()).toBeNull();
  });

  it("switches between a new account and an existing one when an invite allows both", async () => {
    node("/join/inv_abc", {});
    await open("#ticket=t1");

    await click("I already have an account");
    expect(host.textContent).toContain("Link your account");
    await click("Create a new account");
    expect(host.textContent).toContain("Create your account");
  });

  it("starts over with the provider asking for another account, headed where the sign-in was", async () => {
    node("/join/inv_abc", {
      "/auth/oidc/start": () => reply(200, { url: "https://id.example.com/authorize?prompt=select_account" }),
    });
    await open("#ticket=t1");

    await click("Use a different account");
    expect(sent("/auth/oidc/start")).toEqual({ return_to: "/join/inv_abc", prompt: "select_account" });
    expect(assign).toHaveBeenCalledWith("https://id.example.com/authorize?prompt=select_account");
    // The unspent ticket goes with the page: the next sign-in brings its own.
    expect(sessionStorage.getItem("stuga_first_visit_ticket")).toBeNull();
    expect(landed()).toBeNull();
  });

  it("stays, with the ticket, when the provider cannot be reached, and is usable again after Back", async () => {
    node("/", { "/auth/oidc/start": () => reply(502, { error: "provider_unreachable", message: "unreachable" }) });
    await open("#ticket=t1");

    await click("Use a different account");
    expect(assign).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Couldn’t reach the identity provider.");
    expect(sessionStorage.getItem("stuga_first_visit_ticket")).toBe("t1");
    expect(isDisabled(button("Link and sign in"))).toBe(false);
  });

  it("goes back to sign in when Back from the provider restores it: the new start spent its ticket", async () => {
    node("/", { "/auth/oidc/start": () => reply(200, { url: "https://id.example.com/authorize" }) });
    await open("#ticket=t1");
    await click("Use a different account");
    expect(isDisabled(button("Back to sign in"))).toBe(true);

    // The start replaced the cookie the ticket is bound to, so its buttons would only bounce as expired.
    await act(async () => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    await settle();
    expect(landed()?.path).toBe("/login");
    expect(sessionStorage.getItem("stuga_first_visit_ticket")).toBeNull();
  });

  it("makes its buttons usable again in place when restored without having started over", async () => {
    // Left while the start was still on its way: nothing replaced the cookie, so the ticket still works.
    fetchMock.mockImplementation(async (input) => {
      const path = String(input);
      if (path === "/auth/oidc/ticket") return reply(200, ticketAnswer("/"));
      return new Promise<Response>(() => {});
    });
    await open("#ticket=t1");
    await click("Use a different account");
    expect(isDisabled(button("Back to sign in"))).toBe(true);

    await act(async () => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    await settle();
    expect(landed()).toBeNull();
    expect(isDisabled(button("Back to sign in"))).toBe(false);
    expect(isDisabled(button("Use a different account"))).toBe(false);
    expect(sessionStorage.getItem("stuga_first_visit_ticket")).toBe("t1");
  });

  it("goes back to sign in when the ticket has expired", async () => {
    // A fresh response per call: StrictMode reads the ticket twice.
    fetchMock.mockImplementation(async () => reply(403, { error: "ticket_invalid", message: "invalid" }));
    await open("#ticket=old");
    expect(landed()).toEqual({ path: "/login", state: { notice: "That sign-in has expired. Try again." } });
    expect(sessionStorage.getItem("stuga_first_visit_ticket")).toBeNull();
  });

  it("survives a reload: the ticket is kept for the tab once the fragment is gone", async () => {
    sessionStorage.setItem("stuga_first_visit_ticket", "t9");
    node("/", {});
    await open("");
    expect(sent("/auth/oidc/ticket")).toEqual({ ticket: "t9" });
    expect(host.textContent).toContain("Signed in with Okta");
  });
});
