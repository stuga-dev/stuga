// @vitest-environment jsdom
/** The landing page of a sign-in through the identity provider, for an account the node knows. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { AuthComplete, HANDOFF_FAILED_NOTICE } from "./AuthComplete";
import { getToken } from "../lib/session/tokens";
import { hasSsoHint, peekSilentAttempt, setSsoHint } from "../lib/session/provider";
import { peekLoginReturn, rememberLoginReturn } from "../lib/session/return-path";

const fetchMock = vi.fn<typeof fetch>();
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let host: HTMLDivElement;
let root: Root;

/** Where the page sent the browser, and with what router state. */
function Probe() {
  const loc = useLocation();
  return <p id="probe">{JSON.stringify({ path: loc.pathname, state: loc.state ?? null })}</p>;
}

function landed(): { path: string; state: { notice?: string } | null } {
  return JSON.parse(host.querySelector("#probe")?.textContent ?? "null") as { path: string; state: { notice?: string } | null };
}

async function open(fragment: string) {
  window.history.replaceState({}, "", `/auth/complete${fragment}`);
  await act(async () => {
    root.render(
      <StrictMode>
        <MemoryRouter initialEntries={["/auth/complete"]}>
          <Routes>
            <Route path="/auth/complete" element={<AuthComplete />} />
            <Route path="*" element={<Probe />} />
          </Routes>
        </MemoryRouter>
      </StrictMode>,
    );
  });
  await act(async () => new Promise((r) => setTimeout(r, 0)));
}

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
  window.history.replaceState({}, "", "/");
});

describe("AuthComplete", () => {
  it("trades the code once for a session and goes where the sign-in was headed", async () => {
    rememberLoginReturn("/doc/d1");
    fetchMock.mockResolvedValue(
      reply(200, { access_token: "at-1", refresh_token: "rt-1", expires_in: 900, token_type: "Bearer", return_to: "/doc/d1" }),
    );
    await open("#code=c1");

    // Once, under StrictMode's doubled effect: a code works once.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/auth/oidc/handoff");
    expect(JSON.parse(String(init!.body))).toEqual({ code: "c1" });
    expect(window.location.hash).toBe("");
    expect(getToken()).toBe("at-1");
    expect(hasSsoHint()).toBe(true);
    expect(peekLoginReturn()).toBe("/");
    expect(landed().path).toBe("/doc/d1");
  });

  it("goes back to sign in with a notice when the node refuses the code", async () => {
    setSsoHint();
    fetchMock.mockResolvedValue(reply(403, { error: "handoff_invalid", message: "invalid" }));
    await open("#code=spent");

    expect(landed()).toEqual({ path: "/login", state: { notice: HANDOFF_FAILED_NOTICE } });
    expect(getToken()).toBeNull();
    // The login page must not try the provider again on its own.
    expect(hasSsoHint()).toBe(false);
  });

  it("says nothing about a failed silent attempt", async () => {
    setSsoHint();
    sessionStorage.setItem("stuga_sso_silent", "1");
    fetchMock.mockResolvedValue(reply(403, { error: "handoff_invalid", message: "invalid" }));
    await open("#code=spent");

    expect(landed()).toEqual({ path: "/login", state: null });
    expect(peekSilentAttempt()).toBe(false);
    expect(hasSsoHint()).toBe(false);
  });

  it("asks nothing of the node without a code", async () => {
    await open("");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(landed().path).toBe("/login");
  });

  it("never follows a destination off this origin", async () => {
    fetchMock.mockResolvedValue(reply(200, { access_token: "at-1", expires_in: 900, return_to: "//evil.example/" }));
    await open("#code=c2");
    expect(landed().path).toBe("/");
  });
});
