// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";

vi.mock("../api", async (orig) => ({
  ...(await orig<typeof import("../api")>()),
  Workspaces: {
    list: vi.fn(async () => ({
      workspaces: [
        { workspace_id: "ws1", name: "Studio", role: "owner" },
        { workspace_id: "ws2", name: "Family", role: "member" },
        { workspace_id: "ws3", name: "Client", role: "guest" },
      ],
      active: "ws1",
    })),
  },
}));
vi.mock("../lib/http/client", async (orig) => ({
  ...(await orig<typeof import("../lib/http/client")>()),
  authHeaders: vi.fn(async (init?: HeadersInit) => new Headers(init)),
}));

const { OAuthAuthorize, answerConsent } = await import("./OAuthAuthorize");

/** The node's record of the app, which the page asks for before anything else. */
const isClientInfo = (input: unknown) => String(input).startsWith("/oauth/client?");

const REQUEST = {
  clientId: "cid_1",
  redirectUri: "https://client.example.test/callback",
  codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  state: "xyz",
};

const fetchMock = vi.fn<typeof fetch>();
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
/** The body of the nth consent answer the page sent. */
const sentBody = (n = 0) => JSON.parse(String(fetchMock.mock.calls.filter((c) => c[0] === "/oauth/consent")[n]![1]!.body)) as Record<string, unknown>;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
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

describe("answerConsent", () => {
  it("posts the decision and returns the redirect the server validated", async () => {
    fetchMock.mockResolvedValue(reply(200, { redirect: "https://client.example.test/callback?error=access_denied&state=xyz" }));
    expect(await answerConsent("deny", REQUEST)).toBe("https://client.example.test/callback?error=access_denied&state=xyz");
    expect(fetchMock.mock.calls[0]![0]).toBe("/oauth/consent");
    expect(sentBody()).toEqual({
      decision: "deny",
      client_id: "cid_1",
      redirect_uri: "https://client.example.test/callback",
      code_challenge: REQUEST.codeChallenge,
      state: "xyz",
    });
  });

  it("returns null when the server refuses the request or cannot be reached", async () => {
    fetchMock.mockResolvedValueOnce(reply(400, { error: "invalid client/redirect" }));
    expect(await answerConsent("deny", REQUEST)).toBeNull();
    fetchMock.mockRejectedValueOnce(new TypeError("network down"));
    expect(await answerConsent("allow", REQUEST)).toBeNull();
  });
});

describe("OAuthAuthorize", () => {
  /** Consent answers come from `consent`; the app's record says it registered itself unless told otherwise. */
  function node(consent: Response, info: Record<string, unknown> = { client_name: "Liv’s Script", verified_host: null }) {
    fetchMock.mockImplementation(async (input) => (isClientInfo(input) ? reply(200, info) : consent.clone()));
  }

  async function open(query: string): Promise<void> {
    window.history.replaceState({}, "", `/oauth/consent?${query}`);
    await act(async () => {
      root.render(
        <MemoryRouter>
          <OAuthAuthorize />
        </MemoryRouter>,
      );
    });
  }
  const button = (label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === label);

  it("sends Deny to the server instead of the address in its own query string", async () => {
    node(reply(400, { error: "invalid client/redirect" }));
    await open(`client_id=cid_1&redirect_uri=${encodeURIComponent("https://evil.example.test/")}&code_challenge=${REQUEST.codeChallenge}&state=s`);
    expect(host.textContent).toContain("evil.example.test");
    await act(async () => button("Deny")!.click());
    expect(fetchMock.mock.calls.filter((c) => c[0] === "/oauth/consent")).toHaveLength(1);
    expect(sentBody()).toMatchObject({ decision: "deny", redirect_uri: "https://evil.example.test/" });
  });

  it("names the app from the node's record, never the link, and says whether anyone vouches for it", async () => {
    node(reply(200, {}));
    await open(`client_id=cid_1&client_name=Claude&redirect_uri=${encodeURIComponent(REQUEST.redirectUri)}&code_challenge=${REQUEST.codeChallenge}`);
    expect(host.textContent).toContain("Connect Liv’s Script");
    expect(host.textContent).not.toContain("Connect Claude");
    expect(host.textContent).toContain("Unverified app");

    act(() => root.unmount());
    root = createRoot(host);
    node(reply(200, {}), { client_name: "Claude", verified_host: "claude.ai" });
    await open(`client_id=${encodeURIComponent("https://claude.ai/meta.json")}&redirect_uri=${encodeURIComponent(REQUEST.redirectUri)}&code_challenge=${REQUEST.codeChallenge}`);
    expect(host.textContent).toContain("Verified by claude.ai");
  });

  it("grants the workspaces ticked and the access chosen, never a guest workspace", async () => {
    // Refused, so the page stays put: what matters is what it sent.
    node(reply(400, { error: "invalid client/redirect" }));
    await open(`client_id=cid_1&redirect_uri=${encodeURIComponent(REQUEST.redirectUri)}&code_challenge=${REQUEST.codeChallenge}`);
    expect(host.textContent).toContain("Studio");
    expect(host.textContent).toContain("Family");
    expect(host.textContent).not.toContain("Client");
    await act(async () => button("Allow")!.click());
    expect(sentBody()).toMatchObject({ decision: "allow", workspaces: ["ws1", "ws2"], access: "propose" });
  });

  it("shows an error and keeps the screen when Allow is refused", async () => {
    node(reply(400, { error: "invalid client/redirect" }));
    await open(`client_id=cid_1&redirect_uri=${encodeURIComponent(REQUEST.redirectUri)}&code_challenge=${REQUEST.codeChallenge}`);
    await act(async () => button("Allow")!.click());
    expect(sentBody()).toMatchObject({ decision: "allow" });
    expect(host.textContent).toContain("Connection failed");
    expect(button("Allow")!.disabled).toBe(false);
  });

  it("offers nothing to approve for a request whose redirect does not parse", async () => {
    await open(`client_id=cid_1&redirect_uri=not-a-url&code_challenge=${REQUEST.codeChallenge}`);
    expect(host.textContent).toContain("Incomplete request");
    expect(button("Deny")).toBeUndefined();
  });
});
